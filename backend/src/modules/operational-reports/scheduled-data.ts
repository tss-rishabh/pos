import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gt, gte, inArray, lt, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  HyperlocalFdLog,
  HyperlocalOrderLog,
  HyperlocalToOnlineOrderLog,
  Order,
  PosHyperlocalSlot,
  Store,
} from '../../db/legacy-schema.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import { warehouseService } from '../warehouse.js';
import { timestampReportBounds, scalarId } from './report-inputs.js';
import { scheduledCrmLog } from './scheduled-source-schema.js';
import type { ScheduledReportOptions } from './scheduled-options.js';
import {
  availabilityMessages,
  cancellationMessages,
  crmAge,
  crmMessages,
  delayMessages,
  nextStoreIds,
  performanceMessages,
  storeStatusMessages,
  summaryMessages,
  weekday,
  type CrmFact,
  type ScheduleInput,
  type ScheduledArtifact,
  type SlotFact,
  type StoreFact,
} from './scheduled-domain.js';
const timestamp = z.string().transform((value) => value.replace('T', ' ').slice(0, 19));
const flag = z
  .union([z.boolean(), z.number().int(), z.bigint(), z.string().regex(/^-?\d+$/)])
  .nullable()
  .transform((value) =>
    typeof value === 'boolean' ? value : value !== null && BigInt(value) !== 0n,
  );
const oneFlag = z
  .union([z.boolean(), z.number().int(), z.bigint(), z.string().regex(/^-?\d+$/)])
  .nullable()
  .transform((value) => value === true || value === 1 || value === 1n || value === '1');
const timing = z.object({
  orderId: scalarId,
  createdAt: timestamp,
  storeId: scalarId.nullable(),
  storeName: z.string().nullable(),
  acceptedAt: timestamp,
});
const summary = z.object({
  orderId: scalarId,
  storeId: scalarId,
  action: z.string(),
  isTransfer: flag,
  mainStoreId: scalarId.nullable(),
  nextLocationIds: z.string().nullable(),
});
const availability = z
  .object({
    orderId: scalarId,
    cartType: z.string(),
    stockThreshold: z.string(),
    storeAvailability: z.string(),
    slotVisible: z
      .union([z.boolean(), z.number().int(), z.bigint(), z.string().regex(/^-?\d+$/)])
      .nullable(),
    isApp: flag,
  })
  .transform((row) => ({
    ...row,
    slotVisible: oneFlag.parse(row.slotVisible),
    slotGroup:
      row.slotVisible === null
        ? 'NULL'
        : typeof row.slotVisible === 'boolean'
          ? String(Number(row.slotVisible))
          : String(row.slotVisible),
  }));
const platform = z.object({ orderId: scalarId, isApp: flag });
const delays = z.object({ orderId: scalarId, totalDelay: z.string() });
const cancellation = z.object({
  storeName: z.string().nullable(),
  orderId: scalarId,
  reason: z.string().nullable(),
  comment: z.string().nullable(),
  convertedAt: timestamp,
});
const ticket = z.object({
  orderId: scalarId.nullable(),
  ticketId: z.string().regex(/^\d+$/).max(55),
  createdAt: timestamp,
});
interface Period {
  from: string;
  end: string;
  windowStart: string;
}
type ReadKind =
  'timing' | 'summary' | 'availability' | 'platform' | 'delays' | 'cancellations' | 'tickets';
