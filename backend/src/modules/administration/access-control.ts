import { and, asc, eq, gt, inArray, like, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { credentialVersion } from '../../auth/crypto.js';
import {
  invalidateOperatorAuthentication,
  invalidateOperatorAuthenticationBatch,
} from '../../auth/revocation.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from './checkins.js';
import { withAdministrationLock } from './locks.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { administrationEphemeralStore } from './ephemeral-runtime.js';
import { administrationAccessReceipts } from './access-receipts.js';
import {
  accessVersion,
  administrationGroupVersion,
  mayEnterModelAdministration,
  type accessPageInput,
  type administrationGroupInput,
  type administrationGroupDeleteInput,
  type operatorAccessInput,
} from './access-domain.js';
import {
  administrationAccessReconciliation,
  administrationDirectPermissions,
  administrationGroupPermissions,
  administrationGroups,
  administrationMemberships,
  administrationPermissions,
} from './access-schema.js';
import { administrationGroupDeletions } from './group-deletions.js';

type Account = typeof PosUser.$inferSelect;
const unready = () =>
  new AppError(
    503,
    'ADMIN_ACCESS_RECONCILIATION_REQUIRED',
    'Verify and import the complete legacy administration access snapshot before using this feature.',
  );
const denied = () =>
  new AppError(
    403,
    'MODEL_ADMINISTRATION_DENIED',
    'This action requires current internal model administration access.',
  );
const conflict = () =>
  new AppError(409, 'ADMIN_ACCESS_CHANGED', 'Access changed. Reload before saving again.');
const searchText = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
const sameKeys = (one: string[], two: string[]) => {
  const other = new Set(two);
  return one.length === two.length && one.every((value) => other.has(value));
};
async function reconciled(tx: AdministrationTransaction) {
  const [row] = await tx
    .select({ verified: administrationAccessReconciliation.verified })
    .from(administrationAccessReconciliation)
    .where(eq(administrationAccessReconciliation.id, 'legacy'))
    .limit(1)
    .for('share');
  if (!row?.verified) throw unready();
}
async function currentActor(tx: AdministrationTransaction, user: Principal) {
  const [account] = await tx
    .select()
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(user.id)))
    .limit(1)
    .for('share');
  if (!account?.is_active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  if (
    account.role !== 1 ||
    account.user_type !== 1 ||
    !mayEnterModelAdministration({ isActive: account.is_active, isStaff: account.is_staff })
  )
    throw denied();
  return account;
}
/** Grants add model-admin access; they never bypass the POS role/store authorization layer. */
export async function assertModelAdministrationPermission(
  tx: AdministrationTransaction,
  user: Principal,
  allowed: readonly string[],
  mutation = false,
): Promise<Account> {
  const actor = await currentActor(tx, user);
  await reconciled(tx);
  if (actor.is_superuser) return actor;
  // Intentional hardening: only an existing superuser may delegate/revoke global privileges.
  if (mutation)
    throw new AppError(
      403,
      'ADMIN_PRIVILEGE_MUTATION_DENIED',
      'Privilege changes require a current internal superuser.',
    );
  const [direct] = await tx
    .select({ key: administrationDirectPermissions.permissionKey })
    .from(administrationDirectPermissions)
    .where(
      and(
        eq(administrationDirectPermissions.operatorId, user.id),
        inArray(administrationDirectPermissions.permissionKey, allowed),
      ),
    )
    .limit(1)
    .for('share');
  if (direct) return actor;
  const [group] = await tx
    .select({ key: administrationGroupPermissions.permissionKey })
    .from(administrationMemberships)
    .innerJoin(
      administrationGroupPermissions,
      eq(administrationGroupPermissions.groupId, administrationMemberships.groupId),
    )
    .where(
      and(
        eq(administrationMemberships.operatorId, user.id),
        inArray(administrationGroupPermissions.permissionKey, allowed),
      ),
    )
    .limit(1)
    .for('share');
  if (!group) throw denied();
  return actor;
}
export function administrationAccessService(
  config: Config,
  db: Databases,
  ephemeral: EphemeralStore = administrationEphemeralStore(config),
) {
  const locked = <T>(run: () => Promise<T>) =>
    withAdministrationLock(ephemeral, 'operators', () =>
      withAdministrationLock(ephemeral, 'access-control', () => retryTransaction(run)),
    );
  const { inputHash, replay, receipt } = administrationAccessReceipts(config);
  async function lockedGroupMembers(tx: AdministrationTransaction, id: string) {
    const members = await tx
      .select({ id: administrationMemberships.operatorId })
      .from(administrationMemberships)
      .where(eq(administrationMemberships.groupId, id))
      .limit(100001)
      .for('share');
    if (members.length > 100000)
      throw new AppError(
        503,
        'ADMIN_GROUP_MEMBER_CAPACITY',
        'Reconcile a bounded group before changing its grants.',
      );
    const ids = members
      .map((member) => member.id)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : a === b ? 0 : 1));
    for (let start = 0; start < ids.length; start += 500) {
      const batch = ids.slice(start, start + 500),
        locked = await tx
          .select({ id: PosUser.id })
          .from(PosUser)
          .where(inArray(PosUser.id, batch.map(BigInt)))
          .orderBy(asc(PosUser.id))
          .for('update');
      if (locked.length !== batch.length)
        throw new AppError(
          503,
          'ADMIN_GROUP_MEMBER_RECONCILIATION',
          'Reconcile missing group operators before changing its grants.',
        );
    }
    return ids;
  }
  async function invalidateMembers(tx: AdministrationTransaction, ids: string[]) {
    for (let start = 0; start < ids.length; start += 500)
      await invalidateOperatorAuthenticationBatch(tx, ids.slice(start, start + 500));
  }
  async function validateKeys(tx: AdministrationTransaction, keys: string[]) {
    const found = keys.length
      ? await tx
          .select({ key: administrationPermissions.key })
          .from(administrationPermissions)
          .where(inArray(administrationPermissions.key, keys))
          .for('share')
      : [];
    if (found.length !== keys.length)
      throw new AppError(
        400,
        'ADMIN_PERMISSION_NOT_FOUND',
        'Choose existing permissions from the reconciled catalog.',
      );
  }
  async function groupSnapshot(tx: AdministrationTransaction, id: string, write = false) {
    const [group] = await tx
      .select()
      .from(administrationGroups)
      .where(eq(administrationGroups.id, id))
      .limit(1)
      .for(write ? 'update' : 'share');
    if (!group) throw new AppError(404, 'ADMIN_GROUP_NOT_FOUND', 'This group was not found.');
    const permissions = await tx
      .select({ key: administrationGroupPermissions.permissionKey })
      .from(administrationGroupPermissions)
      .where(eq(administrationGroupPermissions.groupId, id))
      .orderBy(asc(administrationGroupPermissions.permissionKey))
      .limit(5001)
      .for('share');
    if (permissions.length > 5000)
      throw new AppError(
        503,
        'ADMIN_GROUP_CAPACITY',
        'Reconcile this group before editing its permissions.',
      );
    const [members] = await tx
      .select({ count: sql<string>`CAST(COUNT(*) AS CHAR)`.mapWith(String) })
      .from(administrationMemberships)
      .where(eq(administrationMemberships.groupId, id));
    return {
      id: group.id,
      name: group.name,
      permissionKeys: permissions.map((row) => row.key),
      memberCount: members?.count || '0',
      version: administrationGroupVersion(
        group,
        permissions.map((row) => row.key),
      ),
    };
  }
  async function operatorSnapshot(tx: AdministrationTransaction, id: string, write = false) {
    const [account] = await tx
      .select()
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(id)))
      .limit(1)
      .for(write ? 'update' : 'share');
    if (!account) throw new AppError(404, 'OPERATOR_NOT_FOUND', 'Operator was not found.');
    const groups = await tx
      .select({
        id: administrationGroups.id,
        name: administrationGroups.name,
        revision: administrationGroups.revision,
      })
      .from(administrationMemberships)
      .innerJoin(
        administrationGroups,
        eq(administrationGroups.id, administrationMemberships.groupId),
      )
      .where(eq(administrationMemberships.operatorId, id))
      .orderBy(asc(administrationGroups.id))
      .limit(1001)
      .for('share');
    const direct = await tx
      .select({ key: administrationDirectPermissions.permissionKey })
      .from(administrationDirectPermissions)
      .where(eq(administrationDirectPermissions.operatorId, id))
      .orderBy(asc(administrationDirectPermissions.permissionKey))
      .limit(5001)
      .for('share');
    if (groups.length > 1000 || direct.length > 5000)
      throw new AppError(
        503,
        'ADMIN_OPERATOR_ACCESS_CAPACITY',
        'Reconcile this operator before editing access.',
      );
    return {
      id,
      isStaff: account.is_staff,
      isSuperuser: account.is_superuser,
      groupIds: groups.map((group) => group.id),
      groups: groups.map((group) => ({ id: group.id, name: group.name })),
      permissionKeys: direct.map((permission) => permission.key),
      version: accessVersion([
        credentialVersion(account),
        account.is_staff,
        account.is_superuser,
        groups,
        direct,
      ]),
    };
  }
  return {
    ...administrationGroupDeletions(config, db, assertModelAdministrationPermission, ephemeral),
    async capabilities(user: Principal) {
      return db.get('writer').transaction(async (tx) => {
        const [account] = await tx
          .select({
            active: PosUser.is_active,
            role: PosUser.role,
            type: PosUser.user_type,
            staff: PosUser.is_staff,
            superuser: PosUser.is_superuser,
          })
          .from(PosUser)
          .where(eq(PosUser.id, BigInt(user.id)))
          .limit(1)
          .for('share');
        if (!account?.active || account.role !== 1) throw denied();
        const [state] = await tx
          .select({ verified: administrationAccessReconciliation.verified })
          .from(administrationAccessReconciliation)
          .where(eq(administrationAccessReconciliation.id, 'legacy'))
          .limit(1);
        let canViewGroups = false,
          canViewOperators = false;
        if (state?.verified && account.staff && account.type === 1) {
          for (const [resource, allowed] of [
            ['groups', ['auth.view_group', 'auth.change_group']],
            ['operators', ['users.view_posuser', 'users.change_posuser']],
          ] as const) {
            try {
              await assertModelAdministrationPermission(tx, user, allowed);
              if (resource === 'groups') canViewGroups = true;
              else canViewOperators = true;
            } catch (error) {
              if (!(error instanceof AppError) || error.status !== 403) throw error;
            }
          }
        }
        return {
          reconciled: Boolean(state?.verified),
          canManage: Boolean(
            state?.verified && account.staff && account.superuser && account.type === 1,
          ),
          staff: account.staff,
          superuser: account.superuser,
          internal: account.type === 1,
          canViewGroups,
          canViewOperators,
        };
      });
    },
    async permissions(user: Principal, page: z.infer<typeof accessPageInput>) {
      await db
        .get('writer')
        .transaction((tx) =>
          assertModelAdministrationPermission(tx, user, [
            'auth.view_group',
            'auth.change_group',
            'users.view_posuser',
            'users.change_posuser',
          ]),
        );
      const rows = await db
        .get('primary')
        .select()
        .from(administrationPermissions)
        .where(
          and(
            page.after ? gt(administrationPermissions.key, page.after) : undefined,
            page.search
              ? or(
                  like(administrationPermissions.key, searchText(page.search)),
                  like(administrationPermissions.name, searchText(page.search)),
                )
              : undefined,
          ),
        )
        .orderBy(asc(administrationPermissions.key))
        .limit(page.limit + 1);
      return {
        data: rows.slice(0, page.limit),
        nextCursor: rows.length > page.limit ? rows[page.limit - 1]!.key : null,
      };
    },
    async groups(user: Principal, page: z.infer<typeof accessPageInput>) {
      await db
        .get('writer')
        .transaction((tx) =>
          assertModelAdministrationPermission(tx, user, ['auth.view_group', 'auth.change_group']),
        );
      const rows = await db
        .get('primary')
        .select({ id: administrationGroups.id, name: administrationGroups.name })
        .from(administrationGroups)
        .where(
          and(
            page.after ? gt(administrationGroups.id, page.after) : undefined,
            page.search ? like(administrationGroups.name, searchText(page.search)) : undefined,
          ),
        )
        .orderBy(asc(administrationGroups.id))
        .limit(page.limit + 1);
      return {
        data: rows.slice(0, page.limit),
        nextCursor: rows.length > page.limit ? rows[page.limit - 1]!.id : null,
      };
    },
    async group(user: Principal, id: string) {
      return db.get('writer').transaction(async (tx) => {
        await assertModelAdministrationPermission(tx, user, [
          'auth.view_group',
          'auth.change_group',
        ]);
        return groupSnapshot(tx, id);
      });
    },
    async saveGroup(
      user: Principal,
      id: string | undefined,
      input: z.infer<typeof administrationGroupInput>,
    ) {
      const groupId = id || input.operationId,
        resourceId = `group:${groupId}`,
        hash = inputHash({ id: id || null, input });
      return locked(() =>
        db.get('writer').transaction(async (tx) => {
          await assertModelAdministrationPermission(
            tx,
            user,
            [id ? 'auth.change_group' : 'auth.add_group'],
            true,
          );
          const previous = await replay(
            tx,
            user,
            input.operationId,
            resourceId,
            id ? 'update-group' : 'create-group',
            hash,
          );
          if (previous) return previous;
          if (id ? input.expectedVersion === null : input.expectedVersion !== null)
            throw conflict();
          const current = id ? await groupSnapshot(tx, id, true) : null;
          if (current && current.version !== input.expectedVersion) throw conflict();
          const [duplicate] = await tx
            .select({ id: administrationGroups.id })
            .from(administrationGroups)
            .where(
              and(
                eq(administrationGroups.name, input.name),
                id ? ne(administrationGroups.id, id) : undefined,
              ),
            )
            .limit(1)
            .for('share');
          if (duplicate)
            throw new AppError(
              409,
              'ADMIN_GROUP_NAME_EXISTS',
              'A group with this name already exists.',
            );
          await validateKeys(tx, input.permissionKeys);
          if (
            current &&
            current.name === input.name &&
            sameKeys(current.permissionKeys, input.permissionKeys)
          )
            return receipt(tx, user, input.operationId, resourceId, 'update-group', hash, {
              id: groupId,
              status: 'success',
              message: 'No group changes were made.',
            });
          const permissionsChanged = Boolean(
            current && !sameKeys(current.permissionKeys, input.permissionKeys),
          );
          const members = permissionsChanged && id ? await lockedGroupMembers(tx, id) : [];
          if (id) {
            await tx
              .update(administrationGroups)
              .set({
                name: input.name,
                revision: sql`${administrationGroups.revision}+1`,
                updatedAt: new Date(),
              })
              .where(eq(administrationGroups.id, id));
            await tx
              .delete(administrationGroupPermissions)
              .where(eq(administrationGroupPermissions.groupId, id));
          } else
            await tx
              .insert(administrationGroups)
              .values({ id: groupId, name: input.name, legacyId: null, updatedAt: new Date() });
          for (let start = 0; start < input.permissionKeys.length; start += 200)
            await tx
              .insert(administrationGroupPermissions)
              .values(
                input.permissionKeys
                  .slice(start, start + 200)
                  .map((key) => ({ groupId, permissionKey: key })),
              );
          if (members.length) await invalidateMembers(tx, members);
          return receipt(
            tx,
            user,
            input.operationId,
            resourceId,
            id ? 'update-group' : 'create-group',
            hash,
            {
              id: groupId,
              status: 'success',
              message: id ? 'Group updated.' : 'Group created.',
              reauthenticate: members.includes(user.id),
            },
          );
        }),
      );
    },
    async deleteGroup(
      user: Principal,
      id: string,
      input: z.infer<typeof administrationGroupDeleteInput>,
    ) {
      const resourceId = `group:${id}`,
        hash = inputHash({ id, input });
      return locked(() =>
        db.get('writer').transaction(async (tx) => {
          await assertModelAdministrationPermission(tx, user, ['auth.delete_group'], true);
          const previous = await replay(
            tx,
            user,
            input.operationId,
            resourceId,
            'delete-group',
            hash,
          );
          if (previous) return previous;
          if ((await groupSnapshot(tx, id, true)).version !== input.expectedVersion)
            throw conflict();
          const members = await lockedGroupMembers(tx, id);
          await tx
            .delete(administrationMemberships)
            .where(eq(administrationMemberships.groupId, id));
          await tx
            .delete(administrationGroupPermissions)
            .where(eq(administrationGroupPermissions.groupId, id));
          await tx.delete(administrationGroups).where(eq(administrationGroups.id, id));
          if (members.length) await invalidateMembers(tx, members);
          return receipt(tx, user, input.operationId, resourceId, 'delete-group', hash, {
            id,
            status: 'success',
            message: 'Group deleted and removed from its operators.',
            reauthenticate: members.includes(user.id),
          });
        }),
      );
    },
    async operator(user: Principal, id: string) {
      return db.get('writer').transaction(async (tx) => {
        await assertModelAdministrationPermission(tx, user, [
          'users.view_posuser',
          'users.change_posuser',
        ]);
        return operatorSnapshot(tx, id);
      });
    },
    async updateOperator(user: Principal, id: string, input: z.infer<typeof operatorAccessInput>) {
      if (id === user.id)
        throw new AppError(
          403,
          'SELF_PRIVILEGE_CHANGE_DENIED',
          'Another internal superuser must change your administration privileges.',
        );
      const resourceId = `operator:${id}`,
        hash = inputHash({ id, input });
      return locked(() =>
        db.get('writer').transaction(async (tx) => {
          await assertModelAdministrationPermission(tx, user, ['users.change_posuser'], true);
          const previous = await replay(
            tx,
            user,
            input.operationId,
            resourceId,
            'operator-access',
            hash,
          );
          if (previous) return previous;
          const current = await operatorSnapshot(tx, id, true);
          if (current.version !== input.expectedVersion) throw conflict();
          await validateKeys(tx, input.permissionKeys);
          const groups = input.groupIds.length
            ? await tx
                .select({ id: administrationGroups.id })
                .from(administrationGroups)
                .where(inArray(administrationGroups.id, input.groupIds))
                .for('update')
            : [];
          if (groups.length !== input.groupIds.length)
            throw new AppError(400, 'ADMIN_GROUP_NOT_FOUND', 'Choose existing groups.');
          await tx
            .delete(administrationMemberships)
            .where(eq(administrationMemberships.operatorId, id));
          await tx
            .delete(administrationDirectPermissions)
            .where(eq(administrationDirectPermissions.operatorId, id));
          for (let start = 0; start < input.groupIds.length; start += 200)
            await tx
              .insert(administrationMemberships)
              .values(
                input.groupIds
                  .slice(start, start + 200)
                  .map((groupId) => ({ groupId, operatorId: id })),
              );
          if (
            current.isStaff === input.isStaff &&
            current.isSuperuser === input.isSuperuser &&
            sameKeys(current.groupIds, input.groupIds) &&
            sameKeys(current.permissionKeys, input.permissionKeys)
          )
            return receipt(tx, user, input.operationId, resourceId, 'operator-access', hash, {
              id,
              status: 'success',
              message: 'No operator access changes were made.',
            });
          for (let start = 0; start < input.permissionKeys.length; start += 200)
            await tx
              .insert(administrationDirectPermissions)
              .values(
                input.permissionKeys
                  .slice(start, start + 200)
                  .map((key) => ({ operatorId: id, permissionKey: key })),
              );
          const changedGroups = [...new Set([...current.groupIds, ...input.groupIds])];
          if (changedGroups.length)
            await tx
              .update(administrationGroups)
              .set({ revision: sql`${administrationGroups.revision}+1`, updatedAt: new Date() })
              .where(inArray(administrationGroups.id, changedGroups));
          await tx
            .update(PosUser)
            .set({ is_staff: input.isStaff, is_superuser: input.isSuperuser })
            .where(eq(PosUser.id, BigInt(id)));
          await invalidateOperatorAuthentication(tx, id);
          return receipt(tx, user, input.operationId, resourceId, 'operator-access', hash, {
            id,
            status: 'success',
            message: 'Operator administration access updated.',
          });
        }),
      );
    },
  };
}
