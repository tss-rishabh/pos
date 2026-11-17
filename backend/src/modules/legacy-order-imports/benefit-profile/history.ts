import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { identifier } from '../../../domain/validation.js';
import { benefitDigest } from './crypto.js';
import { equalImportHash, importFinancialError } from '../financial-adapter-crypto.js';
import { benefitCount, benefitHash, benefitTimestamp } from './contracts.js';

export const couponHistoryContract = 'pos-csv-coupon-history-v1';
export const couponHistoryScopeSchema = z
  .object({
    contract: z.literal(couponHistoryContract),
    operationId: z.uuid(),
    requestHash: benefitHash,
    planHash: benefitHash,
    customerId: identifier,
    couponId: identifier,
    configurationHash: benefitHash,
    asOf: benefitTimestamp,
    /** Exact source datetime.now clock and SQL CONVERT_TZ window are qualified separately. */
    sourceTimeZone: z.string().min(1).max(100),
  })
  .strict()
  .refine((value) => {
    try {
      Temporal.PlainDateTime.from(value.asOf.replace(' ', 'T')).toZonedDateTime(
        value.sourceTimeZone,
      );
      return true;
    } catch {
      return false;
    }
  });
/** These are results of the literal source SELECTs, not a normalized business interpretation.
 * monthlyJoinedUsage/lotCounts retain the source user+coupon join multiplication.
 */
export const qualifiedCouponHistorySchema = z
  .object({
    scope: couponHistoryScopeSchema,
    reader: z.literal('bigquery'),
    generationId: benefitHash,
    complete: z.literal(true),
    fetchedAt: z.number().int().safe().positive(),
    publication: z
      .object({
        sourceCaptureHash: benefitHash,
        controlHeadHash: benefitHash,
        queryContract: z.literal('pos-source-coupon-selects-2960-v1'),
        seal: benefitHash,
      })
      .strict(),
    globalUsage: benefitCount,
    birthdayTodayUsage: benefitCount,
    customerOrderCount: benefitCount,
    monthlyJoinedUsage: benefitCount,
    lotCounts: z
      .array(
        z
          .object({
            couponId: identifier,
            sameCode: z.boolean(),
            noTimesAllowed: benefitCount,
            uniqueNoTimesAllowed: benefitCount,
            usedCount: benefitCount,
          })
          .strict(),
      )
      .max(1000),
    signature: benefitHash,
  })
  .strict()
  .refine(
    (value) => new Set(value.lotCounts.map((row) => row.couponId)).size === value.lotCounts.length,
  );
export type CouponHistoryScope = z.infer<typeof couponHistoryScopeSchema>;
export type QualifiedCouponHistory = z.infer<typeof qualifiedCouponHistorySchema>;
export interface CsvCouponHistoryPort {
  read(scope: CouponHistoryScope): Promise<QualifiedCouponHistory>;
}
export const couponHistoryHash = (value: Omit<QualifiedCouponHistory, 'signature'>, key: string) =>
  benefitDigest('coupon-history', value, key);
export function assertQualifiedCouponHistory(
  value: unknown,
  scope: CouponHistoryScope,
  key: string,
  now = Date.now(),
) {
  const error = () => importFinancialError('ORDER_IMPORT_COUPON_HISTORY_UNQUALIFIED');
  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    Buffer.byteLength(key) < 32 ||
    Buffer.byteLength(key) > 4096
  )
    throw error();
  const bounded = z.object({ lotCounts: z.array(z.unknown()).max(1000) }).safeParse(value);
  if (!bounded.success) throw error();
  const parsed = qualifiedCouponHistorySchema.safeParse(value),
    expected = couponHistoryScopeSchema.safeParse(scope);
  if (!parsed.success || !expected.success) throw error();
  const facts = parsed.data,
    { signature, ...body } = facts;
  if (
    Buffer.byteLength(JSON.stringify(facts)) > 262144 ||
    JSON.stringify(facts.scope) !== JSON.stringify(expected.data) ||
    facts.fetchedAt > now ||
    now - facts.fetchedAt > 60000 ||
    !equalImportHash(signature, couponHistoryHash(body, key))
  )
    throw error();
  return facts;
}
/** Call outside SQL, BEFORE source dispatch allocates its order nonce. Missing
 * publication is a definite local no-effect preparation failure, never an unknown source stage.
 */
export async function preloadCouponHistory(
  port: CsvCouponHistoryPort,
  scope: CouponHistoryScope,
  key: string,
  clock = Date.now,
) {
  const request = couponHistoryScopeSchema.parse(scope);
  return assertQualifiedCouponHistory(await port.read(request), request, key, clock());
}
