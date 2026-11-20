import { generatedId } from '../../db/generated-id.js';
import { Temporal } from '@js-temporal/polyfill';
import { type SQL, and, asc, eq, exists, getTableColumns, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { POSFranchise, PosUser, Store, TssSetting, UserStore } from '../../db/legacy-schema.js';
import type { Principal, Role } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { retryTransaction } from '../../db/retry.js';
import { legacyIntegerReference, manageableOperator } from './policies.js';
import { FormErrors, type CleanStoreForm } from './store-form.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { administrationEphemeralStore } from './ephemeral-runtime.js';
import type { AdministrationTransaction } from './checkins.js';
import { withAdministrationLock, type AdministrationLockResource } from './locks.js';
import type { StoreDefaultOperatorOptions } from './store-default-operators.js';
import { assertCurrentOperatorRole } from './authorization.js';

/** The legacy form displays every store field, `slack_group_url` included (`_form.html:310`). */
export const storeReadFields = getTableColumns(Store);

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
export const required = <T>(value: T | undefined, resource: string): T => {
  if (value === undefined)
    throw new AppError(404, 'RESOURCE_NOT_FOUND', `${resource} was not found.`);
  return value;
};
export const escapedSearch = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
/**
 * Multi-row INSERT batches, as legacy `bulk_create` (`users/views.py:589`), which sends the whole
 * list in one statement on MySQL. Batches of 1000 bound the packet size; rows keep their order, so
 * auto-increment ids still follow list order.
 */
export function insertBatches<T>(rows: readonly T[], size = 1000): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < rows.length; start += size)
    result.push(rows.slice(start, start + size));
  return result;
}
export const active = (value: AdminPage['active']) =>
  value === 'all' ? undefined : value === 'true';
/**
 * What the administration operations share: assignable and franchise store scope, the
 * administration lock, store form checks and values, image preparation and the operator
 * read. The operation groups in `service-*.ts` build on it.
 */
export function administrationServiceCore(
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
    config,
    db,
    options,
    ephemeral,
    now,
    assignableStores,
    lock,
    locationChoices,
    preparedImage,
    storeFormChecks,
    storeValues,
    assertFranchiseScope,
    franchise,
    activeResourceStore,
    operator,
    operatorProjection,
  };
}
export type AdministrationServiceCore = ReturnType<typeof administrationServiceCore>;
