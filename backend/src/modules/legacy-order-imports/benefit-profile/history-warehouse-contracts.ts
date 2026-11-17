import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { benefitCount, benefitHash } from './contracts.js';
import { benefitDigest } from './crypto.js';
import { couponHistoryScopeSchema, type CouponHistoryScope } from './history.js';
import {
  couponHistoryWitnessSchema,
  type CouponHistoryWitness,
  couponHistoryControlHeadHash,
} from './bridge.js';
import { couponHistoryWritersDefinitionHash } from './history-writers.js';
import {
  couponPublicationError,
  verifyCouponSourceCapture,
  type CouponSourceCapture,
} from './history-publication.js';
import { equalImportHash } from '../financial-adapter-crypto.js';
export const couponWarehouse = Object.freeze({
  project: 'tssgcp2025',
  dataset: 'tss_mysql_raw_layer',
  location: 'asia-south1',
});
export const couponBigQueryContract = 'pos-csv-coupon-bigquery-v1';
export const couponWarehouseCandidateContract = 'pos-csv-coupon-warehouse-candidate-v1';
export const couponWarehouseControlsContract = 'pos-csv-coupon-warehouse-controls-v1';
export const couponWarehouseProjectionContract = 'pos-csv-coupon-immutable-projection-v1';
export const couponWarehouseDocumentBytes = 1500000;
export const couponWarehouseSourceDocumentBytes = 262144;
export const couponWarehouseMaximumControls = 10000;
export const couponSignedId = z
  .string()
  .regex(/^(?:0|-?[1-9]\d{0,18})$/)
  .refine(
    (value) => BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n,
  );
export const couponPositiveId = couponSignedId.refine((value) => BigInt(value) > 0n);
const view = z.string().regex(/^tssgcp2025\.tss_mysql_raw_layer\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/);
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
export const couponBigQueryOptionsSchema = z
  .object({
    CSV_COUPON_BIGQUERY_CONTRACT: optional(z.literal(couponBigQueryContract)),
    BQ_CSV_COUPON_PUBLICATIONS_VIEW: optional(view),
    BQ_CSV_COUPON_CANDIDATES_VIEW: optional(view),
    BQ_CSV_COUPON_ORDERS_VIEW: optional(view),
    BQ_CSV_COUPON_LOGS_VIEW: optional(view),
    BQ_CSV_COUPON_CONTROLS_VIEW: optional(view),
    CSV_COUPON_COMPARISON_FINGERPRINT: optional(benefitHash),
    CSV_COUPON_SOURCE_TIMEZONE: optional(
      z
        .string()
        .min(1)
        .max(100)
        .refine((value) => {
          try {
            Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value);
            return /^[A-Za-z0-9_+./-]+$/.test(value);
          } catch {
            return false;
          }
        }),
    ),
    CSV_COUPON_MAX_BYTES_BILLED: z.coerce.number().int().min(1).max(1000000000).default(50000000),
    CSV_COUPON_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(8000),
    CSV_COUPON_MAX_CONTROLS: z.coerce
      .number()
      .int()
      .min(1)
      .max(couponWarehouseMaximumControls)
      .default(10000),
    CSV_COUPON_MAX_LOTS: z.coerce.number().int().min(1).max(1000).default(1000),
    CSV_COUPON_MAX_LAG_SECONDS: z.coerce.number().int().min(1).max(60).default(60),
  })
  .strict();
