import { z } from 'zod';
import { request, post } from '../../api/client';
const id = z.string().regex(/^[1-9]\d{0,18}$/);
export const screeningScopeSchema = z
  .object({ operatorId: id, storeId: id, checkoutId: z.uuid(), operationId: z.uuid() })
  .strict();
export type ScreeningScope = z.infer<typeof screeningScopeSchema>;
export const screeningViewSchema = z
  .object({
    operationId: z.uuid(),
    checkoutId: z.uuid(),
    orderId: id.nullable(),
    status: z.enum([
      'prepared',
      'awaiting-source',
      'awaiting-payment',
      'completed',
      'abandoned',
      'closed-unsent',
      'source-rejected',
      'closed-no-order',
    ]),
    paymentReceiptId: z
      .string()
      .regex(/^[A-Za-z0-9:_-]{1,128}$/)
      .nullable(),
    publicationStatus: z
      .enum(['pending', 'processing', 'uncertain', 'accepted', 'cancelled', 'unavailable'])
      .nullable(),
    canAbandon: z.boolean(),
    canCloseNoOrder: z.boolean().optional(),
    reviewCode: z
      .enum([
        'SCREENING_SOURCE_OUTCOME_UNKNOWN',
        'SCREENING_PUBLICATION_OUTCOME_UNKNOWN',
        'SCREENING_PAYMENT_RECONCILIATION_REQUIRED',
      ])
      .nullable(),
  })
  .strict();
export type ScreeningView = z.infer<typeof screeningViewSchema>;
const base = (scope: ScreeningScope) => {
  const p = screeningScopeSchema.parse(scope);
  return `/api/v1/stores/${p.storeId}/checkout-sessions/${p.checkoutId}/screening-admissions/${p.operationId}`;
};
function bound(scope: ScreeningScope, value: ScreeningView) {
  if (value.operationId !== scope.operationId || value.checkoutId !== scope.checkoutId)
    throw new Error('The screening result does not match this sale.');
  return value;
}
export async function readScreening(scope: ScreeningScope) {
  return bound(
    scope,
    await request(base(scope), { operatorId: scope.operatorId }, screeningViewSchema),
  );
}
export async function reconcileScreening(scope: ScreeningScope) {
  return bound(
    scope,
    await post(base(scope) + '/reconciliations', {}, screeningViewSchema, scope.operatorId),
  );
}
export const screeningAbandonSchema = z
  .object({
    commandId: z.uuid(),
    reason: z.enum(['cash-abandoned', 'stock-unavailable', 'operator-revoked']),
  })
  .strict();
export async function abandonScreening(
  scope: ScreeningScope,
  input: z.infer<typeof screeningAbandonSchema>,
) {
  return bound(
    scope,
    await post(
      base(scope) + '/abandonments',
      screeningAbandonSchema.parse(input),
      screeningViewSchema,
      scope.operatorId,
    ),
  );
}
export async function closeUnsentScreening(scope: ScreeningScope) {
  const value = await post(
    base(scope) + '/closures',
    {},
    z
      .object({ operationId: z.uuid(), status: z.enum(['closed-unsent', 'closed-no-order']) })
      .strict(),
    scope.operatorId,
  );
  if (value.operationId !== scope.operationId)
    throw new Error('The screening result does not match this sale.');
  return value;
}
