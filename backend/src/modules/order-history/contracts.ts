import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { AppError } from '../../domain/errors.js';
import type { OrderDto, Page } from '../../domain/contracts.js';
import type { StoreOrderLegacyContext, StoreOrderLine } from './store-detail.js';
export const orderHistoryContract = 'pos-public-order-history-v1';
const positivePattern = /^[1-9]\d{0,18}$/;
const nonnegativePattern = /^(0|[1-9]\d{0,18})$/;
export const positiveId = z
  .string()
  .regex(positivePattern)
  .refine((value) => positivePattern.test(value) && BigInt(value) <= 9223372036854775807n);
export const nonnegativeId = z
  .string()
  .regex(nonnegativePattern)
  .refine((value) => nonnegativePattern.test(value) && BigInt(value) <= 9223372036854775807n);
export const count = nonnegativeId;
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceDate = z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?$/);
export const date = z.iso.date();
export const orderReadSelection = z
  .object({
    from: date.optional(),
    to: date.optional(),
    intent: z.enum(['interactive', 'report']).default('interactive'),
  })
  .strict()
  .refine((value) => Boolean(value.from) === Boolean(value.to), 'Supply both date boundaries.');
export type OrderReadSelection = z.input<typeof orderReadSelection>;
export const orderListQuery = z
  .object({
    from: date.optional(),
    to: date.optional(),
    intent: z.enum(['interactive', 'report']).default('interactive'),
    before: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict()
  .refine((value) => Boolean(value.from) === Boolean(value.to), 'Supply both date boundaries.');
export interface OrderReadRange {
  from: string;
  to: string;
  start: string;
  end: string;
  cutoff: string;
  timeZone: string;
  reader: 'primary' | 'data' | 'bigquery';
  explicit: boolean;
  intent: 'interactive' | 'report';
}
export function orderRange(
  raw: OrderReadSelection = {},
  timeZone = 'Asia/Kolkata',
  now = Date.now(),
): OrderReadRange {
  const input = orderReadSelection.parse(raw),
    today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone).toPlainDate();
  const first = Temporal.PlainDate.from(input.from ?? today.toString()),
    last = Temporal.PlainDate.from(input.to ?? today.toString());
  if (
    Temporal.PlainDate.compare(first, last) > 0 ||
    Temporal.PlainDate.compare(last, today) > 0 ||
    first.until(last).days > 61
  )
    throw new AppError(
      400,
      'INVALID_ORDER_DATE_RANGE',
      'Select up to 62 calendar days ending today or earlier.',
    );
  const current = first.equals(today) && last.equals(today);
  return {
    from: first.toString(),
    to: last.toString(),
    start: first.toString() + ' 00:00:00',
    end: last.add({ days: 1 }).toString() + ' 00:00:00',
    cutoff: today.toString() + ' 00:00:00',
    timeZone,
    reader: current ? (input.intent === 'report' ? 'data' : 'primary') : 'bigquery',
    explicit: Boolean(input.from),
    intent: input.intent,
  };
}
export const historyHeader = z
  .object({
    id: positiveId,
    customerId: nonnegativeId,
    reference: z.string().max(255),
    first: z.string().max(255),
    last: z.string().max(255),
    amount: z
      .string()
      .max(100)
      .refine((value) => Number.isFinite(Number(value)) && String(Number(value)) === value),
    status: z.string().max(255).nullable(),
    paymentStatus: z.string().max(255).nullable(),
    paymentStatusId: nonnegativeId.nullable(),
    createdAt: sourceDate,
  })
  .strict();
export const historyStore = z
  .object({ id: positiveId, orderId: positiveId, storeId: positiveId, counterId: nonnegativeId })
  .strict();
export const historyLine = z
  .object({
    id: positiveId,
    orderId: positiveId,
    productId: nonnegativeId,
    name: z.string().max(5000).nullable(),
    quantity: z
      .string()
      .regex(/^-?(0|[1-9]\d{0,18})$/)
      .refine(
        (value) => BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n,
      ),
    amount: z
      .string()
      .max(100)
      .refine((value) => Number.isFinite(Number(value)) && String(Number(value)) === value),
    gst: z
      .string()
      .max(100)
      .refine((value) => Number.isFinite(Number(value)) && String(Number(value)) === value),
    status: z.string().max(255),
  })
  .strict();
export type HistoryHeader = z.infer<typeof historyHeader>;
export type HistoryStore = z.infer<typeof historyStore>;
export type HistoryLine = z.infer<typeof historyLine>;
export const copyHeader = historyHeader.pick({ id: true, customerId: true, createdAt: true });
export const copyLine = historyLine.pick({ id: true, orderId: true, productId: true });
export interface OrderHistoryEvidence {
  generationId: string;
  sourceSnapshotId: string;
  sourceSnapshotAt: string;
  sourceCdcWatermark: string;
  publishedAt: string;
}
export interface OrderReadMetadata {
  reader: 'primary' | 'data' | 'bigquery';
  range: OrderReadRange;
  fetchedAt: string;
  publication?: OrderHistoryEvidence;
}
export type OrderListPage = Page<OrderDto & { rowId?: string }> & Partial<OrderReadMetadata>;
export interface OrderDetail {
  id: string | bigint;
  // orders.order_ref_no is nullable; NULL is serialised as null.
  reference: string | null;
  amount: number;
  createdAt: string;
  status: string | null;
  isPaid: boolean;
  lines: ({
    id: string | bigint;
    productId: string | bigint;
    name: string | null;
    quantity: string | bigint;
    amount: number;
    gst: number;
    // has_products.status is a nullable ENUM in production.
    status: string | null;
  } & Partial<
    Pick<
      StoreOrderLine,
      'erpProduct' | 'productType' | 'parentProductId' | 'giftVoucherId' | 'returnStatus'
    >
  >)[];
  reader?: 'primary' | 'data' | 'bigquery';
  range?: OrderReadRange;
  fetchedAt?: string;
  publication?: OrderHistoryEvidence;
  /** Legacy `ShowOrderDetailsView` context (`store-detail.ts`); absent in demo mode. */
  orderAmount?: number;
  legacy?: StoreOrderLegacyContext;
}
export const copySource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('store'), storeId: positiveId }).strict(),
  z.object({ kind: z.literal('customer'), customerId: positiveId }).strict(),
]);
export type OrderCopySource = z.infer<typeof copySource>;
export interface HistoricalCopyRequest {
  source: OrderCopySource;
  orderId: string;
  cutoff: string;
}
export interface HistoricalCopyFacts {
  orderId: string;
  sourceCustomerId: string;
  createdAt: string;
  source: OrderCopySource;
  reader: 'bigquery';
  fetchedAt: string;
  generationId: string;
  complete: true;
  lines: { lineId: string; productId: string }[];
}
export interface HistoryListInput {
  storeId: string;
  range: OrderReadRange;
  generationId?: string;
  before?: { orderId: string; rowId: string };
  limit: number;
}
export interface HistoryListResult {
  rows: { header: HistoryHeader; store: HistoryStore }[];
  evidence: OrderHistoryEvidence;
}
export interface HistoryOrderInput {
  source: OrderCopySource;
  orderId: string;
  range?: OrderReadRange;
  cutoff?: string;
}
export interface HistoryOrderResult {
  header: HistoryHeader;
  stores: HistoryStore[];
  lines: HistoryLine[];
  evidence: OrderHistoryEvidence;
}
/** Callers capture/recheck writer-current permissions around this read-only port. */
export interface OrderHistoryPort {
  list(input: HistoryListInput): Promise<HistoryListResult>;
  order(input: HistoryOrderInput): Promise<HistoryOrderResult>;
  copyFacts(input: HistoricalCopyRequest): Promise<HistoricalCopyFacts>;
}
