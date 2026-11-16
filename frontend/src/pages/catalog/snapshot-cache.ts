import Dexie, { type Table } from 'dexie';
import type { Principal } from '../../api/types';
import { db } from '../../offline/database';
import { catalogSnapshot } from './contracts';
interface CachedSnapshot {
  key: string;
  ownerId: string;
  cachedAt: number;
  expiresAt: number;
  value: unknown;
}
class CatalogSnapshotDatabase extends Dexie {
  snapshots!: Table<CachedSnapshot, string>;
  constructor() {
    super('pos-catalog-snapshots');
    this.version(1).stores({ snapshots: 'key,ownerId,cachedAt' });
  }
}
const cache = new CatalogSnapshotDatabase();
const cacheKey = (user: Principal, storeId: string) =>
  JSON.stringify([user.id, user.role, user.userType, [...user.storeIds].sort(), storeId]);
export async function saveCatalogSnapshot(user: Principal, storeId: string, value: unknown) {
  const parsed = catalogSnapshot.parse(value);
  const session = await db.sessions.get('current');
  if (!session || session.user.id !== user.id || session.expiresAt <= Date.now())
    return { saved: false, expiresAt: null };
  const expiresAt = Math.min(Date.now() + 86400000, session.expiresAt);
  try {
    await cache.snapshots
      .where('cachedAt')
      .below(Date.now() - 86400000)
      .delete();
    await cache.snapshots.put({
      key: cacheKey(user, storeId),
      ownerId: user.id,
      cachedAt: Date.now(),
      expiresAt,
      value: parsed,
    });
    const owned = await cache.snapshots.where('ownerId').equals(user.id).sortBy('cachedAt');
    await cache.snapshots.bulkDelete(
      owned.slice(0, Math.max(0, owned.length - 10)).map((row) => row.key),
    );
    return { saved: true, expiresAt };
  } catch {
    return { saved: false, expiresAt: null };
  }
}
export async function loadCatalogSnapshot(user: Principal, storeId: string) {
  const session = await db.sessions.get('current');
  if (
    !session ||
    session.user.id !== user.id ||
    session.expiresAt <= Date.now() ||
    cacheKey(session.user, storeId) !== cacheKey(user, storeId)
  )
    return null;
  const previous = await cache.snapshots.get(cacheKey(user, storeId));
  return previous && previous.expiresAt > Date.now() && previous.cachedAt > Date.now() - 86400000
    ? { ...catalogSnapshot.parse(previous.value), cacheExpiresAt: previous.expiresAt }
    : null;
}
export async function clearCatalogSnapshots(ownerId?: string) {
  if (typeof localStorage !== 'undefined') {
    const prefixes = ['pos:catalog-columns:', 'pos:catalog-maintenance-command:'].map(
      (value) => value + (ownerId ? ownerId + ':' : ''),
    );
    try {
      for (const key of Object.keys(localStorage))
        if (prefixes.some((prefix) => key.startsWith(prefix))) localStorage.removeItem(key);
    } catch {
      /* Private browser modes can disable preference storage. */
    }
  }
  if (ownerId) await cache.snapshots.where('ownerId').equals(ownerId).delete();
  else await cache.snapshots.clear();
}
