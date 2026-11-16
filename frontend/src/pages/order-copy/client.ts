import { z } from 'zod';
import { request, post } from '../../api/client';
const id = z.string().regex(/^[1-9]\d{0,19}$/);
export const copyBindingSchema = z
  .object({
    commandId: z.uuid(),
    reviewId: z.uuid(),
    originHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['pending', 'uncertain', 'review-required', 'acknowledged']),
    resultHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
export const copySourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('store'), storeId: id, orderId: id }).strict(),
  z.object({ kind: z.literal('customer'), orderId: id }).strict(),
]);
export type CopySource = z.infer<typeof copySourceSchema>;
const step = z
  .object({
    id: z.uuid(),
    productId: id,
    sourceLineIds: z.array(id).min(1).max(500),
    beforeQuantity: z.number().int().min(0).max(999),
    targetQuantity: z.number().int().min(1).max(999),
    status: z.enum(['not-dispatched', 'dispatched', 'confirmed', 'unavailable']),
    errorCode: z.string().nullable(),
  })
  .strict();
const line = z
  .object({
    productId: id,
    quantity: z.number().int().positive().max(999),
    kind: z.enum(['product', 'gift-card', 'complementary']),
    name: z.string().max(300),
    price: z.string().nullable(),
    identity: z.string().nullable(),
  })
  .strict();
export const copyReviewSchema = z
  .object({
    id: z.uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    checkoutVersion: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    source: copySourceSchema,
    steps: z.array(step).min(1).max(500),
    before: z.array(line).max(1100),
  })
  .passthrough();
export type CopyReview = z.infer<typeof copyReviewSchema>;
export const copyCommandSchema = z
  .object({
    id: z.uuid(),
    reviewId: z.uuid(),
    source: copySourceSchema,
    status: z.enum(['pending', 'uncertain', 'review-required', 'acknowledged']),
    steps: z.array(step).min(1).max(500),
    result: z.array(line).max(1100).nullable(),
    resultHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    partial: z.boolean(),
    errorCode: z.string().nullable(),
    originHash: z.string().regex(/^[a-f0-9]{64}$/),
    checkoutVersion: z.number().int().nonnegative(),
    acknowledgementId: z.uuid().nullable(),
    canContinue: z.boolean(),
  })
  .strict();
export type CopyCommand = z.infer<typeof copyCommandSchema>;
export interface OrderCopyScope {
  operatorId: string;
  storeId: string;
  checkoutId: string;
  customerId: string;
}
const base = (scope: OrderCopyScope) =>
  `/api/v1/stores/${encodeURIComponent(scope.storeId)}/checkout-sessions/${scope.checkoutId}`;
export const prepareOrderCopy = (
  scope: OrderCopyScope,
  body: { reviewId: string; expectedVersion: number; source: CopySource },
) => post(base(scope) + '/order-copy-reviews', body, copyReviewSchema, scope.operatorId);
export const readOrderCopyReview = (scope: OrderCopyScope, id: string) =>
  request(
    base(scope) + '/order-copy-reviews/' + id,
    { operatorId: scope.operatorId },
    copyReviewSchema,
  );
export const readOrderCopy = (scope: OrderCopyScope, id: string) =>
  request(base(scope) + '/order-copies/' + id, { operatorId: scope.operatorId }, copyCommandSchema);
export const currentOrderCopy = (scope: OrderCopyScope) =>
  request(
    base(scope) + '/order-copies/current',
    { operatorId: scope.operatorId },
    copyCommandSchema.nullable(),
  );
export const startOrderCopy = (
  scope: OrderCopyScope,
  body: { operationId: string; reviewId: string; manifestHash: string; expectedVersion: number },
) => post(base(scope) + '/order-copies', body, copyCommandSchema, scope.operatorId);
export const acknowledgeOrderCopy = (
  scope: OrderCopyScope,
  id: string,
  body: { operationId: string; expectedVersion: number; resultHash: string },
) =>
  post(
    base(scope) + '/order-copies/' + id + '/acknowledgements',
    body,
    copyCommandSchema,
    scope.operatorId,
  );
export const continueOrderCopy = (
  scope: OrderCopyScope,
  id: string,
  body: { operationId: string; expectedVersion: number },
) =>
  post(
    base(scope) + '/order-copies/' + id + '/continuations',
    body,
    copyCommandSchema,
    scope.operatorId,
  );
