import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { equalImportHash, importFinancialError } from '../financial-adapter-crypto.js';
import { benefitHash, benefitCount, benefitSourceCommit } from './contracts.js';
import { benefitDigest } from './crypto.js';
import {
  couponHistoryScopeSchema,
  qualifiedCouponHistorySchema,
  couponHistoryHash,
  assertQualifiedCouponHistory,
  type CouponHistoryScope,
  type QualifiedCouponHistory,
} from './history.js';

export const couponPublicationContract = 'pos-csv-coupon-publication-v1';
export const couponSourceCaptureContract = 'pos-csv-coupon-source-capture-v1';
export const couponHistoryWritersContract = 'pos-csv-coupon-history-all-writers-v1';
export const couponSourceQueryContract = 'pos-source-coupon-selects-2960-v1';
const timestamp = z.number().int().safe().positive();

export const couponPublicationFactsSchema = z
  .object({
    globalUsage: benefitCount,
    birthdayTodayUsage: benefitCount,
    customerOrderCount: benefitCount,
    monthlyJoinedUsage: benefitCount,
    lotCounts: qualifiedCouponHistorySchema.shape.lotCounts,
  })
  .strict()
  .refine(
    (value) => new Set(value.lotCounts.map((row) => row.couponId)).size === value.lotCounts.length,
  );
export type CouponPublicationFacts = z.infer<typeof couponPublicationFactsSchema>;

export const couponHeadSchema = z
  .object({
    kind: z.enum(['controls', 'coupon', 'customer']),
    scopeId: benefitCount,
    revision: benefitCount,
  })
  .strict();
export const couponSourceCaptureSchema = z
  .object({
    contract: z.literal(couponSourceCaptureContract),
    sourceCommit: z.literal(benefitSourceCommit),
    queryContract: z.literal(couponSourceQueryContract),
    writersContract: z.literal(couponHistoryWritersContract),
    writersDefinitionHash: benefitHash,
    scope: couponHistoryScopeSchema,
    generationId: benefitHash,
    snapshotId: z.uuid(),
    serverUuid: z.uuid(),
    sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    capturedAt: timestamp,
    finishedAt: timestamp,
    heads: z.array(couponHeadSchema).length(3),
    controlHeadHash: benefitHash,
    couponInputHash: benefitHash,
    facts: couponPublicationFactsSchema,
    factsHash: benefitHash,
    signature: benefitHash,
  })
  .strict();
export type CouponSourceCapture = z.infer<typeof couponSourceCaptureSchema>;

export const couponHistoryPublicationSchema = z
  .object({
    contract: z.literal(couponPublicationContract),
    queryContract: z.literal(couponSourceQueryContract),
    scope: couponHistoryScopeSchema,
    generationId: benefitHash,
    snapshotId: z.uuid(),
    sourceCaptureHash: benefitHash,
    controlHeadHash: benefitHash,
    sourceFactsHash: benefitHash,
    warehouseFactsHash: benefitHash,
    sourceFinishedAt: timestamp,
    sourceCdcThrough: timestamp,
    publishedAt: timestamp,
    complete: z.literal(true),
    seal: benefitHash,
  })
  .strict();
export type CouponHistoryPublication = z.infer<typeof couponHistoryPublicationSchema>;

export function couponPublicationError(kind: string, status = 409) {
  return importFinancialError('ORDER_IMPORT_COUPON_PUBLICATION_' + kind, status);
}
function keys(...values: string[]) {
  if (values.some((key) => !/^[!-~]{32,4096}$/.test(key)) || new Set(values).size !== values.length)
    throw couponPublicationError('KEY_REQUIRED', 503);
}
export function couponSourceInstant(scope: CouponHistoryScope) {
  try {
    return Temporal.PlainDateTime.from(scope.asOf.replace(' ', 'T'), {
      overflow: 'reject',
    }).toZonedDateTime(scope.sourceTimeZone, { disambiguation: 'reject' }).epochMilliseconds;
  } catch {
    throw couponPublicationError('SOURCE_CLOCK');
  }
}
export function couponFactsHash(
  scope: CouponHistoryScope,
  facts: CouponPublicationFacts,
  key: string,
) {
  return benefitDigest('coupon-publication-facts', { scope, facts }, key);
}
export function couponControlHeadHash(
  capture: Pick<
    CouponSourceCapture,
    'scope' | 'serverUuid' | 'sourceSchema' | 'writersDefinitionHash' | 'heads'
  >,
  key: string,
) {
  const { scope, serverUuid, sourceSchema, writersDefinitionHash, heads } = capture;
  return benefitDigest(
    'coupon-control-head',
    { scope, serverUuid, sourceSchema, writersDefinitionHash, heads },
    key,
  );
}
export function couponSourceCaptureHash(body: Omit<CouponSourceCapture, 'signature'>, key: string) {
  return benefitDigest('coupon-source-capture', body, key);
}
export function verifyCouponSourceCapture(value: unknown, key: string, now = Date.now()) {
  keys(key);
  const shallow = z
    .object({ heads: z.unknown(), facts: z.object({ lotCounts: z.unknown() }) })
    .safeParse(value);
  if (
    !shallow.success ||
    !Array.isArray(shallow.data.heads) ||
    shallow.data.heads.length !== 3 ||
    !Array.isArray(shallow.data.facts.lotCounts) ||
    shallow.data.facts.lotCounts.length > 1000
  )
    throw couponPublicationError('SOURCE_INVALID');
  const parsed = couponSourceCaptureSchema.safeParse(value);
  if (!parsed.success || !Number.isSafeInteger(now) || now <= 0)
    throw couponPublicationError('SOURCE_INVALID');
  const capture = parsed.data,
    { signature, ...body } = capture;
  const expectedHeads = [
    ['controls', '0'],
    ['coupon', capture.scope.couponId],
    ['customer', capture.scope.customerId],
  ];
  if (
    Buffer.byteLength(JSON.stringify(capture)) > 262144 ||
    capture.capturedAt > capture.finishedAt ||
    capture.finishedAt > now ||
    now - capture.capturedAt > 60000 ||
    couponSourceInstant(capture.scope) > capture.capturedAt ||
    capture.capturedAt - couponSourceInstant(capture.scope) > 60000 ||
    capture.heads.some(
      (head, index) =>
        head.kind !== expectedHeads[index]![0] || head.scopeId !== expectedHeads[index]![1],
    ) ||
    !equalImportHash(
      capture.controlHeadHash,
      couponControlHeadHash(
        {
          scope: capture.scope,
          serverUuid: capture.serverUuid,
          sourceSchema: capture.sourceSchema,
          writersDefinitionHash: capture.writersDefinitionHash,
          heads: capture.heads,
        },
        key,
      ),
    ) ||
    !equalImportHash(capture.factsHash, couponFactsHash(capture.scope, capture.facts, key)) ||
    !equalImportHash(signature, couponSourceCaptureHash(body, key))
  )
    throw couponPublicationError('SOURCE_INVALID');
  return capture;
}

