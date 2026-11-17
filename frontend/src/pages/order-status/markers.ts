import type { Principal } from '../../api/types';
import { statusIntentSchema } from './client';
import { recoveryIntentSchema } from './repair-client';
function scope(user: Principal, storeId: string, orderId: string) {
  return JSON.stringify([
    user.id,
    user.role,
    user.userType,
    [...user.storeIds].sort(),
    storeId,
    orderId,
  ]);
}
export const statusMarkerKey = (user: Principal, storeId: string, orderId: string) =>
  'pos-whole-order-status:' + scope(user, storeId, orderId);
export const repairMarkerKey = (user: Principal, storeId: string, orderId: string) =>
  'pos-return-repair:' + scope(user, storeId, orderId);
/** Invalid saved metadata is retained and blocks new commands; it is never overwritten. */
export function readStatusMarkers(user: Principal, storeId: string, orderId: string) {
  const status = sessionStorage.getItem(statusMarkerKey(user, storeId, orderId)),
    repair = sessionStorage.getItem(repairMarkerKey(user, storeId, orderId));
  return {
    intent: status === null ? null : statusIntentSchema.parse(JSON.parse(status) as unknown),
    recovery: repair === null ? null : recoveryIntentSchema.parse(JSON.parse(repair) as unknown),
  };
}
export function inspectStatusMarkers(user: Principal, storeId: string, orderId: string) {
  try {
    const saved = readStatusMarkers(user, storeId, orderId);
    return { expanded: Boolean(saved.intent || saved.recovery), blocked: false };
  } catch {
    return { expanded: true, blocked: true };
  }
}
