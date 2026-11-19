import { administrationCollectionPage, collectionField } from './collection-page.js';
import { generatedId } from '../../db/generated-id.js';
import { Temporal } from '@js-temporal/polyfill';
import {
  type SQL,
  and,
  asc,
  count,
  eq,
  exists,
  getTableColumns,
  inArray,
  like,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  Country,
  POSFranchise,
  PosUser,
  SalesPerson,
  StockStorage,
  Store,
  StoreCounter,
  StoreSalesPerson,
  StoreStorage,
  TssSetting,
  UserStore,
} from '../../db/legacy-schema.js';
import { requireRole, requireStore, type Principal, type Role } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { retryTransaction } from '../../db/retry.js';
import { credentialVersion } from '../../auth/crypto.js';
import { invalidateOperatorAuthentication } from '../../auth/revocation.js';
import {
  counterName,
  legacyIntegerReference,
  manageableOperator,
  scopedAssignmentDiff,
  storageName,
  storePublicUrl,
} from './policies.js';
import type { SalespersonInput, OperatorInput, StorageFormInput } from './contracts.js';
import { defaultStoreImage } from './contracts.js';
import {
  cleanChoice,
  cleanStoreForm,
  cleanText,
  FormErrors,
  type CleanStoreForm,
  type StoreFormInput,
} from './store-form.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { administrationEphemeralStore } from './ephemeral-runtime.js';
import type { AdministrationTransaction } from './checkins.js';
import { withAdministrationLock, type AdministrationLockResource } from './locks.js';
import {
  resolveDefaultStoreOperatorIds,
  type StoreDefaultOperatorOptions,
} from './store-default-operators.js';
import {
  assertCurrentOperatorIdentity,
  assertCurrentOperatorRole,
  assertCurrentStoreAccess,
} from './authorization.js';

/** The legacy form displays every store field, `slack_group_url` included (`_form.html:310`). */
const storeReadFields = getTableColumns(Store);

