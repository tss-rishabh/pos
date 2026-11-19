import type { OrderRedis } from './order-redis.js';

/**
 * Legacy check-in state read straight from the legacy Redis keys, as the hyperlocal views do:
 * `check_in_{uid}` holds JSON `[store_id, "store name"]` (`Helpers.get_checkin_data`,
 * `helpers/helpers.py:1235-1240`, default `[0, ""]`), and `check_in_list_{store}` lists the
 * user ids checked into a store (`Helpers.get_checked_in_user`, `helpers/helpers.py:815-824`).
 */
export interface CheckInReader {
  /** The checked-in store id, or `null` for "not checked in" / store 0. */
  checkedInStore(userId: string): Promise<string | null>;
  checkedInUsers(storeId: string): Promise<string[]>;
}
export function redisCheckIns(redis: OrderRedis): CheckInReader {
  return {
    async checkedInStore(userId) {
      const raw = await redis.get(`check_in_${userId}`);
      if (raw === null) return null;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return null;
      }
      const storeId = Array.isArray(value) ? value[0] : null;
      const text =
        typeof storeId === 'number' && Number.isSafeInteger(storeId)
          ? String(storeId)
          : typeof storeId === 'string' && /^\d+$/.test(storeId)
            ? storeId
            : null;
      return text && BigInt(text) > 0n ? BigInt(text).toString() : null;
    },
    async checkedInUsers(storeId) {
      if (!/^\d+$/.test(storeId) || BigInt(storeId) <= 0n) return [];
      const values = await redis.lRange(`check_in_list_${storeId}`, 0, -1);
      // Legacy `list(map(int, data))`: order and duplicates are kept.
      return values.filter((value) => /^\d+$/.test(value)).map((v) => BigInt(v).toString());
    },
  };
}
