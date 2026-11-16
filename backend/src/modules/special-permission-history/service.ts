import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gte, inArray, like, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { warehouseService } from '../warehouse.js';
import {
  activityPlatforms,
  activityProjection,
  activitySearchInput,
  countValue,
  readSpecialPermissionHistoryOptions,
  type ActivitySearchInput,
  type SpecialPermissionHistoryOptions,
} from './contracts.js';
import {
  activityReadScope,
  activityRecord,
  sourceActivityPageStart,
  sourceActivityPattern,
  sourceActivityPlatforms,
} from './domain.js';
import { specialPermissionActivity as activity } from './schema.js';
import { historicalActivityQuery } from './warehouse-sql.js';

export interface ActivityDatabases {
  get(name: 'writer' | 'data'): Pick<ReturnType<Databases['get']>, 'select' | 'transaction'>;
}
export type ActivityWarehouse = Pick<ReturnType<typeof warehouseService>, 'queryReport'>;

const unavailable = () =>
  new AppError(
    503,
    'SPECIAL_PERMISSION_HISTORY_UNAVAILABLE',
    'Historical activity is temporarily unavailable. Choose today or try again later.',
  );
const invalid = () =>
  new AppError(
    503,
    'SPECIAL_PERMISSION_HISTORY_DATA_INVALID',
    'Activity history is temporarily unavailable. Try again later.',
  );
export function specialPermissionHistoryService(
  config: Config,
  db: ActivityDatabases,
  options: SpecialPermissionHistoryOptions = readSpecialPermissionHistoryOptions(),
  warehouse: ActivityWarehouse = warehouseService(config),
  clock: () => Temporal.Instant = () => Temporal.Now.instant(),
) {
  async function authorize(user: Principal) {
    await db.get('writer').transaction(async (tx) => {
      const [actor] = await tx
        .select({ role: PosUser.role, userType: PosUser.user_type, active: PosUser.is_active })
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(user.id)))
        .limit(1)
        .for('share');
      if (!actor?.active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      if (actor.userType !== 1 || ![1, 2, 3].includes(actor.role))
        throw new AppError(
          403,
          'SPECIAL_PERMISSION_HISTORY_DENIED',
          'Activity history requires current internal administration access.',
        );
    });
  }
  const projection = {
    id: sql<string>`cast(${activity.id} as char)`,
    actorExists: sql<boolean>`${PosUser.id} is not null`.mapWith(
      (value: unknown) => value === true || String(value) === '1',
    ),
    firstName: PosUser.first_name,
    lastName: PosUser.last_name,
    platform: activity.platform,
    comment: activity.comment,
    createdAt: activity.createdAt,
    recipient: activity.recipient,
  };
  return {
    async capabilities(user: Principal) {
      await authorize(user);
      return {
        today: clock().toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate().toString(),
        platforms: [...activityPlatforms],
        historyConfigured: Boolean(
          options.BQ_SPECIAL_PERMISSION_ACTIVITY_VIEW &&
          options.BQ_SPECIAL_PERMISSION_ACTIVITY_MATCH_UDF,
        ),
      };
    },
    async search(user: Principal, value: ActivitySearchInput) {
      const parsedInput = activitySearchInput.parse(value),
        input = { ...parsedInput, platforms: sourceActivityPlatforms(parsedInput.platforms) };
      await authorize(user);
      const scope = activityReadScope(config, input, clock());
      let total: string, start: number, records: z.infer<typeof activityProjection>[];
      if (scope.reader === 'data-reader') {
        const pattern = sourceActivityPattern(input.search),
          condition = and(
            gte(activity.createdAt, scope.from!),
            scope.to ? lt(activity.createdAt, scope.to) : undefined,
            input.platforms.length ? inArray(activity.platform, input.platforms) : undefined,
            input.search
              ? or(
                  like(activity.recipient, pattern),
                  like(activity.comment, pattern),
                  like(activity.platform, pattern),
                  like(activity.createdAt, pattern),
                )
              : undefined,
          );
        const result = await db.get('data').transaction(
          async (tx) => {
            const [count] = await tx
              .select({ total: sql<string>`cast(count(*) as char)` })
              .from(activity)
              .where(condition);
            const checked = countValue.safeParse(count?.total);
            if (!checked.success) throw invalid();
            const offset = sourceActivityPageStart(input.start, input.length, BigInt(checked.data));
            const rows =
              checked.data === '0'
                ? []
                : await tx
                    .select(projection)
                    .from(activity)
                    .leftJoin(PosUser, eq(PosUser.id, activity.actorId))
                    .where(condition)
                    .orderBy(asc(activity.id))
                    .limit(input.length)
                    .offset(offset);
            return { total: checked.data, start: offset, rows };
          },
          {
            isolationLevel: 'repeatable read',
            accessMode: 'read only',
          },
        );
        total = result.total;
        start = result.start;
        const parsed = z.array(activityProjection).safeParse(result.rows);
        if (!parsed.success) throw invalid();
        records = parsed.data;
      } else {
        const view = options.BQ_SPECIAL_PERMISSION_ACTIVITY_VIEW,
          udf = options.BQ_SPECIAL_PERMISSION_ACTIVITY_MATCH_UDF;
        if (!view || ((input.search || input.platforms.length) && !udf)) throw unavailable();
        const statement = historicalActivityQuery(
          view,
          udf,
          Boolean(input.platforms.length),
          Boolean(input.search),
        );
        const raw = await warehouse.queryReport(
          statement,
          {
            fromTime: scope.from,
            toTime: scope.to,
            platforms: input.platforms,
            pattern: sourceActivityPattern(input.search),
            start: input.start,
            length: input.length,
          },
          {
            fromTime: 'DATETIME',
            toTime: 'DATETIME',
            platforms: ['STRING'],
            pattern: 'STRING',
            start: 'INT64',
            length: 'INT64',
          },
          'special-permission-activity',
        );
        const parsed = z
          .array(
            z.object({
              total: countValue,
              actual_start: z
                .string()
                .regex(/^(?:0|[1-9]\d*)$/)
                .refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)),
              data: z.array(activityProjection).max(input.length),
            }),
          )
          .length(1)
          .safeParse(raw);
        if (!parsed.success) throw invalid();
        const row = parsed.data[0]!;
        total = row.total;
        start = Number(row.actual_start);
        records = row.data;
        if (
          records.some(
            (record, index) => index > 0 && BigInt(record.id) <= BigInt(records[index - 1]!.id),
          )
        )
          throw invalid();
        if (
          start !== sourceActivityPageStart(input.start, input.length, BigInt(total)) ||
          records.length !==
            Number(
              BigInt(total) - BigInt(start) < BigInt(input.length)
                ? BigInt(total) - BigInt(start)
                : BigInt(input.length),
            )
        )
          throw invalid();
      }
      return {
        reader: scope.reader,
        today: scope.today,
        draw: input.draw,
        recordsTotal: total,
        recordsFiltered: total,
        start,
        length: input.length,
        data: records.map(activityRecord),
      };
    },
  };
}
