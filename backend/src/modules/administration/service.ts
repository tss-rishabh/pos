import { generatedId } from '../../db/generated-id.js';
import { Temporal } from '@js-temporal/polyfill';
import {
  and,
  asc,
  count,
  eq,
  exists,
  getTableColumns,
  gt,
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
import type { SalespersonInput, StoreInput, OperatorInput } from './contracts.js';
import { defaultStoreImage } from './contracts.js';
import type { AdministrationTransaction } from './checkins.js';
import { lockAdministrationRegistry } from './locks.js';
import { assertCurrentOperatorRole, assertCurrentStoreAccess } from './authorization.js';

const { slack_group_url: slackWebhookColumn, ...storeColumns } = getTableColumns(Store);
const storeReadFields = {
  ...storeColumns,
  slackConfigured:
    sql<boolean>`${slackWebhookColumn} IS NOT NULL AND ${slackWebhookColumn} <> ''`.mapWith(
      (value: unknown) => value === true || String(value) === '1',
    ),
};

export interface AdministrationOptions {
  /** Explicitly configured legacy STOREDEFAULTUSER identities; [] means intentionally none. */
  defaultStoreOperatorIds?: string[];
}
export interface AdminPage {
  after: string;
  limit: number;
  search: string;
  active: 'true' | 'false' | 'all';
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
  const now = () =>
    Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  const limited = <T extends { id: bigint }>(rows: T[], limit: number) => ({
    data: rows.slice(0, limit),
    nextCursor: rows.length > limit ? String(rows[limit - 1]!.id) : null,
  });
  async function assertActiveStore(transaction: AdministrationTransaction, storeId: string) {
    const [row] = await transaction
      .select()
      .from(Store)
      .where(and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, true)))
      .limit(1)
      .for('update');
    return required(row, 'Store');
  }
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
  async function storeUniqueness(
    transaction: AdministrationTransaction,
    value: StoreInput,
    exclude?: string,
  ) {
    const rows = await transaction
      .select({
        id: Store.id,
        name: Store.store_name,
        phone: Store.phone,
        location: Store.location_code,
        active: Store.is_active,
      })
      .from(Store)
      .where(
        and(
          exclude ? ne(Store.id, BigInt(exclude)) : undefined,
          or(
            and(eq(Store.store_name, value.name), eq(Store.is_active, true)),
            eq(Store.phone, value.phone),
            eq(Store.location_code, value.locationCode),
          ),
        ),
      )
      .limit(1);
    if (rows.length)
      throw new AppError(
        409,
        'STORE_ALREADY_EXISTS',
        'Store name, location code, or phone is already in use.',
      );
    const [setting] = await transaction
      .select({ value: TssSetting.value })
      .from(TssSetting)
      .where(eq(TssSetting.platform, 'STORE_LOCATION_CODE'))
      .orderBy(asc(TssSetting.id))
      .limit(1);
    if (!setting?.value) return unavailable('Store location choices');
    let locations: string[];
    try {
      locations = z.array(z.string()).parse(JSON.parse(setting.value) as unknown);
    } catch {
      return unavailable('Store location choices');
    }
    if (!locations.includes(value.locationCode))
      throw new AppError(400, 'INVALID_LOCATION_CODE', 'Select a configured store location code.');
  }
  function storeValues(value: StoreInput, franchiseId: number, imagePath = defaultStoreImage) {
    return {
      store_name: value.name,
      type: value.type,
      category: value.category,
      location_code: value.locationCode,
      latitude: value.latitude,
      longitude: value.longitude,
      email: value.email || null,
      address: value.address,
      alt_address: value.alternateAddress,
      city_id: value.cityId,
      country_id: value.countryId,
      phone: value.phone,
      pincode: value.pincode,
      per_day_threshold: value.dailyThreshold,
      per_hour_threshold: value.hourlyThreshold,
      gstin: value.gstin,
      short_name: value.shortName,
      ...(value.removeSlack
        ? { slack_group_url: null }
        : value.slackUrl
          ? { slack_group_url: value.slackUrl }
          : {}),
      city_name: value.city,
      state_name: value.state,
      state_id: value.stateId,
      franchise_id: franchiseId,
      store_image: imagePath,
      updated_at: now(),
    };
  }
  async function franchise(
    transaction: AdministrationTransaction,
    value: StoreInput,
    user: Principal,
    existing = 0,
  ) {
    if (value.category !== 'FRANCHISE') return 0;
    const selected = value.franchiseId ? legacyIntegerReference(value.franchiseId) : existing;
    if (selected) {
      const [found] = await transaction
        .select({ id: POSFranchise.id })
        .from(POSFranchise)
        .where(eq(POSFranchise.id, BigInt(selected)))
        .limit(1)
        .for('update');
      required(found, 'Franchise');
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
      if (actor.role !== 1 || actor.userType !== 1) {
        const stores = await transaction
          .select({ id: Store.id, category: Store.category })
          .from(Store)
          .where(eq(Store.franchise_id, selected))
          .limit(1001)
          .for('share');
        if (!stores.length || stores.length > 1000)
          throw new AppError(
            403,
            'FRANCHISE_SCOPE_DENIED',
            'This franchise cannot be changed within your store scope.',
          );
        const assignments = await transaction
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
          .for('share');
        const allowed = new Set(assignments.map((assignment) => String(assignment.storeId)));
        if (
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
      if (value.franchiseId) return selected;
    }
    const details = required(value.franchise, 'Franchise details');
    if (existing) {
      await transaction
        .update(POSFranchise)
        .set({
          name: details.name,
          description: details.description,
          cin_number: details.cin,
          updated_at: now(),
        })
        .where(eq(POSFranchise.id, BigInt(existing)));
      return existing;
    }
    const inserted = await transaction.insert(POSFranchise).values({
      name: details.name,
      description: details.description,
      cin_number: details.cin,
      created_at: now(),
      updated_at: now(),
    });
    return legacyIntegerReference(generatedId(inserted));
  }
  async function operator(
    user: Principal,
    operatorId: string,
    transaction: AdministrationTransaction,
    options: { nextRole?: Role; nextUserType?: 1 | 2; assignment?: boolean } = {},
  ) {
    await lockAdministrationRegistry(transaction, 'operators');
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
    async franchises(user: Principal, page: AdminPage) {
      requireRole(user, [1, 3]);
      const rows = await db
        .get('primary')
        .select({
          id: POSFranchise.id,
          name: POSFranchise.name,
          description: POSFranchise.description,
          cin: POSFranchise.cin_number,
        })
        .from(POSFranchise)
        .where(
          and(
            gt(POSFranchise.id, BigInt(page.after)),
            page.search ? like(POSFranchise.name, escapedSearch(page.search)) : undefined,
            user.role === 1 && user.userType === 1
              ? undefined
              : exists(
                  db
                    .get('primary')
                    .select({ id: Store.id })
                    .from(Store)
                    .innerJoin(
                      UserStore,
                      and(
                        eq(UserStore.store_id, sql`${Store.id}`),
                        eq(UserStore.django_user_id, BigInt(user.id)),
                      ),
                    )
                    .where(
                      and(
                        eq(Store.franchise_id, sql`${POSFranchise.id}`),
                        user.userType === 2 ? eq(Store.category, 'FRANCHISE') : undefined,
                      ),
                    ),
                ),
          ),
        )
        .orderBy(asc(POSFranchise.id))
        .limit(page.limit + 1);
      return limited(rows, page.limit);
    },
    async stores(user: Principal, page: AdminPage) {
      requireRole(user, [1, 2, 3]);
      const global = user.role === 1 && user.userType === 1;
      if (!global && !user.storeIds.length) return { data: [], nextCursor: null };
      const rows = await db
        .get('primary')
        .select(storeReadFields)
        .from(Store)
        .where(
          and(
            global ? undefined : inArray(Store.id, user.storeIds.map(BigInt)),
            user.userType === 2 ? eq(Store.category, 'FRANCHISE') : undefined,
            active(page.active) === undefined
              ? undefined
              : eq(Store.is_active, active(page.active)!),
            gt(Store.id, BigInt(page.after)),
            page.search
              ? or(
                  like(Store.store_name, escapedSearch(page.search)),
                  like(Store.location_code, escapedSearch(page.search)),
                )
              : undefined,
          ),
        )
        .orderBy(asc(Store.id))
        .limit(page.limit + 1);
      return limited(rows, page.limit);
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
      return { ...store, franchise: details || null };
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
      const [row] = await db
        .get('primary')
        .select({ value: TssSetting.value })
        .from(TssSetting)
        .where(eq(TssSetting.platform, 'STORE_LOCATION_CODE'))
        .orderBy(asc(TssSetting.id))
        .limit(1);
      if (!row?.value) return [];
      return z.array(z.string()).parse(JSON.parse(row.value) as unknown);
    },
    async addLocationCode(user: Principal, code: string) {
      requireRole(user, [1, 3]);
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          const rows = await transaction
            .select({ id: TssSetting.id, value: TssSetting.value })
            .from(TssSetting)
            .where(eq(TssSetting.platform, 'STORE_LOCATION_CODE'))
            .orderBy(asc(TssSetting.id))
            .for('update');
          const setting = required(rows[0], 'Store location settings');
          let current: string[];
          try {
            current = z.array(z.string()).parse(JSON.parse(setting.value || '[]') as unknown);
          } catch {
            current = (setting.value || '')
              .replace(/^\[|\]$/g, '')
              .replaceAll('"', '')
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean);
          }
          if (current.includes(code))
            throw new AppError(409, 'LOCATION_CODE_EXISTS', 'Location Code already exists.');
          const serialized = JSON.stringify([...new Set([...current, code])].sort());
          if (serialized.length > 255)
            throw new AppError(
              422,
              'LOCATION_CODE_CAPACITY',
              'Location code settings exceed the supported storage capacity.',
            );
          await transaction
            .update(TssSetting)
            .set({ value: serialized })
            .where(eq(TssSetting.platform, 'STORE_LOCATION_CODE'));
          return { status: 'success', message: 'Location Code added successfully.' };
        }),
      );
    },
    async createStore(user: Principal, value: StoreInput) {
      requireRole(user, [1, 3]);
      if (value.imagePath !== defaultStoreImage)
        throw new AppError(
          400,
          'STORE_IMAGE_UPLOAD_REQUIRED',
          'Create the store, then upload its image.',
        );
      if (options.defaultStoreOperatorIds === undefined)
        return unavailable('Default store operator assignments');
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await lockAdministrationRegistry(transaction, 'stores');
          await assertCurrentOperatorRole(transaction, user.id, [1, 3]);
          await storeUniqueness(transaction, value);
          const franchiseId = await franchise(transaction, value, user);
          const inserted = await transaction.insert(Store).values({
            ...storeValues(value, franchiseId),
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
          for (const operatorId of new Set(options.defaultStoreOperatorIds)) {
            const [exists] = await transaction
              .select({ id: PosUser.id })
              .from(PosUser)
              .where(eq(PosUser.id, BigInt(operatorId)))
              .limit(1);
            if (exists)
              await transaction.insert(UserStore).values({
                django_user_id: BigInt(operatorId),
                store_id: BigInt(storeId),
              });
          }
          return { id: storeId, message: 'Store has been created!' };
        }),
      );
    },
    async updateStore(user: Principal, storeId: string, value: StoreInput) {
      requireRole(user, [1, 3]);
      requireStore(user, storeId);
      return db.get('writer').transaction(async (transaction) => {
        await lockAdministrationRegistry(transaction, 'stores');
        await assertCurrentStoreAccess(transaction, user.id, storeId, [1, 3]);
        const current = await assertActiveStore(transaction, storeId);
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
            (current.category !== 'FRANCHISE' || value.category !== 'FRANCHISE'))
        )
          throw new AppError(
            403,
            'STORE_ACCESS_DENIED',
            'This store is outside your organization.',
          );
        if (operator.userType === 2 && operator.role === 1) {
          const [assignment] = await transaction
            .select({ id: UserStore.id })
            .from(UserStore)
            .where(
              and(
                eq(UserStore.django_user_id, BigInt(user.id)),
                eq(UserStore.store_id, current.id),
              ),
            )
            .limit(1)
            .for('share');
          if (!assignment)
            throw new AppError(403, 'STORE_ACCESS_DENIED', 'You do not have access to this store.');
        }
        if (value.imagePath !== defaultStoreImage && value.imagePath !== current.store_image)
          throw new AppError(
            400,
            'STORE_IMAGE_UPLOAD_REQUIRED',
            'Use the verified image upload to change this image.',
          );
        await storeUniqueness(transaction, value, storeId);
        const franchiseId = await franchise(transaction, value, user, current.franchise_id);
        await transaction
          .update(Store)
          .set({
            ...storeValues(value, franchiseId, current.store_image),
            url_key: storePublicUrl(storeId),
          })
          .where(eq(Store.id, BigInt(storeId)));
        return { id: storeId, message: 'Store has been updated!' };
      });
    },
    async setStoreStatus(user: Principal, storeId: string, enabled: boolean) {
      requireRole(user, [1]);
      return db.get('writer').transaction(async (transaction) => {
        await lockAdministrationRegistry(transaction, 'stores');
        const [row] = await transaction
          .select({ id: Store.id, name: Store.store_name })
          .from(Store)
          .where(eq(Store.id, BigInt(storeId)))
          .limit(1)
          .for('update');
        required(row, 'Store');
        if (enabled && row?.name) {
          const [duplicate] = await transaction
            .select({ id: Store.id })
            .from(Store)
            .where(
              and(
                ne(Store.id, BigInt(storeId)),
                eq(Store.store_name, row.name),
                eq(Store.is_active, true),
              ),
            )
            .limit(1);
          if (duplicate)
            throw new AppError(
              409,
              'STORE_ALREADY_EXISTS',
              'An active store already uses this name.',
            );
        }
        await transaction
          .update(Store)
          .set({ is_active: enabled, updated_at: now() })
          .where(eq(Store.id, BigInt(storeId)));
        return {
          status: 'success',
          message: enabled ? 'The Store has been activated' : 'The Store has been deleted',
        };
      });
    },
    async counters(user: Principal, storeId: string, page: AdminPage) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
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
            gt(StoreCounter.id, BigInt(page.after)),
          ),
        )
        .orderBy(asc(StoreCounter.id))
        .limit(page.limit + 1);
      return limited(rows, page.limit);
    },
    async createCounter(user: Principal, storeId: string, description: string) {
      requireRole(user, [1]);
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await assertActiveStore(transaction, storeId);
          const [total] = await transaction
            .select({ value: count() })
            .from(StoreCounter)
            .where(eq(StoreCounter.store, BigInt(storeId)));
          const name = counterName(total?.value || 0);
          const inserted = await transaction.insert(StoreCounter).values({
            store: BigInt(storeId),
            counter_name: name,
            counter_type: 'IN_STORE',
            counter_desc: description,
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
        .where(and(eq(StoreCounter.id, BigInt(counterId)), eq(StoreCounter.store, BigInt(storeId))))
        .limit(1);
      required(row, 'Counter');
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
            gt(StoreStorage.id, BigInt(page.after)),
          ),
        )
        .orderBy(asc(StoreStorage.id))
        .limit(page.limit + 1);
      return limited(rows, page.limit);
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
    async updateStorage(
      user: Principal,
      storeId: string,
      storageId: string,
      value: { name: string; description: string; type: 'STORAGE'; destinationStoreId?: string },
    ) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      const target = value.destinationStoreId || storeId;
      requireStore(user, target);
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          // Lock store headers consistently before storage rows, including moves between stores.
          for (const id of [...new Set([storeId, target])].sort((left, right) =>
            BigInt(left) < BigInt(right) ? -1 : 1,
          ))
            await assertActiveStore(transaction, id);
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
          required(row, 'Active storage');
          if (target !== storeId) {
            const [stock] = await transaction
              .select({ total: sql<string>`coalesce(sum(${StockStorage.stock}),0)` })
              .from(StockStorage)
              .where(eq(StockStorage.storage, BigInt(storageId)));
            if (BigInt(stock?.total || '0') !== 0n)
              throw new AppError(
                409,
                'STORAGE_CONTAINS_STOCK',
                'Release all stock before moving this storage to another store.',
              );
          }
          // Legacy editing accepts the full existing name, without applying the creation prefix again.
          await transaction
            .update(StoreStorage)
            .set({
              store: BigInt(target),
              storage_name: value.name,
              storage_desc: value.description,
              storage_type: value.type,
              updated_at: now(),
            })
            .where(eq(StoreStorage.id, BigInt(storageId)));
          return { status: 'success', message: 'Storage has been updated!' };
        }),
      );
    },
    async createStorage(
      user: Principal,
      storeId: string,
      value: { name: string; description: string; type: 'STORAGE' },
    ) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      return db.get('writer').transaction(async (transaction) => {
        const store = await assertActiveStore(transaction, storeId);
        const name = storageName(store.store_name || storeId, value.name);
        if (name.length > 100)
          throw new AppError(
            400,
            'STORAGE_NAME_TOO_LONG',
            'Storage name including the store prefix must be at most 100 characters.',
          );
        const inserted = await transaction.insert(StoreStorage).values({
          store: BigInt(storeId),
          storage_name: name,
          storage_type: value.type,
          storage_desc: value.description,
          is_active: true,
          created_at: now(),
          updated_at: now(),
        });
        return {
          id: String(generatedId(inserted)),
          name,
          message: 'Storage has been created!',
        };
      });
    },
    async setStorageStatus(user: Principal, storeId: string, storageId: string, enabled: boolean) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      return db.get('writer').transaction(async (transaction) => {
        const [row] = await transaction
          .select()
          .from(StoreStorage)
          .where(
            and(eq(StoreStorage.id, BigInt(storageId)), eq(StoreStorage.store, BigInt(storeId))),
          )
          .limit(1)
          .for('update');
        required(row, 'Storage');
        if (!enabled) {
          const [stock] = await transaction
            .select({ total: sql<string>`coalesce(sum(${StockStorage.stock}),0)` })
            .from(StockStorage)
            .where(eq(StockStorage.storage, BigInt(storageId)));
          if (BigInt(stock?.total || '0') > 0)
            throw new AppError(409, 'STORAGE_CONTAINS_STOCK', "This Storage can't be deleted");
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
      const rows = await database
        .select()
        .from(SalesPerson)
        .where(
          and(
            gt(SalesPerson.id, BigInt(page.after)),
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
        .orderBy(asc(SalesPerson.id))
        .limit(page.limit + 1);
      const selected = rows.slice(0, page.limit),
        ids = selected.map((row) => row.id);
      if (checkoutPicker)
        return {
          data: selected.map((row) => ({ ...row, storeIds: [storeId!], activeStoreId: storeId! })),
          nextCursor: rows.length > page.limit ? String(selected.at(-1)!.id) : null,
        };
      const assignments = ids.length
        ? await database
            .select({
              salespersonId: StoreSalesPerson.salesperson,
              storeId: StoreSalesPerson.store,
              active: StoreSalesPerson.is_active,
            })
            .from(StoreSalesPerson)
            .where(inArray(StoreSalesPerson.salesperson, ids))
        : [];
      return {
        data: selected.map((row) => ({
          ...row,
          storeIds: assignments
            .filter((a) => a.salespersonId === row.id)
            .map((a) => String(a.storeId)),
          activeStoreId:
            assignments
              .find((a) => a.salespersonId === row.id && a.active === 1)
              ?.storeId.toString() || null,
        })),
        nextCursor: rows.length > page.limit ? String(selected.at(-1)!.id) : null,
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
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await lockAdministrationRegistry(transaction, 'salespeople');
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
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await lockAdministrationRegistry(transaction, 'salespeople');
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
        await lockAdministrationRegistry(transaction, 'salespeople');
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
      const rows = await db
        .get('primary')
        .select(operatorProjection)
        .from(PosUser)
        .where(
          and(
            gt(PosUser.id, BigInt(page.after)),
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
        .orderBy(asc(PosUser.id))
        .limit(page.limit + 1);
      const ids = rows.slice(0, page.limit).map((r) => r.id);
      const assignments = ids.length
        ? await db
            .get('primary')
            .select({ operatorId: UserStore.django_user_id, storeId: UserStore.store_id })
            .from(UserStore)
            .where(inArray(UserStore.django_user_id, ids))
        : [];
      return {
        data: rows.slice(0, page.limit).map((row) => ({
          ...row,
          storeIds: assignments
            .filter((a) => a.operatorId === row.id && a.storeId !== null)
            .map((a) => String(a.storeId)),
        })),
        nextCursor: rows.length > page.limit ? String(rows[page.limit - 1]!.id) : null,
      };
    },
    async updateOperator(user: Principal, operatorId: string, value: OperatorInput) {
      return db.get('writer').transaction(async (transaction) => {
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
      });
    },
    async setOperatorStatus(user: Principal, operatorId: string, enabled: boolean) {
      return db.get('writer').transaction(async (transaction) => {
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
      });
    },
    async assignOperatorStores(user: Principal, operatorId: string, requested: string[]) {
      return db.get('writer').transaction(async (transaction) => {
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
      });
    },
  };
}
export type AdministrationService = ReturnType<typeof administrationService>;
