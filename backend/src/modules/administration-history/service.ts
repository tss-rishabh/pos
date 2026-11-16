import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser, Store } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { assertModelAdministrationPermission } from '../administration/access-control.js';
import { administrationGroups } from '../administration/access-schema.js';
import { warehouseService } from '../warehouse.js';
import {
  administrationHistoryModels,
  historyCount,
  historyInput,
  historyProjection,
  readAdministrationHistoryOptions,
  type AdministrationHistoryInput,
  type AdministrationHistoryOptions,
} from './contracts.js';
import {
  historyReadScope,
  historyRecord,
  sourceHistoryPage,
  sourceHistoryPageNumber,
} from './domain.js';
import {
  administrationHistoryAuthActor as authActor,
  administrationHistoryActorForeignKey as actorForeignKey,
  administrationHistoryContentType as contentType,
  administrationHistoryLog as log,
} from './schema.js';
import { historicalAdministrationQuery } from './warehouse-sql.js';

export type AdministrationHistoryWarehouse = Pick<
  ReturnType<typeof warehouseService>,
  'queryReport'
>;
type Model = AdministrationHistoryInput['model'];
const models = {
  operator: {
    appLabel: 'users',
    model: 'posuser',
    label: 'Operator',
    permissions: ['users.view_posuser', 'users.change_posuser'],
  },
  store: {
    appLabel: 'stores',
    model: 'store',
    label: 'Store',
    permissions: ['stores.view_store', 'stores.change_store'],
  },
  group: {
    appLabel: 'auth',
    model: 'group',
    label: 'Group',
    permissions: ['auth.view_group', 'auth.change_group'],
  },
} as const;
const unavailable = () =>
  new AppError(
    503,
    'ADMINISTRATION_HISTORY_SOURCE_UNVERIFIED',
    'Model history requires a verified source and reader publication.',
  );
const invalid = () =>
  new AppError(
    503,
    'ADMINISTRATION_HISTORY_DATA_INVALID',
    'Model history is temporarily unavailable. Try again later.',
  );
const missing = () =>
  new AppError(404, 'ADMINISTRATION_HISTORY_OBJECT_NOT_FOUND', 'This model object was not found.');