export interface StoreImagePreparation {
  prepare(user: Principal, uploadId: string, storeId: string | null): Promise<string>;
  consume(uploadId: string): Promise<void>;
}
export type AdministrationOptions = StoreDefaultOperatorOptions & {
  ephemeral?: EphemeralStore;
  storeImages?: StoreImagePreparation;
};
export interface AdminPage {
  after: string;
  limit: number;
  search: string;
  active: 'true' | 'false' | 'all';
  sort?: string;
  direction?: 'asc' | 'desc';
}
const required = <T>(value: T | undefined, resource: string): T => {
  if (value === undefined)
    throw new AppError(404, 'RESOURCE_NOT_FOUND', `${resource} was not found.`);
  return value;
};
const escapedSearch = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
const active = (value: AdminPage['active']) => (value === 'all' ? undefined : value === 'true');
export function administrationService(
  config: Config,
  db: Databases,
  options: AdministrationOptions = {},
) {
  const ephemeral = options.ephemeral ?? administrationEphemeralStore(config);
  const now = () =>
    Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  async function assignableStores(user: Principal, transaction: AdministrationTransaction) {
    const role = await assertCurrentOperatorRole(transaction, user.id, [1, 2, 3]);
    const [actor] = await transaction
      .select({ userType: PosUser.user_type })
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(user.id)))
      .limit(1)
      .for('share');
    if (!actor || ![1, 2].includes(actor.userType))
      throw new AppError(
        403,
        'OPERATOR_SCOPE_DENIED',
        'This account has unsupported access settings.',
      );
    const global = role === 1 && actor.userType === 1;
    const assignments = global
      ? []
      : await transaction
          .select({ storeId: UserStore.store_id })
          .from(UserStore)
          .where(eq(UserStore.django_user_id, BigInt(user.id)))
          .limit(10001)
          .for('share');
    if (assignments.length > 10000) return unavailable('Reconciled operator store assignments');
    if (!global && !assignments.length) return [];
    const rows = await transaction
      .select({ id: Store.id })
      .from(Store)
      .where(
        and(
          eq(Store.is_active, true),
          global
            ? undefined
            : inArray(Store.id, [...new Set(assignments.map((row) => row.storeId))]),
        ),
      )
      .limit(10001)
      .for('share');
    if (rows.length > 10000) return unavailable('Reconciled operator store assignments');
    return rows.map((row) => String(row.id));
  }
  const lock = <T>(resource: AdministrationLockResource, run: () => Promise<T>) =>
    withAdministrationLock(ephemeral, resource, () => retryTransaction(run));
  /** `StoreCreateForm.__init__` location choices (`stores/forms.py:31-34`). */
  async function locationChoices(database: Pick<ReturnType<Databases['get']>, 'select'>) {
    const [setting] = await database
      .select({ value: TssSetting.value })
      .from(TssSetting)
      .where(eq(TssSetting.platform, 'STORE_LOCATION_CODE'))
      .orderBy(asc(TssSetting.id))
      .limit(1);
    if (!setting?.value) return unavailable('Store location choices');
    try {
      return z.array(z.string()).parse(JSON.parse(setting.value) as unknown);
    } catch {
      return unavailable('Store location choices');
    }
  }
  /** Django `ImageField` validation of the uploaded store image, before the writer transaction. */
  async function preparedImage(
    user: Principal,
    errors: FormErrors,
    uploadId: string | undefined,
    storeId: string | null,
  ) {
    if (!uploadId) return undefined;
    if (!options.storeImages)
      throw new AppError(
        503,
        'STORE_IMAGE_STORAGE_UNAVAILABLE',
        'Store images are currently unavailable.',
      );
    try {
      return await options.storeImages.prepare(user, uploadId, storeId);
    } catch (error) {
      if (error instanceof AppError && error.status < 500 && error.status !== 429) {
        errors.add('store_image', error.message);
        return undefined;
      }
      throw error;
    }
  }
  /**
   * `ModelForm.validate_unique` (model `unique=True` on location_code and phone) and the custom
   * `StoreCreateForm.is_valid` checks (`stores/forms.py:86-104`), which run only on a valid form.
   */
  async function storeFormChecks(
    transaction: AdministrationTransaction,
    errors: FormErrors,
    form: CleanStoreForm,
    exclude?: string,
  ) {
    const other = (condition: SQL) =>
      transaction
        .select({ id: Store.id })
        .from(Store)
        .where(and(condition, exclude ? ne(Store.id, BigInt(exclude)) : undefined))
        .limit(1);
    if (!errors.has('location_code') && form.locationCode) {
      const [duplicate] = await other(eq(Store.location_code, form.locationCode));
      if (duplicate) errors.add('location_code', 'Store with this Location code already exists.');
    }
    if (!errors.has('phone') && form.phone !== null) {
      const [duplicate] = await other(eq(Store.phone, form.phone));
      if (duplicate) errors.add('phone', 'Store with this Phone already exists.');
    }
    if (errors.has()) return;
    // Legacy checks active stores only; `stores.store_name_unique` also rejects an archived
    // store's name, which legacy surfaced as a database error.
    const [duplicate] = await other(eq(Store.store_name, form.storeName));
    if (duplicate) errors.add('store_name', 'Store name must be unique');
    if (form.phone === null) errors.add('phone', 'Phone cant be empty');
  }
  function storeValues(form: CleanStoreForm, franchiseId: number, imagePath?: string) {
    return {
      store_name: form.storeName,
      type: form.type,
      category: form.category,
      location_code: form.locationCode,
      latitude: form.latitude,
      longitude: form.longitude,
      email: form.email,
      address: form.address,
      alt_address: form.alternateAddress,
      city_id: form.cityId,
      country_id: form.countryId,
      phone: form.phone ?? '',
      pincode: form.pincode,
      per_day_threshold: form.perDayThreshold,
      per_hour_threshold: form.perHourThreshold,
      gstin: form.gstin,
      short_name: form.shortName,
      slack_group_url: form.slackGroupUrl,
      city_name: form.cityName,
      state_name: form.stateName,
      state_id: form.stateId,
      franchise_id: franchiseId,
      ...(imagePath ? { store_image: imagePath } : {}),
      updated_at: now(),
    };
  }
  /**
   * Security hardening (not in legacy `EditStoreView`): a scoped administrator may edit a
   * franchise record only when every store using it is within their scope.
   */
  async function assertFranchiseScope(
    transaction: AdministrationTransaction,
    user: Principal,
    franchiseId: number,
  ) {
    const [actor] = await transaction
      .select({ role: PosUser.role, userType: PosUser.user_type })
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(user.id)))
      .limit(1)
      .for('share');
    if (!actor || ![1, 3].includes(actor.role))
      throw new AppError(
        403,
        'FRANCHISE_SCOPE_DENIED',
        'Franchise changes require current store administration access.',
      );
    if (actor.role === 1 && actor.userType === 1) return;
    const stores = await transaction
      .select({ id: Store.id, category: Store.category })
      .from(Store)
      .where(eq(Store.franchise_id, franchiseId))
      .limit(1001)
      .for('share');
    const assignments = stores.length
      ? await transaction
          .select({ storeId: UserStore.store_id })
          .from(UserStore)
          .where(
            and(
              eq(UserStore.django_user_id, BigInt(user.id)),
              inArray(
                UserStore.store_id,
                stores.map((store) => store.id),
              ),
            ),
          )
          .for('share')
      : [];
    const allowed = new Set(assignments.map((assignment) => String(assignment.storeId)));
    if (
      stores.length > 1000 ||
      stores.some(
        (store) =>
          !allowed.has(String(store.id)) ||
          (actor.userType === 2 && store.category !== 'FRANCHISE'),
      )
    )
      throw new AppError(
        403,
        'FRANCHISE_SCOPE_DENIED',
        'Franchise changes require access to every associated store.',
      );
  }
  /** `CreateStoreView` / `EditStoreView` franchise handling (`stores/views.py:53-62`, `:197-223`). */
  async function franchise(
    transaction: AdministrationTransaction,
    form: CleanStoreForm,
    user: Principal,
    existing = 0,
  ) {
    if (form.category !== 'FRANCHISE') return 0;
    const details = {
      name: form.franchise.name,
      description: form.franchise.description,
      cin_number: form.franchise.cin,
    };
    if (existing) {
      const [found] = await transaction
        .select({ id: POSFranchise.id })
        .from(POSFranchise)
        .where(eq(POSFranchise.id, BigInt(existing)))
        .limit(1)
        .for('update');
      // Legacy keeps a dangling franchise_id when the franchise row is missing.
      if (found) {
        await assertFranchiseScope(transaction, user, existing);
        await transaction
          .update(POSFranchise)
          .set({ ...details, updated_at: now() })
          .where(eq(POSFranchise.id, found.id));
      }
      return existing;
    }
    const inserted = await transaction
      .insert(POSFranchise)
      .values({ ...details, created_at: now(), updated_at: now() });
    return legacyIntegerReference(generatedId(inserted));
  }
  /** Active type=STORE store of the legacy counter/storage forms (`stores/views.py:41-42`, `:373-378`). */
  async function activeResourceStore(transaction: AdministrationTransaction, storeId: string) {
    const [row] = await transaction
      .select()
      .from(Store)
      .where(and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, true), eq(Store.type, 'STORE')))
      .limit(1)
      .for('update');
    if (!row) throw new AppError(404, 'STORE_NOT_FOUND', 'Store does not exists.');
    return row;
  }
  async function operator(
    user: Principal,
    operatorId: string,
    transaction: AdministrationTransaction,
    options: { nextRole?: Role; nextUserType?: 1 | 2; assignment?: boolean } = {},
  ) {
    const role = await assertCurrentOperatorRole(transaction, user.id, [1, 2, 3]);
    const [actor] = await transaction
      .select({ userType: PosUser.user_type })
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(user.id)))
      .limit(1)
      .for('share');
    const userType = ([1, 2] as const).find((value) => value === actor?.userType);
    if (!userType)
      throw new AppError(
        403,
        'OPERATOR_SCOPE_DENIED',
        'This account has unsupported access settings.',
      );
    const [row] = await transaction
      .select()
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(operatorId)))
      .limit(1)
      .for('update');
    const result = required(row, 'Operator');
    if (![1, 2, 3, 4, 5].includes(result.role))
      throw new AppError(409, 'INVALID_OPERATOR_ROLE', 'The operator has an unsupported role.');
    manageableOperator(
      { ...user, role, userType },
      operatorId,
      result.role as Role,
      options.nextRole,
    );
    if (
      userType === 2 &&
      (result.user_type !== 2 || (options.nextUserType !== undefined && options.nextUserType !== 2))
    )
      throw new AppError(
        403,
        'OPERATOR_SCOPE_DENIED',
        'This operator is outside your organization.',
      );
    if (role !== 1 || userType !== 1) {
      const available = new Set(await assignableStores(user, transaction));
      const stores = await transaction
        .select({ id: Store.id })
        .from(Store)
        .where(
          and(
            eq(Store.is_active, true),
            exists(
              transaction
                .select({ id: UserStore.id })
                .from(UserStore)
                .where(
                  and(
                    eq(UserStore.django_user_id, BigInt(operatorId)),
                    eq(UserStore.store_id, Store.id),
                  ),
                ),
            ),
          ),
        )
        .limit(1001)
        .for('share');
      if (
        stores.length > 1000 ||
        (options.assignment
          ? stores.length > 0 && !stores.some((store) => available.has(String(store.id)))
          : !stores.length || stores.some((store) => !available.has(String(store.id))))
      )
        throw new AppError(
          403,
          'OPERATOR_SCOPE_DENIED',
          options.assignment
            ? 'Store assignment requires shared access to this operator.'
            : 'Profile and status changes require access to every active store assigned to this operator.',
        );
    }
    return result;
  }
  const operatorProjection = {
    id: PosUser.id,
    username: PosUser.username,
    firstName: PosUser.first_name,
    lastName: PosUser.last_name,
    email: PosUser.email,
    phone: PosUser.phone,
    contactEmail: PosUser.contact_email,
    role: PosUser.role,
    userType: PosUser.user_type,
    otpMethod: PosUser.otp_method,
    mfa: PosUser.is_mfa,
    active: PosUser.is_active,
  };
  return {
    /**
     * `AjaxStoresListView` / `AjaxArchivedStoresListView` (`stores/datatables/stores_datatable.py`):
     * type STORE only, search on name/address/phone/pincode. Franchise users (user_type 2) see their
     * assigned stores only (legacy exempted franchise role 1; kept scoped as a security decision).
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
          for (const operatorId of defaultOperators)
            await transaction.insert(UserStore).values({
              django_user_id: operatorId,
              store_id: BigInt(storeId),
            });
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
              : user.storeIds.length
                ? inArray(Store.id, user.storeIds.map(BigInt))
                : sql`false`,
          ),
        )
        .orderBy(asc(Store.store_name));
    },
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
        .innerJoin(Store, eq(Store.id, sql`${StoreCounter.store}`))
        .where(
          and(
            scoped ? inArray(StoreCounter.store, user.storeIds.map(BigInt)) : undefined,
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
        .innerJoin(Store, eq(Store.id, sql`${StoreStorage.store}`))
        .where(
          and(
            scoped ? inArray(StoreStorage.store, user.storeIds.map(BigInt)) : undefined,
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
    async salespeople(user: Principal, page: AdminPage, storeId?: string, checkoutPicker = false) {
      if (storeId) requireStore(user, storeId);
      else requireRole(user, [1, 2, 3]);
      if (checkoutPicker) {
        if (!storeId)
          throw new AppError(
            400,
            'SALESPERSON_STORE_REQUIRED',
            'Choose a store for the salesperson picker.',
          );
        await db.get('writer').transaction(async (tx) => {
          await assertCurrentStoreAccess(tx, user.id, storeId);
          const [actor] = await tx
            .select({ userType: PosUser.user_type })
            .from(PosUser)
            .where(eq(PosUser.id, BigInt(user.id)))
            .limit(1)
            .for('share');
          if (actor?.userType !== user.userType)
            throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
          const [store] = await tx
            .select({ id: Store.id })
            .from(Store)
            .where(and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, true)))
            .limit(1)
            .for('share');
          if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'An active store was not found.');
        });
      }
      const database = db.get('primary');
      const collection = administrationCollectionPage(
        page,
        JSON.stringify([
          'salespeople',
          user.id,
          user.role,
          user.userType,
          user.storeIds,
          storeId ?? null,
          checkoutPicker,
        ]),
        collectionField(SalesPerson.id, 'id', 'integer'),
        {
          name: {
            column: sql`trim(concat(coalesce(${SalesPerson.first_name},''),' ',coalesce(${SalesPerson.last_name},'')))`,
            type: 'text',
            value: (row) =>
              [row.first_name, row.last_name]
                .filter(Boolean)
                .join(' ')
                .replace(/^ +| +$/g, ''),
          },
          firstName: collectionField(SalesPerson.first_name, 'first_name', 'text'),
          lastName: collectionField(SalesPerson.last_name, 'last_name', 'text'),
          employeeId: collectionField(SalesPerson.employee_id, 'employee_id', 'text'),
          email: collectionField(SalesPerson.email, 'email', 'text'),
          phone: collectionField(SalesPerson.phone, 'phone', 'text'),
          userType: collectionField(SalesPerson.user_type, 'user_type', 'integer'),
          active: collectionField(SalesPerson.is_active, 'is_active', 'integer'),
        },
      );
      const rows = await database
        .select()
        .from(SalesPerson)
        .where(
          and(
            collection.boundary,
            checkoutPicker ? lte(SalesPerson.id, 2147483647n) : undefined,
            checkoutPicker
              ? eq(SalesPerson.is_active, 1)
              : active(page.active) === undefined
                ? undefined
                : eq(SalesPerson.is_active, active(page.active) ? 1 : 0),
            user.userType === 2 ? eq(SalesPerson.user_type, 2) : undefined,
            storeId
              ? exists(
                  database
                    .select({ id: StoreSalesPerson.id })
                    .from(StoreSalesPerson)
                    .where(
                      and(
                        eq(StoreSalesPerson.salesperson, SalesPerson.id),
                        eq(StoreSalesPerson.store, BigInt(storeId)),
                        checkoutPicker ? eq(StoreSalesPerson.is_active, 1) : undefined,
                      ),
                    ),
                )
              : undefined,
            page.search
              ? or(
                  like(SalesPerson.first_name, escapedSearch(page.search)),
                  like(SalesPerson.last_name, escapedSearch(page.search)),
                  like(SalesPerson.employee_id, escapedSearch(page.search)),
                )
              : undefined,
          ),
        )
        .orderBy(...collection.order)
        .limit(page.limit + 1);
      const selected = rows.slice(0, page.limit),
        ids = selected.map((row) => row.id);
      if (checkoutPicker)
        return {
          data: selected.map((row) => ({ ...row, storeIds: [storeId!], activeStoreId: storeId! })),
          nextCursor: collection.finish(rows).nextCursor,
        };
      const assignments = ids.length
        ? await database
            .select({
              salespersonId: StoreSalesPerson.salesperson,
              storeId: StoreSalesPerson.store,
              active: StoreSalesPerson.is_active,
              storeName: Store.store_name,
            })
            .from(StoreSalesPerson)
            .leftJoin(Store, eq(Store.id, StoreSalesPerson.store))
            .where(inArray(StoreSalesPerson.salesperson, ids))
        : [];
      return {
        data: selected.map((row) => ({
          ...row,
          storeIds: assignments
            .filter((a) => a.salespersonId === row.id)
            .map((a) => String(a.storeId)),
          storeNames: assignments
            .filter((a) => a.salespersonId === row.id)
            .map((a) => a.storeName ?? String(a.storeId)),
          activeStoreId:
            assignments
              .find((a) => a.salespersonId === row.id && a.active === 1)
              ?.storeId.toString() || null,
        })),
        nextCursor: collection.finish(rows).nextCursor,
      };
    },
    async createSalesperson(user: Principal, value: SalespersonInput) {
      requireRole(user, [1, 2, 3]);
      if (user.userType === 2 && value.userType !== 2)
        throw new AppError(
          403,
          'SALESPERSON_SCOPE_DENIED',
          'This user type is outside your organization.',
        );
      return lock('salespeople', () =>
        db.get('writer').transaction(async (transaction) => {
          const [duplicate] = await transaction
            .select({ id: SalesPerson.id })
            .from(SalesPerson)
            .where(
              or(
                eq(SalesPerson.employee_id, value.employeeId),
                eq(SalesPerson.email, value.email),
                eq(SalesPerson.phone, value.phone),
              ),
            )
            .limit(1);
          if (duplicate)
            throw new AppError(409, 'SALESPERSON_ALREADY_EXISTS', 'Salesperson must be unique');
          const inserted = await transaction.insert(SalesPerson).values({
            employee_id: value.employeeId,
            first_name: value.firstName,
            last_name: value.lastName,
            email: value.email,
            phone: value.phone,
            user_type: value.userType,
            is_active: value.active ? 1 : 0,
            created_at: now(),
            updated_at: now(),
          });
          return {
            id: String(generatedId(inserted)),
            message: 'SalesPerson has been created.',
          };
        }),
      );
    },
    async updateSalesperson(user: Principal, salespersonId: string, value: SalespersonInput) {
      requireRole(user, [1, 2, 3]);
      return lock('salespeople', () =>
        db.get('writer').transaction(async (transaction) => {
          const [current] = await transaction
            .select()
            .from(SalesPerson)
            .where(eq(SalesPerson.id, BigInt(salespersonId)))
            .limit(1)
            .for('update');
          required(current, 'Salesperson');
          if (user.userType === 2 && (current!.user_type !== 2 || value.userType !== 2))
            throw new AppError(
              403,
              'SALESPERSON_SCOPE_DENIED',
              'This salesperson is outside your organization.',
            );
          const [duplicate] = await transaction
            .select({ id: SalesPerson.id })
            .from(SalesPerson)
            .where(
              and(
                ne(SalesPerson.id, BigInt(salespersonId)),
                or(
                  eq(SalesPerson.employee_id, value.employeeId),
                  eq(SalesPerson.email, value.email),
                  eq(SalesPerson.phone, value.phone),
                ),
              ),
            )
            .limit(1);
          if (duplicate)
            throw new AppError(409, 'SALESPERSON_ALREADY_EXISTS', 'Salesperson must be unique');
          await transaction
            .update(SalesPerson)
            .set({
              employee_id: value.employeeId,
              first_name: value.firstName,
              last_name: value.lastName,
              email: value.email,
              phone: value.phone,
              user_type: value.userType,
              is_active: value.active ? 1 : 0,
              updated_at: now(),
            })
            .where(eq(SalesPerson.id, BigInt(salespersonId)));
          return { id: salespersonId, message: 'Salesperson has been updated!' };
        }),
      );
    },
    async setSalespersonStatus(user: Principal, salespersonId: string, enabled: boolean) {
      requireRole(user, [1, 2, 3]);
      return db.get('writer').transaction(async (transaction) => {
        const [row] = await transaction
          .select()
          .from(SalesPerson)
          .where(eq(SalesPerson.id, BigInt(salespersonId)))
          .limit(1)
          .for('update');
        required(row, 'Salesperson');
        if (user.userType === 2 && row!.user_type !== 2)
          throw new AppError(
            403,
            'SALESPERSON_SCOPE_DENIED',
            'This salesperson is outside your organization.',
          );
        await transaction
          .update(SalesPerson)
          .set({ is_active: enabled ? 1 : 0, updated_at: now() })
          .where(eq(SalesPerson.id, BigInt(salespersonId)));
        return {
          status: 'success',
          message: enabled
            ? 'The SalesPerson has been activated'
            : 'The SalesPerson has been deleted',
        };
      });
    },
    async assignSalespersonStores(
      user: Principal,
      salespersonId: string,
      requested: string[],
      activeStoreId: string | null,
    ) {
      requireRole(user, [1, 2, 3]);
      requested.forEach((id) => requireStore(user, id));
      if (activeStoreId && !requested.includes(activeStoreId))
        throw new AppError(
          400,
          'INVALID_ACTIVE_STORE',
          'Active store must be assigned to the salesperson.',
        );
      return db.get('writer').transaction(async (transaction) => {
        const [person] = await transaction
          .select()
          .from(SalesPerson)
          .where(eq(SalesPerson.id, BigInt(salespersonId)))
          .limit(1)
          .for('update');
        required(person, 'Salesperson');
        if (user.userType === 2 && person!.user_type !== 2)
          throw new AppError(
            403,
            'SALESPERSON_SCOPE_DENIED',
            'This salesperson is outside your organization.',
          );
        const available = await assignableStores(user, transaction);
        if (requested.some((id) => !available.includes(id)))
          throw new AppError(
            403,
            'STORE_ACCESS_DENIED',
            'Select only active stores in your scope.',
          );
        const existing = await transaction
          .select({ id: StoreSalesPerson.store, active: StoreSalesPerson.is_active })
          .from(StoreSalesPerson)
          .where(eq(StoreSalesPerson.salesperson, BigInt(salespersonId)));
        if (
          activeStoreId &&
          existing.some(
            (assignment) => assignment.active === 1 && !available.includes(String(assignment.id)),
          )
        )
          throw new AppError(
            409,
            'SALESPERSON_ACTIVE_STORE_CONFLICT',
            'The salesperson has an active store outside your scope. Ask an administrator for that store to clear it first.',
          );
        const diff = scopedAssignmentDiff(
          existing.map((r) => String(r.id)),
          requested,
          available,
        );
        if (diff.remove.length)
          await transaction
            .delete(StoreSalesPerson)
            .where(
              and(
                eq(StoreSalesPerson.salesperson, BigInt(salespersonId)),
                inArray(StoreSalesPerson.store, diff.remove.map(BigInt)),
              ),
            );
        for (const id of diff.add)
          await transaction.insert(StoreSalesPerson).values({
            salesperson: BigInt(salespersonId),
            store: BigInt(id),
            is_active: id === activeStoreId ? 1 : 0,
          });
        if (available.length)
          await transaction
            .update(StoreSalesPerson)
            .set({ is_active: 0 })
            .where(
              and(
                eq(StoreSalesPerson.salesperson, BigInt(salespersonId)),
                inArray(StoreSalesPerson.store, available.map(BigInt)),
              ),
            );
        if (activeStoreId)
          await transaction
            .update(StoreSalesPerson)
            .set({ is_active: 1 })
            .where(
              and(
                eq(StoreSalesPerson.salesperson, BigInt(salespersonId)),
                eq(StoreSalesPerson.store, BigInt(activeStoreId)),
              ),
            );
        return {
          status: 'success',
          message: requested.length
            ? 'Store has been assigned to selected SalesPerson.'
            : 'Store has been deleted for the selected SalesPerson.',
        };
      });
    },
    async operators(user: Principal, page: AdminPage) {
      requireRole(user, [1, 2, 3]);
      const collection = administrationCollectionPage(
        page,
        JSON.stringify(['operators', user.id, user.role, user.userType, user.storeIds]),
        collectionField(PosUser.id, 'id', 'integer'),
        {
          name: {
            column: sql`trim(concat(coalesce(${PosUser.first_name},''),' ',coalesce(${PosUser.last_name},'')))`,
            type: 'text',
            value: (row) =>
              [row.firstName, row.lastName]
                .filter(Boolean)
                .join(' ')
                .replace(/^ +| +$/g, ''),
          },
          firstName: collectionField(PosUser.first_name, 'firstName', 'text'),
          lastName: collectionField(PosUser.last_name, 'lastName', 'text'),
          email: collectionField(PosUser.email, 'email', 'text'),
          phone: collectionField(PosUser.phone, 'phone', 'text'),
          role: collectionField(PosUser.role, 'role', 'integer'),
          userType: collectionField(PosUser.user_type, 'userType', 'integer'),
          active: collectionField(PosUser.is_active, 'active', 'boolean'),
        },
      );
      const rows = await db
        .get('primary')
        .select(operatorProjection)
        .from(PosUser)
        .where(
          and(
            collection.boundary,
            active(page.active) === undefined
              ? undefined
              : eq(PosUser.is_active, active(page.active)!),
            user.userType === 2 ? eq(PosUser.user_type, 2) : undefined,
            page.search
              ? or(
                  like(PosUser.first_name, escapedSearch(page.search)),
                  like(PosUser.username, escapedSearch(page.search)),
                  like(PosUser.last_name, escapedSearch(page.search)),
                  like(PosUser.email, escapedSearch(page.search)),
                  like(PosUser.phone, escapedSearch(page.search)),
                )
              : undefined,
          ),
        )
        .orderBy(...collection.order)
        .limit(page.limit + 1);
      const ids = rows.slice(0, page.limit).map((r) => r.id);
      const assignments = ids.length
        ? await db
            .get('primary')
            .select({
              operatorId: UserStore.django_user_id,
              storeId: UserStore.store_id,
              storeName: Store.store_name,
            })
            .from(UserStore)
            .leftJoin(Store, eq(Store.id, sql`${UserStore.store_id}`))
            .where(inArray(UserStore.django_user_id, ids))
        : [];
      return {
        data: rows.slice(0, page.limit).map((row) => ({
          ...row,
          storeNames: assignments
            .filter((a) => a.operatorId === row.id && a.storeId !== null)
            .map((a) => a.storeName ?? String(a.storeId)),
          storeIds: assignments
            .filter((a) => a.operatorId === row.id && a.storeId !== null)
            .map((a) => String(a.storeId)),
        })),
        nextCursor: collection.finish(rows).nextCursor,
      };
    },
    async updateOperator(user: Principal, operatorId: string, value: OperatorInput) {
      return lock('operators', () =>
        db.get('writer').transaction(async (transaction) => {
          const current = await operator(user, operatorId, transaction, {
            nextRole: value.role,
            nextUserType: value.userType,
          });
          if (value.password)
            throw new AppError(
              400,
              'USE_PASSWORD_RESET',
              'Use the audited identity password reset flow to change credentials.',
            );
          const [duplicate] = await transaction
            .select({ id: PosUser.id })
            .from(PosUser)
            .where(
              and(
                ne(PosUser.id, BigInt(operatorId)),
                or(
                  eq(PosUser.email, value.email),
                  eq(PosUser.contact_email, value.contactEmail),
                  eq(PosUser.phone, value.phone),
                ),
              ),
            )
            .limit(1);
          if (duplicate)
            throw new AppError(
              409,
              'OPERATOR_ALREADY_EXISTS',
              'Email, contact email, or phone is already in use.',
            );
          const values = {
            first_name: value.firstName,
            last_name: value.lastName,
            email: value.email,
            phone: value.phone,
            role: value.role,
            contact_email: value.contactEmail,
            otp_method: value.otpMethod,
            user_type: value.userType,
          };
          let credentialsChanged =
            credentialVersion(current) !== credentialVersion({ ...current, ...values });
          await transaction
            .update(PosUser)
            .set(values)
            .where(eq(PosUser.id, BigInt(operatorId)));
          if (value.role === 1) {
            const [removed] = await transaction
              .delete(UserStore)
              .where(eq(UserStore.django_user_id, BigInt(operatorId)));
            credentialsChanged ||= removed.affectedRows > 0;
          }
          if (credentialsChanged) await invalidateOperatorAuthentication(transaction, operatorId);
          return { id: operatorId, message: 'Profile has been Updated!' };
        }),
      );
    },
    async setOperatorStatus(user: Principal, operatorId: string, enabled: boolean) {
      return lock('operators', () =>
        db.get('writer').transaction(async (transaction) => {
          const current = await operator(user, operatorId, transaction);
          await transaction
            .update(PosUser)
            .set({ is_active: enabled })
            .where(eq(PosUser.id, BigInt(operatorId)));
          if (current.is_active !== enabled)
            await invalidateOperatorAuthentication(transaction, operatorId);
          return {
            status: 'success',
            message: enabled ? 'User has been activated' : 'User has been deleted',
          };
        }),
      );
    },
    async assignOperatorStores(user: Principal, operatorId: string, requested: string[]) {
      return lock('operators', () =>
        db.get('writer').transaction(async (transaction) => {
          await operator(user, operatorId, transaction, { assignment: true });
          const available = await assignableStores(user, transaction);
          const existing = await transaction
            .select({ storeId: UserStore.store_id })
            .from(UserStore)
            .where(eq(UserStore.django_user_id, BigInt(operatorId)));
          const diff = scopedAssignmentDiff(
            existing.filter((row) => row.storeId !== null).map((row) => String(row.storeId)),
            requested,
            available,
          );
          if (diff.remove.length)
            await transaction
              .delete(UserStore)
              .where(
                and(
                  eq(UserStore.django_user_id, BigInt(operatorId)),
                  inArray(UserStore.store_id, diff.remove.map(BigInt)),
                ),
              );
          for (const id of diff.add)
            await transaction
              .insert(UserStore)
              .values({ django_user_id: BigInt(operatorId), store_id: BigInt(id) });
          if (diff.add.length || diff.remove.length)
            await invalidateOperatorAuthentication(transaction, operatorId);
          return {
            status: 'success',
            message: diff.message,
            added: diff.add.length,
            removed: diff.remove.length,
          };
        }),
      );
    },
  };
}
export type AdministrationService = ReturnType<typeof administrationService>;
