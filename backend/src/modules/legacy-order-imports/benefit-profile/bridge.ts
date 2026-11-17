import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { equalImportHash, importFinancialError } from '../financial-adapter-crypto.js';
import { benefitDigest } from './crypto.js';
import { benefitHash, benefitTimestamp } from './contracts.js';
import {
  assertQualifiedCouponHistory,
  couponHistoryScopeSchema,
  qualifiedCouponHistorySchema,
  type CouponHistoryScope,
  type CsvCouponHistoryPort,
} from './history.js';

const time = z.number().int().safe().positive();
const revision = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
export const couponHistoryWitnessSchema = z
  .object({
    writersContract: z.literal('pos-csv-coupon-history-all-writers-v1'),
    writersDefinitionHash: benefitHash,
    serverUuid: z.uuid(),
    sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    heads: z.tuple([
      z.object({ kind: z.literal('controls'), scopeId: z.literal('0'), revision }).strict(),
      z.object({ kind: z.literal('coupon'), scopeId: identifier, revision }).strict(),
      z.object({ kind: z.literal('customer'), scopeId: identifier, revision }).strict(),
    ]),
  })
  .strict();
export type CouponHistoryWitness = z.infer<typeof couponHistoryWitnessSchema>;
export const birthdayObservationSchema = z
  .object({
    contract: z.literal('pos-csv-birthday-cooperative-guard-v1'),
    operationId: z.uuid(),
    requestHash: benefitHash,
    customerId: identifier,
    observedAt: time,
    present: z.boolean(),
    signature: benefitHash,
  })
  .strict();
export type BirthdayObservation = z.infer<typeof birthdayObservationSchema>;
export const csvCouponPrefetchContract = 'pos-csv-coupon-prefetch-v1';
export const csvCouponPrefetchMaximumBytes = 300000;
export const csvCouponPrefetchCapabilitySchema = z
  .object({
    contract: z.literal(csvCouponPrefetchContract),
    scope: couponHistoryScopeSchema,
    generationId: benefitHash,
    documentHash: benefitHash,
    controlHeadHash: benefitHash,
    guardObservationHash: benefitHash,
    expiresAt: time,
    signature: benefitHash,
  })
  .strict();
export const csvCouponPrefetchSchema = z
  .object({
    document: qualifiedCouponHistorySchema,
    capability: csvCouponPrefetchCapabilitySchema,
    witness: couponHistoryWitnessSchema,
    guardObservation: birthdayObservationSchema,
  })
  .strict();
export type CsvCouponPrefetch = z.infer<typeof csvCouponPrefetchSchema>;
export interface CsvCouponPrefetchOptions {
  historyKey: string;
  sourceProofKey: string;
  guardKey: string;
  clock?: () => number;
}
const invalid = () => importFinancialError('ORDER_IMPORT_COUPON_PREFETCH_INVALID');
function safe<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
function keys(options: CsvCouponPrefetchOptions) {
  const values = [options.historyKey, options.sourceProofKey, options.guardKey];
  if (
    values.some((value) => !/^[!-~]{32,4096}$/.test(value)) ||
    new Set(values).size !== values.length
  )
    throw invalid();
}
export function couponSourceInstant(value: string, zone: string) {
  try {
    return Temporal.PlainDateTime.from(safe(benefitTimestamp, value).replace(' ', 'T'))
      .toZonedDateTime(zone, { disambiguation: 'reject' })
      .toInstant().epochMilliseconds;
  } catch {
    throw invalid();
  }
}
export function couponHistoryControlHeadHash(
  scope: CouponHistoryScope,
  witness: CouponHistoryWitness,
  sourceProofKey: string,
) {
  const checkedScope = safe(couponHistoryScopeSchema, scope),
    checked = safe(couponHistoryWitnessSchema, witness);
  if (
    checked.heads[1].scopeId !== checkedScope.couponId ||
    checked.heads[2].scopeId !== checkedScope.customerId
  )
    throw invalid();
  return benefitDigest(
    'coupon-control-head',
    {
      scope: checkedScope,
      serverUuid: checked.serverUuid,
      sourceSchema: checked.sourceSchema,
      writersDefinitionHash: checked.writersDefinitionHash,
      heads: checked.heads,
    },
    sourceProofKey,
  );
}
function observation(
  supplied: unknown,
  scope: CouponHistoryScope,
  options: CsvCouponPrefetchOptions,
  now: number,
) {
  const value = safe(birthdayObservationSchema, supplied),
    { signature, ...body } = value;
  if (
    value.operationId !== scope.operationId ||
    value.requestHash !== scope.requestHash ||
    value.customerId !== scope.customerId ||
    value.observedAt > now ||
    now - value.observedAt >= 60000 ||
    !equalImportHash(signature, benefitDigest('birthday-observation', body, options.guardKey))
  )
    throw invalid();
  return value;
}
function expiry(scope: CouponHistoryScope, fetchedAt: number, observedAt: number) {
  const point = couponSourceInstant(scope.asOf, scope.sourceTimeZone),
    dayEnd = Temporal.Instant.fromEpochMilliseconds(point)
      .toZonedDateTimeISO(scope.sourceTimeZone)
      .startOfDay()
      .add({ days: 1 }).epochMilliseconds;
  return Math.min(point + 60000, fetchedAt + 60000, observedAt + 60000, dayEnd);
}
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
/** Pure validation suitable for the native sealed artifact and source dispatch.
 * This verifies a declared source witness, not the all-writer deployment. The
 * source's mandatory late head validator must independently hold at COMMIT. */
