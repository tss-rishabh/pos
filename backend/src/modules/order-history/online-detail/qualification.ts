import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hash, count, type OrderReadRange } from '../contracts.js';
import {
  detailIdentifier as positiveId,
  onlineDetailFact,
  onlineOrderDetailContract,
  type OnlineOrderDetail,
} from './contracts.js';
import { detailInvalid, detailUnavailable } from './errors.js';
import { detailPublicationRequired, type OnlineDetailOptions } from './options.js';
const timestamp = z.iso.datetime({ offset: true });
const publicationSchema = z
  .object({
    contract_version: z.literal(onlineOrderDetailContract),
    generation_id: z.uuid(),
    order_id: positiveId,
    customer_id: positiveId,
    business_date: z.iso.date(),
    business_timezone: z.string().min(1).max(100),
    source_complete: z.literal(true),
    source_snapshot_id: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
    source_snapshot_at: timestamp,
    source_cdc_watermark: timestamp,
    published_at: timestamp,
    source_rows: count,
    warehouse_rows: count,
    source_lines: count,
    warehouse_lines: count,
    source_events: count,
    warehouse_events: count,
    source_express: count,
    warehouse_express: count,
    source_hash: hash,
    warehouse_hash: hash,
  })
  .strict();
const factRow = z
  .object({
    generation_id: z.uuid(),
    order_id: positiveId,
    business_date: z.iso.date(),
    details_json: z.string().max(4000000),
    details_hash: hash,
  })
  .strict();
export interface HistoricalOnlineDetailInput {
  orderId: string;
  customerId: string;
  range?: OrderReadRange;
  cutoff: string;
  timeZone: string;
}
export type HistoricalOnlineDetailResult = {
  fact: z.infer<typeof onlineDetailFact>;
  publication: NonNullable<OnlineOrderDetail['publication']>;
};

export function qualifyDetailPublication(
  raw: unknown,
  input: HistoricalOnlineDetailInput,
  options: OnlineDetailOptions,
  now: number,
) {
  const metadata = publicationSchema.array().max(2).safeParse(raw);
  if (!metadata.success) throw detailInvalid();
  if (!metadata.data.length) throw detailPublicationRequired();
  if (metadata.data.length !== 1) throw detailInvalid();
  const publication = metadata.data[0]!;
  const snapshot = Date.parse(publication.source_snapshot_at),
    watermark = Date.parse(publication.source_cdc_watermark),
    published = Date.parse(publication.published_at);
  if (
    publication.order_id !== input.orderId ||
    publication.customer_id !== input.customerId ||
    publication.business_timezone !== input.timeZone ||
    publication.source_rows !== '1' ||
    publication.warehouse_rows !== '1' ||
    publication.source_lines !== publication.warehouse_lines ||
    publication.source_events !== publication.warehouse_events ||
    publication.source_express !== publication.warehouse_express ||
    BigInt(publication.source_events) > 10000n ||
    BigInt(publication.source_express) > 10000n ||
    BigInt(publication.source_lines) > 10000n ||
    publication.source_hash !== publication.warehouse_hash ||
    snapshot > now + 5000 ||
    watermark > now + 5000 ||
    published > now + 5000 ||
    watermark + 5000 < snapshot ||
    published + 5000 < watermark ||
    now - snapshot > options.ORDER_DETAIL_MAX_LAG_SECONDS * 1000
  )
    throw detailInvalid();

  return publication;
}
export function qualifyDetailFact(
  raw: unknown,
  publication: ReturnType<typeof qualifyDetailPublication>,
  input: HistoricalOnlineDetailInput,
) {
  const rows = factRow.array().max(2).safeParse(raw);
  if (!rows.success || rows.data.length !== 1) throw detailInvalid();
  const row = rows.data[0]!;
  if (
    row.order_id !== input.orderId ||
    row.generation_id !== publication.generation_id ||
    row.business_date !== publication.business_date ||
    row.details_hash !== publication.source_hash ||
    Buffer.byteLength(row.details_json) > 4000000 ||
    createHash('sha256').update(row.details_json).digest('hex') !== row.details_hash
  )
    throw detailInvalid();
  let json: unknown;
  try {
    json = JSON.parse(row.details_json) as unknown;
  } catch {
    throw detailInvalid();
  }
  const result = onlineDetailFact.safeParse(json);
  if (!result.success) throw detailInvalid();
  const fact = result.data;
  if (
    fact.orderId !== input.orderId ||
    fact.customerId !== input.customerId ||
    fact.timeZone !== publication.business_timezone ||
    fact.createdAt.slice(0, 10) !== publication.business_date ||
    String(fact.lines.length) !== publication.source_lines ||
    String(fact.timeline.length) !== publication.source_events ||
    String(fact.lines.reduce((sum, line) => sum + line.express.length, 0)) !==
      publication.source_express
  )
    throw detailInvalid();
  if (
    input.range
      ? fact.createdAt < input.range.start || fact.createdAt >= input.range.end
      : fact.createdAt >= input.cutoff
  )
    throw detailUnavailable();

  return fact;
}