const mysqlQueries: Record<ReadKind, string> = {
  timing: `SELECT CAST(o.id AS CHAR) AS orderId,ANY_VALUE(o.created_at) AS createdAt,CAST(ANY_VALUE(s.id) AS CHAR) AS storeId,ANY_VALUE(s.store_name) AS storeName,ANY_VALUE(hol.updated_at) AS acceptedAt FROM hyperlocal_order_log hol LEFT JOIN orders o ON o.id=hol.order_id LEFT JOIN stores s ON s.id=o.location_id WHERE hol.action='ACCEPTED' AND hol.updated_at>={{from}} AND hol.updated_at<{{end}} GROUP BY o.id`,
  summary: `SELECT orderId,storeId,action,isTransfer,mainStoreId,nextLocationIds FROM (SELECT CAST(o.id AS CHAR) AS orderId,CAST(o.location_id AS CHAR) AS storeId,hol.action AS action,o.is_transfer AS isTransfer,CAST(hol.main_location_id AS CHAR) AS mainStoreId,o.next_location_ids AS nextLocationIds,ROW_NUMBER() OVER(PARTITION BY o.id ORDER BY hol.id) AS position FROM orders o JOIN hyperlocal_order_log hol ON hol.order_id=o.id WHERE o.location_id>0 AND o.location_type IN ('SW','NW') AND o.order_status NOT IN (0,17) AND o.created_at>={{windowStart}} AND o.created_at<{{end}} AND hol.updated_at>={{from}} AND hol.updated_at<{{end}}) AS first_logs WHERE position=1 ORDER BY orderId`,
  availability: `SELECT CAST(hal.order_id AS CHAR) AS orderId,hal.cart_type AS cartType,hal.stock_threshold AS stockThreshold,hal.store_availability AS storeAvailability,hal.is_slot_visible AS slotVisible,EXISTS(SELECT 1 FROM flag_history f WHERE f.order_id=o.id AND f.flag_id=18) AS isApp FROM hyperlocal_availability_log hal JOIN orders o ON o.id=hal.order_id WHERE hal.created_at>={{from}} AND hal.created_at<{{end}} AND o.order_status<>0 ORDER BY hal.id`,
  platform: `SELECT CAST(o.id AS CHAR) AS orderId,EXISTS(SELECT 1 FROM flag_history f WHERE f.order_id=o.id AND f.flag_id=18) AS isApp FROM orders o WHERE o.location_id>0 AND o.location_type IN ('SW','NW') AND o.order_status NOT IN (0,17) AND o.created_at>={{from}} AND o.created_at<{{end}} ORDER BY o.id`,
  delays: `SELECT CAST(o.id AS CHAR) AS orderId,ANY_VALUE(CAST(TIMEDIFF(c.created_at,o.end_timeslot) AS CHAR)) AS totalDelay FROM orders o LEFT JOIN comments c ON c.order_id=o.id WHERE c.hl_status='finished' AND c.created_at>o.end_timeslot AND o.created_at>={{from}} AND o.created_at<{{end}} GROUP BY o.id`,
  cancellations: `SELECT s.store_name AS storeName,CAST(hlol.order_id AS CHAR) AS orderId,hlol.reason AS reason,hlol.remark AS comment,hlol.created_at AS convertedAt FROM hyperlocal_to_online_order_logs hlol LEFT JOIN stores s ON s.id=hlol.location_id WHERE hlol.created_at>={{from}} AND hlol.created_at<{{end}} AND hlol.platform='CONVERT_ONLINE' ORDER BY hlol.id`,
  tickets: `SELECT CAST(order_id AS CHAR) AS orderId,fd_ticket_id AS ticketId,created_at AS createdAt FROM hyperlocal_fd_logs WHERE created_at>={{from}} AND created_at<{{end}} AND ({{includeCompleted}} OR fd_ticket_status NOT IN ('CLOSED')) ORDER BY id`,
};
/** Static source-compatible SQL for DATA and isolated source-projection oracles. */
export function scheduledSourceQuery(
  kind: ReadKind,
  period: Period,
  includeCompleted: boolean,
): SQL {
  const params = { ...period, includeCompleted };
  return sql.join(
    mysqlQueries[kind]
      .split(/(\{\{(?:from|end|windowStart|includeCompleted)\}\})/g)
      .map((part) =>
        part.startsWith('{{')
          ? sql`${params[part.slice(2, -2) as keyof typeof params]}`
          : sql.raw(part),
      ),
    sql``,
  );
}
type ScheduledReader = ReturnType<Databases['get']>;
const scheduledRowLimit = 70001;
/**
 * DATA-reader rows for the scheduled reports, built with Drizzle. Each statement is the
 * builder form of {@link scheduledSourceQuery} for the same kind plus `LIMIT 70001`, returning
 * the same column names and raw driver values (CASTs stay CASTs; plain columns are string,
 * enum or tinyint columns whose decoders return the driver value unchanged).
 */
