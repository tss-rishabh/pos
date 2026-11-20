import { administrationCollectionPage, collectionField } from './collection-page.js';
import { generatedId } from '../../db/generated-id.js';
import { and, asc, eq, inArray, like, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  Country,
  POSFranchise,
  PosUser,
  Store,
  StoreCounter,
  TssSetting,
  UserStore,
} from '../../db/legacy-schema.js';
import { requireRole, requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { retryTransaction } from '../../db/retry.js';
import { counterName, storePublicUrl } from './policies.js';
import { defaultStoreImage } from './contracts.js';
import { cleanStoreForm, type StoreFormInput } from './store-form.js';
import { resolveDefaultStoreOperatorIds } from './store-default-operators.js';
import {
  assertCurrentOperatorIdentity,
  assertCurrentOperatorRole,
  assertCurrentStoreAccess,
} from './authorization.js';
import {
  storeReadFields,
  required,
  escapedSearch,
  insertBatches,
  active,
  type AdministrationServiceCore,
  type AdminPage,
} from './service-core.js';

/**
 * Stores: the list, detail, countries and location codes, create/update and status, and
 * the resource-store picker.
 */
export function storeAdministration(core: AdministrationServiceCore) {
  const {
    db,
    options,
    now,
    lock,
    locationChoices,
    preparedImage,
    storeFormChecks,
    storeValues,
    franchise,
  } = core;
  return {
    /**
     * `AjaxStoresListView` / `AjaxArchivedStoresListView` (`stores/datatables/stores_datatable.py`):
     * type STORE only, search on name/address/phone/pincode. Franchise users (user_type 2) see their
     * assigned franchise stores only (legacy exempted franchise role 1 and did not check the
     * category; kept scoped as everywhere else in the rewrite, a security decision).
     */
    async stores(user: Principal, page: AdminPage) {
      requireRole(user, [1, 2, 3]);
      const scoped = user.userType === 2;
      if (scoped && !user.storeIds.length) return { data: [], nextCursor: null };
      const collection = administrationCollectionPage(
        page,
        JSON.stringify(['stores', user.id, user.role, user.userType, user.storeIds]),
        collectionField(Store.id, 'id', 'integer'),
        {
          name: collectionField(Store.store_name, 'store_name', 'text'),
          locationCode: collectionField(Store.location_code, 'location_code', 'text'),
          category: collectionField(Store.category, 'category', 'text'),
          city: collectionField(Store.city_name, 'city_name', 'text'),
          type: collectionField(Store.type, 'type', 'text'),
          phone: collectionField(Store.phone, 'phone', 'text'),
          address: collectionField(Store.address, 'address'),
          pincode: collectionField(Store.pincode, 'pincode'),
          email: collectionField(Store.email, 'email', 'text'),
          latitude: collectionField(Store.latitude, 'latitude', 'text'),
          longitude: collectionField(Store.longitude, 'longitude', 'text'),
          createdAt: collectionField(Store.created_at, 'created_at', 'text'),
          active: collectionField(Store.is_active, 'is_active', 'boolean'),
        },
      );
      const rows = await db
        .get('primary')
        .select(storeReadFields)
        .from(Store)
        .where(
          and(
            eq(Store.type, 'STORE'),
            scoped ? inArray(Store.id, user.storeIds.map(BigInt)) : undefined,
            scoped ? eq(Store.category, 'FRANCHISE') : undefined,
            active(page.active) === undefined
              ? undefined
              : eq(Store.is_active, active(page.active)!),
            collection.boundary,
            page.search
              ? or(
                  like(Store.store_name, escapedSearch(page.search)),
                  like(Store.address, escapedSearch(page.search)),
                  like(Store.phone, escapedSearch(page.search)),
                  like(Store.pincode, escapedSearch(page.search)),
                )
              : undefined,
          ),
        )
        .orderBy(...collection.order)
        .limit(page.limit + 1);
      return collection.finish(rows);
    },
    async store(user: Principal, storeId: string) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      const [row] = await db
        .get('primary')
        .select(storeReadFields)
        .from(Store)
        .where(eq(Store.id, BigInt(storeId)))
        .limit(1);
      const store = required(row, 'Store');
      const [details] = store.franchise_id
        ? await db
            .get('primary')
            .select({
              id: POSFranchise.id,
              name: POSFranchise.name,
              description: POSFranchise.description,
              cin: POSFranchise.cin_number,
            })
            .from(POSFranchise)
            .where(eq(POSFranchise.id, BigInt(store.franchise_id)))
            .limit(1)
        : [];
      const [country] = store.country_id
        ? await db
            .get('primary')
            .select({ name: Country.name })
            .from(Country)
            .where(eq(Country.id, BigInt(store.country_id)))
            .limit(1)
        : [];
      return { ...store, franchise: details || null, country_name: country?.name ?? null };
    },
    async countries(user: Principal) {
      requireRole(user, [1, 2, 3]);
      return db
        .get('primary')
        .select({
          id: Country.id,
          name: Country.name,
          iso2: Country.iso_code_2,
          iso3: Country.iso_code_3,
        })
        .from(Country)
        .where(eq(Country.status, 1))
        .orderBy(asc(Country.name));
    },
    async locations(user: Principal) {
      requireRole(user, [1, 2, 3]);
      return locationChoices(db.get('primary'));
    },
    /** `AddLocationCodeView` (`stores/views.py:116-162`). */
    async addLocationCode(user: Principal, raw: string) {
      requireRole(user, [1, 3]);
      const code = raw.trim().toUpperCase();
      if (!code) throw new AppError(400, 'LOCATION_CODE_REQUIRED', 'Location Code is required.');
      if (!/^[A-Z0-9]{1,4}$/.test(code))
        throw new AppError(
          400,
          'LOCATION_CODE_INVALID',
          'Location Code must be 1-4 characters, letters and numbers only.',
        );
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          const rows = await transaction
            .select({ id: TssSetting.id, value: TssSetting.value })
            .from(TssSetting)
            .where(eq(TssSetting.platform, 'STORE_LOCATION_CODE'))
            .orderBy(asc(TssSetting.id))
            .for('update');
          const setting = rows[0];
          if (!setting)
            throw new AppError(503, 'LOCATION_CODE_FAILED', 'Failed to add Location Code.');
          const rawValue = setting.value || '[]';
          let current: string[];
          try {
            current = z.array(z.string()).parse(JSON.parse(rawValue) as unknown);
          } catch {
            current = rawValue
              .replace(/^\[|\]$/g, '')
              .replaceAll('"', '')
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean);
          }
          if (current.includes(code))
            throw new AppError(409, 'LOCATION_CODE_EXISTS', 'Location Code already exists.');
          // Python json.dumps(sorted(set(...))): ", " separators.
          const serialized =
            '[' +
            [...new Set([...current, code])]
              .sort()
              .map((value) => JSON.stringify(value))
              .join(', ') +
            ']';
          if (serialized.length > 255)
            throw new AppError(422, 'LOCATION_CODE_FAILED', 'Failed to add Location Code.');
          await transaction
            .update(TssSetting)
            .set({ value: serialized })
            .where(eq(TssSetting.platform, 'STORE_LOCATION_CODE'));
          return { success: true, status: 'success', message: 'Location Code added successfully.' };
        }),
      );
    },
    /** `CreateStoreView.post` (`stores/views.py:45-104`). */
    async createStore(user: Principal, input: StoreFormInput) {
      requireRole(user, [1, 3]);
      const { form, errors } = cleanStoreForm(input, await locationChoices(db.get('writer')));
      const imagePath = await preparedImage(user, errors, input.store_image, null);
      const result = await lock('stores', () =>
        db.get('writer').transaction(async (transaction) => {
          const identity = await assertCurrentOperatorIdentity(transaction, user.id, [1, 3]);
          if (identity.userType === 2 && form.category !== 'FRANCHISE')
            throw new AppError(
              403,
              'STORE_ACCESS_DENIED',
              'This store is outside your organization.',
            );
          await storeFormChecks(transaction, errors, form);
          errors.throwIfAny();
          const defaultOperators = await resolveDefaultStoreOperatorIds(transaction, options);
          const franchiseId = await franchise(transaction, form, user);
          const inserted = await transaction.insert(Store).values({
            ...storeValues(form, franchiseId, imagePath ?? defaultStoreImage),
            created_at: now(),
            is_active: true,
            url_key: '',
            ecom_delivery: 0,
            ecom_threshold: 0,
          });
          const storeId = String(generatedId(inserted));
          await transaction
            .update(Store)
            .set({ url_key: storePublicUrl(storeId) })
            .where(eq(Store.id, BigInt(storeId)));
          await transaction.insert(StoreCounter).values({
            store: BigInt(storeId),
            counter_name: counterName(0),
            counter_type: 'IN_STORE',
            counter_desc: 'Created by default on the store creation',
            is_active: true,
            created_at: now(),
            updated_at: now(),
          });
          for (const batch of insertBatches(defaultOperators))
            await transaction.insert(UserStore).values(
              batch.map((operatorId) => ({
                django_user_id: operatorId,
                store_id: BigInt(storeId),
              })),
            );
          return { id: storeId, message: 'Store has been created!' };
        }),
      );
      if (input.store_image) await options.storeImages?.consume(input.store_image);
      return result;
    },
    /** `EditStoreView.post` (`stores/views.py:181-229`). */
    async updateStore(user: Principal, storeId: string, input: StoreFormInput) {
      requireRole(user, [1, 3]);
      requireStore(user, storeId);
      const { form, errors } = cleanStoreForm(input, await locationChoices(db.get('writer')));
      const imagePath = await preparedImage(user, errors, input.store_image, storeId);
      const result = await lock('stores', () =>
        db.get('writer').transaction(async (transaction) => {
          await assertCurrentStoreAccess(transaction, user.id, storeId, [1, 3]);
          const [current] = await transaction
            .select()
            .from(Store)
            .where(and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, true)))
            .limit(1)
            .for('update');
          if (!current) throw new AppError(404, 'STORE_NOT_FOUND', 'Store does not exists.');
          const [operator] = await transaction
            .select({ userType: PosUser.user_type, role: PosUser.role })
            .from(PosUser)
            .where(eq(PosUser.id, BigInt(user.id)))
            .limit(1)
            .for('share');
          if (
            !operator ||
            ![1, 2].includes(operator.userType) ||
            (operator.userType === 2 &&
              (current.category !== 'FRANCHISE' || form.category !== 'FRANCHISE'))
          )
            throw new AppError(
              403,
              'STORE_ACCESS_DENIED',
              'This store is outside your organization.',
            );
          await storeFormChecks(transaction, errors, form, storeId);
          errors.throwIfAny();
          const franchiseId = await franchise(transaction, form, user, current.franchise_id);
          await transaction
            .update(Store)
            .set({
              ...storeValues(form, franchiseId, imagePath),
              url_key: storePublicUrl(storeId),
            })
            .where(eq(Store.id, BigInt(storeId)));
          return { id: storeId, message: 'Store has been updated!' };
        }),
      );
      if (input.store_image) await options.storeImages?.consume(input.store_image);
      return result;
    },
    /** `DeleteStoreView` / `ActivateStoreView` (`stores/views.py:270-307`). */
    async setStoreStatus(user: Principal, storeId: string, enabled: boolean) {
      requireRole(user, [1]);
      return lock('stores', () =>
        db.get('writer').transaction(async (transaction) => {
          await assertCurrentOperatorRole(transaction, user.id, [1]);
          const [row] = await transaction
            .select({ id: Store.id })
            .from(Store)
            .where(and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, !enabled)))
            .limit(1)
            .for('update');
          if (!row) throw new AppError(404, 'STORE_NOT_FOUND', 'Store does not exist');
          await transaction
            .update(Store)
            .set({ is_active: enabled, updated_at: now() })
            .where(eq(Store.id, BigInt(storeId)));
          return {
            status: 'success',
            message: enabled ? 'The Store has been activated' : 'The Store has been deleted',
          };
        }),
      );
    },
    /** Active type=STORE stores offered by the legacy counter and storage forms (`stores/views.py:41-42`, `:373-378`). */
    async resourceStores(user: Principal) {
      requireRole(user, [1, 2, 3]);
      return db
        .get('primary')
        .select({ id: Store.id, name: Store.store_name })
        .from(Store)
        .where(
          and(
            eq(Store.is_active, true),
            eq(Store.type, 'STORE'),
            user.role === 1 && user.userType === 1
              ? undefined
              : inArray(Store.id, user.storeIds.map(BigInt)),
          ),
        )
        .orderBy(asc(Store.store_name));
    },
  };
}
