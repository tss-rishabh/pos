import { administrationCollectionPage, collectionField } from './collection-page.js';
import { generatedId } from '../../db/generated-id.js';
import { and, count, eq, getTableColumns, inArray, like, or, sql } from 'drizzle-orm';
import { StockStorage, Store, StoreCounter, StoreStorage } from '../../db/legacy-schema.js';
import { requireRole, requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { retryTransaction } from '../../db/retry.js';
import { counterName, storageName } from './policies.js';
import type { StorageFormInput } from './contracts.js';
import { cleanChoice, cleanText, FormErrors } from './store-form.js';
import {
  required,
  escapedSearch,
  active,
  type AdministrationServiceCore,
  type AdminPage,
} from './service-core.js';

/**
 * Counters and storages: the cross-store and per-store lists, create, update and status.
 */
export function counterAdministration(core: AdministrationServiceCore) {
  const { db, now, activeResourceStore } = core;
  return {
    /**
     * Cross-store counter list (`AjaxStoreCounterListView` / archived, `stores_counter_datatable.py`):
     * store name column, search on name/description; franchise users see their stores only.
     */
    async allCounters(user: Principal, page: AdminPage) {
      requireRole(user, [1, 2, 3]);
      const scoped = user.userType === 2;
      if (scoped && !user.storeIds.length) return { data: [], nextCursor: null };
      const collection = administrationCollectionPage(
        page,
        JSON.stringify(['all-counters', user.id, user.role, user.userType, user.storeIds]),
        collectionField(StoreCounter.id, 'id', 'integer'),
        {
          store: collectionField(Store.store_name, 'storeName', 'text'),
          name: collectionField(StoreCounter.counter_name, 'counter_name', 'text'),
          type: collectionField(StoreCounter.counter_type, 'counter_type', 'text'),
          description: collectionField(StoreCounter.counter_desc, 'counter_desc', 'text'),
          active: collectionField(StoreCounter.is_active, 'is_active', 'boolean'),
        },
      );
      const rows = await db
        .get('primary')
        .select({ ...getTableColumns(StoreCounter), storeName: Store.store_name })
        .from(StoreCounter)
        .innerJoin(Store, eq(Store.id, StoreCounter.store))
        .where(
          and(
            scoped ? inArray(StoreCounter.store, user.storeIds.map(BigInt)) : undefined,
            scoped ? eq(Store.category, 'FRANCHISE') : undefined,
            active(page.active) === undefined
              ? undefined
              : eq(StoreCounter.is_active, active(page.active)!),
            collection.boundary,
            page.search
              ? or(
                  like(StoreCounter.counter_name, escapedSearch(page.search)),
                  like(StoreCounter.counter_desc, escapedSearch(page.search)),
                )
              : undefined,
          ),
        )
        .orderBy(...collection.order)
        .limit(page.limit + 1);
      return collection.finish(rows);
    },
    /** Cross-store storage list (`AjaxStoreStorageListView` / archived, `stores_datatable.py:202-338`). */
    async allStorages(user: Principal, page: AdminPage) {
      requireRole(user, [1, 2, 3]);
      const scoped = user.userType === 2;
      if (scoped && !user.storeIds.length) return { data: [], nextCursor: null };
      const collection = administrationCollectionPage(
        page,
        JSON.stringify(['all-storages', user.id, user.role, user.userType, user.storeIds]),
        collectionField(StoreStorage.id, 'id', 'integer'),
        {
          store: collectionField(Store.store_name, 'storeName', 'text'),
          name: collectionField(StoreStorage.storage_name, 'storage_name', 'text'),
          type: collectionField(StoreStorage.storage_type, 'storage_type', 'text'),
          description: collectionField(StoreStorage.storage_desc, 'storage_desc', 'text'),
          active: collectionField(StoreStorage.is_active, 'is_active', 'boolean'),
        },
      );
      const rows = await db
        .get('primary')
        .select({ ...getTableColumns(StoreStorage), storeName: Store.store_name })
        .from(StoreStorage)
        .innerJoin(Store, eq(Store.id, StoreStorage.store))
        .where(
          and(
            scoped ? inArray(StoreStorage.store, user.storeIds.map(BigInt)) : undefined,
            scoped ? eq(Store.category, 'FRANCHISE') : undefined,
            active(page.active) === undefined
              ? undefined
              : eq(StoreStorage.is_active, active(page.active)!),
            collection.boundary,
            page.search
              ? or(
                  like(StoreStorage.storage_name, escapedSearch(page.search)),
                  like(StoreStorage.storage_desc, escapedSearch(page.search)),
                )
              : undefined,
          ),
        )
        .orderBy(...collection.order)
        .limit(page.limit + 1);
      return collection.finish(rows);
    },
    async counters(user: Principal, storeId: string, page: AdminPage) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      const collection = administrationCollectionPage(
        page,
        JSON.stringify(['counters', user.id, user.role, user.userType, user.storeIds, storeId]),
        collectionField(StoreCounter.id, 'id', 'integer'),
        {
          name: collectionField(StoreCounter.counter_name, 'counter_name', 'text'),
          type: collectionField(StoreCounter.counter_type, 'counter_type', 'text'),
          description: collectionField(StoreCounter.counter_desc, 'counter_desc', 'text'),
          active: collectionField(StoreCounter.is_active, 'is_active', 'boolean'),
        },
      );
      const rows = await db
        .get('primary')
        .select()
        .from(StoreCounter)
        .where(
          and(
            eq(StoreCounter.store, BigInt(storeId)),
            active(page.active) === undefined
              ? undefined
              : eq(StoreCounter.is_active, active(page.active)!),
            collection.boundary,
            page.search
              ? or(
                  like(StoreCounter.counter_name, escapedSearch(page.search)),
                  like(StoreCounter.counter_desc, escapedSearch(page.search)),
                )
              : undefined,
          ),
        )
        .orderBy(...collection.order)
        .limit(page.limit + 1);
      return collection.finish(rows);
    },
    /** `CreateCounterView` (`stores/views.py:480-498`, `helpers.py:1386-1392`). */
    async createCounter(user: Principal, storeId: string, description: string) {
      requireRole(user, [1]);
      const counterDescription = description.trim();
      if (!counterDescription)
        throw new AppError(400, 'COUNTER_DESCRIPTION_REQUIRED', 'Provide a valid message');
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await activeResourceStore(transaction, storeId);
          const [total] = await transaction
            .select({ value: count() })
            .from(StoreCounter)
            .where(eq(StoreCounter.store, BigInt(storeId)));
          const name = counterName(total?.value || 0);
          const inserted = await transaction.insert(StoreCounter).values({
            store: BigInt(storeId),
            counter_name: name,
            counter_type: 'IN_STORE',
            counter_desc: counterDescription,
            is_active: true,
            created_at: now(),
            updated_at: now(),
          });
          return {
            id: String(generatedId(inserted)),
            name,
            status: 'success',
            message: 'The Counter has been created',
          };
        }),
      );
    },
    async setCounterStatus(user: Principal, storeId: string, counterId: string, enabled: boolean) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      const [row] = await db
        .get('writer')
        .select({ id: StoreCounter.id })
        .from(StoreCounter)
        .where(
          and(
            eq(StoreCounter.id, BigInt(counterId)),
            eq(StoreCounter.store, BigInt(storeId)),
            eq(StoreCounter.is_active, !enabled),
          ),
        )
        .limit(1);
      if (!row) throw new AppError(404, 'COUNTER_NOT_FOUND', 'Counter does not exist');
      await db
        .get('writer')
        .update(StoreCounter)
        .set({ is_active: enabled, updated_at: now() })
        .where(eq(StoreCounter.id, BigInt(counterId)));
      return {
        status: 'success',
        message: enabled ? 'The Counter has been activated' : 'The Counter has been deleted',
      };
    },
    async storages(user: Principal, storeId: string, page: AdminPage) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      const collection = administrationCollectionPage(
        page,
        JSON.stringify(['storages', user.id, user.role, user.userType, user.storeIds, storeId]),
        collectionField(StoreStorage.id, 'id', 'integer'),
        {
          name: collectionField(StoreStorage.storage_name, 'storage_name', 'text'),
          type: collectionField(StoreStorage.storage_type, 'storage_type', 'text'),
          description: collectionField(StoreStorage.storage_desc, 'storage_desc', 'text'),
          active: collectionField(StoreStorage.is_active, 'is_active', 'boolean'),
        },
      );
      const rows = await db
        .get('primary')
        .select()
        .from(StoreStorage)
        .where(
          and(
            eq(StoreStorage.store, BigInt(storeId)),
            active(page.active) === undefined
              ? undefined
              : eq(StoreStorage.is_active, active(page.active)!),
            collection.boundary,
            page.search
              ? or(
                  like(StoreStorage.storage_name, escapedSearch(page.search)),
                  like(StoreStorage.storage_desc, escapedSearch(page.search)),
                )
              : undefined,
          ),
        )
        .orderBy(...collection.order)
        .limit(page.limit + 1);
      return collection.finish(rows);
    },
    async storage(user: Principal, storeId: string, storageId: string) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      const [row] = await db
        .get('primary')
        .select()
        .from(StoreStorage)
        .where(and(eq(StoreStorage.id, BigInt(storageId)), eq(StoreStorage.store, BigInt(storeId))))
        .limit(1);
      return required(row, 'Storage');
    },
    /** `EditStorageView.post` (`stores/views.py:393-410`): name, type and description only. */
    async updateStorage(
      user: Principal,
      storeId: string,
      storageId: string,
      input: StorageFormInput,
    ) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      const errors = new FormErrors(),
        name = cleanText(errors, 'storage_name', input.storage_name, { required: true, max: 100 }),
        type = cleanChoice(errors, 'storage_type', input.storage_type, ['STORAGE'] as const),
        description = cleanText(errors, 'storage_desc', input.storage_desc, {
          required: true,
          max: 255,
        });
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          const [row] = await transaction
            .select({ id: StoreStorage.id })
            .from(StoreStorage)
            .where(
              and(
                eq(StoreStorage.id, BigInt(storageId)),
                eq(StoreStorage.store, BigInt(storeId)),
                eq(StoreStorage.is_active, true),
              ),
            )
            .limit(1)
            .for('update');
          if (!row) throw new AppError(404, 'STORAGE_NOT_FOUND', 'Store does not exists.');
          errors.throwIfAny();
          // Legacy editing saves the name as posted, without applying the creation prefix again.
          await transaction
            .update(StoreStorage)
            .set({
              storage_name: name,
              storage_desc: description,
              storage_type: type ?? 'STORAGE',
              updated_at: now(),
            })
            .where(eq(StoreStorage.id, BigInt(storageId)));
          return { status: 'success', message: 'Storage has been updated!' };
        }),
      );
    },
    /** `CreateStorageView.post` (`stores/views.py:350-364`, `forms.py:113-127`). */
    async createStorage(user: Principal, storeId: string, input: StorageFormInput) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      const errors = new FormErrors(),
        name = cleanText(errors, 'storage_name', input.storage_name, { required: true, max: 100 }),
        type = cleanChoice(errors, 'storage_type', input.storage_type, ['STORAGE'] as const),
        description = cleanText(errors, 'storage_desc', input.storage_desc, {
          required: true,
          max: 255,
        });
      errors.throwIfAny();
      return db.get('writer').transaction(async (transaction) => {
        const store = await activeResourceStore(transaction, storeId);
        const storageNameValue = storageName(store.store_name || storeId, name);
        const inserted = await transaction.insert(StoreStorage).values({
          store: BigInt(storeId),
          storage_name: storageNameValue,
          storage_type: type ?? 'STORAGE',
          storage_desc: description,
          is_active: true,
          created_at: now(),
          updated_at: now(),
        });
        return {
          id: String(generatedId(inserted)),
          name: storageNameValue,
          message: 'Storage has been created!',
        };
      });
    },
    /** `DeleteStorageView` / `ActivateStorageView` (`stores/views.py:433-478`). */
    async setStorageStatus(user: Principal, storeId: string, storageId: string, enabled: boolean) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      return db.get('writer').transaction(async (transaction) => {
        const [row] = await transaction
          .select()
          .from(StoreStorage)
          .where(
            and(
              eq(StoreStorage.id, BigInt(storageId)),
              eq(StoreStorage.store, BigInt(storeId)),
              eq(StoreStorage.is_active, !enabled),
            ),
          )
          .limit(1)
          .for('update');
        if (!row) throw new AppError(404, 'STORAGE_NOT_FOUND', 'Storage does not exist');
        if (!enabled) {
          const [stock] = await transaction
            .select({ total: sql<string>`coalesce(sum(${StockStorage.stock}),0)` })
            .from(StockStorage)
            .where(eq(StockStorage.storage, BigInt(storageId)));
          if (BigInt(stock?.total || '0') > 0)
            throw new AppError(
              409,
              'STORAGE_CONTAINS_STOCK',
              'This Storage contains some stock, Release all stock from the storage before deletion',
            );
        }
        await transaction
          .update(StoreStorage)
          .set({ is_active: enabled, updated_at: now() })
          .where(eq(StoreStorage.id, BigInt(storageId)));
        return {
          status: 'success',
          message: enabled ? 'The Storage has been activated' : 'The Storage has been deleted',
        };
      });
    },
  };
}
