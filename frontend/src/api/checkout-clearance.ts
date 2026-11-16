import { z } from 'zod';

const identifier = z.string().regex(/^[1-9]\d{0,19}$/);
export const checkoutClearanceSchema = z
  .object({
    status: z.literal('cleared'),
    checkoutId: z.uuid(),
    operationId: z.uuid(),
    operatorId: identifier,
    storeId: identifier,
    counterId: identifier,
    draftId: z.uuid(),
    draftVersion: z.number().int().nonnegative(),
    reason: z.enum(['cart-clear', 'customer-detach']),
    clearedAt: z.number().int().positive(),
  })
  .strict();
export type CheckoutClearance = z.infer<typeof checkoutClearanceSchema>;
