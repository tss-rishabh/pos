import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { benefitHash, benefitCount, benefitSourceCommit, benefitTimestamp } from './contracts.js';
import { benefitDigest } from './crypto.js';
import {
  couponHistoryWitnessSchema,
  couponHistoryControlHeadHash,
  type CouponHistoryWitness,
} from './bridge.js';
import {
  couponHistoryScopeSchema,
  couponHistoryHash,
  assertQualifiedCouponHistory,
  type CouponHistoryScope,
  type QualifiedCouponHistory,
} from './history.js';
import {
  couponPublicationFactsSchema,
  couponSourceQueryContract,
  couponPublicationError,
  type CouponPublicationFacts,
} from './history-publication.js';
import { couponHistoryWritersDefinitionHash } from './history-writers.js';
import {
  couponComparisonSchema,
  couponComparisonFingerprint,
  couponWarehouseControlRowSchema,
  couponWarehouseKeys,
  type CouponWarehouseControlRow,
} from './history-warehouse-contracts.js';
import {
  generationControlEnvelopeSchema,
  verifyGenerationControl,
  generationPositiveId,
} from './history-generation-control.js';
import { equalImportHash } from '../financial-adapter-primitives.js';
export const generationSourceContract = 'pos-csv-coupon-generation-source-v1';
export const generationPublicationContract = 'pos-csv-coupon-generation-publication-v1';
export const generationProjectionContract = 'pos-csv-coupon-generation-rows-v1';
export const generationCandidateContract = 'pos-csv-coupon-generation-candidate-v1';
export const generationRuntimeContract = 'pos-csv-coupon-generation-runtime-v1';
export const generationWriterContract = 'pos-csv-coupon-generation-writer-v1';
const time = z.number().int().positive().safe();
export const generationScopeSchema = z
  .object({
    customerId: generationPositiveId,
    couponId: generationPositiveId,
    configurationHash: benefitHash,
    sourceTimeZone: z
      .string()
      .min(1)
      .max(100)
      .refine((v) => {
        try {
          Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(v);
          return true;
        } catch {
          return false;
        }
      }),
    sourceDay: z.iso.date(),
  })
  .strict();
export type GenerationScope = z.infer<typeof generationScopeSchema>;
export const generationProjectionSchema = z
  .object({ rows: benefitCount, uniqueRows: benefitCount, hash: benefitHash })
  .strict()
  .refine((v) => v.rows === v.uniqueRows);
export type GenerationProjection = z.infer<typeof generationProjectionSchema>;
export const generationCaptureSchema = z
  .object({
    contract: z.literal(generationSourceContract),
    sourceCommit: z.literal(benefitSourceCommit),
    queryContract: z.literal(couponSourceQueryContract),
    scope: generationScopeSchema,
    control: generationControlEnvelopeSchema,
    sourceAsOf: benefitTimestamp,
    generationId: benefitHash,
    snapshotId: z.uuid(),
    serverUuid: z.uuid(),
    sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    writersContract: z.literal('pos-csv-coupon-history-all-writers-v1'),
    writersDefinitionHash: benefitHash,
    heads: couponHistoryWitnessSchema.shape.heads,
    headHash: benefitHash,
    capturedAt: time,
    finishedAt: time,
    couponInputHash: benefitHash,
    comparison: couponComparisonSchema,
    comparisonFingerprint: benefitHash,
    controlsCount: benefitCount,
    controlsHash: benefitHash,
    projections: z
      .object({ orders: generationProjectionSchema, logs: generationProjectionSchema })
      .strict(),
    facts: couponPublicationFactsSchema,
    signature: benefitHash,
  })
  .strict();
