import { orderLinkState, type OrderLinkScope } from '../checkout/order-link';
import { notificationIdentifier, type StoreNotice } from './notification-contracts';

const internalOrigin = 'https://pos.invalid';

/** WHATWG URL parsing treats a slash followed by a backslash as a network URL. */
export function safeNotificationPath(value: string | null): string | null {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u001f\u007f]/.test(value)
  )
    return null;
  try {
    const parsed = new URL(value, internalOrigin);
    if (parsed.origin !== internalOrigin || parsed.username || parsed.password) return null;
    return value;
  } catch {
    return null;
  }
}

/** Stored legacy notices have no persisted is_new_order field. */
export function isNewOrderNotice(notice: StoreNotice, incoming?: boolean): boolean {
  return incoming ?? notice.title.includes('Hyperlocal');
}

export function notificationDestination(
  notice: StoreNotice,
  scope: OrderLinkScope,
  incoming?: boolean,
): { to: string; state: Record<string, unknown> } | null {
  if (isNewOrderNotice(notice, incoming)) return { to: '/fulfillment?tab=in_queue', state: {} };
  const orderId = notificationIdentifier.safeParse(notice.orderId);
  if (orderId.success)
    return {
      to: '/orders?' + new URLSearchParams({ orderId: orderId.data }).toString(),
      state: orderLinkState(undefined, scope),
    };
  const path = safeNotificationPath(notice.url);
  return path ? { to: path, state: orderLinkState(undefined, scope) } : null;
}
