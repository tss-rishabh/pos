import { timingSafeEqual } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { AppError, unavailable } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { operationHash } from '../checkout/crypto.js';
import type { DailyWarehouseQuery } from '../daily-report-warehouse.js';

export const paymentCorrectionPublicationContract = 'pos-payment-correction-finance-publication-v1';
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  money = z.string().regex(/^-?\d{1,12}\.\d{2}$/),
  positiveMoney = z.string().regex(/^\d{1,12}\.\d{2}$/),
  count = z.number().int().safe().nonnegative();
const metadata = {
  contract: z.literal(paymentCorrectionPublicationContract),
  generationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  sourcePosition: z.string().regex(/^[A-Za-z0-9:._,-]{1,4096}$/),
  cdcWatermark: z.iso.datetime(),
  publishedAt: z.iso.datetime(),
  businessTimezone: z.string().min(1).max(100),
  storeId: identifier,
  businessDate: z.iso.date(),
};
const daily = z
  .object({
    ...metadata,
    kind: z.literal('daily'),
    payload: z
      .object({
        storeName: z.string().max(255),
        locationCode: z.string().max(255),
        baselineHash: hash.nullable(),
        sourceCashRemoval: positiveMoney,
        sourceOnlineRemoval: money,
        sourceOrderCountRemoval: count,
        cashIn: positiveMoney,
        cashOut: positiveMoney,
        logicalOrderCount: count,
      })
      .strict(),
  })
  .strict();
const ledger = z
  .object({
    ...metadata,
    kind: z.literal('cash-ledger'),
    payload: z
      .object({
        baselineHash: hash,
        cashAdjustment: money,
        cashOut: positiveMoney,
      })
      .strict(),
  })
  .strict();
export const paymentCorrectionPartitionSchema = z.discriminatedUnion('kind', [daily, ledger]);
export type PaymentCorrectionPartition = z.infer<typeof paymentCorrectionPartitionSchema>;
export interface PaymentCorrectionPublicationOptions {
  table?: string;
  proofKey?: string;
  maxCdcAgeSeconds?: number;
  maxPublicationAgeSeconds?: number;
}
export interface CorrectionPublicationScope {
  kind: 'daily' | 'cash-ledger';
  storeIds: readonly string[];
  from: string;
  to: string;
}
export interface CorrectionPublicationBase {
  generationId: string;
  sourcePosition?: string;
  cdcWatermark?: string;
  publishedAt?: string;
}
const table = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/,
  );
const invalid = () =>
  new AppError(
    503,
    'PAYMENT_CORRECTION_PUBLICATION_INVALID',
    'A complete consistent payment cash publication could not be verified.',
  );
