import { captureOperatorScope } from '../../api/client';
import type { Principal } from '../../api/types';
import { db } from '../../offline/database';
import { cachedOperatorForStore } from '../../offline/operator-session';
export const invoiceIdentity = (user: Principal) =>
  JSON.stringify([user.id, user.role, user.userType, [...new Set(user.storeIds)].sort()]);
export async function currentInvoiceSession(user: Principal, storeId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const cached = await db.sessions.get('current');
  signal.throwIfAborted();
  const current = cachedOperatorForStore(cached, user.id, storeId, Date.now());
  if (
    invoiceIdentity(current) !== invoiceIdentity(user) ||
    localStorage.getItem('pos-pending-logout')
  )
    throw new Error('Sign in with a current operator session for this store.');
  return cached!;
}
export function invoiceActorSignal(user: Principal, signal?: AbortSignal) {
  return AbortSignal.any([captureOperatorScope(user.id), ...(signal ? [signal] : [])]);
}
