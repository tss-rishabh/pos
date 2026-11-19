import { z } from 'zod';
import { request } from '../../api/client';

export type FulfillmentAction = 'acceptance' | 'rejection' | 'packing' | 'shipment' | 'rto-receipt';
export interface CommandInput {
  storeId: string;
  orderId: string;
  action: FulfillmentAction;
  rejectionReasonId?: string;
}
const resultSchema = z.object({ message: z.string(), updatedCount: z.number() });
export type FulfillmentResult = z.infer<typeof resultSchema>;
/**
 * One legacy express action. Legacy sends each click once with no command id; the
 * server's state-filtered update is the duplicate guard, so a retry never repeats a move.
 */
export function sendFulfillmentCommand(
  operatorId: string,
  input: CommandInput,
  send: typeof request = request,
): Promise<FulfillmentResult> {
  return send(
    `/api/v1/stores/${encodeURIComponent(input.storeId)}/fulfillment/orders/${encodeURIComponent(input.orderId)}/${input.action}`,
    {
      method: 'POST',
      operatorId,
      body: JSON.stringify(
        input.rejectionReasonId ? { rejectionReasonId: input.rejectionReasonId } : {},
      ),
    },
    resultSchema,
  );
}
