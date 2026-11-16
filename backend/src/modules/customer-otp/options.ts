import { z } from 'zod';

const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');
const text = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());
const template = text.refine(
  (value) =>
    value === undefined ||
    (value.length <= 1000 &&
      value.split('{{code}}').length === 2 &&
      !value.replace('{{code}}', '').includes('{{')),
  'A purpose template must contain exactly one code placeholder.',
);
export function readCustomerOtpOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      CUSTOMER_OTP_ENABLED: flag,
      CUSTOMER_OTP_CONTRACT: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.literal('pos-customer-otp-v1').optional(),
      ),
      CUSTOMER_OTP_SECRET: text.refine((value) => value === undefined || value.length >= 32),
      CUSTOMER_OTP_WORKER_ENABLED: flag,
      CUSTOMER_OTP_TEMPLATE_CONTRACT: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.literal('pos-customer-otp-purpose-v1').optional(),
      ),
      CUSTOMER_OTP_CHECKOUT_SMS_TEMPLATE: template,
      CUSTOMER_OTP_RETURN_SMS_TEMPLATE: template,
      CUSTOMER_OTP_CHECKOUT_EMAIL_TEMPLATE: template,
      CUSTOMER_OTP_RETURN_EMAIL_TEMPLATE: template,
      CUSTOMER_OTP_WHATSAPP_FALLBACK_ENABLED: flag,
      CUSTOMER_OTP_WHATSAPP_DELAY_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
      CUSTOMER_OTP_CHECKOUT_WHATSAPP_TEMPLATE: template,
      CUSTOMER_OTP_RETURN_WHATSAPP_TEMPLATE: template,
      CUSTOMER_OTP_MOBILE_FOR_EMPLOYEES: flag,
      CUSTOMER_OTP_SENDS_PER_DAY: z.coerce.number().int().min(1).max(10).default(6),
      CUSTOMER_OTP_FAILURES_PER_WINDOW: z.coerce.number().int().min(1).max(10).default(5),
      CUSTOMER_OTP_FAILURES_PER_DAY: z.coerce.number().int().min(1).max(50).default(30),
      CUSTOMER_OTP_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(30000).default(1000),
      CUSTOMER_OTP_LEASE_MS: z.coerce.number().int().min(10000).max(120000).default(30000),
    })
    .parse(env);
}
export type CustomerOtpOptions = ReturnType<typeof readCustomerOtpOptions>;