export function administrationHistoryService(
  config: Config,
  db: Databases,
  options: AdministrationHistoryOptions = readAdministrationHistoryOptions(),
  warehouse: AdministrationHistoryWarehouse = warehouseService(config),
  clock: () => Temporal.Instant = () => Temporal.Now.instant(),
) {
  const dailyConfigured = Boolean(
    options.POS_ADMINISTRATION_HISTORY_MYSQL_CONTRACT &&
    options.POS_ADMINISTRATION_HISTORY_MYSQL_ACTOR,
  );
  const historyConfigured = Boolean(
    options.BQ_ADMINISTRATION_HISTORY_VIEW &&
    options.BQ_ADMINISTRATION_HISTORY_MATCH_UDF &&
    options.BQ_ADMINISTRATION_HISTORY_CONTRACT,
  );
  async function authorize(user: Principal, model: Model, objectId?: string) {
    return db.get('writer').transaction(async (tx) => {
      await assertModelAdministrationPermission(tx, user, models[model].permissions);
      if (objectId === undefined) return null;
      if (model === 'operator') {
        const [target] = await tx
          .select({ id: PosUser.id, label: PosUser.username })
          .from(PosUser)
          .where(eq(PosUser.id, BigInt(objectId)))
          .limit(1)
          .for('share');
        if (!target) throw missing();
        return { id: target.id.toString(), label: target.label };
      }
      if (model === 'store') {
        const [target] = await tx
          .select({ id: Store.id, label: Store.store_name })
          .from(Store)
          .where(eq(Store.id, BigInt(objectId)))
          .limit(1)
          .for('share');
        if (!target) throw missing();
        return { id: target.id.toString(), label: target.label || target.id.toString() };
      }
      const [target] = await tx
        .select({ id: administrationGroups.legacyId, label: administrationGroups.name })
        .from(administrationGroups)
        .where(eq(administrationGroups.id, objectId))
        .limit(1)
        .for('share');
      if (!target) throw missing();
      if (target.id !== null && !/^[1-9]\d{0,18}$/.test(target.id)) throw invalid();
      return target;
    });
  }
  return {
    async capabilities(user: Principal) {
      const available: { id: Model; label: string }[] = [];
      for (const model of administrationHistoryModels) {
        try {
          await authorize(user, model);
          available.push({ id: model, label: models[model].label });
        } catch (error) {
          if (!(error instanceof AppError && error.status === 403)) throw error;
        }
      }
      return {
        today: clock().toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate().toString(),
        timeZone: config.BUSINESS_TIMEZONE,
        models: available,
        pageSize: 100,
        dailyConfigured,
        historyConfigured,
      };
    },
    async search(user: Principal, raw: AdministrationHistoryInput) {
      const input = historyInput.parse(raw),
        target = (await authorize(user, input.model, input.objectId))!,
        scope = historyReadScope(config, input, clock());
      const resource = { model: input.model, objectId: input.objectId, label: target.label };
      // New rewrite groups have no source object key; receipts are never presented as Django logs.
      if (target.id === null)
        return {
          resource,
          reader: 'none' as const,
          today: scope.today,
          timeZone: config.BUSINESS_TIMEZONE,
          provenance: 'django-admin' as const,
          notice: 'This group was created in the rewrite and has no legacy Django history.',
          total: '0',
          ...sourceHistoryPage(input.page, 0n),
          pageSize: 100,
          data: [],
        };
      let total: string, records: z.infer<typeof historyProjection>[];
      if (scope.reader === 'data-reader') {
        if (!dailyConfigured) throw unavailable();
        const actor =
          options.POS_ADMINISTRATION_HISTORY_MYSQL_ACTOR === 'auth-user'
            ? {
                table: authActor,
                id: authActor.id,
                username: authActor.username,
                firstName: authActor.firstName,
                lastName: authActor.lastName,
              }
            : {
                table: PosUser,
                id: PosUser.id,
                username: PosUser.username,
                firstName: PosUser.first_name,
                lastName: PosUser.last_name,
              };
        const where = and(
          eq(contentType.appLabel, models[input.model].appLabel),
          eq(contentType.model, models[input.model].model),
          eq(log.objectId, target.id),
          gte(log.actionTime, scope.from!),
          scope.to ? lt(log.actionTime, scope.to) : undefined,
        );
        const result = await db.get('data').transaction(
          async (tx) => {
            const binding = await tx
              .select({
                schema: actorForeignKey.referencedSchema,
                table: actorForeignKey.referencedTable,
                column: actorForeignKey.referencedColumn,
                currentSchema: sql<string>`DATABASE()`,
              })
              .from(actorForeignKey)
              .where(
                and(
                  eq(actorForeignKey.tableSchema, sql`DATABASE()`),
                  eq(actorForeignKey.tableName, 'django_admin_log'),
                  eq(actorForeignKey.columnName, 'user_id'),
                ),
              )
              .limit(2);
            const expected =
              options.POS_ADMINISTRATION_HISTORY_MYSQL_ACTOR === 'auth-user'
                ? 'auth_user'
                : 'pos_user';
            if (
              binding.length !== 1 ||
              binding[0]!.schema !== binding[0]!.currentSchema ||
              binding[0]!.table !== expected ||
              binding[0]!.column !== 'id'
            )
              throw unavailable();
            const [count] = await tx
              .select({ total: sql<string>`CAST(COUNT(*) AS CHAR)` })
              .from(log)
              .innerJoin(contentType, eq(contentType.id, log.contentTypeId))
              .where(where);
            const checked = historyCount.safeParse(count?.total);
            if (!checked.success) throw invalid();
            const paging = sourceHistoryPage(input.page, BigInt(checked.data));
            if (BigInt(paging.start) > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
            const rows =
              checked.data === '0'
                ? []
                : await tx
                    .select({
                      id: sql<string>`CAST(${log.id} AS CHAR)`,
                      actionTime: log.actionTime,
                      actorId: sql<string>`CAST(${actor.id} AS CHAR)`,
                      actorUsername: actor.username,
                      actorFirstName: actor.firstName,
                      actorLastName: actor.lastName,
                      actionFlag: log.actionFlag,
                      changeMessage: log.changeMessage,
                    })
                    .from(log)
                    .innerJoin(contentType, eq(contentType.id, log.contentTypeId))
                    .innerJoin(actor.table, eq(actor.id, log.actorId))
                    .where(where)
                    .orderBy(asc(log.actionTime), asc(log.id))
                    .limit(100)
                    .offset(Number(paging.start));
            return { total: checked.data, rows };
          },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        );
        total = result.total;
        const parsed = z.array(historyProjection).max(100).safeParse(result.rows);
        if (!parsed.success) throw invalid();
        records = parsed.data;
      } else {
        const view = options.BQ_ADMINISTRATION_HISTORY_VIEW,
          udf = options.BQ_ADMINISTRATION_HISTORY_MATCH_UDF;
        if (!historyConfigured || !view || !udf) throw unavailable();
        const requested = sourceHistoryPageNumber(input.page);
        const requestedPage =
          requested === null
            ? null
            : requested < 0n
              ? '-1'
              : requested > 18446744073709551615n
                ? '18446744073709551615'
                : requested.toString();
        const rows = await warehouse.queryReport(
          historicalAdministrationQuery(view, udf),
          {
            appLabel: models[input.model].appLabel,
            model: models[input.model].model,
            objectId: target.id,
            fromTime: scope.from,
            toTime: scope.to,
            requestedPage,
          },
          {
            appLabel: 'STRING',
            model: 'STRING',
            objectId: 'STRING',
            fromTime: 'DATETIME',
            toTime: 'DATETIME',
            requestedPage: 'STRING',
          },
          'administration-history',
        );
        const parsed = z
          .array(
            z.object({
              total: historyCount,
              page: historyCount,
              pages: historyCount,
              data: z.array(historyProjection).max(100),
            }),
          )
          .length(1)
          .safeParse(rows);
        if (!parsed.success) throw invalid();
        const row = parsed.data[0]!,
          paging = sourceHistoryPage(input.page, BigInt(row.total));
        if (row.page !== paging.page || row.pages !== paging.pages) throw invalid();
        total = row.total;
        records = row.data;
      }
      const paging = sourceHistoryPage(input.page, BigInt(total));
      if (
        records.length !== paging.count ||
        records.some((record, index) => {
          if (index === 0) return false;
          const previous = records[index - 1]!,
            order = Temporal.PlainDateTime.compare(
              record.actionTime.replace(' ', 'T'),
              previous.actionTime.replace(' ', 'T'),
            );
          return order < 0 || (order === 0 && BigInt(record.id) <= BigInt(previous.id));
        })
      )
        throw invalid();
      // Provider latency must not let a revoked model grant disclose a later response.
      const current = await authorize(user, input.model, input.objectId);
      if (current?.id !== target.id) throw invalid();
      return {
        resource: { ...resource, label: current.label },
        reader: scope.reader,
        today: scope.today,
        timeZone: config.BUSINESS_TIMEZONE,
        provenance: 'django-admin' as const,
        notice: null,
        total,
        ...paging,
        pageSize: 100,
        data: records.map(historyRecord),
      };
    },
  };
}
