import { administrationCollectionPage, collectionField } from './collection-page.js';
import { generatedId } from '../../db/generated-id.js';
import { and, eq, exists, inArray, like, lte, ne, or, sql } from 'drizzle-orm';
import { PosUser, SalesPerson, Store, StoreSalesPerson } from '../../db/legacy-schema.js';
import { requireRole, requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { scopedAssignmentDiff } from './policies.js';
import type { SalespersonInput } from './contracts.js';
import { assertCurrentStoreAccess } from './authorization.js';
import {
  required,
  escapedSearch,
  insertBatches,
  active,
  type AdministrationServiceCore,
  type AdminPage,
} from './service-core.js';

/**
 * Salespeople: the list and checkout picker, create, update, status and store assignment.
 */
export function salespersonAdministration(core: AdministrationServiceCore) {
  const { db, now, assignableStores, lock } = core;
  return {
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
        for (const batch of insertBatches(diff.add))
          await transaction.insert(StoreSalesPerson).values(
            batch.map((id) => ({
              salesperson: BigInt(salespersonId),
              store: BigInt(id),
              is_active: id === activeStoreId ? 1 : 0,
            })),
          );
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
  };
}
