import { principalSchema } from '../api/schemas';
import { z } from 'zod';
import { db } from './database';

const cachedSession = z.object({
  id: z.literal('current'),
  user: principalSchema,
  expiresAt: z.number().int().safe().positive(),
});
export function cachedOperatorForStore(
  value: unknown,
  operatorId: string,
  storeId: string,
  now: number,
) {
  const parsed = cachedSession.safeParse(value);
  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !parsed.success ||
    parsed.data.expiresAt <= now ||
    parsed.data.user.id !== operatorId ||
    !(
      (parsed.data.user.role === 1 && parsed.data.user.userType === 1) ||
      parsed.data.user.storeIds.includes(storeId)
    )
  )
    throw new Error('Sign in with a current operator session for this store.');
  return parsed.data.user;
}

/** Read-only private panels require the current, unexpired operator/store scope. */
export async function requireCachedOperatorSession(
  operatorId: string,
  storeId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const record = await db.sessions.get('current');
  signal.throwIfAborted();
  const user = cachedOperatorForStore(record, operatorId, storeId, Date.now());
  if (localStorage.getItem('pos-pending-logout'))
    throw new Error('Sign in with a current operator session for this store.');
  return user;
}
