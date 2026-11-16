import { Temporal } from '@js-temporal/polyfill';
import { and, eq, exists, gt, inArray, or } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser, Store, StoreCounter, UserStore } from '../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { operatorCheckIns } from './schema.js';
import { assertCurrentStoreAccess } from './authorization.js';

export type AdministrationTransaction = Parameters<
  Parameters<ReturnType<Databases['get']>['transaction']>[0]
>[0];
function sqlInstant(value: Temporal.Instant) {
  return value
    .toZonedDateTimeISO('UTC')
    .toPlainDateTime()
    .toString({ smallestUnit: 'millisecond' })
    .replace('T', ' ');
}
export function checkInExpiry(now = Temporal.Now.instant(), zone = 'Asia/Kolkata') {
  const local = now.toZonedDateTimeISO(zone);
  const seconds =
    (24 - local.hour - 1) * 3600 + (60 - local.minute - 1) * 60 + (60 - local.second) - 1;
  return now.add({ seconds });
}
export function checkInService(db: Databases, config: Pick<Config, 'BUSINESS_TIMEZONE'>) {
  function currentCheckInAuthorization(database: Pick<ReturnType<Databases['get']>, 'select'>) {
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
                eq(UserStore.store_id, operatorCheckIns.storeId),
              ),
            ),
        ),
      ),
    );
  }
  async function currentStoreAccess(
    userId: string,
    storeId: string,
    transaction?: AdministrationTransaction,
  ) {
    if (transaction) return assertCurrentStoreAccess(transaction, userId, storeId);
    return db
      .get('writer')
      .transaction((current) => assertCurrentStoreAccess(current, userId, storeId));
  }
  async function activeScope(
    storeId: string,
    counterId: string | null,
    transaction?: AdministrationTransaction,
  ) {
    const database = transaction ?? db.get('writer');
    const storeQuery = database
      .select({ id: Store.id })
      .from(Store)
      .where(
        and(
          eq(Store.id, BigInt(storeId)),
          eq(Store.is_active, true),
          inArray(Store.type, ['STORE', 'CORE_WAREHOUSE']),
        ),
      )
      .limit(1);
    const [store] = transaction ? await storeQuery.for('share') : await storeQuery;
    if (!store)
      throw new AppError(409, 'STORE_UNAVAILABLE', 'Select an active store or core warehouse.');
    if (counterId) {
      const counterQuery = database
        .select({ id: StoreCounter.id })
        .from(StoreCounter)
        .where(
          and(
            eq(StoreCounter.id, BigInt(counterId)),
            eq(StoreCounter.store, BigInt(storeId)),
            eq(StoreCounter.is_active, true),
          ),
        )
        .limit(1);
      const [counter] = transaction ? await counterQuery.for('share') : await counterQuery;
      if (!counter)
        throw new AppError(409, 'COUNTER_UNAVAILABLE', 'Select an active counter in this store.');
    }
  }
  return {
    async checkedInStore(userId: string): Promise<string | null> {
      const database = db.get('writer');
      const [row] = await database
        .select({ storeId: operatorCheckIns.storeId })
        .from(operatorCheckIns)
        .innerJoin(PosUser, eq(PosUser.id, BigInt(userId)))
        .innerJoin(Store, eq(Store.id, operatorCheckIns.storeId))
        .where(
          and(
            eq(operatorCheckIns.operatorId, userId),
            gt(operatorCheckIns.expiresAt, sqlInstant(Temporal.Now.instant())),
            eq(PosUser.is_active, true),
            inArray(PosUser.role, [1, 2, 3, 4, 5]),
            eq(Store.is_active, true),
            inArray(Store.type, ['STORE', 'CORE_WAREHOUSE']),
            currentCheckInAuthorization(database),
          ),
        )
        .limit(1);
      return row ? String(row.storeId) : null;
    },
    async checkedInUsers(storeId: string): Promise<string[]> {
      const database = db.get('writer');
      const rows = await database
        .select({ operatorId: operatorCheckIns.operatorId })
        .from(operatorCheckIns)
        .innerJoin(PosUser, eq(PosUser.id, operatorCheckIns.operatorId))
        .innerJoin(Store, eq(Store.id, operatorCheckIns.storeId))
        .where(
          and(
            eq(operatorCheckIns.storeId, BigInt(storeId)),
            gt(operatorCheckIns.expiresAt, sqlInstant(Temporal.Now.instant())),
            eq(PosUser.is_active, true),
            inArray(PosUser.role, [1, 2, 3, 4, 5]),
            eq(Store.is_active, true),
            inArray(Store.type, ['STORE', 'CORE_WAREHOUSE']),
            currentCheckInAuthorization(database),
          ),
        );
      return rows.map((row) => row.operatorId);
    },
    async current(user: Principal) {
      const [row] = await db
        .get('writer')
        .select()
        .from(operatorCheckIns)
        .where(eq(operatorCheckIns.operatorId, user.id))
        .limit(1);
      if (
        !row ||
        Temporal.Instant.compare(
          Temporal.PlainDateTime.from(row.expiresAt.replace(' ', 'T'))
            .toZonedDateTime('UTC')
            .toInstant(),
          Temporal.Now.instant(),
        ) <= 0
      )
        return null;
      requireStore(user, String(row.storeId));
      try {
        await currentStoreAccess(user.id, String(row.storeId));
        await activeScope(
          String(row.storeId),
          row.counterId === null ? null : String(row.counterId),
        );
      } catch (error) {
        if (error instanceof AppError && [401, 403, 409].includes(error.status)) return null;
        throw error;
      }
      return {
        storeId: String(row.storeId),
        counterId: row.counterId === null ? null : String(row.counterId),
        expiresAt: Temporal.PlainDateTime.from(row.expiresAt.replace(' ', 'T'))
          .toZonedDateTime('UTC')
          .toInstant()
          .toString(),
      };
    },
    async set(
      user: Principal,
      storeId: string,
      counterId: string | null,
      transaction?: AdministrationTransaction,
    ) {
      requireStore(user, storeId);
      const save = async (transaction: AdministrationTransaction) => {
        await currentStoreAccess(user.id, storeId, transaction);
        await activeScope(storeId, counterId, transaction);
        const now = Temporal.Now.instant(),
          expires = checkInExpiry(now, config.BUSINESS_TIMEZONE);
        const record = {
          operatorId: user.id,
          storeId: BigInt(storeId),
          counterId: counterId ? BigInt(counterId) : null,
          expiresAt: sqlInstant(expires),
          checkedInAt: sqlInstant(now),
        };
        await transaction
          .insert(operatorCheckIns)
          .values(record)
          .onDuplicateKeyUpdate({ set: record });
        return { storeId, counterId, expiresAt: expires.toString() };
      };
      return transaction ? save(transaction) : db.get('writer').transaction(save);
    },
    async clear(user: Principal) {
      await db
        .get('writer')
        .delete(operatorCheckIns)
        .where(eq(operatorCheckIns.operatorId, user.id));
    },
    async assertCheckIn(
      userId: string,
      storeId: string,
      counterId?: string,
      transaction?: AdministrationTransaction,
    ) {
      const database = transaction ?? db.get('writer');
      const query = database
        .select()
        .from(operatorCheckIns)
        .where(eq(operatorCheckIns.operatorId, userId))
        .limit(1);
      const [row] = transaction ? await query.for('update') : await query;
      const expired =
        !row ||
        Temporal.Instant.compare(
          Temporal.PlainDateTime.from(row.expiresAt.replace(' ', 'T'))
            .toZonedDateTime('UTC')
            .toInstant(),
          Temporal.Now.instant(),
        ) <= 0;
      if (
        expired ||
        String(row!.storeId) !== storeId ||
        (counterId && String(row!.counterId) !== counterId)
      )
        throw new AppError(
          409,
          'CHECK_IN_REQUIRED',
          'Check in to this store and counter before continuing.',
        );
      await currentStoreAccess(userId, storeId, transaction);
      await activeScope(
        storeId,
        counterId ?? (row!.counterId === null ? null : String(row!.counterId)),
        transaction,
      );
    },
  };
}
