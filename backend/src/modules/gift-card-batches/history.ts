import { Temporal } from '@js-temporal/polyfill';
import { and, asc, desc, eq, gte, like, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { PosUser } from '../../db/legacy-schema.js';
import { sourceAdministrationFullName } from '../administration-history/messages.js';
import { warehouseService, warehouseScalar } from '../warehouse.js';
import { legacyGiftCardBatches as batches } from './schema.js';
import {
  giftCardBatchId,
  giftCardBatchSearchInput,
  type GiftCardBatchSearchInput,
} from './contracts.js';
import type { GiftCardBatchService } from './service.js';

type Warehouse = Pick<ReturnType<typeof warehouseService>, 'queryReport'>;
const invalid = () =>
  new AppError(
    503,
    'GIFT_CARD_BATCH_HISTORY_INVALID',
    'Gift card batch history is temporarily unavailable.',
  );
const missing = () =>
  new AppError(
    503,
    'GIFT_CARD_BATCH_HISTORY_UNAVAILABLE',
    'Configure historical gift card batches or choose today.',
  );
const count = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
const scalar = <T extends z.ZodType>(schema: T) => z.preprocess(warehouseScalar, schema);
const boolean = scalar(
  z
    .union([z.boolean(), z.literal(0), z.literal(1), z.literal('0'), z.literal('1')])
    .transform((value) => value === true || value === 1 || value === '1'),
);
const wall = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  .refine((value) => {
    try {
      return Temporal.PlainDateTime.from(value.replace(' ', 'T')).year >= 1000;
    } catch {
      return false;
    }
  });
const integer = scalar(
  z
    .union([
      z.number().int().refine(Number.isSafeInteger),
      z.string().regex(/^\d+$/).transform(Number),
    ])
    .pipe(z.number().int().min(0).max(2147483647)),
);
const projection = z.object({
  id: scalar(giftCardBatchId),
  size: integer,
  message: scalar(z.string().max(255).nullable()),
  completed: boolean,
  printed: boolean,
  blocked: boolean,
  createdById: scalar(giftCardBatchId),
  firstName: scalar(z.string().max(150).nullable()),
  lastName: scalar(z.string().max(150).nullable()),
  createdAt: scalar(wall),
});
export function giftCardBatchPageStart(start: number, length: number, total: bigint) {
  // Django's Paginator rejects nonintegral, negative and out-of-range page numbers.
  return start < 0 || start % length !== 0 || BigInt(start) >= total ? 0 : start;
}
export function giftCardBatchReadScope(
  timeZone: string,
  input: GiftCardBatchSearchInput,
  now: Temporal.Instant,
) {
  const today = now.toZonedDateTimeISO(timeZone).toPlainDate().toString();
  const fromTime = input.from ? input.from + ' 00:00:00' : null;
  const toTime =
    input.to && input.to !== '9999-12-31'
      ? Temporal.PlainDate.from(input.to).add({ days: 1 }).toString() + ' 00:00:00'
      : null;
  return {
    today,
    fromTime,
    toTime,
    reader:
      input.from === today && input.to === today ? ('data-reader' as const) : ('bigquery' as const),
  };
}
export function giftCardBatchPattern(search: string) {
  return '%' + search.replace(/[\\%_]/g, (value) => '\\' + value) + '%';
}

/** Historical view/UDF publication is an explicit release contract, not a MySQL fallback. */
export function historicalGiftCardBatchQuery(
  view: string,
  udf: string | undefined,
  input: GiftCardBatchSearchInput,
) {
  const columns = {
    id: 'CAST(id AS BIGNUMERIC)',
    size: 'size',
    message: 'message_sort_key',
    createdBy: 'CAST(created_by AS BIGNUMERIC)',
    createdAt: 'created_at',
  };
  const order =
    columns[input.sort] +
    (input.direction === 'asc' ? ' ASC' : ' DESC') +
    (input.sort === 'id' ? '' : ',CAST(id AS BIGNUMERIC) ASC');
  const match = input.search
    ? '(' +
      ['id_mysql', 'size_mysql', 'message']
        .map((field) => `\`${udf}\`(${field},@pattern,'${field}.icontains')`)
        .join(' OR ') +
      ')'
    : 'TRUE';
  return `WITH filtered AS (
 SELECT id,size,message,is_completed,is_printed,is_block,created_by,actor_first_name,actor_last_name,created_at,created_at_mysql,message_sort_key
 FROM \`${view}\` WHERE (@fromTime IS NULL OR created_at>=@fromTime) AND (@toTime IS NULL OR created_at<@toTime) AND ${match}
 ), counted AS (SELECT COUNT(*) AS total FROM filtered),
 paging AS (SELECT total,IF(@start<0 OR MOD(@start,@length)<>0 OR @start>=total,0,@start) AS actual_start FROM counted),
 numbered AS (SELECT *,ROW_NUMBER() OVER(ORDER BY ${order}) AS row_number FROM filtered)
 SELECT CAST(p.total AS STRING) AS total,CAST(p.actual_start AS STRING) AS actual_start,
 IFNULL(ARRAY_AGG(IF(n.row_number IS NULL,NULL,STRUCT(CAST(n.id AS STRING) AS id,CAST(n.size AS STRING) AS size,n.message AS message,
 n.is_completed AS completed,n.is_printed AS printed,n.is_block AS blocked,CAST(n.created_by AS STRING) AS createdById,
 n.actor_first_name AS firstName,n.actor_last_name AS lastName,n.created_at_mysql AS createdAt)) IGNORE NULLS ORDER BY n.row_number),[]) AS data
 FROM paging p LEFT JOIN numbered n ON n.row_number>p.actual_start AND n.row_number<=p.actual_start+@length GROUP BY p.total,p.actual_start`;
}
export function giftCardBatchHistory(
  service: GiftCardBatchService,
  warehouse: Warehouse = warehouseService(service.repository.config),
) {
  const { repository, options } = service;
  async function authorize(user: Principal) {
    await repository.db.get('writer').transaction((tx) => repository.actor(tx, user.id));
  }
  return {
    async search(user: Principal, raw: GiftCardBatchSearchInput) {
      const input = giftCardBatchSearchInput.parse(raw);
      await authorize(user);
      if (input.viewOperationId) await service.recordView(user, input.viewOperationId);
      const scope = giftCardBatchReadScope(
        repository.config.BUSINESS_TIMEZONE,
        input,
        repository.instant(),
      );
      let total: string, start: number, rows: z.infer<typeof projection>[];
      if (scope.reader === 'data-reader') {
        const columns = {
          id: batches.id,
          size: batches.size,
          message: batches.message,
          createdBy: batches.createdBy,
          createdAt: batches.createdAt,
        };
        const pattern = giftCardBatchPattern(input.search);
        const condition = and(
          gte(batches.createdAt, scope.fromTime!),
          scope.toTime ? lt(batches.createdAt, scope.toTime) : undefined,
          input.search
            ? or(
                like(sql`CAST(${batches.id} AS CHAR)`, pattern),
                like(sql`CAST(${batches.size} AS CHAR)`, pattern),
                like(batches.message, pattern),
              )
            : undefined,
        );
        const result = await repository.db.get('data').transaction(
          async (tx) => {
            const [tally] = await tx
              .select({ total: sql<string>`CAST(COUNT(*) AS CHAR)` })
              .from(batches)
              .where(condition);
            const checked = count.safeParse(tally?.total);
            if (!checked.success) throw invalid();
            const offset = giftCardBatchPageStart(input.start, input.length, BigInt(checked.data));
            const data =
              checked.data === '0'
                ? []
                : await tx
                    .select({
                      id: sql<string>`CAST(${batches.id} AS CHAR)`,
                      size: batches.size,
                      message: batches.message,
                      completed: batches.completed,
                      printed: batches.printed,
                      blocked: batches.blocked,
                      createdById: sql<string>`CAST(${batches.createdBy} AS CHAR)`,
                      firstName: PosUser.first_name,
                      lastName: PosUser.last_name,
                      createdAt: batches.createdAt,
                    })
                    .from(batches)
                    .leftJoin(PosUser, eq(PosUser.id, batches.createdBy))
                    .where(condition)
                    .orderBy(
                      input.direction === 'asc'
                        ? asc(columns[input.sort])
                        : desc(columns[input.sort]),
                      ...(input.sort === 'id' ? [] : [asc(batches.id)]),
                    )
                    .limit(input.length)
                    .offset(offset);
            return { total: checked.data, start: offset, data };
          },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        );
        total = result.total;
        start = result.start;
        const checked = z.array(projection).safeParse(result.data);
        if (!checked.success) throw invalid();
        rows = checked.data;
      } else {
        if (
          !options.BQ_GIFT_CARD_BATCH_VIEW ||
          !options.BQ_GIFT_CARD_BATCH_CONTRACT ||
          !options.BQ_GIFT_CARD_BATCH_MATCH_UDF
        )
          throw missing();
        const values = await warehouse.queryReport(
          historicalGiftCardBatchQuery(
            options.BQ_GIFT_CARD_BATCH_VIEW,
            options.BQ_GIFT_CARD_BATCH_MATCH_UDF,
            input,
          ),
          {
            fromTime: scope.fromTime,
            toTime: scope.toTime,
            start: input.start,
            length: input.length,
            pattern: giftCardBatchPattern(input.search),
          },
          {
            fromTime: 'DATETIME',
            toTime: 'DATETIME',
            start: 'INT64',
            length: 'INT64',
            pattern: 'STRING',
          },
          'gift-card-batch-history',
        );
        const checked = z
          .array(
            z.object({
              total: scalar(count),
              actual_start: scalar(
                z
                  .string()
                  .regex(/^(?:0|[1-9]\d*)$/)
                  .refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)),
              ),
              data: z.array(projection).max(input.length),
            }),
          )
          .length(1)
          .safeParse(values);
        if (!checked.success) throw invalid();
        const page = checked.data[0]!;
        total = page.total;
        start = Number(page.actual_start);
        rows = page.data;
        if (
          start !== giftCardBatchPageStart(input.start, input.length, BigInt(total)) ||
          new Set(rows.map((row) => row.id)).size !== rows.length ||
          rows.length !==
            Number(
              BigInt(total) - BigInt(start) < BigInt(input.length)
                ? BigInt(total) - BigInt(start)
                : BigInt(input.length),
            )
        )
          throw invalid();
        if (
          input.sort === 'id' &&
          rows.some(
            (row, index) =>
              index > 0 &&
              (input.direction === 'asc'
                ? BigInt(row.id) <= BigInt(rows[index - 1]!.id)
                : BigInt(row.id) >= BigInt(rows[index - 1]!.id)),
          )
        )
          throw invalid();
        if (
          rows.some(
            (row) =>
              (scope.fromTime && row.createdAt < scope.fromTime) ||
              (scope.toTime && row.createdAt >= scope.toTime),
          )
        )
          throw invalid();
      }
      return {
        reader: scope.reader,
        today: scope.today,
        recordsTotal: total,
        recordsFiltered: total,
        start,
        length: input.length,
        data: rows.map(({ firstName, lastName, ...row }) => ({
          ...row,
          createdByName:
            firstName === null && lastName === null
              ? ''
              : sourceAdministrationFullName(firstName || '', lastName || ''),
        })),
      };
    },
  };
}