export function assertCsvCouponPrefetch(
  supplied: unknown,
  expected: CouponHistoryScope,
  options: CsvCouponPrefetchOptions,
): CsvCouponPrefetch {
  keys(options);
  const now = (options.clock ?? Date.now)();
  if (!Number.isSafeInteger(now) || now <= 0) throw invalid();
  try {
    if (Buffer.byteLength(JSON.stringify(supplied)) > csvCouponPrefetchMaximumBytes)
      throw invalid();
  } catch {
    throw invalid();
  }
  const scope = safe(couponHistoryScopeSchema, expected),
    outer = safe(
      z
        .object({
          document: z.unknown(),
          capability: z.unknown(),
          witness: z.unknown(),
          guardObservation: z.unknown(),
        })
        .strict(),
      supplied,
    ),
    document = assertQualifiedCouponHistory(outer.document, scope, options.historyKey, now),
    capability = safe(csvCouponPrefetchCapabilitySchema, outer.capability),
    witness = safe(couponHistoryWitnessSchema, outer.witness),
    guardObservation = observation(outer.guardObservation, scope, options, now),
    controlHash = couponHistoryControlHeadHash(scope, witness, options.sourceProofKey),
    { signature, ...body } = capability;
  if (
    JSON.stringify(capability.scope) !== JSON.stringify(scope) ||
    capability.generationId !== document.generationId ||
    capability.documentHash !==
      benefitDigest('coupon-history-document', document, options.historyKey) ||
    capability.controlHeadHash !== controlHash ||
    document.publication.controlHeadHash !== controlHash ||
    capability.guardObservationHash !==
      benefitDigest('birthday-observation-document', guardObservation, options.historyKey) ||
    capability.expiresAt > expiry(scope, document.fetchedAt, guardObservation.observedAt) ||
    now >= capability.expiresAt ||
    couponSourceInstant(scope.asOf, scope.sourceTimeZone) > now ||
    !equalImportHash(signature, benefitDigest('coupon-prefetch', body, options.historyKey))
  )
    throw invalid();
  return freeze({ document, capability, witness, guardObservation });
}
/** Outside SQL only. No document, generation, legacy absence or current-head
 * proof is manufactured if the configured BQ-only port cannot supply one. */
export async function prefetchCsvCouponHistory(
  reader: CsvCouponHistoryPort,
  expected: CouponHistoryScope,
  witnessInput: CouponHistoryWitness,
  guardInput: BirthdayObservation,
  options: CsvCouponPrefetchOptions,
  request: { signal: AbortSignal; expiresAt: number },
): Promise<CsvCouponPrefetch> {
  keys(options);
  request.signal.throwIfAborted();
  const now = (options.clock ?? Date.now)();
  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.expiresAt <= now ||
    request.expiresAt > now + 60000
  )
    throw invalid();
  const scope = freeze(safe(couponHistoryScopeSchema, structuredClone(expected))),
    witness = freeze(safe(couponHistoryWitnessSchema, structuredClone(witnessInput))),
    guardObservation = freeze(safe(birthdayObservationSchema, structuredClone(guardInput)));
  couponHistoryControlHeadHash(scope, witness, options.sourceProofKey);
  observation(guardObservation, scope, options, now);
  const document = assertQualifiedCouponHistory(
    await reader.read(scope, { witness, signal: request.signal }),
    scope,
    options.historyKey,
    (options.clock ?? Date.now)(),
  );
  request.signal.throwIfAborted();
  const body: Omit<CsvCouponPrefetch['capability'], 'signature'> = {
    contract: csvCouponPrefetchContract,
    scope,
    generationId: document.generationId,
    documentHash: benefitDigest('coupon-history-document', document, options.historyKey),
    controlHeadHash: couponHistoryControlHeadHash(scope, witness, options.sourceProofKey),
    guardObservationHash: benefitDigest(
      'birthday-observation-document',
      guardObservation,
      options.historyKey,
    ),
    expiresAt: Math.min(
      request.expiresAt,
      expiry(scope, document.fetchedAt, guardObservation.observedAt),
    ),
  };
  return assertCsvCouponPrefetch(
    {
      document,
      capability: {
        ...body,
        signature: benefitDigest('coupon-prefetch', body, options.historyKey),
      },
      witness,
      guardObservation,
    },
    scope,
    options,
  );
}
