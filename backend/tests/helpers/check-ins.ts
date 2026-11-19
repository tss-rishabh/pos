import { administrationEphemeralStore } from '../../src/modules/administration/ephemeral-runtime.js';
import {
  checkInCounterKey,
  checkInKey,
  checkInListKey,
  writeLegacyCheckIn,
} from '../../src/modules/administration/checkins.js';

/**
 * Check-ins live in the legacy Redis keys `check_in_{uid}` / `check_in_list_{store}` (W8), not in
 * `pos_rewrite_operator_checkins`. Tests seed and expire them through the process-wide
 * administration store (in-memory outside production), which `buildApp` and every
 * `checkInService(db, config)` share. Seed after `buildApp`, which installs its own store.
 */
export async function seedCheckIn(
  operatorId: string,
  storeId: string,
  counterId: string | null = null,
  options: { storeName?: string; ttlSeconds?: number } = {},
) {
  await writeLegacyCheckIn(
    administrationEphemeralStore({ NODE_ENV: 'test' }),
    operatorId,
    storeId,
    options.storeName ?? `Store ${storeId}`,
    options.ttlSeconds ?? 86_400,
    counterId,
  );
}

/** Equivalent of the old `expires_at` in the past: the legacy key is gone. */
export async function clearCheckIn(operatorId: string) {
  const store = administrationEphemeralStore({ NODE_ENV: 'test' });
  for (const key of await store.scanKeys('check_in_list_*')) await store.lRem(key, 0, operatorId);
  await store.del(checkInKey(operatorId), checkInCounterKey(operatorId));
}

export { checkInListKey };
