import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { equalImportHash, importFinancialError } from '../financial-adapter-primitives.js';

export const counterContract = 'pos-screening-current-counter-v1';
export const counterPublicationContract = 'pos-screening-counter-publication-v1';
export const counterSourceContract = 'pos-screening-counter-source-v1';
export const counterWritersContract = 'pos-screening-counter-writers-v1';
export const counterSku = '390238';
export const counterSourceCommit = '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5';
export const counterHash = z.string().regex(/^[a-f0-9]{64}$/);
export const counterOwner = z.string().regex(/^[A-Za-z0-9_.-]{1,32}@[A-Za-z0-9_.%:-]{1,255}$/);
export const counterCount = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
export const counterCustomer = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const signed = (bits: number) =>
  z
    .string()
    .regex(/^(?:0|-?[1-9][0-9]*)$/)
    .refine(
      (value) =>
        BigInt(value) >= -(1n << BigInt(bits - 1)) && BigInt(value) < 1n << BigInt(bits - 1),
    );
export const counterRowSchema = z
  .object({
    markerId: signed(32),
    orderId: signed(64),
    lineId: signed(64),
    included: z.boolean(),
  })
  .strict();
export type CounterRow = z.infer<typeof counterRowSchema>;
export const counterScopeSchema = z
  .object({ customerId: counterCustomer, sku: z.literal(counterSku) })
  .strict();
export type CounterScope = z.infer<typeof counterScopeSchema>;
const time = z.number().int().positive().safe();
export const counterCaptureSchema = z
  .object({
    contract: z.literal(counterSourceContract),
    sourceCommit: z.literal(counterSourceCommit),
    scope: counterScopeSchema,
    snapshotId: z.uuid(),
    serverUuid: z.uuid(),
    sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    headRevision: counterCount,
    writersDefinitionHash: counterHash,
    writersOwner: counterOwner,
    rows: counterCount,
    count: counterCount,
    rowsHash: counterHash,
    capturedAt: time,
    finishedAt: time,
    signature: counterHash,
  })
  .strict();
export type CounterCapture = z.infer<typeof counterCaptureSchema>;
export const counterPublicationSchema = z
  .object({
    contract: z.literal(counterPublicationContract),
    sourceCommit: z.literal(counterSourceCommit),
    writersContract: z.literal(counterWritersContract),
    scope: counterScopeSchema,
    snapshotId: z.uuid(),
    serverUuid: z.uuid(),
    sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    generationId: counterHash,
    headRevision: counterCount,
    writersDefinitionHash: counterHash,
    writersOwner: counterOwner,
    rows: counterCount,
    count: counterCount,
    rowsHash: counterHash,
    sourceCaptureHash: counterHash,
    sourceCapturedAt: time,
    sourceFinishedAt: time,
    sourceCdcThrough: time,
    publishedAt: time,
    complete: z.literal(true),
    signature: counterHash,
  })
  .strict();
export type CounterPublication = z.infer<typeof counterPublicationSchema>;
export function counterError(kind: string, status = 503) {
  return importFinancialError('SCREENING_COUNTER_' + kind, status);
}
/** Python protocol.canonical uses Unicode codepoint ordering, never locale
 * collation. Serialize keys directly so JSON numeric-key enumeration cannot
 * undo that ordering. Actual counter schemas have fixed ASCII field names. */
