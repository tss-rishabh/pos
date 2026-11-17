import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import type { Principal } from '../../../domain/access.js';
import type { Cart, CheckoutState } from '../contracts.js';
import { customerContactBindingSchema } from '../customer-contact-authority.js';

/** Private server authorization captured only after native OTP verification.
 * Never returned to a browser or synthesized for historical rows. */
export const copyCustomerAuthoritySchema = z
  .object({
    contact: customerContactBindingSchema,
    actorVersion: z.string().regex(/^[a-f0-9]{64}$/),
    challengeId: z.uuid(),
    verifiedUntil: z.number().int().positive(),
    capturedAt: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.verifiedUntil > value.capturedAt);
export type CopyCustomerAuthority = z.infer<typeof copyCustomerAuthoritySchema>;

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
export type CopyBinding = z.infer<typeof copyBindingSchema>;
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
export const copyStepSchema = z
  .object({
    id: z.uuid(),
    productId: identifier,
    sourceLineIds: z.array(identifier).min(1).max(500),
    beforeQuantity: z.number().int().min(0).max(999),
    targetQuantity: z.number().int().min(1).max(999),
    status: z.enum(['not-dispatched', 'dispatched', 'confirmed', 'unavailable']),
    errorCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,64}$/)
      .nullable(),
  })
  .strict();
export const copyReviewSchema = z
  .object({
    id: z.uuid(),
    checkoutId: z.uuid(),
    operatorId: identifier,
    storeId: identifier,
    counterId: identifier,
    customerId: identifier,
    checkoutVersion: z.number().int().nonnegative(),
    originHash: z.string().regex(/^[a-f0-9]{64}$/),
    beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
    source: copySourceSchema,
    customerAuthority: copyCustomerAuthoritySchema.optional(),
    facts: copyFactsSchema,
    before: copyManifestSchema,
    steps: z.array(copyStepSchema).min(1).max(500),
    expiresAt: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CopyReview = z.infer<typeof copyReviewSchema>;
export const copyCommandSchema = z
  .object({
    id: z.uuid(),
    review: copyReviewSchema,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['pending', 'uncertain', 'review-required', 'acknowledged', 'cancelled-unsent']),
    steps: z.array(copyStepSchema).min(1).max(500),
    currentHash: z.string().regex(/^[a-f0-9]{64}$/),
    result: copyManifestSchema.nullable(),
    resultHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    partial: z.boolean(),
    leaseId: z.uuid(),
    leaseUntil: z.number().int().positive(),
    continuations: z.array(z.uuid()).max(100),
    errorCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,64}$/)
      .nullable(),
    requestId: z.string().max(128).nullable(),
    acknowledgementId: z.uuid().nullable(),
  })
  .strict();
export type CopyCommand = z.infer<typeof copyCommandSchema>;
export interface CopyScope {
  storeId: string;
  checkoutId: string;
}
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
export interface CopyAuthority {
  user: Principal;
  scope: CopyScope;
}
