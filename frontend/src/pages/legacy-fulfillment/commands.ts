import { z } from 'zod';
import { legacyAction, legacyId, legacyReceipt, type LegacyAction } from './contracts';
import { recoverCommand, submitCommand } from './journal';
function journal(actor: string, store: string, order: string, action: LegacyAction, note: string) {
  legacyId.parse(actor);
  legacyId.parse(store);
  legacyId.parse(order);
  legacyAction.parse(action);
  z.string().max(255).parse(note);
  return {
    namespace: 'legacy-fulfillment' as const,
    actor,
    store,
    order,
    action,
    readPath: '/api/v1/legacy-fulfillment/commands/',
    writePath:
      `/api/v1/stores/${store}/legacy-fulfillment/orders/${order}/` +
      (action === 'packing' ? 'packing' : 'rto-receipts'),
    method: action === 'packing' ? ('PUT' as const) : ('POST' as const),
    body: { note },
    intent: [1, actor, store, order, action, note],
    schema: legacyReceipt,
  };
}
export function checkSavedLegacyCommand(
  actor: string,
  store: string,
  order: string,
  action: LegacyAction,
  signal?: AbortSignal,
) {
  return recoverCommand(journal(actor, store, order, action, ''), signal);
}
export function sendLegacyCommand(
  actor: string,
  store: string,
  order: string,
  action: LegacyAction,
  note: string,
  signal?: AbortSignal,
) {
  return submitCommand(journal(actor, store, order, action, note), signal);
}