function canonicalCounter(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalCounter).join(',') + ']';
  if (typeof value === 'object' && value !== null) {
    const compare = (a: string, b: string) => {
      const left = Array.from(a),
        right = Array.from(b);
      for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const difference = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
        if (difference) return difference;
      }
      return left.length - right.length;
    };
    return (
      '{' +
      Object.keys(value)
        .sort(compare)
        .map(
          (key) =>
            JSON.stringify(key) + ':' + canonicalCounter((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  }
  throw counterError('SOURCE_INVALID');
}
export function counterDigest(key: string, purpose: 'capture' | 'publication', body: unknown) {
  if (!/^[!-~]{32,4096}$/.test(key)) throw counterError('KEY_REQUIRED');
  return createHmac('sha256', key)
    .update(
      '{"kind":' +
        JSON.stringify('screening-counter.' + purpose + '.v1') +
        ',"input":' +
        canonicalCounter(body) +
        '}',
    )
    .digest('hex');
}
export function counterRows(input: unknown): CounterRow[] {
  const rows = z.array(counterRowSchema).max(10000).safeParse(input);
  if (!rows.success) throw counterError('BASELINE_INVALID');
  const sorted = [...rows.data].sort((a, b) =>
    BigInt(a.markerId) < BigInt(b.markerId) ? -1 : BigInt(a.markerId) > BigInt(b.markerId) ? 1 : 0,
  );
  if (new Set(sorted.map((row) => row.markerId)).size !== sorted.length)
    throw counterError('BASELINE_INVALID');
  return sorted;
}
export function counterRowsHash(input: readonly CounterRow[]) {
  const rows = counterRows(input);
  return createHash('sha256')
    .update(
      JSON.stringify(rows.map((row) => [row.markerId, row.orderId, row.lineId, row.included])),
    )
    .digest('hex');
}
export function assertCounterPublication(input: unknown, key: string): CounterPublication {
  const parsed = counterPublicationSchema.safeParse(input);
  if (!parsed.success) throw counterError('PUBLICATION_INVALID');
  const { signature, ...body } = parsed.data;
  if (
    !equalImportHash(signature, counterDigest(key, 'publication', body)) ||
    parsed.data.sourceCapturedAt > parsed.data.sourceFinishedAt ||
    BigInt(parsed.data.count) > BigInt(parsed.data.rows) ||
    parsed.data.sourceFinishedAt > parsed.data.sourceCdcThrough ||
    parsed.data.sourceCdcThrough > parsed.data.publishedAt
  )
    throw counterError('PUBLICATION_INVALID');
  return parsed.data;
}
export function sealCounterPublication(
  captureInput: unknown,
  sourceKey: string,
  publicationKey: string,
  warehouse: {
    generationId: string;
    snapshotId: string;
    sourceCaptureHash: string;
    sourceCdcThrough: number;
    complete: true;
    rows: unknown;
  },
  now = Date.now(),
): { publication: CounterPublication; rows: CounterRow[] } {
  if (sourceKey === publicationKey) throw counterError('KEY_REQUIRED');
  const parsed = counterCaptureSchema.safeParse(captureInput);
  if (!parsed.success) throw counterError('SOURCE_INVALID');
  const capture = parsed.data,
    { signature, ...body } = capture;
  if (
    !equalImportHash(signature, counterDigest(sourceKey, 'capture', body)) ||
    capture.capturedAt > capture.finishedAt ||
    capture.finishedAt > now ||
    now - capture.capturedAt > 60000 ||
    warehouse.complete !== true ||
    warehouse.snapshotId !== capture.snapshotId ||
    warehouse.sourceCaptureHash !== signature ||
    !Number.isSafeInteger(warehouse.sourceCdcThrough) ||
    warehouse.sourceCdcThrough < capture.finishedAt ||
    warehouse.sourceCdcThrough > now
  )
    throw counterError('SOURCE_INVALID');
  const rows = counterRows(warehouse.rows),
    rowsHash = counterRowsHash(rows);
  if (
    rowsHash !== capture.rowsHash ||
    String(rows.length) !== capture.rows ||
    String(rows.filter((row) => row.included).length) !== capture.count
  )
    throw counterError('BASELINE_MISMATCH');
  const value = {
    contract: counterPublicationContract,
    sourceCommit: counterSourceCommit,
    writersContract: counterWritersContract,
    scope: capture.scope,
    snapshotId: capture.snapshotId,
    serverUuid: capture.serverUuid,
    sourceSchema: capture.sourceSchema,
    generationId: warehouse.generationId,
    headRevision: capture.headRevision,
    writersDefinitionHash: capture.writersDefinitionHash,
    rows: capture.rows,
    count: capture.count,
    rowsHash,
    writersOwner: capture.writersOwner,
    sourceCaptureHash: signature,
    sourceCapturedAt: capture.capturedAt,
    sourceFinishedAt: capture.finishedAt,
    sourceCdcThrough: warehouse.sourceCdcThrough,
    publishedAt: now,
    complete: true as const,
  };
  return {
    publication: assertCounterPublication(
      { ...value, signature: counterDigest(publicationKey, 'publication', value) },
      publicationKey,
    ),
    rows,
  };
}
