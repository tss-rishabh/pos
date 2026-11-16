import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { feedbackProofContract } from './feedback-proof.js';

export const orderMessageContract = 'pos-order-sms-security-v1';
const scopeSchema = z
  .object({
    eventId: z.string().regex(/^order-sms:[1-9]\d{0,18}$/),
    orderId: identifier,
    operatorId: identifier,
    requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  })
  .strict()
  .refine((value) => value.eventId === `order-sms:${value.orderId}`);
export type OrderMessageScope = z.infer<typeof scopeSchema>;
export function orderMessageResponseProof(scope: OrderMessageScope, body: string, key: string) {
  const checked = scopeSchema.parse(scope);
  if (!/^[!-~]{32,4096}$/.test(key)) throw new Error('Order-message security is not configured.');
  return createHmac('sha256', key)
    .update(
      [
        orderMessageContract,
        feedbackProofContract,
        checked.eventId,
        checked.orderId,
        checked.operatorId,
        checked.requestId,
        checked.nonce,
        createHash('sha256').update(body, 'utf8').digest('hex'),
      ].join('\n'),
      'utf8',
    )
    .digest('hex');
}
export function assertOrderMessageResponseProof(
  response: Response,
  scope: OrderMessageScope,
  body: string,
  key: string,
) {
  const proof = response.headers.get('x-pos-order-sms-proof') ?? '';
  if (
    response.headers.get('x-pos-order-sms-contract') !== orderMessageContract ||
    response.headers.get('x-pos-feedback-contract') !== feedbackProofContract ||
    response.headers.get('x-pos-order-sms-nonce') !== scope.nonce ||
    !/^[a-f0-9]{64}$/.test(proof) ||
    !timingSafeEqual(
      Buffer.from(proof, 'hex'),
      Buffer.from(orderMessageResponseProof(scope, body, key), 'hex'),
    )
  )
    throw new AppError(
      502,
      'ORDER_MESSAGE_SECURITY_UNCONFIRMED',
      'The private order-message response could not be verified.',
    );
}
