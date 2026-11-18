import { z } from 'zod';

/**
 * Customer OTP is always on, as legacy: API-v2 generates and delivers the code. These are POS-side
 * limits only (listed as security decisions in the W4 report).
 */
export function readCustomerOtpOptions(env: NodeJS.ProcessEnv = process.env) {
  const blank = (value: unknown) => (value === '' ? undefined : value);
  return z
    .object({
      /** Codes requested per customer per business day (anti SMS-bombing; legacy has none). */
      CUSTOMER_OTP_SENDS_PER_DAY: z.preprocess(
        blank,
        z.coerce.number().int().min(1).max(50).default(6),
      ),
      /** Wrong codes accepted per challenge before it locks (API-v2 itself has no limit). */
      CUSTOMER_OTP_FAILURES_PER_WINDOW: z.preprocess(
        blank,
        z.coerce.number().int().min(1).max(10).default(5),
      ),
      /** Legacy `REDIS_VERIFIED_USER_OBJECT_EXPIRY` (seconds) for the verified-customer flag. */
      REDIS_VERIFIED_USER_OBJECT_EXPIRY: z.preprocess(
        blank,
        z.coerce.number().int().min(60).max(86400).default(900),
      ),
    })
    .parse(env);
}
export type CustomerOtpOptions = ReturnType<typeof readCustomerOtpOptions>;
