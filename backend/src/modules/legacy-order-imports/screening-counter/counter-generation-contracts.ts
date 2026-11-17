import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  counterCaptureSchema,
  counterRows,
  counterRowsHash,
  counterRowSchema,
  counterHash,
  counterPublicationSchema,
  counterDigest,
  counterError,
} from './contracts.js';
import { equalImportHash } from '../financial-adapter-primitives.js';
export const counterGenerationContract = 'pos-screening-counter-generation-worker-v1';
export const counterGenerationSnapshotSchema = z
  .object({
    capture: counterCaptureSchema,
    rows: z.array(counterRowSchema).max(10000),
    configuration: z.string().min(1).max(16000),
    attestationHash: counterHash,
  })
  .strict();
export type CounterGenerationSnapshot = z.infer<typeof counterGenerationSnapshotSchema>;
export function counterGenerationDigest(key: string, purpose: string, input: unknown) {
  if (!/^[!-~]{32,4096}$/.test(key)) throw counterError('KEY_REQUIRED');
  return createHmac('sha256', key)
    .update(JSON.stringify({ contract: counterGenerationContract, purpose, input }))
    .digest('hex');
}
export function sealCounterGenerationSnapshot(
  input: Omit<CounterGenerationSnapshot, 'attestationHash'>,
  sourceKey: string,
) {
  const body = { ...input, rows: counterRows(input.rows) };
  return verifyCounterGenerationSnapshot(
    { ...body, attestationHash: counterGenerationDigest(sourceKey, 'snapshot', body) },
    sourceKey,
  );
}
export function verifyCounterGenerationSnapshot(input: unknown, sourceKey: string) {
  const snapshot = counterGenerationSnapshotSchema.parse(input),
    { attestationHash, ...body } = snapshot,
    c = snapshot.capture,
    { signature, ...capture } = c;
  if (
    !equalImportHash(attestationHash, counterGenerationDigest(sourceKey, 'snapshot', body)) ||
    !equalImportHash(signature, counterDigest(sourceKey, 'capture', capture)) ||
    c.capturedAt > c.finishedAt ||
    c.rows !== String(snapshot.rows.length) ||
    c.count !== String(snapshot.rows.filter((row) => row.included).length) ||
    c.rowsHash !== counterRowsHash(snapshot.rows)
  )
    throw counterError('GENERATION_SNAPSHOT_INVALID');
  return snapshot;
}
export const counterGenerationId = (snapshot: CounterGenerationSnapshot) =>
  createHash('sha256').update(snapshot.capture.snapshotId).digest('hex');
export const counterGenerationPhase = z.enum([
  'prepared',
  'materializing',
  'materialized',
  'verified',
  'seeding',
  'seeded',
  'failed',
]);
export const counterGenerationPlanSchema = z
  .object({
    jobId: z.string().regex(/^pos_screening_counter_[a-f0-9]{64}$/),
    statement: z.string().min(1).max(20000),
    preflight: z.string().min(1).max(2000),
    params: z.record(z.string(), z.string()),
    types: z.record(z.string(), z.string()),
    hash: counterHash,
  })
  .strict();
export type CounterGenerationPlan = z.infer<typeof counterGenerationPlanSchema>;
export const counterGenerationReplySchema = z
  .object({
    status: z.enum(['pending', 'unknown', 'succeeded', 'failed']),
    jobId: z.string(),
    queryHash: counterHash,
    evidenceHash: counterHash,
  })
  .strict();
export type CounterGenerationReply = z.infer<typeof counterGenerationReplySchema>;
export const counterGenerationRecordSchema = z
  .object({
    id: counterHash,
    version: z.string().regex(/^[1-9][0-9]{0,19}$/),
    phase: counterGenerationPhase,
    snapshot: counterGenerationSnapshotSchema,
    expectedGeneration: counterHash.nullable(),
    plan: counterGenerationPlanSchema,
    reply: counterGenerationReplySchema.nullable(),
    publication: counterPublicationSchema.nullable(),
    createdAt: z.number().int().positive().safe(),
    updatedAt: z.number().int().positive().safe(),
  })
  .strict();
export type CounterGenerationRecord = z.infer<typeof counterGenerationRecordSchema>;
