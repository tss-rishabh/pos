import { Temporal } from '@js-temporal/polyfill';
import { and, eq, exists, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser, Store, StoreCounter, UserStore } from '../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { administrationEphemeralStore, type EphemeralConfig } from './ephemeral-runtime.js';
import { assertCurrentStoreAccess } from './authorization.js';

export type AdministrationTransaction = Parameters<
  Parameters<ReturnType<Databases['get']>['transaction']>[0]
>[0];

/**
 * Legacy Redis check-in state (`helpers/helpers.py:794-812`, `:1235-1240`):
 * - `check_in_{uid}` → JSON `[store_id, store_name]`, EX = seconds to end of day − 1;
 * - `check_in_list_{store}` → LIST of user ids (LREM from every list, LPUSH, EXPIRE).
 * Check-out is legacy `check_in_store=0`, stored as `[0, ""]` (`core/views.py:2406-2425`).
 * The optional counter is rewrite-only: `pos:checkin_counter:{uid}` → counter id, same TTL.
 */
export const checkInKey = (userId: string) => `check_in_${userId}`;
export const checkInListKey = (storeId: string) => `check_in_list_${storeId}`;
export const checkInCounterKey = (userId: string) => `pos:checkin_counter:${userId}`;

/** `Helpers.time_until_end_of_day() - 1` in the business time zone (`helpers.py:759-765`). */
export function checkInSeconds(now = Temporal.Now.instant(), zone = 'Asia/Kolkata') {
  const local = now.toZonedDateTimeISO(zone);
  return (24 - local.hour - 1) * 3600 + (60 - local.minute - 1) * 60 + (60 - local.second) - 1;
}
export function checkInExpiry(now = Temporal.Now.instant(), zone = 'Asia/Kolkata') {
  return now.add({ seconds: checkInSeconds(now, zone) });
}

