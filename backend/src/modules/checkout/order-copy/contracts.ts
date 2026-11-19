import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import type { Cart, CheckoutState } from '../contracts.js';

/** Legacy `AjaxFetchTheProducts` (order/views.py:2045-2104) takes only `order_id` from the operator. */
export const orderCopyInputSchema = z.object({ orderId: identifier }).strict();
export type OrderCopyInput = z.infer<typeof orderCopyInputSchema>;
/** Legacy messages, order/views.py:2103-2104. */
export const orderCopyMessages = {
  synced: 'Cart Synced',
  partial: 'Cart partially synced - please review the cart',
} as const;
export const orderCopyResultSchema = z
  .object({
    orderId: identifier,
    partial: z.boolean(),
    message: z.enum([orderCopyMessages.synced, orderCopyMessages.partial]),
  })
  .strict();
export type OrderCopyResult = z.infer<typeof orderCopyResultSchema>;

/** Cart lines used to compare a cart before and after a copy step. */
export const manifestLineSchema = z
  .object({
    productId: identifier,
    quantity: z.number().int().min(1).max(999),
    kind: z.enum(['product', 'gift-card', 'complementary']),
    name: z.string().max(300),
    price: z.string().max(64).nullable(),
    identity: z.string().max(32).nullable(),
  })
  .strict();
export const copyManifestSchema = z.array(manifestLineSchema).max(1100);
export type CopyManifest = z.infer<typeof copyManifestSchema>;

/**
 * Checkout cart port supplied by `checkoutService().orderCopyCart`. `setLine` currently requires the
 * state to be reserved for the copy (`busyOperationId === orderCopy.commandId`) and the expected
 * cart hash; the copy service reserves only an in-memory state inside `sessions.exclusive`.
 */
export interface CopyCartPort {
  read(state: CheckoutState): Promise<Cart>;
  setLine(
    state: CheckoutState,
    stepId: string,
    productId: string,
    quantity: number,
    expectedHash: string,
  ): Promise<CheckoutState>;
}

// ---------------------------------------------------------------------------------------------
// TRANSITIONAL compatibility exports. Legacy has no copy review/command journal; these remain only
// because files owned elsewhere still import them:
// - `copyBindingSchema`/`CopyBinding`: checkout/contracts.ts (`CheckoutState.orderCopy`).
// - `CopyFactsPort`: order-history/copy-adapter.ts (`orderCopy.history` in app.ts). Order copy now
//   reads the source order from MySQL like legacy and ignores this port.
// Delete once those callers drop them.
// ---------------------------------------------------------------------------------------------
const activeCopyBindingSchema = z
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
const cancelledCopyBindingSchema = z
  .object({
    status: z.literal('cancelled-unsent'),
    commandId: z.uuid(),
    reviewId: z.uuid(),
    cancellationId: z.uuid(),
  })
  .strict();
export const copyBindingSchema = z.discriminatedUnion('status', [
  activeCopyBindingSchema,
  cancelledCopyBindingSchema,
]);
export type CopyBinding = z.infer<typeof copyBindingSchema>;
export const copySourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('store'), storeId: identifier, orderId: identifier }).strict(),
  z.object({ kind: z.literal('customer'), orderId: identifier }).strict(),
]);
export type CopySource = z.infer<typeof copySourceSchema>;
export const copyFactsSchema = z
  .object({
    orderId: identifier,
    sourceCustomerId: identifier,
    sourceStoreId: identifier.nullable(),
    createdAt: z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?$/),
    reader: z.enum(['primary', 'bigquery']),
    fetchedAt: z.iso.datetime(),
    generationId: z.string().min(1).max(128),
    complete: z.literal(true),
    lines: z
      .array(z.object({ lineId: identifier, productId: identifier }).strict())
      .min(1)
      .max(500)
      .refine((lines) => new Set(lines.map((line) => line.lineId)).size === lines.length),
  })
  .strict();
export type CopyFacts = z.infer<typeof copyFactsSchema>;
export interface CopyFactsPort {
  read(input: { source: CopySource; targetCustomerId: string; cutoff: string }): Promise<CopyFacts>;
}
