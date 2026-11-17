import {
  originHistoryCaptureSchema,
  originHistoryCandidateSchema,
  originHistoryFacts,
  originHistoryKeys,
  originHistoryPublicationSchema,
  sameHistoryWitness,
} from './history-contracts.js';
import { originDigest, originError, sameOriginHash } from './contracts.js';
export { originHistoryCaptureSchema, originHistoryCandidateSchema } from './history-contracts.js';
/** Independent source and BQ reduction. It cannot turn CDC freshness or copied
 * source counts into a complete cohort and is never called by the runtime. */
export function sealOriginHistoryPublication(
  rawCapture: unknown,
  rawCandidate: unknown,
  keys: { captureKey: string; publicationKey: string },
  now = Date.now(),
) {
  originHistoryKeys(keys.captureKey, keys.publicationKey);
  const capture = originHistoryCaptureSchema.parse(rawCapture),
    candidate = originHistoryCandidateSchema.parse(rawCandidate),
    { signature, ...unsigned } = capture;
  if (
    !sameOriginHash(originDigest(keys.captureKey, 'history-capture', unsigned), signature) ||
    candidate.customerId !== capture.customerId ||
    candidate.sourceCaptureHash !== signature ||
    !sameHistoryWitness(candidate.witness, capture.witness) ||
    candidate.projectionHash !== capture.projectionHash ||
    (Object.keys(originHistoryFacts) as (keyof typeof originHistoryFacts)[]).some(
      (field) => candidate[field] !== capture[field],
    ) ||
    capture.orderRows !== capture.uniqueOrders ||
    capture.finishedAt < capture.capturedAt ||
    candidate.sourceCompleteThrough !== capture.capturedAt ||
    capture.finishedAt > now ||
    [capture.welcomeCount, capture.appCashbackCount, capture.webCashbackCount].some(
      (value) => BigInt(value) > BigInt(capture.orderRows),
    )
  )
    throw originError('SCREENING_ORIGIN_HISTORY_PUBLICATION_INVALID');
  const data = {
    contract: 'pos-screening-origin-history-publication-v1' as const,
    customerId: candidate.customerId,
    witness: candidate.witness,
    generationId: candidate.generationId,
    projectionHash: candidate.projectionHash,
    sourceCaptureHash: signature,
    capturedAt: capture.capturedAt,
    sourceComplete: true as const,
    sourceCompleteThrough: capture.capturedAt,
    publishedAt: now,
    orderRows: candidate.orderRows,
    uniqueOrders: candidate.uniqueOrders,
    welcomeCount: candidate.welcomeCount,
    appCashbackCount: candidate.appCashbackCount,
    webCashbackCount: candidate.webCashbackCount,
    rowsHash: candidate.rowsHash,
  };
  const publication = originHistoryPublicationSchema.parse({
    ...data,
    signature: originDigest(keys.publicationKey, 'history-publication', data),
  });
  return {
    publication,
    facts: {
      generationId: candidate.generationId,
      customerId: candidate.customerId,
      revision: candidate.witness.revision,
      orderRows: candidate.orderRows,
      uniqueOrders: candidate.uniqueOrders,
      welcomeCount: candidate.welcomeCount,
      appCashbackCount: candidate.appCashbackCount,
      webCashbackCount: candidate.webCashbackCount,
      rowsHash: candidate.rowsHash,
    },
  };
}
