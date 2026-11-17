import { z } from 'zod';
import { request } from '../../api/client';
const id = z.string().regex(/^[1-9]\d{0,18}$/);
export const repairSchema = z
  .object({
    returnOperationId: z.uuid(),
    operationId: z.uuid(),
    operatorId: id,
    storeId: id,
    orderId: id,
    state: z.enum(['PENDING', 'BLOCKED', 'LINKED']),
    errorCode: z.string().nullable(),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    command: z
      .object({
        operationId: z.uuid(),
        state: z.enum([
          'PENDING',
          'SENDING',
          'QUEUED',
          'SUCCEEDED',
          'REJECTED',
          'UNCERTAIN',
          'BLOCKED',
        ]),
        platform: z.literal('PACK'),
        errorCode: z.string().nullable(),
      })
      .nullable(),
    receiptRefreshError: z.string().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.operationId !== value.returnOperationId ||
      (value.command && value.command.operationId !== value.operationId)
    )
      ctx.addIssue({ code: 'custom', message: 'The original repair identity changed.' });
  });
export type ReturnRepair = z.infer<typeof repairSchema>;
export const recoveryIntentSchema = z
  .object({
    returnId: z.uuid(),
    operationId: z.uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type RepairRecoveryIntent = z.infer<typeof recoveryIntentSchema>;
const base = (storeId: string, orderId: string) =>
  '/api/v1/stores/' +
  id.parse(storeId) +
  '/orders/' +
  id.parse(orderId) +
  '/status-repair-obligations';
function scoped(value: ReturnRepair, storeId: string, orderId: string, returnId?: string) {
  if (
    value.storeId !== storeId ||
    value.orderId !== orderId ||
    (returnId && returnId !== value.returnOperationId)
  )
    throw new Error('The repair receipt scope changed.');
  return value;
}
export async function listReturnRepairs(
  ownerId: string,
  storeId: string,
  orderId: string,
  signal?: AbortSignal,
) {
  const value = await request(
    base(storeId, orderId),
    { operatorId: ownerId, signal },
    z.object({ storeId: id, orderId: id, obligations: z.array(repairSchema).max(100) }),
  );
  if (value.storeId !== storeId || value.orderId !== orderId)
    throw new Error('The repair list scope changed.');
  return value.obligations.map((row) => scoped(row, storeId, orderId));
}
export async function readReturnRepair(
  ownerId: string,
  storeId: string,
  orderId: string,
  returnId: string,
  signal?: AbortSignal,
) {
  return scoped(
    await request(
      base(storeId, orderId) + '/' + z.uuid().parse(returnId),
      { operatorId: ownerId, signal },
      repairSchema,
    ),
    storeId,
    orderId,
    returnId,
  );
}
export async function recoverReturnRepair(
  ownerId: string,
  storeId: string,
  orderId: string,
  intent: RepairRecoveryIntent,
  signal?: AbortSignal,
) {
  const parsed = recoveryIntentSchema.parse(intent);
  return scoped(
    await request(
      base(storeId, orderId) + '/' + parsed.returnId + '/recoveries',
      {
        operatorId: ownerId,
        signal,
        method: 'POST',
        body: JSON.stringify({
          operationId: parsed.operationId,
          expectedVersion: parsed.expectedVersion,
        }),
      },
      repairSchema,
    ),
    storeId,
    orderId,
    parsed.returnId,
  );
}
