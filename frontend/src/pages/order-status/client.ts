import { z } from 'zod';
import { request } from '../../api/client';
const id = z.string().regex(/^[1-9]\d{0,18}$/);
export const platformSchema = z.enum(['PACK', 'SHIP', 'DELIVER']);
export type StatusPlatform = z.infer<typeof platformSchema>;
const stage = z.object({ status: z.string().nullable(), date: z.string() }),
  statusSchema = z.object({
    orderId: id,
    storeId: id,
    processed: z.boolean(),
    stages: z.object({ CREATE: stage, PACK: stage, SHIP: stage, DELIVER: stage }),
  });
export type WholeOrderStatus = z.infer<typeof statusSchema>;
const base = (storeId: string, orderId: string) =>
  '/api/v1/stores/' + id.parse(storeId) + '/orders/' + id.parse(orderId);
/** Legacy order detail "Vinculum Status" tab data. */
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
/** Legacy `ajax-update-status-vinc/`: one push of every order line; answers a fixed message. */
export async function pushOrderStatus(
  ownerId: string,
  storeId: string,
  orderId: string,
  platform: StatusPlatform,
  signal?: AbortSignal,
) {
  return request(
    base(storeId, orderId) + '/status-requests',
    {
      operatorId: ownerId,
      method: 'POST',
      body: JSON.stringify({ platform: platformSchema.parse(platform) }),
      signal,
    },
    z.object({ message: z.string() }),
  );
}
