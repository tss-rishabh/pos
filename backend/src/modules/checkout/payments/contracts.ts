import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { amountSchema } from '../contracts.js';
import type { PineMachine } from '../payloads.js';
import { isLegacyLatinText } from '../settlement-note.js';

/**
 * Counter payment input (legacy `AjaxTransactionUploadView`, order/views.py:3020-3069).
 *
 * `channel` names the legacy routing branch. `pine` carries any other active Pine
 * `AllowedPaymentMode` in `paymentMode` (create_order.html:5849-5857,
 * terminal_helpers.py:273-317); `pine-card`/`pine-upi` are modes 1 and 10.
 */
export const paymentChannels = [
  'cash',
  'other',
  'district',
  'pincode',
  'pine-card',
  'pine-upi',
  'pine',
  'paytm-card',
  'paytm-qr',
] as const;
export type PaymentChannel = (typeof paymentChannels)[number];
/** order_stores.message is VARCHAR(255) latin1. Blank is allowed for API callers (offline sync). */
export const paymentMessageSchema = z
  .string()
  .max(255)
  .refine(isLegacyLatinText, 'Use text supported by the store payment ledger.');
export const paymentInputSchema = z
  .object({
    operationId: z.uuid(),
    channel: z.enum(paymentChannels),
    paymentMode: z.number().int().min(1).max(2147483647).optional(),
    onlineAmount: amountSchema,
    cashAmount: amountSchema,
    cashReceived: amountSchema,
    machineId: identifier.optional(),
    externalReference: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/)
      .optional(),
    message: paymentMessageSchema.optional(),
  })
  .strict()
  .refine((value) => (value.channel === 'pine') === (value.paymentMode !== undefined), {
    message: 'A Pine payment mode is required only for the generic Pine channel.',
    path: ['paymentMode'],
  });
export type PaymentInput = z.infer<typeof paymentInputSchema>;

/** Legacy `AjaxPaymentStatusView` form (order/views.py:685-775). */
export const paymentStatusInputSchema = z
  .object({
    payType: z.union([z.literal(0), z.literal(1)]),
    transactionId: z.string().max(255).refine(isLegacyLatinText).optional(),
    paymentStatus: z.number().int().min(1).max(2147483647).default(1),
    orderStatus: z.number().int().min(0).max(2147483647).default(0),
    message: paymentMessageSchema.default(''),
    offlinePayment: amountSchema.default('0'),
    onlinePayment: amountSchema.default('0'),
  })
  .strict();
export type PaymentStatusInput = z.infer<typeof paymentStatusInputSchema>;

export type PaymentProvider = 'cash' | 'others' | 'pine' | 'paytm';
export type PaymentOutcome =
  'dispatching' | 'pending' | 'paid' | 'failed' | 'cancelled' | 'uncertain';
/** Redis `pos:payment_attempt:{attemptId}` (EX 86400): idempotency of one start request. */
export const paymentAttemptRecordSchema = z
  .object({
    orderId: identifier,
    storeId: identifier,
    operatorId: identifier,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['dispatching', 'pending', 'paid', 'failed', 'uncertain']),
    transactionId: z.string().min(1).max(45),
    provider: z.enum(['cash', 'others', 'pine', 'paytm']),
    legacyStatus: z.string().max(255),
    errorCode: z.string().max(64).nullable(),
    message: z.string().max(400),
    cashAmount: amountSchema,
    onlineAmount: amountSchema,
  })
  .strict();
export type PaymentAttemptRecord = z.infer<typeof paymentAttemptRecordSchema>;

/** Public payment result. Raw provider responses and credentials never leave the server. */
export interface PaymentResult {
  attemptId: string | null;
  orderId: string;
  transactionId: string;
  provider: PaymentProvider;
  status: PaymentOutcome;
  /** The legacy status string the original view returned (`Approved`, `Cash Delivered`, ...). */
  legacyStatus: string;
  message: string;
  cashAmount: string;
  onlineAmount: string;
}

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

/** A provider reply that was received and parsed. Anything else is an unknown outcome. */
export interface PineReply {
  responseCode: number | null;
  responseMessage: string;
  plutusId: string | null;
  /** Python `str(dict)` of the parsed reply, as legacy stores it in `api_response`. */
  apiResponse: string;
}
export interface PaytmReply {
  resultCode: string;
  resultMessage: string;
  apiResponse: string;
}
/** Provider transport: throws `PaymentOutcomeUnknown` when no definitive reply exists. */
export interface PaymentGateway {
  configured(provider: 'pine' | 'paytm'): void;
  pineUpload(
    terminal: PineTerminal,
    transactionId: string,
    onlineAmount: string,
    paymentMode: number,
    operatorId: string,
  ): Promise<PineReply>;
  pineStatus(terminal: PineTerminal, plutusId: string): Promise<PineReply>;
  pineCancel(terminal: PineTerminal, plutusId: string, onlineAmount: string): Promise<PineReply>;
  paytmRequest(
    terminal: PaytmTerminal,
    transactionId: string,
    onlineAmount: string,
    mode: 'CARD' | 'QR',
    now: string,
  ): Promise<PaytmReply>;
  paytmStatus(terminal: PaytmTerminal, transactionId: string, now: string): Promise<PaytmReply>;
}
export class PaymentOutcomeUnknown extends Error {
  constructor(readonly reason: 'timeout' | 'transport' | 'http' | 'unreadable') {
    super('The payment provider outcome is unknown.');
    this.name = 'PaymentOutcomeUnknown';
  }
}

/** Legacy `payment_mode` for each fixed channel; `pine` uses the submitted mode. */
export function paymentModeOf(input: Pick<PaymentInput, 'channel' | 'paymentMode'>): number {
  switch (input.channel) {
    case 'cash':
      return 0;
    case 'other':
      return 1001;
    case 'district':
      return 1005;
    case 'pincode':
      return 1006;
    case 'pine-card':
      return 1;
    case 'pine-upi':
      return 10;
    case 'paytm-card':
      return 1003;
    case 'paytm-qr':
      return 1004;
    case 'pine':
      return input.paymentMode ?? 0;
  }
}
export const providerOf = (channel: PaymentChannel): PaymentProvider =>
  channel === 'cash'
    ? 'cash'
    : channel.startsWith('paytm-')
      ? 'paytm'
      : channel.startsWith('pine')
        ? 'pine'
        : 'others';
/** Legacy channel for an option row (order/views.py:3047-3069 routing). */
export function channelForMode(mode: number): PaymentChannel {
  switch (mode) {
    case 1001:
      return 'other';
    case 1003:
      return 'paytm-card';
    case 1004:
      return 'paytm-qr';
    case 1005:
      return 'district';
    case 1006:
      return 'pincode';
    case 1:
      return 'pine-card';
    case 10:
      return 'pine-upi';
    default:
      return 'pine';
  }
}
