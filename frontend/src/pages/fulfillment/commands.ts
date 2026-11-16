import { z } from 'zod';
import { ApiError, request } from '../../api/client';

export interface CommandInput {
  orderId: string;
  path: string;
  rejectionReasonId?: string;
}
const savedSchema = z.object({
  commandId: z.uuid(),
  input: z.object({
    orderId: z.string(),
    path: z.string(),
    rejectionReasonId: z.string().optional(),
  }),
});
const receiptSchema = z.object({
  commandId: z.uuid(),
  updatedCount: z.number(),
  integrationState: z.enum(['pending', 'not-required']),
  effectIds: z.array(z.string()),
});
type Receipt = z.infer<typeof receiptSchema>;
type CommandStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** Keep the original command ID/body across timeouts, reloads and desktop restarts. */
export async function sendFulfillmentCommand(
  ownerId: string,
  storeId: string,
  input: CommandInput,
  storage: CommandStorage = localStorage,
  send?: (commandId: string, input: CommandInput) => Promise<Receipt>,
): Promise<Receipt> {
  const key = `pos-fulfillment-command:${ownerId}:${storeId}:${input.orderId}:${input.path}`;
  const raw = storage.getItem(key);
  let saved: z.infer<typeof savedSchema> | undefined;
  if (raw) {
    try {
      saved = savedSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      throw new Error('The saved operation cannot be read. Review this order before trying again.');
    }
  }
  if (saved && JSON.stringify(saved.input) !== JSON.stringify(input))
    throw new Error('A previous operation needs confirmation before changing its details.');
  saved ??= { commandId: crypto.randomUUID(), input };
  storage.setItem(key, JSON.stringify(saved));
  try {
    const receipt = send
      ? await send(saved.commandId, saved.input)
      : await request(
          `/api/v1/stores/${storeId}/fulfillment/orders/${saved.input.orderId}/${saved.input.path}`,
          {
            method: 'POST',
            operatorId: ownerId,
            body: JSON.stringify({
              commandId: saved.commandId,
              ...(saved.input.rejectionReasonId
                ? { rejectionReasonId: saved.input.rejectionReasonId }
                : {}),
            }),
          },
          receiptSchema,
        );
    storage.removeItem(key);
    return receipt;
  } catch (error) {
    if (error instanceof ApiError && [400, 401, 403, 404].includes(error.status))
      storage.removeItem(key);
    throw error;
  }
}
