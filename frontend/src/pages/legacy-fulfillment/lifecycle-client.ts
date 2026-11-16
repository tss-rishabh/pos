import { z } from 'zod';
import { captureOperatorScope, request } from '../../api/client';
import { legacyId } from './contracts';
import {
  deliveryAction,
  deliveryReceipt,
  type DeliveryAction,
  type DeliveryReceipt,
} from './lifecycle-contracts';
import { recoverCommand, submitCommand } from './journal';
const resources: Record<DeliveryAction, string> = {
  create: 'courier-requests',
  pass: 'transfers',
  convert: 'online-conversions',
  cancel: 'cancellations',
};
function journal(
  actor: string,
  store: string,
  order: string,
  action: DeliveryAction,
  reason: string,
  category: string,
) {
  legacyId.parse(actor);
  legacyId.parse(store);
  legacyId.parse(order);
  deliveryAction.parse(action);
  z.string()
    .max(action === 'cancel' ? 200 : 255)
    .parse(reason);
  z.string().max(255).parse(category);
  return {
    namespace: 'local-delivery' as const,
    actor,
    store,
    order,
    action,
    readPath: '/api/v1/local-delivery-commands/',
    writePath: `/api/v1/stores/${store}/local-deliveries/orders/${order}/${resources[action]}`,
    method: 'POST' as const,
    body: { reason, reasonCategory: category, notify: false },
    intent: [1, actor, store, order, action, reason, category],
    schema: deliveryReceipt,
  };
}
export function submitDeliveryCommand(
  actor: string,
  store: string,
  order: string,
  action: DeliveryAction,
  reason: string,
  category: string,
  signal?: AbortSignal,
) {
  return submitCommand(journal(actor, store, order, action, reason, category), signal);
}
export function recoverDeliveryCommand(
  actor: string,
  store: string,
  order: string,
  action: DeliveryAction,
  signal?: AbortSignal,
) {
  return recoverCommand(journal(actor, store, order, action, '', ''), signal);
}
export async function reconcileDeliveryCommand(
  actor: string,
  receipt: DeliveryReceipt,
  reason: string,
  operation: { commandId: string; expectedVersion: number },
  signal?: AbortSignal,
) {
  legacyId.parse(actor);
  const scope = AbortSignal.any([captureOperatorScope(actor), ...(signal ? [signal] : [])]);
  const body = z
    .object({
      commandId: z.uuid(),
      expectedVersion: z.number().int().positive(),
      reason: z.string().min(1).max(200),
    })
    .strict()
    .parse({ ...operation, reason });
  scope.throwIfAborted();
  const value = await request(
    `/api/v1/local-delivery-commands/${receipt.commandId}/reconciliations`,
    {
      operatorId: actor,
      signal: scope,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    deliveryReceipt,
  );
  scope.throwIfAborted();
  if (
    value.commandId !== receipt.commandId ||
    value.storeId !== receipt.storeId ||
    value.orderId !== receipt.orderId
  )
    throw new Error('The delivery receipt does not match this order.');
  return value;
}
