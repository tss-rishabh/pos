import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
export const fullSyncContract = 'pos-ecommerce-full-sync-v1';
export const fullSyncCommand = z
  .object({
    operationId: z.uuid(),
    storeId: identifier,
    actorId: identifier,
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,128}$/)
      .nullable(),
  })
  .strict();
export type FullSyncCommand = z.infer<typeof fullSyncCommand>;
export const fullSyncBody = (command: FullSyncCommand) =>
  JSON.stringify({ contract: fullSyncContract, ...fullSyncCommand.parse(command) });
export const fullSyncHash = (command: FullSyncCommand) =>
  createHash('sha256').update(fullSyncBody(command)).digest('hex');
export const fullSyncResult = z
  .object({
    contract: z.literal(fullSyncContract),
    operationId: z.uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'uncertain']),
    proof: z
      .object({
        mongoWrites: z.number().int().safe().nonnegative(),
        redisWrites: z.number().int().safe().nonnegative(),
        cdnBatches: z.number().int().safe().nonnegative(),
        catalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .nullable(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (value.status === 'succeeded') === (value.proof !== null) &&
      (value.status !== 'succeeded' || value.errorCode === null),
  );
export type FullSyncResult = z.infer<typeof fullSyncResult>;
export interface FullSyncAdapter {
  submit(command: FullSyncCommand, signal?: AbortSignal): Promise<FullSyncResult>;
  read(command: FullSyncCommand, signal?: AbortSignal): Promise<FullSyncResult | null>;
}
export const syncScope = z.object({ storeId: identifier, syncId: z.uuid() }).strict();
