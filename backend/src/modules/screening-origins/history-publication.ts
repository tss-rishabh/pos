import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { originDigest, originError, originHashSchema, sameOriginHash } from './contracts.js';
import { originHistoryWitnessSchema } from './history.js';
const count = z.string().regex(/^(?:0|[1-9]\d{0,19})$/);
const time = z.number().int().safe().positive();
const counts = {
  orderRows: count, uniqueOrders: count, welcomeCount: count, appCashbackCount: count, webCashbackCount: count, rowsHash: originHashSchema,
};
export const originHistoryCaptureSchema = z.object({
  contract: z.literal('pos-screening-origin-history-capture-v1'), customerId: identifier,
  witness: originHistoryWitnessSchema, ...counts, capturedAt: time, finishedAt: time, signature: originHashSchema,
}).strict();
export const originHistoryCandidateSchema = z.object({
  contract: z.literal('pos-screening-origin-history-candidate-v1'), customerId: identifier,
  witness: originHistoryWitnessSchema, sourceCaptureHash: originHashSchema, generationId: originHashSchema,
  complete: z.literal(true), reader: z.literal('bigquery'), sourceCompleteThrough: time, ...counts,
}).strict();
/** Separately authorized publisher composition. Both inputs originate outside
 * checkout. Exact BQ/native cohort hashes and counts establish conservation;
 * there is no raw-as-complete alias or on-request native capture. */
export function sealOriginHistoryPublication(
  rawCapture: unknown,
  rawCandidate: unknown,
  keys: { captureKey: string; publicationKey: string },
  now = Date.now(),
) {
  const capture = originHistoryCaptureSchema.parse(rawCapture), candidate = originHistoryCandidateSchema.parse(rawCandidate);
  const { signature, ...unsigned } = capture;
  if (keys.captureKey === keys.publicationKey ||
      !sameOriginHash(originDigest(keys.captureKey, 'history-capture', unsigned), signature) ||
      candidate.customerId !== capture.customerId || candidate.sourceCaptureHash !== signature ||
      JSON.stringify(candidate.witness) !== JSON.stringify(capture.witness) ||
      Object.keys(counts).some((field) => candidate[field as keyof typeof counts] !== capture[field as keyof typeof counts]) ||
      capture.orderRows !== capture.uniqueOrders ||
      [capture.welcomeCount,capture.appCashbackCount,capture.webCashbackCount].some((value) => BigInt(value)>BigInt(capture.orderRows)) ||
      capture.finishedAt < capture.capturedAt || candidate.sourceCompleteThrough < capture.finishedAt ||
      candidate.sourceCompleteThrough > now || now-capture.capturedAt > 60000) throw originError('SCREENING_ORIGIN_HISTORY_PUBLICATION_INVALID');
  const publication = {
    contract: 'pos-screening-origin-history-publication-v1' as const,
    customerId: capture.customerId, witness: capture.witness, generationId: candidate.generationId,
    sourceComplete: true as const, sourceCompleteThrough: candidate.sourceCompleteThrough, publishedAt: now,
    orderRows: capture.orderRows, uniqueOrders: capture.uniqueOrders, welcomeCount: capture.welcomeCount,
    appCashbackCount: capture.appCashbackCount, webCashbackCount: capture.webCashbackCount, rowsHash: capture.rowsHash,
  };
  return { publication: { ...publication, signature: originDigest(keys.publicationKey,'history-publication',publication) },
    facts: { generationId: candidate.generationId, customerId: capture.customerId, revision: capture.witness.revision,
      orderRows: capture.orderRows, uniqueOrders: capture.uniqueOrders, welcomeCount: capture.welcomeCount,
      appCashbackCount: capture.appCashbackCount, webCashbackCount: capture.webCashbackCount, rowsHash: capture.rowsHash } };
}