export type GenerationCapture = z.infer<typeof generationCaptureSchema>;
export const generationPublicationSchema = z
  .object({
    contract: z.literal(generationPublicationContract),
    scope: generationScopeSchema,
    queryContract: z.literal(couponSourceQueryContract),
    generationId: benefitHash,
    snapshotId: z.uuid(),
    captureHash: benefitHash,
    headHash: benefitHash,
    controlsHash: benefitHash,
    factsHash: benefitHash,
    projectionsHash: benefitHash,
    sourceFinishedAt: time,
    materializedAt: time,
    publishedAt: time,
    seal: benefitHash,
  })
  .strict();
export type GenerationPublication = z.infer<typeof generationPublicationSchema>;
export const generationError = (kind: string, status = 409) =>
  couponPublicationError('GENERATION_' + kind, status);
export function generationScopeFor(scope: CouponHistoryScope): GenerationScope {
  const parsed = couponHistoryScopeSchema.safeParse(scope);
  if (!parsed.success) throw generationError('SCOPE');
  return generationScopeSchema.parse({
    customerId: parsed.data.customerId,
    couponId: parsed.data.couponId,
    configurationHash: parsed.data.configurationHash,
    sourceTimeZone: parsed.data.sourceTimeZone,
    sourceDay: parsed.data.asOf.slice(0, 10),
  });
}
export function generationHeadHash(
  scope: GenerationScope,
  witness: CouponHistoryWitness,
  key: string,
) {
  const s = generationScopeSchema.parse(scope),
    w = couponHistoryWitnessSchema.parse(witness);
  if (
    w.heads[1].scopeId !== s.couponId ||
    w.heads[2].scopeId !== s.customerId ||
    w.writersDefinitionHash !== couponHistoryWritersDefinitionHash ||
    BigInt(w.heads[0].revision) < 1n
  )
    throw generationError('WITNESS');
  return benefitDigest(
    'coupon-generation-head',
    {
      scope: s,
      serverUuid: w.serverUuid,
      sourceSchema: w.sourceSchema,
      writersDefinitionHash: w.writersDefinitionHash,
      heads: w.heads,
    },
    key,
  );
}
export function generationControlsHash(
  scope: GenerationScope,
  generationId: string,
  snapshotId: string,
  rows: readonly CouponWarehouseControlRow[],
  key: string,
) {
  const values = z
    .array(couponWarehouseControlRowSchema)
    .max(10000)
    .parse(rows)
    .sort((a, b) => (BigInt(a.couponId) < BigInt(b.couponId) ? -1 : 1));
  if (new Set(values.map((v) => v.couponId)).size !== values.length)
    throw generationError('CONTROLS');
  const chunks: string[] = [];
  for (let offset = 0; offset < values.length; offset += 1000)
    chunks.push(
      benefitDigest(
        'coupon-generation-control-chunk',
        { offset, rows: values.slice(offset, offset + 1000) },
        key,
      ),
    );
  return benefitDigest(
    'coupon-generation-controls',
    { scope, generationId, snapshotId, rows: String(values.length), chunks },
    key,
  );
}
export function signGenerationCapture(body: Omit<GenerationCapture, 'signature'>, key: string) {
  return { ...body, signature: benefitDigest('coupon-generation-source', body, key) };
}
export function verifyGenerationCapture(
  value: unknown,
  key: string,
  now = Date.now(),
  maxLag = 60000,
) {
  couponWarehouseKeys(key);
  const parsed = generationCaptureSchema.safeParse(value);
  if (
    !parsed.success ||
    Buffer.byteLength(JSON.stringify(parsed.data)) > 262144 ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !Number.isSafeInteger(maxLag) ||
    maxLag < 1 ||
    maxLag > 60000
  )
    throw generationError('SOURCE');
  const c = parsed.data,
    { signature, ...body } = c,
    control = verifyGenerationControl(c.control, key, now).data,
    w = couponHistoryWitnessSchema.parse({
      writersContract: c.writersContract,
      writersDefinitionHash: c.writersDefinitionHash,
      serverUuid: c.serverUuid,
      sourceSchema: c.sourceSchema,
      heads: c.heads,
    });
  let at: number;
  try {
    at = Temporal.PlainDateTime.from(c.sourceAsOf.replace(' ', 'T')).toZonedDateTime(
      c.scope.sourceTimeZone,
      { disambiguation: 'reject' },
    ).epochMilliseconds;
  } catch {
    throw generationError('SOURCE');
  }
  if (
    control.couponId !== c.scope.couponId ||
    control.configurationHash !== c.scope.configurationHash ||
    control.couponInputHash !== c.couponInputHash ||
    control.serverUuid !== c.serverUuid ||
    control.sourceSchema !== c.sourceSchema ||
    control.sourceDay !== c.scope.sourceDay ||
    control.sourceTimeZone !== c.scope.sourceTimeZone ||
    JSON.stringify(control.heads) !== JSON.stringify(c.heads.slice(0, 2)) ||
    control.observedAt > c.capturedAt ||
    c.sourceAsOf.slice(0, 10) !== c.scope.sourceDay ||
    Temporal.Instant.fromEpochMilliseconds(c.finishedAt)
      .toZonedDateTimeISO(c.scope.sourceTimeZone)
      .toPlainDate()
      .toString() !== c.scope.sourceDay ||
    at > c.capturedAt ||
    c.capturedAt - at >= 1000 ||
    c.capturedAt > c.finishedAt ||
    c.finishedAt > now ||
    now - c.capturedAt >= maxLag ||
    c.comparisonFingerprint !== couponComparisonFingerprint(c.comparison) ||
    c.controlsCount === '0' ||
    BigInt(c.controlsCount) > 10000n ||
    c.writersDefinitionHash !== couponHistoryWritersDefinitionHash ||
    !equalImportHash(c.headHash, generationHeadHash(c.scope, w, key)) ||
    !equalImportHash(signature, benefitDigest('coupon-generation-source', body, key))
  )
    throw generationError('SOURCE');
  return c;
}
export interface GenerationFacts {
  capture: GenerationCapture;
  controls: CouponWarehouseControlRow[];
  facts: CouponPublicationFacts;
  projections: GenerationCapture['projections'];
  materializedAt: number;
  publication: GenerationPublication | null;
}
export function verifyGenerationFacts(
  value: GenerationFacts,
  key: string,
  comparisonFingerprint: string,
  now = Date.now(),
) {
  const c = verifyGenerationCapture(value.capture, key, now),
    facts = couponPublicationFactsSchema.parse(value.facts),
    projections = z
      .object({ orders: generationProjectionSchema, logs: generationProjectionSchema })
      .strict()
      .parse(value.projections);
  if (
    c.comparisonFingerprint !== comparisonFingerprint ||
    c.controlsCount !== String(value.controls.length) ||
    !equalImportHash(
      c.controlsHash,
      generationControlsHash(c.scope, c.generationId, c.snapshotId, value.controls, key),
    ) ||
    JSON.stringify(projections) !== JSON.stringify(c.projections) ||
    !equalImportHash(
      benefitDigest('coupon-generation-facts', { scope: c.scope, facts }, key),
      benefitDigest('coupon-generation-facts', { scope: c.scope, facts: c.facts }, key),
    ) ||
    !Number.isSafeInteger(value.materializedAt) ||
    value.materializedAt < c.finishedAt ||
    value.materializedAt > now
  )
    throw generationError('INCOMPLETE');
  return { ...value, capture: c, facts, projections };
}
export function sealGenerationPublication(
  value: GenerationFacts,
  authority: { sourceKey: string; publicationKey: string; historyKey: string },
  comparisonFingerprint: string,
  now = Date.now(),
): GenerationPublication {
  couponWarehouseKeys(authority.sourceKey, authority.publicationKey, authority.historyKey);
  const v = verifyGenerationFacts(value, authority.sourceKey, comparisonFingerprint, now),
    c = v.capture;
  const body = {
    contract: generationPublicationContract,
    scope: c.scope,
    queryContract: couponSourceQueryContract,
    generationId: c.generationId,
    snapshotId: c.snapshotId,
    captureHash: c.signature,
    headHash: c.headHash,
    controlsHash: c.controlsHash,
    factsHash: benefitDigest(
      'coupon-generation-facts',
      { scope: c.scope, facts: v.facts },
      authority.publicationKey,
    ),
    projectionsHash: benefitDigest(
      'coupon-generation-projections',
      { scope: c.scope, projections: v.projections },
      authority.publicationKey,
    ),
    sourceFinishedAt: c.finishedAt,
    materializedAt: v.materializedAt,
    publishedAt: now,
  };
  return generationPublicationSchema.parse({
    ...body,
    seal: benefitDigest('coupon-generation-publication', body, authority.publicationKey),
  });
}
export function bindGenerationHistory(
  value: GenerationFacts,
  scope: CouponHistoryScope,
  witness: CouponHistoryWitness,
  authority: { sourceKey: string; publicationKey: string; historyKey: string },
  comparisonFingerprint: string,
  now = Date.now(),
): QualifiedCouponHistory {
  couponWarehouseKeys(authority.sourceKey, authority.publicationKey, authority.historyKey);
  const request = couponHistoryScopeSchema.parse(scope),
    v = verifyGenerationFacts(value, authority.sourceKey, comparisonFingerprint, now),
    p = generationPublicationSchema.parse(v.publication),
    { seal, ...body } = p,
    c = v.capture;
  const current = generationScopeFor(request);
  const point = Temporal.PlainDateTime.from(request.asOf.replace(' ', 'T')).toZonedDateTime(
    request.sourceTimeZone,
    { disambiguation: 'reject' },
  ).epochMilliseconds;
  if (
    point > now ||
    now - point >= 60000 ||
    Temporal.Instant.fromEpochMilliseconds(now)
      .toZonedDateTimeISO(current.sourceTimeZone)
      .toPlainDate()
      .toString() !== current.sourceDay ||
    JSON.stringify(current) !== JSON.stringify(c.scope) ||
    JSON.stringify(p.scope) !== JSON.stringify(current) ||
    p.generationId !== c.generationId ||
    p.snapshotId !== c.snapshotId ||
    p.captureHash !== c.signature ||
    p.controlsHash !== c.controlsHash ||
    p.headHash !== c.headHash ||
    p.sourceFinishedAt !== c.finishedAt ||
    p.materializedAt !== v.materializedAt ||
    p.publishedAt < p.materializedAt ||
    p.publishedAt > now ||
    !equalImportHash(c.headHash, generationHeadHash(current, witness, authority.sourceKey)) ||
    !equalImportHash(
      p.factsHash,
      benefitDigest(
        'coupon-generation-facts',
        { scope: current, facts: v.facts },
        authority.publicationKey,
      ),
    ) ||
    !equalImportHash(
      p.projectionsHash,
      benefitDigest(
        'coupon-generation-projections',
        { scope: current, projections: v.projections },
        authority.publicationKey,
      ),
    ) ||
    !equalImportHash(
      seal,
      benefitDigest('coupon-generation-publication', body, authority.publicationKey),
    )
  )
    throw generationError('PUBLICATION');
  // Conservative source snapshot time keeps the existing bridge expiry at the
  // genuine generation deadline. No operation-specific native capture is minted.
  const document: Omit<QualifiedCouponHistory, 'signature'> = {
    scope: request,
    reader: 'bigquery',
    generationId: c.generationId,
    complete: true,
    fetchedAt: Math.min(c.capturedAt, c.control.data.observedAt),
    publication: {
      sourceCaptureHash: c.signature,
      controlHeadHash: couponHistoryControlHeadHash(request, witness, authority.sourceKey),
      queryContract: couponSourceQueryContract,
      seal: p.seal,
    },
    ...v.facts,
  };
  return assertQualifiedCouponHistory(
    { ...document, signature: couponHistoryHash(document, authority.historyKey) },
    request,
    authority.historyKey,
    now,
  );
}
