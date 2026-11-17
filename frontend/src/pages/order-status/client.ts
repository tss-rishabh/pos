import { z } from 'zod';
import { request } from '../../api/client';
const id = z.string().regex(/^[1-9]\d{0,18}$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  platform = z.enum(['PACK', 'SHIP', 'DELIVER']);
const receipt = z.object({
  contract: z.literal('pos-whole-order-status-v1'),
  operationId: z.uuid(),
  requestHash: digest,
  scopeHash: digest,
  state: z.enum(['queued', 'succeeded', 'rejected', 'unknown']),
  acceptedAt: z.iso.datetime({ offset: true }).nullable(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  taskId: z.string().nullable(),
  stages: z
    .array(
      z.object({
        platform,
        status: z.enum(['QUEUED', 'SUCCESS', 'FAILED', 'UNEXPECTED', 'UNKNOWN']),
        updatedAt: z.iso.datetime({ offset: true }),
      }),
    )
    .max(3),
});
export const statusCommandSchema = z.object({
  operationId: z.uuid(),
  storeId: id,
  orderId: id,
  platform,
  source: z.enum(['manual', 'return-failure']),
  returnOperationId: z.uuid().nullable(),
  state: z.enum(['PENDING', 'SENDING', 'QUEUED', 'SUCCEEDED', 'REJECTED', 'UNCERTAIN', 'BLOCKED']),
  requestHash: digest,
  lineCount: z.number().int().min(1).max(10000),
  receipt: receipt.nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  message: z.string(),
});
const stage = z.object({ status: z.string().nullable(), date: z.string() }),
  statusSchema = z.object({
    orderId: id,
    storeId: id,
    scopeHash: digest,
    eligible: z.boolean(),
    adapterReady: z.boolean(),
    stages: z.object({ CREATE: stage, PACK: stage, SHIP: stage, DELIVER: stage }),
    commands: z.array(statusCommandSchema).max(25),
  });
export const statusIntentSchema = z
  .object({ operationId: z.uuid(), platform, scopeHash: digest })
  .strict();
export type StatusIntent = z.infer<typeof statusIntentSchema>;
export type StatusCommand = z.infer<typeof statusCommandSchema>;
export type WholeOrderStatus = z.infer<typeof statusSchema>;
const base = (storeId: string, orderId: string) =>
  '/api/v1/stores/' + id.parse(storeId) + '/orders/' + id.parse(orderId);
export async function readOrderStatus(
  ownerId: string,
  storeId: string,
  orderId: string,
  signal?: AbortSignal,
) {
  const value = await request(
    base(storeId, orderId) + '/fulfillment-status',
    { operatorId: ownerId, signal },
    statusSchema,
  );
  if (value.orderId !== orderId || value.storeId !== storeId)
    throw new Error('The returned status scope changed.');
  return value;
}
function commandScope(value: StatusCommand, storeId: string, orderId: string, operationId: string) {
  if (value.storeId !== storeId || value.orderId !== orderId || value.operationId !== operationId)
    throw new Error('The returned status receipt belongs to another scope.');
  return value;
}
export async function saveOrderStatus(
  ownerId: string,
  storeId: string,
  orderId: string,
  intent: StatusIntent,
  signal?: AbortSignal,
) {
  const body = statusIntentSchema.parse(intent),
    value = await request(
      base(storeId, orderId) + '/status-requests',
      { operatorId: ownerId, method: 'POST', body: JSON.stringify(body), signal },
      statusCommandSchema,
    );
  if (
    value.platform !== body.platform ||
    (value.receipt && value.receipt.scopeHash !== body.scopeHash)
  )
    throw new Error('The immutable status request changed.');
  return commandScope(value, storeId, orderId, body.operationId);
}
export async function readStatusCommand(
  ownerId: string,
  storeId: string,
  orderId: string,
  operationId: string,
  signal?: AbortSignal,
) {
  return commandScope(
    await request(
      base(storeId, orderId) + '/status-requests/' + z.uuid().parse(operationId),
      { operatorId: ownerId, signal },
      statusCommandSchema,
    ),
    storeId,
    orderId,
    operationId,
  );
}
