import { z } from 'zod';
const owner = z.string().regex(/^[1-9]\d{0,19}$/);
const marker = z.object({ v: z.literal(1), commandId: z.uuid() }).strict();
const key = (operatorId: string, storeId: string, checkoutId: string) =>
  'pos-order-copy-origin:' +
  JSON.stringify([owner.parse(operatorId), owner.parse(storeId), z.uuid().parse(checkoutId)]);
/** Before dispatch: an unchanged local draft cannot represent this server copy. */
export function markOrderCopyOrigin(
  operatorId: string,
  storeId: string,
  checkoutId: string,
  commandId: string,
) {
  localStorage.setItem(
    key(operatorId, storeId, checkoutId),
    JSON.stringify(marker.parse({ v: 1, commandId })),
  );
  window.dispatchEvent(new Event('pos-order-copy-marker-changed'));
}
/** A copied origin fails closed (needs online review) until the original online sale/clear completes. */
export function orderCopyRequiresOnlineReview(
  operatorId: string,
  storeId: string,
  checkoutId: string,
): boolean {
  try {
    const raw = localStorage.getItem(key(operatorId, storeId, checkoutId));
    if (raw === null) return false;
    marker.parse(JSON.parse(raw) as unknown);
    return true;
  } catch {
    return true;
  }
}
/** Call only after independently validated online paid completion/terminal clear. */
export function clearOrderCopyOrigin(operatorId: string, storeId: string, checkoutId: string) {
  try {
    localStorage.removeItem(key(operatorId, storeId, checkoutId));
    window.dispatchEvent(new Event('pos-order-copy-marker-changed'));
  } catch {
    // Optional cleanup cannot undo a committed paid/clear result. An orphan
    // marker remains scoped to the retired checkout UUID.
  }
}
