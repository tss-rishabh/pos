import { z } from 'zod';
import { captureOperatorScope, request } from '../../../api/client';
import { administrationIdentifier } from '../api';
export const ecommerceInput = z
  .object({
    operationId: z.uuid(),
    expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
    threshold: z.number().int().min(0).max(2147483647),
    active: z.boolean(),
  })
  .strict();
export const ecommerceReceipt = z
  .object({
    status: z.literal('success'),
    message: z.string(),
    effectsQueued: z.boolean(),
    storeId: administrationIdentifier,
    operationId: z.uuid(),
    actorId: administrationIdentifier,
    ecommerceSyncId: z.uuid().optional(),
    cancelled: z.boolean().optional(),
    originalOperationId: z.uuid().optional(),
    requestId: z.string().nullable().optional(),
  })
  .strict();
export const synchronizationSchema = z
  .object({
    id: z.uuid(),
    storeId: administrationIdentifier,
    state: z.enum(['QUEUED', 'PREPARING', 'PROJECTING', 'FULL_SYNC', 'COMPLETED', 'BLOCKED']),
    fullState: z.enum(['READY', 'POSTING', 'UNCERTAIN', 'PENDING', 'SUCCEEDED']),
    selectedRows: z.number().int().nonnegative(),
    processedRows: z.number().int().nonnegative(),
    skippedRows: z.number().int().nonnegative(),
    errorCode: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    completed: z.boolean(),
    blockedRecord: z
      .object({ associationId: administrationIdentifier, productId: administrationIdentifier })
      .strict()
      .nullable()
      .default(null),
    fullProof: z
      .object({
        mongoWrites: z.number().int().nonnegative(),
        redisWrites: z.number().int().nonnegative(),
        cdnBatches: z.number().int().nonnegative(),
        catalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const recordsSchema = z
  .object({
    data: z.array(
      z
        .object({
          associationId: administrationIdentifier,
          productId: administrationIdentifier,
          selectedStock: z.number().int(),
          currentStock: z.number().int().nullable(),
          state: z.enum(['PENDING', 'PROCESSED', 'SKIPPED']),
        })
        .strict(),
    ),
    nextCursor: administrationIdentifier.nullable(),
  })
  .strict();
export const ecommerceBase = (storeId: string) =>
  '/api/v1/admin/stores/' + administrationIdentifier.parse(storeId);
export async function readEcommerceReceipt(
  ownerId: string,
  storeId: string,
  operationId: string,
  signal: AbortSignal,
) {
  return matchingReceipt(
    await request(
      ecommerceBase(storeId) + '/ecommerce-settings/operations/' + z.uuid().parse(operationId),
      { operatorId: ownerId, signal: AbortSignal.any([signal, captureOperatorScope(ownerId)]) },
      ecommerceReceipt,
    ),
    ownerId,
    storeId,
    operationId,
  );
}
export function matchingReceipt(
  receipt: z.infer<typeof ecommerceReceipt>,
  ownerId: string,
  storeId: string,
  operationId: string,
) {
  if (
    receipt.actorId !== ownerId ||
    receipt.storeId !== storeId ||
    receipt.operationId !== operationId
  )
    throw new Error(
      'The result belongs to another settings operation. Keep the original request for recovery.',
    );
  return receipt;
}
