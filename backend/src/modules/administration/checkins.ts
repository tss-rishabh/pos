import { Temporal } from '@js-temporal/polyfill';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { Store, StoreCounter } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { authKeys } from '../../auth/keys.js';
import { loginCheckIns, storeDirectory } from '../../auth/checkin.js';
import type { RedisPort } from '../../redis/port.js';
import { connectRedisPort } from '../../redis/node-client.js';
import { assertCurrentStoreAccess } from './authorization.js';

export type AdministrationTransaction = Parameters<
  Parameters<ReturnType<Databases['get']>['transaction']>[0]
>[0];
/** Instant at which a check-in made `now` expires: legacy `time_until_end_of_day() - 1`. */
export function checkInExpiry(now = Temporal.Now.instant(), zone = 'Asia/Kolkata') {
  return now.add({ seconds: checkInSeconds(now, zone) });
}
/** Legacy `Helpers.time_until_end_of_day() - 1` (`helpers/helpers.py:759-765`, `core/views.py:2421`). */
export function checkInSeconds(now = Temporal.Now.instant(), zone = 'Asia/Kolkata') {
  const local = now.toZonedDateTimeISO(zone);
  return Math.max(
    1,
    (24 - local.hour - 1) * 3600 + (60 - local.minute - 1) * 60 + (60 - local.second) - 1,
  );
}

/**
 * The check-in store lives only in the legacy Redis keys that login (W3) and a running legacy
 * app write: `check_in_{uid}` = JSON `[store_id, "store name"]` until the end of the business
 * day, and `check_in_list_{store}` = operator ids (`helpers/helpers.py:794-812`). The rewrite-only
 * `pos_rewrite_operator_checkins` table is no longer read or written.
 *
 * `buildApp` binds the authentication Redis port here; otherwise one client per `REDIS_URL`
 * is created lazily. Without either, every check-in read is refused (503).
 */
let bound: RedisPort | undefined;
const shared = new Map<string, RedisPort>();
export function bindCheckInRedis(port: RedisPort | undefined) {
  bound = port;
}
function checkInRedis(config: Partial<Pick<Config, 'REDIS_URL' | 'NODE_ENV'>>): RedisPort | null {
  if (bound) return bound;
  if (!config.REDIS_URL) return null;
  let port = shared.get(config.REDIS_URL);
  if (!port) {
    port = connectRedisPort(config.REDIS_URL, config.NODE_ENV ?? 'production');
    shared.set(config.REDIS_URL, port);
  }
  return port;
}
const unavailable = () =>
  new AppError(503, 'CHECK_IN_UNAVAILABLE', 'Store check-in is temporarily unavailable.');
const legacyValue = z.tuple([z.union([z.number().int(), z.string().regex(/^\d+$/)]), z.unknown()]);
/** Legacy `Helpers.get_checkin_data` (`helpers/helpers.py:1235-1240`): `[0, ""]` when absent. */
export function parseCheckInValue(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed = legacyValue.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const id = String(parsed.data[0]);
    return id === '0' ? null : id;
  } catch {
    return null;
  }
}