/** Python `json.dumps` text for `[id, name]` (", " separator, ASCII escapes), as legacy writes it. */
function pythonJsonPair(storeId: number, storeName: string) {
  const name = JSON.stringify(storeName).replace(
    /[\u007f-￿]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `[${storeId}, ${name}]`;
}
const legacyCheckInValue = z.tuple([z.coerce.number().int(), z.string()]).rest(z.unknown());

export interface LegacyCheckIn {
  storeId: string;
  storeName: string;
  /** Remaining TTL in seconds (legacy keys always carry one). */
  ttlSeconds: number;
}

/** `Helpers.get_checkin_data` (`helpers.py:1235-1240`); `null` when absent or checked out (id 0). */
export async function readLegacyCheckIn(
  ephemeral: EphemeralStore,
  userId: string,
): Promise<LegacyCheckIn | null> {
  const raw = await ephemeral.get(checkInKey(userId));
  if (raw === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = legacyCheckInValue.safeParse(decoded);
  if (!parsed.success || parsed.data[0] <= 0) return null;
  const ttlSeconds = await ephemeral.ttl(checkInKey(userId));
  if (ttlSeconds === -2) return null;
  return { storeId: String(parsed.data[0]), storeName: parsed.data[1], ttlSeconds };
}

/** `Helpers.set_check_in_store` (`helpers.py:794-812`), plus the rewrite-only counter key. */
export async function writeLegacyCheckIn(
  ephemeral: EphemeralStore,
  userId: string,
  storeId: string,
  storeName: string,
  seconds: number,
  counterId: string | null = null,
) {
  const ttl = Math.max(1, seconds);
  await ephemeral.set(checkInKey(userId), pythonJsonPair(Number(storeId), storeName), { EX: ttl });
  for (const key of await ephemeral.scanKeys('check_in_list_*'))
    await ephemeral.lRem(key, 0, userId);
  await ephemeral.lPush(checkInListKey(storeId), userId);
  await ephemeral.expire(checkInListKey(storeId), ttl);
  if (counterId) await ephemeral.set(checkInCounterKey(userId), counterId, { EX: ttl });
  else await ephemeral.del(checkInCounterKey(userId));
}

/** `Helpers.get_checked_in_user` (`helpers.py:815-824`). */
export async function legacyCheckedInUsers(ephemeral: EphemeralStore, storeId: string) {
  if (!(Number(storeId) > 0)) return [];
  return ephemeral.lRange(checkInListKey(storeId), 0, -1);
}

type CheckInConfig = Pick<Config, 'BUSINESS_TIMEZONE'> & EphemeralConfig;

const checkInStoreTypes: ('STORE' | 'CORE_WAREHOUSE')[] = ['STORE', 'CORE_WAREHOUSE'];

export function checkInService(
  db: Databases,
  config: CheckInConfig,
  ephemeral: EphemeralStore = administrationEphemeralStore(config),
) {
  function currentCheckInAuthorization(
    database: Pick<ReturnType<Databases['get']>, 'select'>,
    storeId: string,
  ) {
    return and(
      or(eq(PosUser.user_type, 1), and(eq(PosUser.user_type, 2), eq(Store.category, 'FRANCHISE'))),
      or(
        and(eq(PosUser.role, 1), eq(PosUser.user_type, 1)),
        exists(
          database
            .select({ id: UserStore.id })
            .from(UserStore)
            .where(
              and(
                eq(UserStore.django_user_id, PosUser.id),
                eq(UserStore.store_id, BigInt(storeId)),
              ),
            ),
        ),
      ),
    );
  }
  async function currentStoreAccess(
    userId: string,
    storeId: string,
    transaction: AdministrationTransaction,
    storeLock: 'share' | 'update' = 'update',
  ) {
    return assertCurrentStoreAccess(transaction, userId, storeId, undefined, storeLock);
  }
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
  /** Operational actions (billing, returns, …) need an active store, as `get_checkin_store`. */
  async function activeScope(
    storeId: string,
    counterId: string | null,
    transaction: AdministrationTransaction,
  ) {
    const [store] = await transaction
      .select({ id: Store.id })
      .from(Store)
      .where(
        and(
          eq(Store.id, BigInt(storeId)),
          eq(Store.is_active, true),
          inArray(Store.type, checkInStoreTypes),
        ),
      )
      .limit(1)
      .for('share');
    if (!store)
      throw new AppError(409, 'STORE_UNAVAILABLE', 'Select an active store or core warehouse.');
    if (counterId) await activeCounter(storeId, counterId, transaction);
  }
  /**
   * `Helpers.user_can_check_in` (`helpers.py:778-791`): STORE/CORE_WAREHOUSE only; closed
   * stores stay allowed so a pending day close can be signed off.
   */
  async function checkInTarget(storeId: string, transaction: AdministrationTransaction) {
    const [store] = await transaction
      .select({ name: Store.store_name })
      .from(Store)
      .where(and(eq(Store.id, BigInt(storeId)), inArray(Store.type, checkInStoreTypes)))
      .limit(1)
      .for('share');
    if (!store)
      throw new AppError(403, 'STORE_ACCESS_DENIED', 'You are not assigned to this store');
    return store.name;
  }
  async function currentCounter(userId: string) {
    const counterId = await ephemeral.get(checkInCounterKey(userId));
    return counterId && /^[1-9]\d{0,19}$/.test(counterId) ? counterId : null;
  }
  return {
    async checkedInStore(userId: string): Promise<string | null> {
      const checkIn = await readLegacyCheckIn(ephemeral, userId);
      if (!checkIn) return null;
      const database = db.get('writer');
      const [row] = await database
        .select({ storeId: Store.id })
        .from(Store)
        .innerJoin(PosUser, eq(PosUser.id, BigInt(userId)))
        .where(
          and(
            eq(Store.id, BigInt(checkIn.storeId)),
            eq(PosUser.is_active, true),
            inArray(PosUser.role, [1, 2, 3, 4, 5]),
            eq(Store.is_active, true),
            inArray(Store.type, checkInStoreTypes),
            currentCheckInAuthorization(database, checkIn.storeId),
          ),
        )
        .limit(1);
      return row ? String(row.storeId) : null;
    },
    async checkedInUsers(storeId: string): Promise<string[]> {
      const listed = [...new Set(await legacyCheckedInUsers(ephemeral, storeId))].filter((id) =>
        /^[1-9]\d{0,19}$/.test(id),
      );
      if (!listed.length) return [];
      const database = db.get('writer');
      const rows = await database
        .select({ operatorId: PosUser.id })
        .from(PosUser)
        .innerJoin(Store, eq(Store.id, BigInt(storeId)))
        .where(
          and(
            inArray(
              PosUser.id,
              listed.map((id) => BigInt(id)),
            ),
            eq(PosUser.is_active, true),
            inArray(PosUser.role, [1, 2, 3, 4, 5]),
            eq(Store.is_active, true),
            inArray(Store.type, checkInStoreTypes),
            currentCheckInAuthorization(database, storeId),
          ),
        );
      const allowed = new Set(rows.map((row) => String(row.operatorId)));
      return listed.filter((id) => allowed.has(id));
    },
    async current(user: Principal) {
      const checkIn = await readLegacyCheckIn(ephemeral, user.id);
      if (!checkIn) return null;
      try {
        requireStore(user, checkIn.storeId);
        await db
          .get('writer')
          .transaction(async (tx) => currentStoreAccess(user.id, checkIn.storeId, tx, 'share'));
      } catch (error) {
        if (error instanceof AppError && [401, 403].includes(error.status)) return null;
        throw error;
      }
      return {
        storeId: checkIn.storeId,
        counterId: await currentCounter(user.id),
        expiresAt: Temporal.Now.instant()
          .add({ seconds: Math.max(0, checkIn.ttlSeconds) })
          .toString(),
      };
    },
    /** `AjaxSetCheckindataView` (`core/views.py:2406-2425`). */
    async set(
      user: Principal,
      storeId: string,
      counterId: string | null,
      transaction?: AdministrationTransaction,
    ) {
      try {
        requireStore(user, storeId);
      } catch {
        throw new AppError(403, 'STORE_ACCESS_DENIED', 'You are not assigned to this store');
      }
      const validate = async (current: AdministrationTransaction) => {
        try {
          await currentStoreAccess(user.id, storeId, current, 'share');
        } catch (error) {
          if (error instanceof AppError && error.code === 'STORE_ACCESS_DENIED')
            throw new AppError(403, 'STORE_ACCESS_DENIED', 'You are not assigned to this store');
          throw error;
        }
        const storeName = await checkInTarget(storeId, current);
        if (counterId) await activeCounter(storeId, counterId, current);
        return storeName;
      };
      const storeName = transaction
        ? await validate(transaction)
        : await db.get('writer').transaction(validate);
      const now = Temporal.Now.instant(),
        seconds = checkInSeconds(now, config.BUSINESS_TIMEZONE);
      await writeLegacyCheckIn(ephemeral, user.id, storeId, storeName, seconds, counterId);
      return {
        storeId,
        counterId,
        expiresAt: now.add({ seconds: Math.max(1, seconds) }).toString(),
        message: 'Check-in changed',
      };
    },
    /** Legacy check-out is a check-in to store 0 (`helpers.py:778-783`, `:794-812`). */
    async clear(user: Principal) {
      await writeLegacyCheckIn(
        ephemeral,
        user.id,
        '0',
        '',
        checkInSeconds(Temporal.Now.instant(), config.BUSINESS_TIMEZONE),
      );
    },
    async assertCheckIn(
      userId: string,
      storeId: string,
      counterId?: string,
      transaction?: AdministrationTransaction,
    ) {
      const assertCurrent = async (current: AdministrationTransaction) => {
        let scopeError: AppError | undefined;
        try {
          await currentStoreAccess(userId, storeId, current);
          await activeScope(storeId, counterId ?? null, current);
        } catch (error: unknown) {
          if (
            error instanceof AppError &&
            ['STORE_ACCESS_DENIED', 'STORE_UNAVAILABLE', 'COUNTER_UNAVAILABLE'].includes(error.code)
          )
            // Preserve CHECK_IN_REQUIRED for a missing/expired/wrong check-in, then
            // return the original current-scope refusal.
            scopeError = error;
          else throw error;
        }
        const checkIn = await readLegacyCheckIn(ephemeral, userId),
          checkedInCounter = checkIn ? await currentCounter(userId) : null;
        if (
          !checkIn ||
          checkIn.storeId !== storeId ||
          (counterId && checkedInCounter !== counterId)
        )
          throw new AppError(
            409,
            'CHECK_IN_REQUIRED',
            'Check in to this store and counter before continuing.',
          );
        if (scopeError) throw scopeError;
        if (counterId === undefined && checkedInCounter !== null)
          await activeCounter(storeId, checkedInCounter, current);
      };
      return transaction ? assertCurrent(transaction) : db.get('writer').transaction(assertCurrent);
    },
  };
}
