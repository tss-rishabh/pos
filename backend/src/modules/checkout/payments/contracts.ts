import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { amountSchema } from '../contracts.js';
import type { PineMachine } from '../payloads.js';
import { settlementMessageSchema } from '../settlement-note.js';

const checkoutNoteReferenceSchema = z
  .object({ checkoutId: z.uuid(), noteHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

export const paymentInputSchema = z
  .object({
    operationId: z.uuid(),
    channel: z.enum([
      'cash',
      'other',
      'district',
      'pincode',
      'pine-card',
      'pine-upi',
      'paytm-card',
      'paytm-qr',
    ]),
    onlineAmount: amountSchema,
    cashAmount: amountSchema,
    cashReceived: amountSchema,
    checkoutNote: checkoutNoteReferenceSchema.optional(),
    machineId: identifier.optional(),
    externalReference: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/)
      .optional(),
  })
  .strict();
export type PaymentInput = z.infer<typeof paymentInputSchema>;
export const legacyPaymentRecoverySchema = z
  .object({
    operationId: z.uuid(),
    provider: z.enum(['pine', 'paytm']),
    legacyId: identifier,
  })
  .strict();
export type LegacyPaymentRecoveryInput = z.infer<typeof legacyPaymentRecoverySchema>;
export const legacyPaymentSourceSchema = z
  .object({
    version: z.literal(1).optional(),
    provider: z.enum(['pine', 'paytm']),
    legacyId: identifier,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const paymentAttemptSchema = z.object({
  id: z.uuid(),
  operatorId: identifier,
  storeId: identifier,
  counterId: identifier,
  orderId: identifier,
  channel: paymentInputSchema.shape.channel,
  onlineAmount: amountSchema,
  cashAmount: amountSchema,
  cashReceived: amountSchema,
  checkoutNote: checkoutNoteReferenceSchema
    .extend({ message: settlementMessageSchema })
    .nullable()
    .optional(),
  legacySource: legacyPaymentSourceSchema.optional(),
  machineId: identifier.nullable(),
  externalReference: z.string().nullable(),
  transactionId: z.string(),
  providerReference: z.string().nullable(),
  status: z.enum([
    'dispatching',
    'pending',
    'uncertain',
    'cancelling',
    'paid',
    'failed',
    'cancelled',
  ]),
  requestHash: z.string().length(64),
  busyOperationId: z.uuid().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PaymentAttempt = z.infer<typeof paymentAttemptSchema>;
export type PaymentStatus = PaymentAttempt['status'];
export interface PineTerminal extends PineMachine {
  provider: 'pine';
  id: string;
  imei: string;
}
export interface PaytmTerminal {
  provider: 'paytm';
  id: string;
  merchantKey: string;
  mid: string;
  tid: string;
  channelId: string;
}
export type Terminal = PineTerminal | PaytmTerminal;
export interface ProviderDecision {
  status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'uncertain';
  reference: string | null;
  code: string;
}
export interface PaymentGateway {
  configured(channel: PaymentInput['channel']): void;
  start(attempt: PaymentAttempt, terminal: Terminal): Promise<ProviderDecision>;
  status(attempt: PaymentAttempt, terminal: Terminal): Promise<ProviderDecision>;
  cancel(attempt: PaymentAttempt, terminal: Terminal): Promise<ProviderDecision>;
}
export const terminalPayment = (channel: PaymentInput['channel']) =>
  channel.startsWith('pine-') || channel.startsWith('paytm-');
export const paymentMode = (channel: PaymentInput['channel']) =>
  ({
    cash: 0,
    other: 1001,
    district: 1005,
    pincode: 1006,
    'pine-card': 1,
    'pine-upi': 10,
    'paytm-card': 1003,
    'paytm-qr': 1004,
  })[channel];
export function publicPayment(attempt: PaymentAttempt) {
  const {
    requestHash: _requestHash,
    busyOperationId: _busyOperationId,
    checkoutNote,
    legacySource,
    ...value
  } = attempt;
  return {
    ...value,
    ...(legacySource
      ? { legacySource: { provider: legacySource.provider, legacyId: legacySource.legacyId } }
      : {}),
    ...(checkoutNote
      ? { checkoutNote: { checkoutId: checkoutNote.checkoutId, noteHash: checkoutNote.noteHash } }
      : {}),
  };
}
