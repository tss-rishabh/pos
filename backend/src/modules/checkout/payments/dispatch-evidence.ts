import { z } from 'zod';
import type { PaymentAttempt, ProviderDecision, Terminal } from './contracts.js';
import { AppError } from '../../../domain/errors.js';

const frames = new WeakSet<object>();
const identifier = z.string().regex(/^[1-9]\d{0,18}$/);
export const paymentDispatchFrameSchema = z
  .object({
    contract: z.literal('pos-payment-dispatch-evidence-v1'),
    attemptId: z.uuid(),
    busyOperationId: z.uuid(),
    orderId: identifier,
    storeId: identifier,
    counterId: identifier,
    originalOperatorId: identifier,
    actorId: identifier,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    transactionId: z.string().min(1).max(128),
    provider: z.enum(['pine', 'paytm', 'operator']),
    machineId: identifier.nullable(),
    channel: z.string().min(1).max(32),
    cashAmount: z.string().max(16),
    onlineAmount: z.string().max(16),
    cashReceived: z.string().max(16),
    currency: z.literal('INR'),
    action: z.enum(['start', 'status', 'cancel']),
    device: z
      .discriminatedUnion('provider', [
        z
          .object({
            provider: z.literal('pine'),
            storePosCode: z.string().max(128),
            imei: z.string().max(128),
          })
          .strict(),
        z
          .object({
            provider: z.literal('paytm'),
            mid: z.string().max(128),
            tid: z.string().max(128),
          })
          .strict(),
      ])
      .nullable(),
  })
  .strict();
export type PaymentDispatchFrame = z.infer<typeof paymentDispatchFrameSchema>;
/** Only the internal service captures this after a native dispatch reservation.
 * It is not accepted from an HTTP body, JSON clone or restored renderer state. */
export function capturePaymentDispatch(
  attempt: PaymentAttempt,
  machine: Terminal | null,
  action: PaymentDispatchFrame['action'],
  actorId: string,
): PaymentDispatchFrame {
  const value = Object.freeze(
    paymentDispatchFrameSchema.parse({
      contract: 'pos-payment-dispatch-evidence-v1',
      attemptId: attempt.id,
      busyOperationId: attempt.busyOperationId,
      orderId: attempt.orderId,
      storeId: attempt.storeId,
      counterId: attempt.counterId,
      originalOperatorId: attempt.operatorId,
      actorId,
      requestHash: attempt.requestHash,
      transactionId: attempt.transactionId,
      provider: machine?.provider ?? 'operator',
      machineId: attempt.machineId,
      channel: attempt.channel,
      cashAmount: attempt.cashAmount,
      onlineAmount: attempt.onlineAmount,
      cashReceived: attempt.cashReceived,
      currency: 'INR',
      action,
      device:
        machine?.provider === 'pine'
          ? { provider: 'pine', storePosCode: machine.storePosCode, imei: machine.imei }
          : machine?.provider === 'paytm'
            ? { provider: 'paytm', mid: machine.mid, tid: machine.tid }
            : null,
    }),
  );
  frames.add(value);
  return value;
}
export function assertPaymentDispatchFrame(
  frame: PaymentDispatchFrame | undefined,
): asserts frame is PaymentDispatchFrame {
  if (!frame || !frames.has(frame))
    throw new AppError(
      409,
      'PAYMENT_REPLY_PROVENANCE_REQUIRED',
      'The original provider reply needs reconciliation.',
    );
}
export const providerDecisionFactSchema = z
  .object({
    status: z.enum(['pending', 'paid', 'failed', 'cancelled', 'uncertain']),
    reference: z.string().min(1).max(256).nullable(),
    code: z.string().regex(/^[A-Z0-9_-]{1,64}$/),
  })
  .strict();
export function safeProviderDecisionFact(decision: ProviderDecision) {
  return providerDecisionFactSchema.parse({
    ...decision,
    code: /^[A-Z0-9_-]{1,64}$/.test(decision.code)
      ? decision.code
      : 'PROVIDER_REPLY_REQUIRES_REVIEW',
  });
}
