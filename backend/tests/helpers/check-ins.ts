import { loginCheckIns } from '../../src/auth/checkin.js';
import { authKeys } from '../../src/auth/keys.js';
import { bindCheckInRedis, boundCheckInRedis } from '../../src/modules/administration/checkins.js';
import { memoryRedisPort } from './memory-redis.js';
import type { RedisPort } from '../../src/redis/port.js';

/**
 * Check-ins live only in the legacy Redis keys `check_in_{uid}` = `[store_id, "name"]` and
 * `check_in_list_{store}` (`helpers/helpers.py:794-812`), written by the same `loginCheckIns`
 * code that login and `PUT /api/v1/operators/me/check-in` use. Tests seed them on the port
 * `buildApp` bound (`bindCheckInRedis(authRedis)`); seed after `buildApp`. Without a bound port
 * an in-process one is bound. Legacy check-ins carry no counter.
 */
export function checkInRedis(): RedisPort {
  const current = boundCheckInRedis();
  if (current) return current;
  const port = memoryRedisPort();
  bindCheckInRedis(port);
  return port;
}

export async function seedCheckIn(
  operatorId: string,
  storeId: string,
  options: { storeName?: string; ttlSeconds?: number } = {},
) {
  const name = options.storeName ?? `Store ${storeId}`;
  await loginCheckIns(
    { eligible: async () => true, name: async () => name },
    checkInRedis(),
  ).record(operatorId, storeId, options.ttlSeconds ?? 86_400);
}

/** Equivalent of the old `expires_at` in the past: the legacy key is gone. */
export async function clearCheckIn(operatorId: string) {
  const port = checkInRedis();
  await loginCheckIns({ eligible: async () => true, name: async () => '' }, port).leaveLists(
    operatorId,
  );
  await port.del([authKeys.checkIn(operatorId)]);
}