export function checkInService(
  db: Databases,
  config: Pick<Config, 'BUSINESS_TIMEZONE'> & Partial<Pick<Config, 'REDIS_URL' | 'NODE_ENV'>>,
  redis?: RedisPort,
) {
  const port = () => {
    const value = redis ?? checkInRedis(config);
    if (!value) throw unavailable();
    return value;
  };
  async function activeCounter(
    storeId: string,
    counterId: string,
    transaction: AdministrationTransaction,
  ) {
    const [counter] = await transaction
      .select({ id: StoreCounter.id })
      .from(StoreCounter)
      .where(
        and(
          eq(StoreCounter.id, BigInt(counterId)),
          eq(StoreCounter.store, BigInt(storeId)),
          eq(StoreCounter.is_active, true),
        ),
      )
      .limit(1)
      .for('share');
    if (!counter)
      throw new AppError(409, 'COUNTER_UNAVAILABLE', 'Select an active counter in this store.');
  }
  async function activeStore(storeId: string, transaction: AdministrationTransaction) {
    const [store] = await transaction
      .select({ id: Store.id })
      .from(Store)
      .where(
        and(
          eq(Store.id, BigInt(storeId)),
          eq(Store.is_active, true),
          inArray(Store.type, ['STORE', 'CORE_WAREHOUSE']),
        ),
      )
      .limit(1)
      .for('share');
    if (!store)
      throw new AppError(409, 'STORE_UNAVAILABLE', 'Select an active store or core warehouse.');
  }
  async function storeOf(userId: string): Promise<string | null> {
    return parseCheckInValue(await port().get(authKeys.checkIn(userId)));
  }
  async function record(userId: string, storeId: string) {
    await loginCheckIns(storeDirectory(db), port()).record(
      userId,
      storeId,
      checkInSeconds(Temporal.Now.instant(), config.BUSINESS_TIMEZONE),
    );
  }
  async function expiresAt(userId: string) {
    const ttl = await port().pTtl(authKeys.checkIn(userId));
    return ttl > 0 ? Temporal.Now.instant().add({ milliseconds: ttl }).toString() : null;
  }
  return {
    /** The operator's checked-in store id, or null for none / "Not at the store" (store 0). */
    checkedInStore: storeOf,
    /** Legacy `Helpers.get_checked_in_user` (`helpers/helpers.py:815-823`). */
    async checkedInUsers(storeId: string): Promise<string[]> {
      if (BigInt(storeId) <= 0n) return [];
      return (await port().lRange(authKeys.checkInList(storeId), 0, -1)).filter((id) =>
        /^\d+$/.test(id),
      );
    },
    /** Legacy `AjaxGetCheckindataView` check-in id (`core/views.py:2399-2400`). */
    async current(user: Principal) {
      const storeId = await storeOf(user.id);
      if (!storeId) return null;
      return { storeId, counterId: null, expiresAt: await expiresAt(user.id) };
    },
    /**
     * Legacy `AjaxSetCheckindataView` (`core/views.py:2406-2425`): `user_can_check_in` (STORE or
     * CORE_WAREHOUSE, closed stores allowed, assigned unless role 1), then `set_check_in_store`
     * until the end of the business day. Legacy check-ins carry no counter; `counterId` is ignored.
     */
    async set(
      user: Principal,
      storeId: string,
      _counterId: string | null,
      _transaction?: AdministrationTransaction,
    ) {
      if (!(await loginCheckIns(storeDirectory(db), port()).allowed(user.id, user.role, storeId)))
        throw new AppError(403, 'STORE_ACCESS_DENIED', 'You are not assigned to this store');
      await record(user.id, storeId);
      return { storeId, counterId: null, expiresAt: await expiresAt(user.id) };
    },
    /** "Not at the store": legacy check-in to store 0 (`helpers/helpers.py:782-783`). */
    async clear(user: Principal) {
      await record(user.id, '0');
    },
    /**
     * Current store access and an active store (and counter, when given) under the caller's
     * transaction, then the operator's legacy check-in must be this store.
     */
    async assertCheckIn(
      userId: string,
      storeId: string,
      counterId?: string,
      transaction?: AdministrationTransaction,
    ) {
      const assertCurrent = async (current: AdministrationTransaction) => {
        let scopeError: AppError | undefined;
        try {
          await assertCurrentStoreAccess(current, userId, storeId);
          await activeStore(storeId, current);
          if (counterId) await activeCounter(storeId, counterId, current);
        } catch (error: unknown) {
          if (
            error instanceof AppError &&
            ['STORE_ACCESS_DENIED', 'STORE_UNAVAILABLE', 'COUNTER_UNAVAILABLE'].includes(error.code)
          )
            scopeError = error;
          else throw error;
        }
        if ((await storeOf(userId)) !== storeId)
          throw new AppError(409, 'CHECK_IN_REQUIRED', 'Check in to this store before continuing.');
        if (scopeError) throw scopeError;
      };
      return transaction ? assertCurrent(transaction) : db.get('writer').transaction(assertCurrent);
    },
  };
}
export type CheckInService = ReturnType<typeof checkInService>;
