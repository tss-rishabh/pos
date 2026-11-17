import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { originDigest, originError, originHashSchema, sameOriginHash } from './contracts.js';

export const originHistoryContract = 'pos-screening-origin-history-v1';
export const originHistoryHeadContract = 'pos-screening-origin-history-head-v1';
export const originHistoryProjectionHash = createHash('sha256')
  .update(
    JSON.stringify({
      source: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
      welcome: 'COUNT(id) WHERE user_id=:customer AND NOT order_status=4',
      app: 'COUNT(id) WHERE user_id=:customer AND order_status=3 AND flag_id=18',
      web: 'COUNT(id) WHERE user_id=:customer AND order_status=3 AND flag_id!=18',
      bounds: 'all rows, including already-present future timestamps; SQL NULL predicates',
      commitment:
        'sha256 UTF8 JSON array, numeric id order, keys flag,id,status; nullable signed decimal strings',
    }),
  )
  .digest('hex');
export const originHistoryCount = z.string().regex(/^(?:0|[1-9]\d{0,19})$/);
const time = z.number().int().safe().positive();
const nativeInteger = z
  .string()
  .regex(/^(?:0|-?[1-9]\d{0,18})$/)
  .refine(
    (value) => BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n,
  );
export const originHistoryRowSchema = z
  .object({ flag: nativeInteger.nullable(), id: identifier, status: nativeInteger.nullable() })
  .strict();
export const originHistoryWitnessSchema = z
  .object({
    contract: z.literal(originHistoryHeadContract),
    sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    sourceServerUuid: z.uuid(),
    revision: originHistoryCount.refine((value) => BigInt(value) <= 18446744073709551615n),
    writersHash: originHashSchema,
  })
  .strict();
export const originHistoryFacts = {
  orderRows: originHistoryCount,
  uniqueOrders: originHistoryCount,
  welcomeCount: originHistoryCount,
  appCashbackCount: originHistoryCount,
  webCashbackCount: originHistoryCount,
  rowsHash: originHashSchema,
};
export const originHistoryCaptureSchema = z
  .object({
    contract: z.literal('pos-screening-origin-history-capture-v1'),
    customerId: identifier,
    witness: originHistoryWitnessSchema,
    projectionHash: z.literal(originHistoryProjectionHash),
    ...originHistoryFacts,
    capturedAt: time,
    finishedAt: time,
    signature: originHashSchema,
  })
  .strict();
export const originHistorySnapshotSchema = z
  .object({ capture: originHistoryCaptureSchema, rows: z.array(originHistoryRowSchema).max(50000) })
  .strict();
export const originHistoryCandidateSchema = z
  .object({
    contract: z.literal('pos-screening-origin-history-candidate-v1'),
    customerId: identifier,
    witness: originHistoryWitnessSchema,
    sourceCaptureHash: originHashSchema,
    generationId: originHashSchema,
    projectionHash: z.literal(originHistoryProjectionHash),
    complete: z.literal(true),
    reader: z.literal('bigquery'),
    sourceCompleteThrough: time,
    ...originHistoryFacts,
  })
  .strict();
export const originHistoryPublicationSchema = z
  .object({
    contract: z.literal('pos-screening-origin-history-publication-v1'),
    generationId: originHashSchema,
    customerId: identifier,
    witness: originHistoryWitnessSchema,
    projectionHash: z.literal(originHistoryProjectionHash),
    sourceCaptureHash: originHashSchema,
    capturedAt: time,
    sourceComplete: z.literal(true),
    sourceCompleteThrough: time,
    publishedAt: time,
    ...originHistoryFacts,
    signature: originHashSchema,
  })
  .strict();
export const originHistoryDocumentSchema = z
  .object({
    contract: z.literal(originHistoryContract),
    commandId: z.uuid(),
    customerId: identifier,
    requestHash: originHashSchema,
    cartHash: originHashSchema,
    witness: originHistoryWitnessSchema,
    generationId: originHashSchema,
    sourceCompleteThrough: time,
    reader: z.literal('bigquery'),
    complete: z.literal(true),
    welcomeCount: originHistoryCount,
    appCashbackCount: originHistoryCount,
    webCashbackCount: originHistoryCount,
    fetchedAt: time,
    expiresAt: time,
    signature: originHashSchema,
  })
  .strict();
export type OriginHistoryWitness = z.infer<typeof originHistoryWitnessSchema>;
export type OriginHistoryCapture = z.infer<typeof originHistoryCaptureSchema>;
export type OriginHistorySnapshot = z.infer<typeof originHistorySnapshotSchema>;
export type OriginHistoryCandidate = z.infer<typeof originHistoryCandidateSchema>;
export type OriginHistoryPublication = z.infer<typeof originHistoryPublicationSchema>;
export type OriginHistoryDocument = z.infer<typeof originHistoryDocumentSchema>;
export type OriginHistoryRow = z.infer<typeof originHistoryRowSchema>;
export const sameHistoryWitness = (a: OriginHistoryWitness, b: OriginHistoryWitness) =>
  (['contract', 'sourceSchema', 'sourceServerUuid', 'revision', 'writersHash'] as const).every(
    (key) => a[key] === b[key],
  );
export function originHistoryKeys(...keys: string[]) {
  if (keys.some((key) => !/^[!-~]{32,4096}$/.test(key)) || new Set(keys).size !== keys.length)
    throw originError('SCREENING_ORIGIN_HISTORY_KEY_REQUIRED');
}
export function literalOriginHistoryFacts(input: readonly OriginHistoryRow[]) {
  const rows = input.map((row) => originHistoryRowSchema.parse(row));
  if (rows.length > 50000 || new Set(rows.map((row) => row.id)).size !== rows.length)
    throw originError('SCREENING_ORIGIN_HISTORY_COHORT_INVALID');
  rows.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  return {
    orderRows: String(rows.length),
    uniqueOrders: String(rows.length),
    welcomeCount: String(rows.filter((row) => row.status !== null && row.status !== '4').length),
    appCashbackCount: String(rows.filter((row) => row.status === '3' && row.flag === '18').length),
    webCashbackCount: String(
      rows.filter((row) => row.status === '3' && row.flag !== null && row.flag !== '18').length,
    ),
    rowsHash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}
export function verifyOriginHistorySnapshot(input: unknown, key: string): OriginHistorySnapshot {
  const snapshot = originHistorySnapshotSchema.parse(input),
    { signature, ...body } = snapshot.capture,
    facts = literalOriginHistoryFacts(snapshot.rows);
  if (
    !sameOriginHash(signature, originDigest(key, 'history-capture', body)) ||
    snapshot.capture.finishedAt < snapshot.capture.capturedAt ||
    (Object.keys(originHistoryFacts) as (keyof typeof originHistoryFacts)[]).some(
      (field) => facts[field] !== snapshot.capture[field],
    ) ||
    Buffer.byteLength(JSON.stringify(snapshot)) > 9_000_000
  )
    throw originError('SCREENING_ORIGIN_HISTORY_CAPTURE_INVALID');
  return snapshot;
}