export type CouponBigQueryOptions = z.infer<typeof couponBigQueryOptionsSchema>;
export function readCouponBigQueryOptions(env: NodeJS.ProcessEnv = process.env) {
  const fields = Object.fromEntries(
    Object.keys(couponBigQueryOptionsSchema.shape).map((key) => [
      key,
      env[key] === '' ? undefined : env[key],
    ]),
  );
  const value = couponBigQueryOptionsSchema.safeParse(fields);
  if (!value.success) throw couponPublicationError('CONFIGURATION', 503);
  return value.data;
}
export function requireCouponWarehouseOptions(
  value: CouponBigQueryOptions,
  mode: 'read' | 'candidate',
) {
  const parsed = couponBigQueryOptionsSchema.safeParse(value);
  if (!parsed.success) throw couponPublicationError('CONFIGURATION', 503);
  const p = parsed.data,
    names = [
      p.BQ_CSV_COUPON_PUBLICATIONS_VIEW,
      p.BQ_CSV_COUPON_CANDIDATES_VIEW,
      p.BQ_CSV_COUPON_ORDERS_VIEW,
      p.BQ_CSV_COUPON_LOGS_VIEW,
      p.BQ_CSV_COUPON_CONTROLS_VIEW,
    ];
  if (
    p.CSV_COUPON_BIGQUERY_CONTRACT !== couponBigQueryContract ||
    !p.CSV_COUPON_SOURCE_TIMEZONE ||
    !p.CSV_COUPON_COMPARISON_FINGERPRINT ||
    !p.BQ_CSV_COUPON_ORDERS_VIEW ||
    !p.BQ_CSV_COUPON_LOGS_VIEW ||
    !p.BQ_CSV_COUPON_CONTROLS_VIEW ||
    (mode === 'read' ? !p.BQ_CSV_COUPON_PUBLICATIONS_VIEW : !p.BQ_CSV_COUPON_CANDIDATES_VIEW)
  )
    throw couponPublicationError('WAREHOUSE_REQUIRED', 503);
  const configured = names.filter((name): name is string => Boolean(name));
  if (new Set(configured).size !== configured.length)
    throw couponPublicationError('CONFIGURATION', 503);
  return p;
}
export function couponWarehouseKeys(...values: string[]) {
  if (
    values.some((value) => !/^[!-~]{32,4096}$/.test(value)) ||
    new Set(values).size !== values.length
  )
    throw couponPublicationError('KEY_REQUIRED', 503);
}
export function requireCouponWitness(
  scope: CouponHistoryScope,
  supplied: unknown,
  sourceKey: string,
): CouponHistoryWitness {
  const value = couponHistoryWitnessSchema.safeParse(supplied);
  if (
    !value.success ||
    value.data.writersDefinitionHash !== couponHistoryWritersDefinitionHash ||
    BigInt(value.data.heads[0].revision) < 1n ||
    value.data.heads[1].scopeId !== scope.couponId ||
    value.data.heads[2].scopeId !== scope.customerId
  )
    throw couponPublicationError('WITNESS_REQUIRED', 503);
  couponHistoryControlHeadHash(scope, value.data, sourceKey);
  return value.data;
}
const nativeColumn = z
  .object({
    column: z.enum(['coupon_lot_no', 'voucher_code']),
    dataType: z.enum(['varchar', 'char', 'text', 'mediumtext', 'longtext']),
    characterSet: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
    collation: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
    padAttribute: z.enum(['PAD SPACE', 'NO PAD']),
  })
  .strict();
export const couponComparisonSchema = z
  .object({
    contract: z.literal('pos-native-coupon-comparisons-v1'),
    lot: nativeColumn,
    code: nativeColumn,
    lotComparison: z.literal('native-column-equality-and-nonempty'),
    codeComparison: z.literal('python-decoded-exact-utf8'),
  })
  .strict()
  .refine((value) => value.lot.column === 'coupon_lot_no' && value.code.column === 'voucher_code');
export type CouponComparison = z.infer<typeof couponComparisonSchema>;
export const couponComparisonFingerprint = (value: CouponComparison) =>
  createHash('sha256')
    .update(JSON.stringify(couponComparisonSchema.parse(value)))
    .digest('hex');
export const couponWarehouseControlRowSchema = z
  .object({
    couponId: couponSignedId,
    present: z.boolean(),
    lotMatches: z.boolean(),
    sameCode: z.boolean(),
    noTimesAllowed: benefitCount.nullable(),
    uniqueNoTimesAllowed: benefitCount.nullable(),
  })
  .strict()
  .refine((value) =>
    value.present
      ? value.noTimesAllowed !== null && value.uniqueNoTimesAllowed !== null
      : !value.lotMatches &&
        !value.sameCode &&
        value.noTimesAllowed === null &&
        value.uniqueNoTimesAllowed === null,
  );
export type CouponWarehouseControlRow = z.infer<typeof couponWarehouseControlRowSchema>;
export const couponWarehouseControlsSchema = z
  .object({
    contract: z.literal(couponWarehouseControlsContract),
    scope: couponHistoryScopeSchema,
    generationId: benefitHash,
    snapshotId: z.uuid(),
    sourceCaptureHash: benefitHash,
    controlHeadHash: benefitHash,
    couponInputHash: benefitHash,
    comparison: couponComparisonSchema,
    comparisonFingerprint: benefitHash,
    rowCount: benefitCount,
    rowsHash: benefitHash,
    observedAt: z.number().int().positive().safe(),
    signature: benefitHash,
  })
  .strict();
