import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { customerContactBindingSchema } from '../checkout/customer-contact-authority.js';

const base = {
  operatorId: identifier,
  storeId: identifier,
  counterId: identifier,
  customerId: identifier,
  subjectId: z.uuid(),
};
/** Checkout benefits only: returns, exchanges and date extension have no customer OTP (legacy). */
export const customerOtpScopeSchema = z
  .object({ ...base, purpose: z.literal('checkout-benefits'), orderId: z.null() })
  .strict();
export type CustomerOtpScope = z.infer<typeof customerOtpScopeSchema>;
export type CustomerOtpPurpose = CustomerOtpScope['purpose'];
export const customerOtpViewSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(['pending', 'sent', 'uncertain', 'rejected']),
    expiresAt: z.number().int().nonnegative(),
    verifiedUntil: z.number().int().nonnegative().nullable(),
    contact: customerContactBindingSchema,
  })
  .strict();
export type CustomerOtpView = z.infer<typeof customerOtpViewSchema>;
export const customerOtpErrorSchema = z.enum([
  'CUSTOMER_OTP_INVALID',
  'CUSTOMER_OTP_ATTEMPT_LIMIT',
  'CUSTOMER_OTP_NOT_SENT',
]);
export const customerOtpOperationViewSchema = z
  .object({
    kind: z.enum(['request', 'verify']),
    result: customerOtpViewSchema.nullable(),
    error: customerOtpErrorSchema.nullable(),
  })
  .strict();
export type CustomerOtpOperationView = z.infer<typeof customerOtpOperationViewSchema>;

/**
 * One API-v2 answer. `null` means no readable answer arrived (network error, timeout, redirect
 * or unreadable body), so the outcome is unknown.
 */
export type CustomerOtpApiReply = { status: number; body: unknown } | null;
/**
 * API-v2 `omnichannel-sendotp` / `omnichannel-verifyotp`, called synchronously as legacy
 * `order/views.py:2549-2560` and `:2584-2597` do. Tests replace it with a fake.
 */
export interface CustomerOtpApi {
  /** Throws 503 when the API-v2 base URL is missing or not HTTPS. */
  assertReady(): void;
  sendOtp(userId: number | bigint): Promise<CustomerOtpApiReply>;
  verifyOtp(userId: number | bigint, otp: number): Promise<CustomerOtpApiReply>;
}
