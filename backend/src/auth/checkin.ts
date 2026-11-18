import { and, eq, inArray } from 'drizzle-orm';
import type { Databases } from '../db/pools.js';
import { Store, UserStore } from '../db/legacy-schema.js';
import type { MultiCommand, RedisPort } from '../redis/port.js';
import { authKeys } from './keys.js';

/** Python `json.dumps(value)` (ensure_ascii, ", " separator) for `[store_id, store_name]`. */
export function legacyCheckInValue(storeId: string, storeName: string | null): string {
  const name =
    storeName === null
      ? 'null'
      : JSON.stringify(storeName).replace(
          /[\u007f-￿]/g,
          (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
        );
  return `[${BigInt(storeId).toString()}, ${name}]`;
}
/**
 * Login-time check-in, as legacy AjaxMfaLoginView does it. The keys are the legacy
 * `check_in_{uid}` / `check_in_list_{store}` so a running legacy app and the readers that
 * still use them (context processor, notification targets, day close) see the same state.
 */
export interface CheckInStoreDirectory {
  /** Store eligibility for a non-zero store id. */
  eligible(userId: string, role: number, storeId: string): Promise<boolean>;
  /** `stores.store_name` ('' when the row is missing, as legacy). */
  name(storeId: string): Promise<string | null>;
}
export function storeDirectory(db: Databases): CheckInStoreDirectory {
  return {
    async eligible(userId, role, storeId) {
      const reader = db.get('writer');
      const [store] = await reader
        .select({ id: Store.id })
        .from(Store)
        .where(
          and(
            eq(Store.id, BigInt(storeId)),
            inArray(Store.type, ['STORE', 'CORE_WAREHOUSE']),
            role === 1
              ? undefined
              : inArray(
                  Store.id,
                  reader
                    .select({ id: UserStore.store_id })
                    .from(UserStore)
                    .where(eq(UserStore.django_user_id, BigInt(userId))),
                ),
          ),
        )
        .limit(1);
      return Boolean(store);
    },
    async name(storeId) {
      const [store] = await db
        .get('writer')
        .select({ name: Store.store_name })
        .from(Store)
        .where(eq(Store.id, BigInt(storeId)))
        .limit(1);
      return store ? store.name : '';
    },
  };
}
export function loginCheckIns(stores: CheckInStoreDirectory, redis: RedisPort) {
  return {
    /**
     * legacy Helpers.user_can_check_in (helpers.py:778-791): store 0 ("Not at the store")
     * is always allowed; otherwise a STORE or CORE_WAREHOUSE (inactive stores allowed),
     * assigned to the user unless role 1.
     */
    async allowed(userId: string, role: number, storeId: string): Promise<boolean> {
      return storeId === '0' || stores.eligible(userId, role, storeId);
    },
    /** legacy Helpers.set_check_in_store (helpers.py:794-812), with the writes in one MULTI. */
    async record(userId: string, storeId: string, eodSeconds: number) {
      const storeName = storeId === '0' ? '' : await stores.name(storeId);
      const lists = await redis.scanKeys(authKeys.checkInListPattern);
      const commands: MultiCommand[] = [
        {
          command: 'SET',
          key: authKeys.checkIn(userId),
          value: legacyCheckInValue(storeId, storeName),
          options: { EX: eodSeconds },
        },
        ...lists.map((key): MultiCommand => ({ command: 'LREM', key, count: 0, value: userId })),
        { command: 'LPUSH', key: authKeys.checkInList(storeId), value: userId },
        { command: 'EXPIRE', key: authKeys.checkInList(storeId), seconds: eodSeconds },
      ];
      await redis.multi(commands);
    },
    /** legacy CustomLogoutView: LREM the user from every check-in list; `check_in_{uid}` stays. */
    async leaveLists(userId: string) {
      const lists = await redis.scanKeys(authKeys.checkInListPattern);
      if (lists.length)
        await redis.multi(
          lists.map((key): MultiCommand => ({ command: 'LREM', key, count: 0, value: userId })),
        );
    },
  };
}
export type LoginCheckIns = ReturnType<typeof loginCheckIns>;
