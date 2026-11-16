import { z } from 'zod';
import { walletAdjustmentReceiptSchema, walletAdjustmentSchema } from './contracts';
import { walletIdentifier } from './fields';

export const walletCommandSchema = z
  .object({
    id: z.uuid(),
    ownerId: walletIdentifier,
    request: walletAdjustmentSchema,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['prepared', 'dispatching', 'uncertain', 'completed']),
    attemptId: z.uuid().nullable(),
    claimedAt: z.number().int().nonnegative().nullable(),
    receipt: walletAdjustmentReceiptSchema.nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type WalletCommand = z.infer<typeof walletCommandSchema>;
export interface WalletCommandOwner {
  ownerId: string;
  commandId: string;
}
