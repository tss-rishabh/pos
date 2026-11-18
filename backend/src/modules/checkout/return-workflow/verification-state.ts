import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { customerContactBindingSchema } from '../customer-contact-authority.js';
import type { CustomerOtpScope } from '../../customer-otp/index.js';
import type { CustomerContactBinding } from '../customer-contact-authority.js';

/** Customer OTP proof for a return; Redis `pos:return_verification:{id}` (see state.ts). */
export interface ReturnVerification {
  id: string;
  operatorId: string;
  storeId: string;
  counterId: string;
  orderId: string;
  customerId: string;
  requestHash: string;
  sent: boolean;
  expiresAt: number;
  verifiedUntil: number | null;
  busyOperationId: string | null;
  contact?: CustomerContactBinding | null;
  otpChallengeId?: string | null;
  deliveryStatus?: 'pending' | 'sent' | 'uncertain' | 'rejected' | null;
  requestOperationId?: string | null;
  verifyOperationId?: string | null;
  verificationError?: string | null;
}

export const returnVerificationSchema: z.ZodType<ReturnVerification> = z.object({
  id: z.uuid(),
  operatorId: identifier,
  storeId: identifier,
  counterId: identifier,
  orderId: identifier,
  customerId: identifier,
  requestHash: z.string().length(64),
  sent: z.boolean(),
  expiresAt: z.number(),
  verifiedUntil: z.number().nullable(),
  busyOperationId: z.uuid().nullable(),
  contact: customerContactBindingSchema.nullable().default(null),
  otpChallengeId: z.uuid().nullable().default(null),
  deliveryStatus: z.enum(['pending', 'sent', 'uncertain', 'rejected']).nullable().default(null),
  requestOperationId: z.uuid().nullable().default(null),
  verifyOperationId: z.uuid().nullable().default(null),
  verificationError: z.string().max(64).nullable().default(null),
});
export const publicReturnVerification = (value: ReturnVerification) => ({
  id: value.id,
  orderId: value.orderId,
  sent: value.sent,
  expiresAt: value.expiresAt,
  verifiedUntil: value.verifiedUntil,
  pending: value.busyOperationId !== null,
  deliveryStatus: value.deliveryStatus ?? null,
  requestOperationId: value.requestOperationId ?? null,
  verifyOperationId: value.verifyOperationId ?? null,
  pendingOperationId: value.busyOperationId,
  errorCode: value.verificationError ?? null,
});
export const returnCustomerOtpScope = (value: ReturnVerification): CustomerOtpScope => ({
  operatorId: value.operatorId,
  storeId: value.storeId,
  counterId: value.counterId,
  customerId: value.customerId,
  subjectId: value.id,
  purpose: 'order-return',
  orderId: value.orderId,
});
