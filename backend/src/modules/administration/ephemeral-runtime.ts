import type { Config } from '../../config.js';
import {
  memoryEphemeralStore,
  redisEphemeralStore,
  unavailableEphemeralStore,
  type EphemeralStore,
} from '../../jobs/ephemeral.js';
import { connectRedis } from '../../jobs/redis.js';

export type EphemeralConfig = Partial<Pick<Config, 'REDIS_URL' | 'NODE_ENV' | 'DEMO_MODE'>>;
let shared: EphemeralStore | undefined;

/** The API process hands its module-runtime Redis store here once (`src/app.ts`). */
export function useAdministrationEphemeralStore(store: EphemeralStore) {
  shared = store;
}

/**
 * One ephemeral store per process, so every `checkInService(db, config)` (constructed by many
 * modules) and every administration service read the same Redis state. Without REDIS_URL:
 * in-process memory outside production, fail-closed (503) in production.
 */
export function administrationEphemeralStore(config: EphemeralConfig): EphemeralStore {
  if (shared) return shared;
  if (config.REDIS_URL && !config.DEMO_MODE)
    shared = redisEphemeralStore(connectRedis(config.REDIS_URL, config.NODE_ENV ?? 'production'));
  else
    shared =
      config.NODE_ENV === 'production' ? unavailableEphemeralStore() : memoryEphemeralStore();
  return shared;
}