export type CouponWarehouseControls = z.infer<typeof couponWarehouseControlsSchema>;
export function couponWarehouseRowsHash(
  capture: Pick<CouponSourceCapture, 'scope' | 'generationId' | 'snapshotId' | 'controlHeadHash'>,
  rows: readonly CouponWarehouseControlRow[],
  key: string,
) {
  const parsed = z
      .array(couponWarehouseControlRowSchema)
      .max(couponWarehouseMaximumControls)
      .parse(rows),
    ordered = [...parsed].sort((a, b) => (BigInt(a.couponId) < BigInt(b.couponId) ? -1 : 1));
  if (new Set(ordered.map((row) => row.couponId)).size !== ordered.length)
    throw couponPublicationError('CONTROLS_INVALID');
  const { scope, generationId, snapshotId, controlHeadHash } = capture;
  // Bound each canonical HMAC input independently of the configured 10k rows.
  // Both chunk position and total rows are authenticated by the outer digest.
  const chunks: string[] = [];
  for (let offset = 0; offset < ordered.length; offset += 1000)
    chunks.push(
      benefitDigest(
        'coupon-warehouse-control-chunk',
        { offset, rows: ordered.slice(offset, offset + 1000) },
        key,
      ),
    );
  return benefitDigest(
    'coupon-warehouse-control-rows',
    { scope, generationId, snapshotId, controlHeadHash, rowCount: String(ordered.length), chunks },
    key,
  );
}
export function sealCouponWarehouseControls(
  capture: CouponSourceCapture,
  comparison: CouponComparison,
  rows: readonly CouponWarehouseControlRow[],
  sourceKey: string,
  now = Date.now(),
): CouponWarehouseControls {
  const verified = verifyCouponSourceCapture(capture, sourceKey, now),
    parsed = z
      .array(couponWarehouseControlRowSchema)
      .max(couponWarehouseMaximumControls)
      .parse(rows);
  const body = {
    contract: couponWarehouseControlsContract,
    scope: verified.scope,
    generationId: verified.generationId,
    snapshotId: verified.snapshotId,
    sourceCaptureHash: verified.signature,
    controlHeadHash: verified.controlHeadHash,
    couponInputHash: verified.couponInputHash,
    comparison: couponComparisonSchema.parse(comparison),
    comparisonFingerprint: couponComparisonFingerprint(comparison),
    rowCount: String(parsed.length),
    rowsHash: couponWarehouseRowsHash(
      {
        scope: verified.scope,
        generationId: verified.generationId,
        snapshotId: verified.snapshotId,
        controlHeadHash: verified.controlHeadHash,
      },
      parsed,
      sourceKey,
    ),
    observedAt: now,
  };
  return couponWarehouseControlsSchema.parse({
    ...body,
    signature: benefitDigest('coupon-warehouse-controls', body, sourceKey),
  });
}
export function verifyCouponWarehouseControls(
  value: unknown,
  capture: CouponSourceCapture,
  rows: unknown,
  sourceKey: string,
  comparisonFingerprint: string,
  now = Date.now(),
) {
  verifyCouponSourceCapture(capture, sourceKey, now);
  const parsed = couponWarehouseControlsSchema.safeParse(value),
    selection = z
      .array(couponWarehouseControlRowSchema)
      .max(couponWarehouseMaximumControls)
      .safeParse(rows);
  if (!parsed.success || !selection.success) throw couponPublicationError('CONTROLS_INVALID');
  const p = parsed.data,
    { signature, ...body } = p;
  if (
    JSON.stringify(p.scope) !== JSON.stringify(capture.scope) ||
    p.generationId !== capture.generationId ||
    p.snapshotId !== capture.snapshotId ||
    p.sourceCaptureHash !== capture.signature ||
    p.controlHeadHash !== capture.controlHeadHash ||
    p.couponInputHash !== capture.couponInputHash ||
    p.comparisonFingerprint !== comparisonFingerprint ||
    p.comparisonFingerprint !== couponComparisonFingerprint(p.comparison) ||
    p.rowCount !== String(selection.data.length) ||
    p.observedAt < capture.finishedAt ||
    p.observedAt > now ||
    now - p.observedAt > 60000 ||
    !equalImportHash(signature, benefitDigest('coupon-warehouse-controls', body, sourceKey)) ||
    !equalImportHash(
      p.rowsHash,
      couponWarehouseRowsHash(
        {
          scope: capture.scope,
          generationId: capture.generationId,
          snapshotId: capture.snapshotId,
          controlHeadHash: capture.controlHeadHash,
        },
        selection.data,
        sourceKey,
      ),
    )
  )
    throw couponPublicationError('CONTROLS_INVALID');
  return { manifest: p, rows: selection.data };
}
