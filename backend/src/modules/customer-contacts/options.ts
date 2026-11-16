import { z } from 'zod';
import { contactChangeContract, contactEffectsContract } from './contracts.js';
const optional = <T extends z.ZodType>(value: T) =>
  z.preprocess((input) => (input === '' ? undefined : input), value.optional());
const flag = z.preprocess(
  (value) =>
    value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
  z.boolean(),
);
const secret = z.string().regex(/^[\x21-\x7e]{32,4096}$/);
export function readCustomerContactOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      CUSTOMER_CONTACTS_ENABLED: flag,
      CUSTOMER_CONTACTS_CONTRACT: optional(z.literal(contactChangeContract)),
      CUSTOMER_CONTACTS_SECRET: optional(secret),
      CUSTOMER_REGISTRATION_SECRET: optional(secret),
      RESEND_COUNT: z.coerce.number().int().min(1).max(10).default(6),
      VERIFICATION_COUNT: z.coerce.number().int().min(1).max(5).default(3),
      CHANGE_MOBILE_OTP_EXPIRY_IN_SEC: z.coerce.number().int().min(60).max(600).default(600),
      CUSTOMER_CONTACTS_WORKER_ENABLED: flag,
      CUSTOMER_CONTACTS_WORKER_INTERVAL_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(60000)
        .default(2000),
      CUSTOMER_CONTACTS_WORKER_LEASE_MS: z.coerce
        .number()
        .int()
        .min(30000)
        .max(300000)
        .default(60000),
      CUSTOMER_CONTACT_SMS_TEMPLATE: optional(
        z
          .string()
          .min(10)
          .max(1000)
          .refine(
            (value) => value.split('{{code}}').length === 2,
            'Configure exactly one code placeholder in the approved contact SMS template.',
          ),
      ),
      CUSTOMER_CONTACT_EFFECTS_URL: optional(z.url()),
      CUSTOMER_CONTACT_EFFECTS_KEY: optional(secret),
      CUSTOMER_CONTACT_EFFECTS_CONTRACT: optional(z.literal(contactEffectsContract)),
      CUSTOMER_CONTACT_EFFECTS_REPLAY_SAFE: flag,
      REFUND_SUCCESS_STATUS: z.literal('SUCCESS').default('SUCCESS'),
      REFUND_FAILED_STATUS: z.literal('FAILED').default('FAILED'),
    })
    .parse(env);
}
export type CustomerContactOptions = ReturnType<typeof readCustomerContactOptions>;
