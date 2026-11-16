import { asc, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { invalidateOperatorAuthenticationBatch } from '../../auth/revocation.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import type { AdministrationTransaction } from './checkins.js';
import {
  administrationGroupBulkDeleteInput,
  administrationGroupDeletionPreviewInput,
  administrationGroupVersion,
} from './access-domain.js';
import {
  administrationGroups,
  administrationGroupPermissions,
  administrationMemberships,
} from './access-schema.js';
import { administrationAccessReceipts } from './access-receipts.js';
import { lockAdministrationRegistry } from './locks.js';

type Authorize = (
  tx: AdministrationTransaction,
  user: Principal,
  permissions: readonly string[],
  mutation: boolean,
) => Promise<unknown>;
const capacity = () =>
  new AppError(
    503,
    'ADMIN_GROUP_DELETION_CAPACITY',
    'Choose a bounded group selection before deleting.',
  );
const invalid = () =>
  new AppError(
    503,
    'ADMIN_GROUP_MEMBER_RECONCILIATION',
    'Reconcile group membership before deleting.',
  );
const conflict = () =>
  new AppError(
    409,
    'ADMIN_ACCESS_CHANGED',
    'Access changed. Reload the deletion preview before confirming again.',
  );
/** The reconciled rewrite Group/M2M graph only. This never deletes operators, stores, or legacy auth tables. */
export function administrationGroupDeletions(config: Config, db: Databases, authorize: Authorize) {
  const receipts = administrationAccessReceipts(config);
  async function lock(tx: AdministrationTransaction, user: Principal) {
    await lockAdministrationRegistry(tx, 'operators');
    await lockAdministrationRegistry(tx, 'access-control');
    await authorize(tx, user, ['auth.delete_group'], true);
  }
  async function snapshots(tx: AdministrationTransaction, ids: readonly string[]) {
    const groups = await tx
      .select()
      .from(administrationGroups)
      .where(inArray(administrationGroups.id, [...ids]))
      .orderBy(asc(administrationGroups.id))
      .for('update');
    if (groups.length !== ids.length)
      throw new AppError(
        404,
        'ADMIN_GROUP_NOT_FOUND',
        'One or more selected groups no longer exist.',
      );
    const permissions = await tx
      .select({
        id: administrationGroupPermissions.groupId,
        key: administrationGroupPermissions.permissionKey,
      })
      .from(administrationGroupPermissions)
      .where(inArray(administrationGroupPermissions.groupId, [...ids]))
      .orderBy(
        asc(administrationGroupPermissions.groupId),
        asc(administrationGroupPermissions.permissionKey),
      )
      .limit(20001)
      .for('share');
    if (permissions.length > 20000) throw capacity();
    const counts = await tx
      .select({ id: administrationMemberships.groupId, count: sql<string>`CAST(COUNT(*) AS CHAR)` })
      .from(administrationMemberships)
      .where(inArray(administrationMemberships.groupId, [...ids]))
      .groupBy(administrationMemberships.groupId)
      .limit(100);
    const countSchema = z
        .string()
        .regex(/^(?:0|[1-9]\d*)$/)
        .refine((value) => BigInt(value) <= 100000n),
      countMap = new Map<string, string>();
    let memberships = 0;
    for (const row of counts) {
      const count = countSchema.safeParse(row.count);
      if (!count.success) throw capacity();
      countMap.set(row.id, count.data);
      memberships += Number(count.data);
    }
    if (memberships > 100000) throw capacity();
    const permissionMap = new Map<string, string[]>();
    for (const row of permissions) {
      const keys = permissionMap.get(row.id) || [];
      keys.push(row.key);
      permissionMap.set(row.id, keys);
      if (keys.length > 5000) throw capacity();
    }
    return {
      groups: groups.map((group) => {
        const keys = permissionMap.get(group.id) || [];
        return {
          id: group.id,
          name: group.name,
          version: administrationGroupVersion(group, keys),
          memberCount: countMap.get(group.id) || '0',
          permissionCount: keys.length,
        };
      }),
      membershipCount: memberships,
      permissionAssignmentCount: permissions.length,
    };
  }
  async function lockMembers(tx: AdministrationTransaction, ids: readonly string[]) {
    const memberships = await tx
      .select({ id: administrationMemberships.operatorId })
      .from(administrationMemberships)
      .where(inArray(administrationMemberships.groupId, [...ids]))
      .orderBy(asc(administrationMemberships.operatorId), asc(administrationMemberships.groupId))
      .limit(100001)
      .for('share');
    if (memberships.length > 100000) throw capacity();
    if (memberships.some((row) => !identifier.safeParse(row.id).success)) throw invalid();
    const operators = [...new Set(memberships.map((row) => row.id))].sort((left, right) =>
      BigInt(left) < BigInt(right) ? -1 : left === right ? 0 : 1,
    );
    for (let start = 0; start < operators.length; start += 500) {
      const batch = operators.slice(start, start + 500),
        locked = await tx
          .select({ id: PosUser.id })
          .from(PosUser)
          .where(inArray(PosUser.id, batch.map(BigInt)))
          .orderBy(asc(PosUser.id))
          .for('update');
      if (locked.length !== batch.length) throw invalid();
    }
    return operators;
  }
  return {
    async previewGroupDeletion(
      user: Principal,
      value: z.infer<typeof administrationGroupDeletionPreviewInput>,
    ) {
      const input = administrationGroupDeletionPreviewInput.parse(value),
        ids = [...input.groupIds].sort();
      return db.get('writer').transaction(async (tx) => {
        await lock(tx, user);
        return { ...(await snapshots(tx, ids)), operatorAccountsDeleted: 0 as const };
      });
    },
    async deleteGroups(user: Principal, value: z.infer<typeof administrationGroupBulkDeleteInput>) {
      const input = administrationGroupBulkDeleteInput.parse(value),
        groups = [...input.groups].sort((left, right) => left.id.localeCompare(right.id)),
        ids = groups.map((group) => group.id),
        hash = receipts.inputHash({ groups }),
        resource = 'group-selection';
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await lock(tx, user);
          const previous = await receipts.replay(
            tx,
            user,
            input.operationId,
            resource,
            'bulk-delete-groups',
            hash,
          );
          if (previous) return previous;
          const current = await snapshots(tx, ids),
            expected = new Map(groups.map((group) => [group.id, group.expectedVersion]));
          if (current.groups.some((group) => expected.get(group.id) !== group.version))
            throw conflict();
          const operators = await lockMembers(tx, ids);
          await tx
            .delete(administrationMemberships)
            .where(inArray(administrationMemberships.groupId, ids));
          await tx
            .delete(administrationGroupPermissions)
            .where(inArray(administrationGroupPermissions.groupId, ids));
          await tx.delete(administrationGroups).where(inArray(administrationGroups.id, ids));
          for (let start = 0; start < operators.length; start += 500)
            await invalidateOperatorAuthenticationBatch(tx, operators.slice(start, start + 500));
          return receipts.receipt(
            tx,
            user,
            input.operationId,
            resource,
            'bulk-delete-groups',
            hash,
            {
              id: input.operationId,
              status: 'success',
              message: `Deleted ${ids.length} administration groups and removed their memberships.`,
              reauthenticate: operators.includes(user.id),
              deletedGroupIds: ids,
            },
          );
        }),
      );
    },
  };
}
