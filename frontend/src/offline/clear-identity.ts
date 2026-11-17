import type { QueryClient } from '@tanstack/react-query';
import { setRequestOperator } from '../api/client';
import { useWorkspace } from '../state/workspace';
import { db } from './database';
import { clearDesktopSsoReference } from './desktop-sso';

/** Revoke local identity immediately; operator-owned sales/outbox remain durable. */
export async function clearLocalIdentity(
  client: QueryClient,
  ownerId: string,
  fromOperatorQuery = false,
) {
  setRequestOperator(null);
  clearDesktopSsoReference();
  try {
    localStorage.setItem('pos-pending-logout', '1');
  } catch {
    /* A disabled storage API has no usable identity cache. */
  }
  await client.cancelQueries(
    fromOperatorQuery ? { predicate: (query) => query.queryKey[0] !== 'operator' } : undefined,
  );
  try {
    await db.transaction('rw', db.sessions, db.catalog, db.lookups, async () => {
      await db.sessions.clear();
      await db.catalog.where('ownerId').equals(ownerId).delete();
      await db.lookups.delete(ownerId);
    });
    await (await import('../pages/catalog/snapshot-cache')).clearCatalogSnapshots(ownerId);
  } finally {
    useWorkspace.getState().reset();
    client.setQueryData(['operator'], null);
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'operator' });
  }
}
