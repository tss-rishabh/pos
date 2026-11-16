import { z } from 'zod';
import { exactVoucherValueContract } from './contracts.js';
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');
const optional = z
  .string()
  .transform((value) => value.trim() || undefined)
  .optional();
export const globalVoucherOptionsSchema = z
  .object({
    GLOBAL_VOUCHERS_ENABLED: flag,
    GLOBAL_VOUCHERS_CONTRACT: optional,
    GLOBAL_VOUCHER_VALUE_CONTRACT: z.preprocess(
      (value) => (value === undefined || value === '' ? exactVoucherValueContract : value),
      z.literal(exactVoucherValueContract),
    ),
    GLOBAL_VOUCHER_LEGACY_CONTRACT: optional,
    GLOBAL_BENEFIT_WALLET_LOCK_CONTRACT: optional,
    GLOBAL_VOUCHER_SECRET: optional,
    GLOBAL_VOUCHER_CONVERSION_ENABLED: flag,
    GLOBAL_VOUCHER_MONEY_EXPIRY_ENABLED: flag,
    GLOBAL_VOUCHER_GIFT_CARD_PIN_LIMIT: z.coerce.number().int().min(1).max(6).default(6),
    GLOBAL_VOUCHER_GIFT_CARD_PIN_LIMIT_EX: z.coerce
      .number()
      .int()
      .min(86400)
      .max(604800)
      .default(86400),
    GLOBAL_VOUCHER_GIFT_CARD_PIN_REQUIRED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    GLOBAL_VOUCHER_GIFT_CARD_DATES_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .superRefine((value, context) => {
    if (value.GLOBAL_VOUCHER_SECRET && value.GLOBAL_VOUCHER_SECRET.length < 32)
      context.addIssue({
        code: 'custom',
        path: ['GLOBAL_VOUCHER_SECRET'],
        message: 'Use at least 32 characters.',
      });
  });
export type GlobalVoucherOptions = z.infer<typeof globalVoucherOptionsSchema>;
export function readGlobalVoucherOptions(
  environment: Record<string, string | undefined> = process.env,
) {
  return globalVoucherOptionsSchema.parse(environment);
}
