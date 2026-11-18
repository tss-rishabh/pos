import { z } from 'zod';

/**
 * Legacy global gift-voucher issuance (core/views.py:1482-1555) and the voucher -> TSS Money
 * check/top-up (order/views.py:4518-4579) have no rewrite activation flags. Top-up visibility is
 * the legacy `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT` (config.ts, `int(env, 0)`).
 * The former rewrite contract flags are no longer read.
 */
export const globalVoucherOptionsSchema = z.object({}).strip();
export type GlobalVoucherOptions = z.infer<typeof globalVoucherOptionsSchema>;
export function readGlobalVoucherOptions(
  environment: Record<string, string | undefined> = process.env,
): GlobalVoucherOptions {
  return globalVoucherOptionsSchema.parse(environment);
}