export async function scheduledMysqlRows(
  reader: ScheduledReader,
  kind: ReadKind,
  period: Period,
  includeCompleted: boolean,
): Promise<unknown[]> {
  if (kind === 'timing')
    return reader
      .select({
        orderId: sql<string | null>`CAST(${Order.id} AS CHAR)`,
        createdAt: sql<string | null>`ANY_VALUE(${Order.created_at})`,
        storeId: sql<string | null>`CAST(ANY_VALUE(${Store.id}) AS CHAR)`,
        storeName: sql<string | null>`ANY_VALUE(${Store.store_name})`,
        acceptedAt: sql<string>`ANY_VALUE(${HyperlocalOrderLog.updated_at})`,
      })
      .from(HyperlocalOrderLog)
      .leftJoin(Order, eq(Order.id, HyperlocalOrderLog.order_id))
      .leftJoin(Store, eq(Store.id, Order.location_id))
      .where(
        and(
          eq(HyperlocalOrderLog.action, 'ACCEPTED'),
          gte(HyperlocalOrderLog.updated_at, period.from),
          lt(HyperlocalOrderLog.updated_at, period.end),
        ),
      )
      .groupBy(Order.id)
      .limit(scheduledRowLimit);
  if (kind === 'summary') {
    const firstLogs = reader
      .select({
        orderId: sql<string>`CAST(${Order.id} AS CHAR)`.as('orderId'),
        storeId: sql<string>`CAST(${Order.location_id} AS CHAR)`.as('storeId'),
        action: HyperlocalOrderLog.action,
        isTransfer: Order.is_transfer,
        mainStoreId: sql<string | null>`CAST(${HyperlocalOrderLog.main_location_id} AS CHAR)`.as(
          'mainStoreId',
        ),
        nextLocationIds: Order.next_location_ids,
        position:
          sql<number>`ROW_NUMBER() OVER(PARTITION BY ${Order.id} ORDER BY ${HyperlocalOrderLog.id})`.as(
            'position',
          ),
      })
      .from(Order)
      .innerJoin(HyperlocalOrderLog, eq(HyperlocalOrderLog.order_id, Order.id))
      .where(
        and(
          gt(Order.location_id, 0),
          inArray(Order.location_type, ['SW', 'NW']),
          notInArray(Order.order_statuses, [0n, 17n]),
          gte(Order.created_at, period.windowStart),
          lt(Order.created_at, period.end),
          gte(HyperlocalOrderLog.updated_at, period.from),
          lt(HyperlocalOrderLog.updated_at, period.end),
        ),
      )
      .as('first_logs');
    return reader
      .select({
        orderId: firstLogs.orderId,
        storeId: firstLogs.storeId,
        action: firstLogs.action,
        isTransfer: firstLogs.isTransfer,
        mainStoreId: firstLogs.mainStoreId,
        nextLocationIds: firstLogs.nextLocationIds,
      })
      .from(firstLogs)
      .where(eq(firstLogs.position, 1))
      .orderBy(asc(firstLogs.orderId))
      .limit(scheduledRowLimit);
  }
  if (kind === 'cancellations')
    return reader
      .select({
        storeName: Store.store_name,
        orderId: sql<string>`CAST(${HyperlocalToOnlineOrderLog.order_id} AS CHAR)`,
        reason: HyperlocalToOnlineOrderLog.reason,
        comment: HyperlocalToOnlineOrderLog.remark,
        convertedAt: HyperlocalToOnlineOrderLog.created_at,
      })
      .from(HyperlocalToOnlineOrderLog)
      .leftJoin(Store, eq(Store.id, HyperlocalToOnlineOrderLog.location_id))
      .where(
        and(
          gte(HyperlocalToOnlineOrderLog.created_at, period.from),
          lt(HyperlocalToOnlineOrderLog.created_at, period.end),
          eq(HyperlocalToOnlineOrderLog.platform, 'CONVERT_ONLINE'),
        ),
      )
      .orderBy(asc(HyperlocalToOnlineOrderLog.id))
      .limit(scheduledRowLimit);
  if (kind === 'tickets')
    return reader
      .select({
        orderId: sql<string | null>`CAST(${HyperlocalFdLog.order_id} AS CHAR)`,
        ticketId: HyperlocalFdLog.fd_ticket_id,
        createdAt: HyperlocalFdLog.created_at,
      })
      .from(HyperlocalFdLog)
      .where(
        and(
          gte(HyperlocalFdLog.created_at, period.from),
          lt(HyperlocalFdLog.created_at, period.end),
          includeCompleted ? undefined : notInArray(HyperlocalFdLog.fd_ticket_status, ['CLOSED']),
        ),
      )
      .orderBy(asc(HyperlocalFdLog.id))
      .limit(scheduledRowLimit);
  // W11 exception: delays/availability/platform read `comments.hl_status`, `flag_history` and
  // `hyperlocal_availability_log`, which have no definition in legacy-schema.ts yet.
  const rows = await reader.execute(
    sql`${scheduledSourceQuery(kind, period, includeCompleted)} LIMIT ${scheduledRowLimit}`,
  );
  return z.array(z.unknown()).parse(rows[0]);
}
function table(value: string | undefined) {
  if (!value) return unavailable('BigQuery scheduled-report compatible view');
  return '`' + value + '`';
}
function warehouseQuery(kind: ReadKind, options: ScheduledReportOptions) {
  if (kind === 'timing')
    return `SELECT CAST(o.order_id AS STRING) AS orderId,ANY_VALUE(o.created_at) AS createdAt,CAST(ANY_VALUE(o.store_id) AS STRING) AS storeId,ANY_VALUE(o.store_name) AS storeName,ANY_VALUE(hol.updated_at) AS acceptedAt FROM ${table(options.BQ_HYPERLOCAL_ORDER_LOGS_VIEW)} hol LEFT JOIN ${table(options.BQ_HYPERLOCAL_ORDER_FACTS_VIEW)} o ON o.order_id=hol.order_id WHERE hol.action='ACCEPTED' AND hol.updated_at>=@from AND hol.updated_at<@end GROUP BY o.order_id`;
  if (kind === 'summary')
    return `SELECT orderId,storeId,action,isTransfer,mainStoreId,nextLocationIds FROM (SELECT CAST(o.order_id AS STRING) AS orderId,CAST(o.store_id AS STRING) AS storeId,hol.action AS action,o.is_transfer AS isTransfer,CAST(hol.main_location_id AS STRING) AS mainStoreId,o.next_location_ids AS nextLocationIds,ROW_NUMBER() OVER(PARTITION BY o.order_id ORDER BY hol.log_id) AS position FROM ${table(options.BQ_HYPERLOCAL_ORDER_FACTS_VIEW)} o JOIN ${table(options.BQ_HYPERLOCAL_ORDER_LOGS_VIEW)} hol ON hol.order_id=o.order_id WHERE o.store_id>0 AND o.location_type IN ('SW','NW') AND o.order_status NOT IN (0,17) AND o.created_at>=@windowStart AND o.created_at<@end AND hol.updated_at>=@from AND hol.updated_at<@end) AS first_logs WHERE position=1 ORDER BY orderId`;
  if (kind === 'availability')
    return `SELECT CAST(order_id AS STRING) AS orderId,cart_type AS cartType,stock_threshold AS stockThreshold,store_availability AS storeAvailability,is_slot_visible AS slotVisible,is_app AS isApp FROM ${table(options.BQ_HYPERLOCAL_AVAILABILITY_VIEW)} WHERE log_created_at>=@from AND log_created_at<@end AND order_status<>0 ORDER BY log_id`;
  if (kind === 'platform')
    return `SELECT CAST(order_id AS STRING) AS orderId,is_app AS isApp FROM ${table(options.BQ_HYPERLOCAL_ORDER_FACTS_VIEW)} WHERE store_id>0 AND location_type IN ('SW','NW') AND order_status NOT IN (0,17) AND created_at>=@from AND created_at<@end ORDER BY order_id`;
  if (kind === 'delays')
    return `SELECT CAST(order_id AS STRING) AS orderId,ANY_VALUE(total_delay) AS totalDelay FROM ${table(options.BQ_HYPERLOCAL_DELIVERY_ISSUES_VIEW)} WHERE hl_status='finished' AND delivered_at>end_timeslot AND order_created_at>=@from AND order_created_at<@end GROUP BY order_id`;
  if (kind === 'cancellations')
    return `SELECT store_name AS storeName,CAST(order_id AS STRING) AS orderId,reason,remark AS comment,created_at AS convertedAt FROM ${table(options.BQ_HYPERLOCAL_CANCELLATIONS_VIEW)} WHERE created_at>=@from AND created_at<@end AND platform='CONVERT_ONLINE' ORDER BY log_id`;
  return `SELECT CAST(order_id AS STRING) AS orderId,fd_ticket_id AS ticketId,created_at AS createdAt FROM ${table(options.BQ_HYPERLOCAL_CRM_TICKETS_VIEW)} WHERE created_at>=@from AND created_at<@end AND (@includeCompleted OR fd_ticket_status NOT IN ('CLOSED')) ORDER BY log_id`;
}
export interface FreshdeskTicket {
  status: string;
  createdAt: string;
}
export type FreshdeskReader = (ticketId: string, signal: AbortSignal) => Promise<FreshdeskTicket>;
export function freshdeskReader(config: Config, options: ScheduledReportOptions): FreshdeskReader {
  return async (ticketId, signal) => {
    if (
      config.DEMO_MODE ||
      !options.FRESHDESK_TICKET_URL ||
      !options.FRESHDESK_BASIC_AUTH_USERNAME ||
      !options.FRESHDESK_BASIC_AUTH_PASSWORD
    )
      return unavailable('Freshdesk ticket credentials');
    try {
      const base = options.FRESHDESK_TICKET_URL.replace(/\/$/, ''),
        response = await fetch(base + '/' + encodeURIComponent(ticketId), {
          headers: {
            Authorization:
              'Basic ' +
              Buffer.from(
                options.FRESHDESK_BASIC_AUTH_USERNAME + ':' + options.FRESHDESK_BASIC_AUTH_PASSWORD,
              ).toString('base64'),
            Accept: 'application/json',
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          redirect: 'error',
        });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('CRM lookup failed');
      }
      const value = z
          .object({
            status: z.number().int(),
            created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
          })
          .parse(await boundedJson(response)),
        status =
          (
            { 0: 'NEW', 2: 'OPEN', 3: 'PENDING', 4: 'RESOLVED', 5: 'CLOSED' } as Record<
              number,
              string
            >
          )[value.status] || 'UNKNOWN';
      Temporal.Instant.from(value.created_at);
      return { status, createdAt: value.created_at };
    } catch {
      throw new AppError(502, 'CRM_LOOKUP_FAILED', 'The CRM ticket status could not be retrieved.');
    }
  };
}
export function scheduledReportBuilder(
  config: Config,
  db: Databases,
  options: ScheduledReportOptions,
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  crm: FreshdeskReader = freshdeskReader(config, options),
  clock = () => Temporal.Now.instant(),
  metadataReader?: () => Promise<{ stores: StoreFact[]; slots: SlotFact[] }>,
) {
  async function loadMetadata() {
    const primary = db.get('primary'),
      [stores, slots] = await Promise.all([
        primary
          .select({ id: Store.id, name: Store.store_name, type: Store.type })
          .from(Store)
          .orderBy(asc(Store.id)),
        primary
          .select({
            id: PosHyperlocalSlot.id,
            storeId: PosHyperlocalSlot.store_id,
            weekday: PosHyperlocalSlot.weekday,
            available: PosHyperlocalSlot.is_avail,
            start: PosHyperlocalSlot.start_timeslot,
            end: PosHyperlocalSlot.end_timeslot,
          })
          .from(PosHyperlocalSlot)
          .orderBy(asc(PosHyperlocalSlot.id)),
      ]);
    return {
      stores: z
        .array(z.object({ id: scalarId, name: z.string(), type: z.string() }))
        .parse(stores) as StoreFact[],
      slots: z
        .array(
          z.object({
            id: scalarId,
            storeId: scalarId,
            weekday,
            available: flag,
            start: z.string(),
            end: z.string(),
          }),
        )
        .parse(slots) as SlotFact[],
    };
  }
  const metadata = metadataReader || loadMetadata;
  return async (input: ScheduleInput & { date: string }): Promise<ScheduledArtifact> => {
    const now = clock(),
      day = Temporal.PlainDate.from(input.date),
      from = input.kind === 'crm-tickets' ? day.subtract({ days: input.previousDays - 1 }) : day,
      period = {
        from: from.toString() + ' 00:00:00',
        end: day.add({ days: 1 }).toString() + ' 00:00:00',
        windowStart: day.subtract({ days: 1 }).toString() + ' 00:00:00',
      },
      bounds = timestampReportBounds(
        config,
        from.toString() + 'T00:00:00',
        day.toString() + 'T23:59:59',
        now,
      );
    const read = async (kind: ReadKind) => {
      // Timing includes an unbounded original Order.created_at. Summary reads
      // orders from the preceding day as well as today's requested log window.
      const reader =
        kind === 'timing'
          ? 'bigquery'
          : kind === 'summary'
            ? timestampReportBounds(
                config,
                period.windowStart.replace(' ', 'T'),
                day.toString() + 'T23:59:59',
                now,
              ).reader
            : bounds.reader;
      if (reader === 'bigquery')
        return warehouse.queryReport(
          warehouseQuery(kind, options) + ' LIMIT 70001',
          { ...period, includeCompleted: input.includeCompleted },
          { from: 'DATETIME', end: 'DATETIME', windowStart: 'DATETIME', includeCompleted: 'BOOL' },
          input.kind,
        );
      const rows = await scheduledMysqlRows(db.get('data'), kind, period, input.includeCompleted);
      return z.array(z.record(z.string(), z.unknown())).parse(rows);
    };
    const parsed = async <T>(kind: ReadKind, schema: z.ZodType<T>) => {
      const rows = await read(kind);
      if (rows.length > 70000)
        throw new AppError(
          422,
          'REPORT_TOO_LARGE',
          'The scheduled report contains too many records.',
        );
      const result = z.array(schema).safeParse(rows);
      if (!result.success)
        throw new AppError(
          503,
          'REPORT_VIEW_INVALID',
          'The scheduled-report values do not match the data contract.',
        );
      return result.data;
    };
    try {
      if (input.kind === 'hyperlocal-store-status') {
        const facts = await metadata();
        return storeStatusMessages(input.date, facts.stores, facts.slots);
      }
      if (input.kind === 'hyperlocal-performance') {
        const [rows, facts] = await Promise.all([parsed('timing', timing), metadata()]);
        return performanceMessages(input.date, rows, facts.slots);
      }
      if (input.kind === 'hyperlocal-summary') {
        const [rows, facts] = await Promise.all([parsed('summary', summary), metadata()]);
        return summaryMessages(
          input.date,
          rows.map((row) => ({
            ...row,
            nextStoreIds: row.isTransfer ? nextStoreIds(row.nextLocationIds) : [],
          })),
          facts.stores,
          facts.slots,
        );
      }
      if (input.kind === 'hyperlocal-availability') {
        const [rows, orders] = await Promise.all([
          parsed('availability', availability),
          parsed('platform', platform),
        ]);
        return availabilityMessages(input.date, rows, orders);
      }
      if (input.kind === 'hyperlocal-delivery-delays')
        return delayMessages(input.date, await parsed('delays', delays));
      if (input.kind === 'hyperlocal-cancellations')
        return cancellationMessages(input.date, await parsed('cancellations', cancellation));
      const candidates = await parsed('tickets', ticket);
      if (candidates.length > options.SCHEDULED_REPORT_MAX_CRM_TICKETS)
        throw new AppError(
          422,
          'CRM_REPORT_TOO_LARGE',
          'Choose fewer previous days for CRM refresh.',
        );
      const ids = [...new Set(candidates.map((row) => row.ticketId))],
        writer = db.get('writer'),
        current = ids.length
          ? await writer
              .select({
                id: scheduledCrmLog.id,
                orderId: scheduledCrmLog.orderId,
                ticketId: scheduledCrmLog.ticketId,
                createdAt: scheduledCrmLog.createdAt,
              })
              .from(scheduledCrmLog)
              .where(
                and(
                  inArray(scheduledCrmLog.ticketId, ids),
                  gte(scheduledCrmLog.createdAt, period.from),
                  lt(scheduledCrmLog.createdAt, period.end),
                  input.includeCompleted ? undefined : ne(scheduledCrmLog.status, 'CLOSED'),
                ),
              )
              .orderBy(asc(scheduledCrmLog.id))
          : [],
        verified = candidates.filter((row) =>
          current.some(
            (record) =>
              record.ticketId === row.ticketId &&
              (record.orderId === null
                ? row.orderId === null
                : String(record.orderId) === row.orderId),
          ),
        ),
        ticketIds = [...new Set(verified.map((row) => row.ticketId))],
        results = new Map<string, FreshdeskTicket>(),
        deadline = AbortSignal.timeout(55000);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, ticketIds.length) }, async () => {
          while (next < ticketIds.length) {
            const id = ticketIds[next++]!;
            results.set(id, await crm(id, deadline));
          }
        }),
      );
      // fd_ticket_status is an ENUM without 'NEW'; only members can be written.
      const ticketStatus = (status: string) =>
        scheduledCrmLog.status.enumValues.find((value) => value === status);
      for (const result of results.values())
        if (ticketStatus(result.status) === undefined)
          throw new AppError(
            503,
            'CRM_STATUS_UNSUPPORTED',
            'The CRM status is unsupported by the current source schema.',
          );
      const facts: CrmFact[] = await writer.transaction(async (tx) => {
        if (!ticketIds.length) return [];
        const locked = await tx
          .select({
            ticketId: scheduledCrmLog.ticketId,
            orderId: scheduledCrmLog.orderId,
            status: scheduledCrmLog.status,
            createdAt: scheduledCrmLog.createdAt,
          })
          .from(scheduledCrmLog)
          .where(inArray(scheduledCrmLog.ticketId, ticketIds))
          .for('update');
        const authoritative = new Set(
            locked
              .filter(
                (row) =>
                  row.createdAt !== null &&
                  row.createdAt >= period.from &&
                  row.createdAt < period.end &&
                  (input.includeCompleted || (row.status !== null && row.status !== 'CLOSED')),
              )
              .map((row) =>
                JSON.stringify([row.ticketId, row.orderId === null ? null : String(row.orderId)]),
              ),
          ),
          kept = verified.filter((row) =>
            authoritative.has(JSON.stringify([row.ticketId, row.orderId])),
          ),
          updated = new Set<string>(),
          facts: CrmFact[] = [];
        for (const row of kept) {
          const result = results.get(row.ticketId)!;
          if (!updated.has(row.ticketId)) {
            await tx
              .update(scheduledCrmLog)
              .set({
                status: ticketStatus(result.status),
                age: crmAge(result.createdAt, clock()).milliseconds,
              })
              .where(eq(scheduledCrmLog.ticketId, row.ticketId));
            updated.add(row.ticketId);
          }
          facts.push({
            orderId: row.orderId,
            ticketId: row.ticketId,
            status: result.status,
            createdAt: result.createdAt,
          });
        }
        return facts;
      });
      return crmMessages(
        input.date,
        input.previousDays,
        input.sendToSlack,
        input.includeCompleted,
        facts,
        clock(),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        503,
        'SCHEDULED_REPORT_QUERY_FAILED',
        'The scheduled report could not be prepared.',
      );
    }
  };
}
