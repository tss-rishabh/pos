import { administrationCollectionPage, collectionField } from './collection-page.js';
import { and, eq, inArray, like, ne, or, sql } from 'drizzle-orm';
import { PosUser, Store, UserStore } from '../../db/legacy-schema.js';
import { requireRole, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { credentialVersion } from '../../auth/crypto.js';
import { invalidateOperatorAuthentication } from '../../auth/revocation.js';
import { scopedAssignmentDiff } from './policies.js';
import type { OperatorInput } from './contracts.js';
import {
  escapedSearch,
  insertBatches,
  active,
  type AdministrationServiceCore,
  type AdminPage,
} from './service-core.js';

/**
 * Operators: the list, update, status and store assignment.
 */
export function operatorAdministration(core: AdministrationServiceCore) {
  const { db, assignableStores, lock, operator, operatorProjection } = core;
  return {
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
            .leftJoin(Store, eq(Store.id, UserStore.store_id))
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
          for (const batch of insertBatches(diff.add))
            await transaction
              .insert(UserStore)
              .values(
                batch.map((id) => ({ django_user_id: BigInt(operatorId), store_id: BigInt(id) })),
              );
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
