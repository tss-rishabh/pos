import { z } from 'zod';
export const performanceReadyEvent = 'pos-performance-ready';

const id = z.string().regex(/^[1-9]\d{0,19}$/);
const phase = z.union([z.literal(''), z.string().regex(/^\d{1,12}\.\d{2}$/)]);
export const performanceValues = z
  .object({
    product_main_list: phase,
    user_behaviour: phase,
    add_to_cart: phase,
    proceed_to_payment: phase,
    overall_performance_time: z.string().regex(/^(?:|NaN|\d{1,13})$/),
    fast_payment: phase.optional(),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 255,
    'The timing snapshot is too long.',
  );
export type PerformanceValues = z.infer<typeof performanceValues>;
export const phaseNames = [
  'product_main_list',
  'user_behaviour',
  'add_to_cart',
  'proceed_to_payment',
] as const;
export type PerformancePhase = (typeof phaseNames)[number];
export const timingOwner = z
  .object({ ownerId: id, storeId: id, counterId: id, draftId: z.uuid() })
  .strict();
export type TimingOwner = z.infer<typeof timingOwner>;
export const performanceCapture = timingOwner
  .extend({
    checkoutId: z.uuid().nullable(),
    connectionOperationId: z.uuid().nullable(),
    connectionVersion: z.number().int().nonnegative().nullable().default(null),
    startedAt: z.number().int().safe().nullable(),
    phases: z
      .object({
        product_main_list: phase,
        user_behaviour: phase,
        add_to_cart: phase,
        proceed_to_payment: phase,
      })
      .strict(),
    updatedAt: z.number().int().safe(),
  })
  .strict();
export type PerformanceCapture = z.infer<typeof performanceCapture>;
export const performanceCommand = timingOwner
  .extend({
    id: z.uuid(),
    operationId: z.uuid(),
    checkoutId: z.uuid(),
    draftVersion: z.number().int().nonnegative(),
    submissionId: z.uuid(),
    paymentId: z.uuid(),
    performance: performanceValues,
    orderId: id.nullable(),
    receiptId: z.uuid().nullable(),
    state: z.enum(['captured', 'prepared', 'sending', 'unknown', 'recorded', 'rejected']),
    revision: z.number().int().nonnegative(),
    claimId: z.uuid().nullable(),
    claimedAt: z.number().int().safe().nullable(),
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.number().int().safe(),
    createdAt: z.number().int().safe(),
    errorCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,100}$/)
      .nullable(),
  })
  .strict();
export type PerformanceCommand = z.infer<typeof performanceCommand>;
export const emptyPerformance = (): PerformanceValues => ({
  product_main_list: '',
  user_behaviour: '',
  add_to_cart: '',
  proceed_to_payment: '',
  overall_performance_time: 'NaN',
});
