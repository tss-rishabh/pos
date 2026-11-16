import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { customerContactBindingSchema } from './customer-contact-authority.js';

export const customerConsentContract = 'pos-customer-contact-consent-v1';
export interface CustomerConsentConfiguration {
  customerConsentContract?: string;
  checkoutProjectionKey?: string;
}
const signedIdentifier = identifier.refine(
  (value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
);
export const customerConsentSchema = z
  .object({
    v: z.literal(1),
    contract: z.literal(customerConsentContract),
    orderId: signedIdentifier,
    customerId: signedIdentifier,
    operatorId: signedIdentifier,
    storeId: signedIdentifier,
    counterId: signedIdentifier,
    contact: customerContactBindingSchema,
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
export type CustomerConsent = z.infer<typeof customerConsentSchema>;
export function assertCustomerConsentReady(environment: CustomerConsentConfiguration) {
  if (
    environment.customerConsentContract !== customerConsentContract ||
    !environment.checkoutProjectionKey ||
    !/^[!-~]{32,4096}$/.test(environment.checkoutProjectionKey)
  )
    throw new AppError(
      503,
      'CUSTOMER_CONSENT_CONTRACT_UNVERIFIED',
      'Customer contact and benefit consent must be verified before creating an order.',
    );
}
export function signCustomerConsent(value: CustomerConsent, key: string, now = Date.now()) {
  const consent = customerConsentSchema.parse(value);
  if (!/^[!-~]{32,4096}$/.test(key) || consent.expiresAt <= now || consent.expiresAt > now + 900000)
    throw new AppError(
      403,
      'CUSTOMER_VERIFICATION_REQUIRED',
      'Verify this customer again before confirming these benefits.',
    );
  const encoded = Buffer.from(JSON.stringify(consent), 'utf8').toString('base64url');
  return (
    encoded +
    '.' +
    createHmac('sha256', key)
      .update(customerConsentContract + '\n' + encoded, 'utf8')
      .digest('hex')
  );
}
