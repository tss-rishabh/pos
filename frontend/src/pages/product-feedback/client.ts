import { z } from 'zod';
import {
  customerWorkspaceBase,
  customerWorkspaceRequest,
  type ProfileScope,
} from '../customer-insights/client';

export const feedbackId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
export const feedbackScope = z
  .object({
    operatorId: feedbackId,
    storeId: feedbackId,
    checkoutId: z.uuid(),
    customerId: feedbackId,
    orderId: feedbackId,
  })
  .strict();
export type FeedbackScope = z.infer<typeof feedbackScope> & ProfileScope;
const rating = z
  .number()
  .min(0)
  .max(5)
  .refine(
    (value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-9,
    'Use increments of 0.1.',
  );
const legacyText =
  /^[\t\n\r\u0020-\u007E\u00A0-\u00FF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018-\u201A\u201C-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC]*$/u;
export const feedbackInput = z
  .object({
    operationId: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
    productId: feedbackId,
    overall: rating,
    fit: rating.default(0),
    size: rating.default(0),
    quality: rating.default(0),
    comment: z
      .string()
      .max(255)
      .regex(legacyText, 'Use text supported by the product feedback system.')
      .default(''),
  })
  .strict();
export type FeedbackInput = z.infer<typeof feedbackInput>;
export const feedbackRow = z
  .object({
    id: feedbackId,
    optionId: z
      .string()
      .regex(/^-?\d{1,19}$/)
      .nullable(),
    rating: z.number().nullable(),
    platform: z.string().max(8).nullable(),
    comment: z.string().max(255).nullable(),
  })
  .strict();
export const feedbackResponse = z
  .object({
    customerId: feedbackId,
    checkoutVersion: z.number().int().nonnegative(),
    orderId: feedbackId,
    orderAmount: z.number(),
    editable: z.boolean(),
    items: z
      .array(
        z
          .object({
            lineId: feedbackId,
            productId: feedbackId,
            name: z.string().max(255),
            feedback: z.array(feedbackRow).max(1000),
          })
          .strict(),
      )
      .max(50),
    nextCursor: feedbackId.nullable(),
  })
  .strict();
export type FeedbackWorkspace = z.infer<typeof feedbackResponse>;
export const feedbackReceipt = z
  .object({
    operationId: z.uuid(),
    customerId: feedbackId,
    checkoutId: z.uuid(),
    checkoutVersion: z.number().int().nonnegative(),
    orderId: feedbackId,
    productId: feedbackId,
    ratingIds: z.array(feedbackId).length(4),
    appliedAt: z.iso.datetime(),
  })
  .strict();
export function productFeedbackPath(scope: Omit<FeedbackScope, 'operatorId'>) {
  return `/stores/${encodeURIComponent(scope.storeId)}/checkout-sessions/${encodeURIComponent(scope.checkoutId)}/customers/${encodeURIComponent(scope.customerId)}/orders/${encodeURIComponent(scope.orderId)}/feedback`;
}
function endpoint(scope: FeedbackScope) {
  return (
    customerWorkspaceBase(scope) +
    `/customers/${encodeURIComponent(scope.customerId)}/orders/${encodeURIComponent(scope.orderId)}/product-feedback`
  );
}
export async function readProductFeedback(
  scope: FeedbackScope,
  after: string | undefined,
  signal: AbortSignal,
) {
  feedbackScope.parse(scope);
  if (after) feedbackId.parse(after);
  const query = new URLSearchParams({ limit: '25', ...(after ? { after } : {}) });
  const result = await customerWorkspaceRequest(
    scope,
    endpoint(scope) + '?' + query.toString(),
    { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) },
    feedbackResponse,
  );
  if (
    result.customerId !== scope.customerId ||
    result.orderId !== scope.orderId ||
    result.items.some(
      (item, i) => BigInt(item.lineId) <= BigInt(i ? result.items[i - 1]!.lineId : (after ?? '0')),
    ) ||
    (result.nextCursor && result.nextCursor !== result.items.at(-1)?.lineId)
  )
    throw new Error('This product feedback page does not match the current sale.');
  return result;
}
export async function saveProductFeedback(
  scope: FeedbackScope,
  raw: FeedbackInput,
  reconcile: boolean,
) {
  feedbackScope.parse(scope);
  const input = feedbackInput.parse(raw);
  const result = await customerWorkspaceRequest(
    scope,
    endpoint(scope) + (reconcile ? '/submissions/' + encodeURIComponent(input.operationId) : ''),
    reconcile ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(input) },
    feedbackReceipt,
  );
  if (
    result.operationId !== input.operationId ||
    result.customerId !== scope.customerId ||
    result.checkoutId !== scope.checkoutId ||
    result.checkoutVersion !== input.expectedVersion ||
    result.orderId !== scope.orderId ||
    result.productId !== input.productId ||
    new Set(result.ratingIds).size !== 4
  )
    throw new Error('The saved feedback does not match this submission.');
  return result;
}
