import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { benefitDigest } from './crypto.js';
import { benefitHash, benefitTimestamp } from './contracts.js';
import { couponWarehouseKeys } from './history-warehouse-contracts.js';
import { couponHistoryWritersDefinitionHash } from './history-writers.js';
import { equalImportHash, importFinancialError } from '../financial-adapter-primitives.js';
export const generationControlContract = 'pos-csv-coupon-generation-controls-v1';
export const generationPositiveId = z
  .string()
  .min(1)
  .max(19)
  .refine((v) => {
    try {
      return (
        /^[1-9][0-9]*$/.test(v) && BigInt(v).toString() === v && BigInt(v) <= 9223372036854775807n
      );
    } catch {
      return false;
    }
  });
export const generationSignedId = z
  .string()
  .min(1)
  .max(20)
  .refine((v) => {
    try {
      return (
        /^(?:0|-?[1-9][0-9]*)$/.test(v) &&
        BigInt(v).toString() === v &&
        BigInt(v) >= -9223372036854775808n &&
        BigInt(v) <= 9223372036854775807n
      );
    } catch {
      return false;
    }
  });
const id = generationPositiveId,
  time = z.number().int().positive().safe(),
  revision = z
    .string()
    .min(1)
    .max(20)
    .refine((v) => {
      try {
        return (
          /^(?:0|[1-9][0-9]*)$/.test(v) &&
          BigInt(v).toString() === v &&
          BigInt(v) <= 18446744073709551615n
        );
      } catch {
        return false;
      }
    });
export const generationControlDataSchema = z
  .object({
    contract: z.literal(generationControlContract),
    couponId: id,
    configurationHash: benefitHash,
    couponInputHash: benefitHash,
    sourceTimeZone: z.string().min(1).max(100),
    sourceDay: z.iso.date(),
    sourceAsOf: benefitTimestamp,
    serverUuid: z.uuid(),
    sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    writersContract: z.literal('pos-csv-coupon-history-all-writers-v1'),
    writersDefinitionHash: benefitHash,
    heads: z.tuple([
      z.object({ kind: z.literal('controls'), scopeId: z.literal('0'), revision }).strict(),
      z.object({ kind: z.literal('coupon'), scopeId: id, revision }).strict(),
    ]),
    observedAt: time,
    expiresAt: time,
  })
  .strict();
export const generationControlEnvelopeSchema = z
  .object({ data: generationControlDataSchema, proofHash: benefitHash })
  .strict();
export type GenerationControlDescriptor = z.infer<typeof generationControlEnvelopeSchema>;
export interface GenerationControlPort {
  read(signal: AbortSignal): Promise<GenerationControlDescriptor>;
}
const invalid = () =>
  importFinancialError('ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_CONTROL_REQUIRED', 503);
/** Producer is source-owned. Node never reconstructs cache/settings or replaces
 * configurationHash with a coupon-only hash. */
export function verifyGenerationControl(
  value: unknown,
  key: string,
  now = Date.now(),
): GenerationControlDescriptor {
  couponWarehouseKeys(key);
  const parsed = generationControlEnvelopeSchema.safeParse(value);
  if (
    !parsed.success ||
    Buffer.byteLength(JSON.stringify(parsed.data)) > 16000 ||
    !Number.isSafeInteger(now) ||
    now <= 0
  )
    throw invalid();
  const v = parsed.data,
    d = v.data;
  let point: number, end: number;
  try {
    const day = Temporal.PlainDateTime.from(d.sourceAsOf.replace(' ', 'T')).toZonedDateTime(
      d.sourceTimeZone,
      { disambiguation: 'reject' },
    );
    point = day.epochMilliseconds;
    end = day.startOfDay().add({ days: 1 }).epochMilliseconds;
  } catch {
    throw invalid();
  }
  if (
    d.sourceAsOf.slice(0, 10) !== d.sourceDay ||
    point > d.observedAt ||
    d.observedAt - point >= 1000 ||
    d.observedAt > now ||
    now >= d.expiresAt ||
    d.expiresAt > d.observedAt + 60000 ||
    d.expiresAt > end ||
    d.heads[1].scopeId !== d.couponId ||
    BigInt(d.heads[0].revision) < 1n ||
    d.writersDefinitionHash !== couponHistoryWritersDefinitionHash ||
    !equalImportHash(v.proofHash, benefitDigest('coupon-generation-config', d, key))
  )
    throw invalid();
  return v;
}