export function paymentCorrectionBaselineHash(kind: 'cash-ledger', value: unknown) {
  // Only normalized non-PII source cash/anchor/close/banking DTOs belong here.
  return operationHash(
    `payment-correction.${kind}.baseline.v1`,
    value,
    'pos-payment-correction-baseline-profile-v1',
  );
}
/** Private publisher primitive: call only after native proof + source/CDC barrier checks. */
export function sealPaymentCorrectionPartition(
  raw: z.input<typeof paymentCorrectionPartitionSchema>,
  secret: string,
) {
  const body = paymentCorrectionPartitionSchema.parse(raw);
  if (secret.length < 32) throw invalid();
  return {
    body: JSON.stringify(body),
    proofHash: operationHash('payment-correction.publication.v1', body, secret),
  };
}
export function correctionPublicationDays(scope: CorrectionPublicationScope) {
  const stores = [...new Set(scope.storeIds.map((id) => identifier.parse(id)))].sort();
  if (!stores.length || stores.length > 500) throw invalid();
  const dates: string[] = [];
  let day = Temporal.PlainDate.from(z.iso.date().parse(scope.from));
  const end = Temporal.PlainDate.from(z.iso.date().parse(scope.to));
  if (Temporal.PlainDate.compare(day, end) > 0) throw invalid();
  while (Temporal.PlainDate.compare(day, end) <= 0) {
    dates.push(day.toString());
    if (dates.length * stores.length > 70000)
      throw new AppError(
        422,
        'REPORT_TOO_LARGE',
        'Select fewer stores or a shorter cash history range.',
      );
    day = day.add({ days: 1 });
  }
  return { stores, dates };
}
export async function readPaymentCorrectionPartitions(
  options: PaymentCorrectionPublicationOptions,
  query: DailyWarehouseQuery,
  scope: CorrectionPublicationScope,
  zone: string,
  now: Temporal.Instant,
  base?: CorrectionPublicationBase,
) {
  if (!options.table || !options.proofKey)
    return unavailable('BigQuery payment cash publication contract');
  const relation = table.safeParse(options.table);
  if (!relation.success || options.proofKey.length < 32) throw invalid();
  const { stores, dates } = correctionPublicationDays(scope),
    expected = new Set(stores.flatMap((store) => dates.map((date) => `${store}\0${date}`)));
  const params = {
      stores,
      start: scope.from,
      end: scope.to,
      kind: scope.kind,
      contract: paymentCorrectionPublicationContract,
    },
    types = { stores: ['STRING'], start: 'DATE', end: 'DATE', kind: 'STRING', contract: 'STRING' };
  let generation = base?.generationId;
  if (!generation) {
    const candidates = await query(
      `SELECT generation_id AS generationId FROM \`${relation.data}\` WHERE CAST(store_id AS STRING) IN UNNEST(@stores) AND business_date BETWEEN @start AND @end AND kind=@kind AND contract=@contract AND publication_state='COMPLETE' GROUP BY generation_id HAVING COUNT(*)=@expected ORDER BY MAX(published_at) DESC,generation_id DESC LIMIT 1`,
      { ...params, expected: expected.size },
      { ...types, expected: 'INT64' },
      'payment-cash-publication',
    );
    if (candidates.length !== 1) throw invalid();
    generation = z
      .object({ generationId: metadata.generationId })
      .parse(candidates[0]).generationId;
  }
  const records = await query(
    `SELECT body,proof_hash AS proofHash FROM \`${relation.data}\` WHERE generation_id=@generation AND CAST(store_id AS STRING) IN UNNEST(@stores) AND business_date BETWEEN @start AND @end AND kind=@kind AND contract=@contract AND publication_state='COMPLETE' LIMIT 70001`,
    { ...params, generation },
    { ...types, generation: 'STRING' },
    'payment-cash-publication',
  );
  if (records.length !== expected.size) throw invalid();
  let bytes = 0,
    common: string | undefined;
  const result = new Map<string, PaymentCorrectionPartition>();
  for (const raw of records) {
    const record = z.object({ body: z.string().max(2_000_000), proofHash: hash }).safeParse(raw);
    if (!record.success) throw invalid();
    bytes += Buffer.byteLength(record.data.body, 'utf8');
    if (bytes > 16_000_000)
      throw new AppError(422, 'REPORT_TOO_LARGE', 'The cash history publication is too large.');
    let json: unknown;
    try {
      json = JSON.parse(record.data.body) as unknown;
    } catch {
      throw invalid();
    }
    const parsed = paymentCorrectionPartitionSchema.safeParse(json);
    if (!parsed.success) throw invalid();
    const body = parsed.data;
    const signature = operationHash('payment-correction.publication.v1', body, options.proofKey),
      key = `${body.storeId}\0${body.businessDate}`;
    if (
      !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(record.data.proofHash, 'hex')) ||
      body.generationId !== generation ||
      body.kind !== scope.kind ||
      body.businessTimezone !== zone ||
      !expected.has(key) ||
      result.has(key)
    )
      throw invalid();
    if (
      (base?.sourcePosition && body.sourcePosition !== base.sourcePosition) ||
      (base?.publishedAt &&
        Temporal.Instant.compare(
          Temporal.Instant.from(body.publishedAt),
          Temporal.Instant.from(base.publishedAt),
        ) !== 0) ||
      (base?.cdcWatermark &&
        Temporal.Instant.compare(
          Temporal.Instant.from(body.cdcWatermark),
          Temporal.Instant.from(base.cdcWatermark),
        ) !== 0)
    )
      throw invalid();
    const fingerprint = JSON.stringify([body.sourcePosition, body.publishedAt, body.cdcWatermark]);
    if (common !== undefined && common !== fingerprint) throw invalid();
    common = fingerprint;
    const publicationAge =
        now.epochMilliseconds - Temporal.Instant.from(body.publishedAt).epochMilliseconds,
      cdcAge = now.epochMilliseconds - Temporal.Instant.from(body.cdcWatermark).epochMilliseconds;
    if (
      publicationAge > (options.maxPublicationAgeSeconds ?? 900) * 1000 ||
      cdcAge > (options.maxCdcAgeSeconds ?? 300) * 1000 ||
      publicationAge < -30000 ||
      cdcAge < -30000 ||
      Temporal.Instant.compare(
        Temporal.Instant.from(body.cdcWatermark),
        Temporal.Instant.from(body.publishedAt).add({ seconds: 30 }),
      ) > 0
    )
      throw new AppError(
        503,
        'PAYMENT_CORRECTION_PUBLICATION_STALE',
        'A fresh payment cash publication is not available.',
      );
    result.set(key, body);
  }
  return { generationId: generation, partitions: result };
}