/** The publisher receives independently queried warehouse facts, never copies
 * native counts into a declaration that the warehouse is complete. */
export function sealCouponHistoryPublication(
  supplied: unknown,
  warehouse: {
    generationId: string;
    snapshotId: string;
    sourceCaptureHash: string;
    controlHeadHash: string;
    sourceCdcThrough: number;
    facts: unknown;
  },
  authority: { sourceKey: string; publicationKey: string; historyKey: string },
  now = Date.now(),
): CouponHistoryPublication {
  keys(authority.sourceKey, authority.publicationKey, authority.historyKey);
  const capture = verifyCouponSourceCapture(supplied, authority.sourceKey, now),
    facts = couponPublicationFactsSchema.safeParse(warehouse.facts);
  if (
    !facts.success ||
    warehouse.generationId !== capture.generationId ||
    warehouse.snapshotId !== capture.snapshotId ||
    warehouse.sourceCaptureHash !== capture.signature ||
    warehouse.controlHeadHash !== capture.controlHeadHash ||
    !Number.isSafeInteger(warehouse.sourceCdcThrough) ||
    warehouse.sourceCdcThrough < capture.finishedAt ||
    warehouse.sourceCdcThrough > now ||
    !equalImportHash(
      capture.factsHash,
      couponFactsHash(capture.scope, facts.data, authority.sourceKey),
    )
  )
    throw couponPublicationError('WAREHOUSE_INCOMPLETE');
  const body = {
    contract: couponPublicationContract,
    queryContract: couponSourceQueryContract,
    scope: capture.scope,
    generationId: capture.generationId,
    snapshotId: capture.snapshotId,
    sourceCaptureHash: capture.signature,
    controlHeadHash: capture.controlHeadHash,
    sourceFactsHash: couponFactsHash(capture.scope, capture.facts, authority.publicationKey),
    warehouseFactsHash: couponFactsHash(capture.scope, facts.data, authority.publicationKey),
    sourceFinishedAt: capture.finishedAt,
    sourceCdcThrough: warehouse.sourceCdcThrough,
    publishedAt: now,
    complete: true as const,
  };
  return couponHistoryPublicationSchema.parse({
    ...body,
    seal: benefitDigest('coupon-publication', body, authority.publicationKey),
  });
}

export function qualifyCouponPublishedFacts(
  value: unknown,
  scope: CouponHistoryScope,
  facts: unknown,
  authority: { publicationKey: string; historyKey: string },
  now = Date.now(),
) {
  keys(authority.publicationKey, authority.historyKey);
  const publication = couponHistoryPublicationSchema.safeParse(value),
    selection = couponPublicationFactsSchema.safeParse(facts),
    expected = couponHistoryScopeSchema.safeParse(scope);
  if (
    !publication.success ||
    !selection.success ||
    !expected.success ||
    !Number.isSafeInteger(now) ||
    now <= 0
  )
    throw couponPublicationError('INVALID');
  const p = publication.data,
    { seal, ...body } = p;
  if (
    JSON.stringify(p.scope) !== JSON.stringify(expected.data) ||
    p.publishedAt > now ||
    p.sourceFinishedAt > p.sourceCdcThrough ||
    p.sourceCdcThrough > p.publishedAt ||
    p.publishedAt - p.sourceFinishedAt > 60000 ||
    now - p.sourceFinishedAt > 60000 ||
    couponSourceInstant(p.scope) > p.sourceFinishedAt ||
    p.sourceFinishedAt - couponSourceInstant(p.scope) > 60000 ||
    !equalImportHash(p.sourceFactsHash, p.warehouseFactsHash) ||
    !equalImportHash(
      p.warehouseFactsHash,
      couponFactsHash(p.scope, selection.data, authority.publicationKey),
    ) ||
    !equalImportHash(seal, benefitDigest('coupon-publication', body, authority.publicationKey))
  )
    throw couponPublicationError('INVALID');
  const document: Omit<QualifiedCouponHistory, 'signature'> = {
    scope: p.scope,
    reader: 'bigquery' as const,
    generationId: p.generationId,
    complete: true as const,
    fetchedAt: now,
    publication: {
      sourceCaptureHash: p.sourceCaptureHash,
      controlHeadHash: p.controlHeadHash,
      queryContract: couponSourceQueryContract,
      seal: p.seal,
    },
    ...selection.data,
  };
  return assertQualifiedCouponHistory(
    { ...document, signature: couponHistoryHash(document, authority.historyKey) },
    scope,
    authority.historyKey,
    now,
  );
}
