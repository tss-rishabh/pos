import { z } from 'zod';

/** Offline billing limits (AGENTS.md revisions, 19 Nov 2026): backend
 * environment, not tss_settings. Delivered to desktops on each online contact. */
const positive = (fallback: number) =>
  z.preprocess(
    (value) => (value === undefined || value === '' ? undefined : value),
    z.coerce.number().int().positive().max(1_000_000).default(fallback),
  );
const optionsSchema = z.object({
  OFFLINE_BILLING_MAX_MINUTES: positive(120),
  OFFLINE_BILLING_MAX_ORDERS: positive(10),
});
export interface OfflineBillingLimits {
  maxMinutes: number;
  maxOrders: number;
}
export function readOfflineBillingOptions(
  env: NodeJS.ProcessEnv = process.env,
): OfflineBillingLimits {
  const value = optionsSchema.parse({
    OFFLINE_BILLING_MAX_MINUTES: env.OFFLINE_BILLING_MAX_MINUTES,
    OFFLINE_BILLING_MAX_ORDERS: env.OFFLINE_BILLING_MAX_ORDERS,
  });
  return {
    maxMinutes: value.OFFLINE_BILLING_MAX_MINUTES,
    maxOrders: value.OFFLINE_BILLING_MAX_ORDERS,
  };
}
