import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { CheckoutState, CustomerIdentity } from '../contracts.js';
import { wireId } from '../payloads.js';

export const registrationDetailsSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(45)
      .regex(/^[^\u0000-\u001f\u007f<>]+$/u),
    telephone: z.string().regex(/^[6-9]\d{9}$/),
    email: z.union([z.email().max(254), z.literal('')]).default(''),
    birthdate: z.union([z.iso.date(), z.literal('')]).default(''),
    customerType: z.enum(['B2B', 'B2C']),
    gstin: z.string().trim().toUpperCase().max(15).default(''),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.customerType === 'B2B' &&
      !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value.gstin)
    )
      context.addIssue({
        code: 'custom',
        path: ['gstin'],
        message: 'Enter a valid 15-character GSTIN for B2B.',
      });
    if (value.customerType === 'B2C' && value.gstin)
      context.addIssue({
        code: 'custom',
        path: ['gstin'],
        message: 'B2C registration must not include a GSTIN.',
      });
    // The pinned upstream uses this narrower email rule. Reject before creating
    // an ambiguous external registration rather than silently rewriting a contact.
    if (value.email && !/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/.test(value.email))
      context.addIssue({
        code: 'custom',
        path: ['email'],
        message: 'This email format is not supported by customer registration.',
      });
  });
export type RegistrationDetails = z.infer<typeof registrationDetailsSchema>;
export function validateRegistrationDetails(
  value: unknown,
  timeZone: string,
  now = Date.now(),
): RegistrationDetails {
  const details = registrationDetailsSchema.parse(value);
  if (details.birthdate) {
    const date = Temporal.PlainDate.from(details.birthdate),
      today = Temporal.Instant.fromEpochMilliseconds(now)
        .toZonedDateTimeISO(timeZone)
        .toPlainDate();
    if (date.year < 1900 || Temporal.PlainDate.compare(date, today) > 0)
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['birthdate'],
          message: 'Enter a birthdate from 1900 through today.',
        },
      ]);
  }
  return details;
}
export function registrationPayload(details: RegistrationDetails, storeId: string) {
  return {
    first_name: details.name,
    telephone: Number(details.telephone),
    email: details.email || `${details.telephone}@temp.id`,
    customer_type: details.customerType,
    gstin: details.gstin,
    birthdate: details.birthdate,
    localcart: {},
    store_id: wireId(storeId),
    pos_localcart: {},
  };
}
export type RegistrationStatus =
  'pending' | 'verified' | 'dispatching' | 'registered' | 'uncertain' | 'expired' | 'locked';
export interface PublicRegistration {
  id: string;
  status: RegistrationStatus;
  expiresAt: number;
  retryAt: number;
  attemptsRemaining: number;
  customerId: string | null;
  verifiedAt: number | null;
  deliveries: { channel: 'sms' | 'whatsapp'; status: string }[];
}
export interface CustomerRegistrations {
  request(
    state: CheckoutState,
    id: string,
    input: RegistrationDetails,
  ): Promise<PublicRegistration>;
  read(state: CheckoutState): Promise<PublicRegistration | null>;
  verify(state: CheckoutState, code: string): Promise<PublicRegistration>;
  resend(state: CheckoutState, operationId: string): Promise<PublicRegistration>;
  cancel(state: CheckoutState): Promise<boolean>;
  verifiedCustomerUntil(state: CheckoutState, customer: CustomerIdentity): Promise<number | null>;
  register(state: CheckoutState): Promise<PublicRegistration>;
  reconcile(state: CheckoutState): Promise<PublicRegistration>;
}
