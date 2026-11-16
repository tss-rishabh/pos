import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

const date = z.iso.date().refine((value) => {
  try {
    return Temporal.PlainDate.from(value).year >= 1000;
  } catch {
    return false;
  }
}, 'Choose a valid source date.');
const resource = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/,
  );
const optionalResource = z.preprocess(
  (value) => (value === '' ? undefined : value),
  resource.optional(),
);
export function readSpecialPermissionHistoryOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      BQ_SPECIAL_PERMISSION_ACTIVITY_VIEW: optionalResource,
      BQ_SPECIAL_PERMISSION_ACTIVITY_MATCH_UDF: optionalResource,
    })
    .parse(env);
}
export type SpecialPermissionHistoryOptions = ReturnType<
  typeof readSpecialPermissionHistoryOptions
>;
export const activityPlatforms = [
  'barcode',
  'Tss Money',
  'Tss Points',
  'Gift Voucher',
  'Gift Card',
] as const;
export const activitySearchInput = z
  .object({
    from: date.nullable().default(null),
    to: date.nullable().default(null),
    platforms: z.array(z.string().max(255)).max(20).default([]),
    search: z.string().max(255).default(''),
    start: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).default(0),
    length: z.number().int().min(1).max(500).default(10),
    draw: z.number().int().min(-2147483648).max(2147483647).default(1),
    order: z
      .object({ column: z.number().int().min(0).max(5), direction: z.enum(['asc', 'desc']) })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.from === null) === (value.to === null),
    'Choose both dates or all history.',
  )
  .refine(
    (value) => !value.from || !value.to || value.from <= value.to,
    'Choose the dates in order.',
  );
export type ActivitySearchInput = z.infer<typeof activitySearchInput>;
export const sourceId = z
  .string()
  .regex(/^(?:0|-?[1-9]\d{0,18})$/)
  .refine(
    (value) => BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n,
  );
export const countValue = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
export const activityProjection = z
  .object({
    id: sourceId,
    actorExists: z.boolean(),
    firstName: z.string().max(150).nullable(),
    lastName: z.string().max(150).nullable(),
    platform: z.string().max(255),
    comment: z.string().max(255).nullable(),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/),
    recipient: z.string().max(45).nullable(),
  })
  .refine(
    (value) => !value.actorExists || (value.firstName !== null && value.lastName !== null),
    'The activity projection must preserve current operator names.',
  );
export type ActivityProjection = z.infer<typeof activityProjection>;
