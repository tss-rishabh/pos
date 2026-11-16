import { count, eq } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import { PosUser } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { z } from 'zod';
import { lockAdministrationRegistry } from './locks.js';
import { validateAccessSnapshot } from './access-domain.js';
import {
  administrationAccessReconciliation,
  administrationDirectPermissions,
  administrationGroupPermissions,
  administrationGroups,
  administrationMemberships,
  administrationPermissions,
} from './access-schema.js';

/** Explicit migration operation; it never fetches from an assumed legacy auth database. */
export async function reconcileAdministrationAccess(
  db: Databases,
  input: unknown,
  options: { operatorId: string; requestId?: string },
) {
  z.object({ operatorId: identifier, requestId: z.string().min(1).max(128).optional() })
    .strict()
    .parse(options);
  const validated = validateAccessSnapshot(input),
    { snapshot, counts, hash } = validated;
  if (counts.memberships + counts.groupPermissions + counts.directPermissions > 500000)
    throw new AppError(
      400,
      'ADMIN_ACCESS_SNAPSHOT_CAPACITY',
      'Reconcile a bounded complete source snapshot.',
    );
  return retryTransaction(() =>
    db.get('writer').transaction(async (tx) => {
      await lockAdministrationRegistry(tx, 'operators');
      await lockAdministrationRegistry(tx, 'access-control');
      const [actor] = await tx
        .select({
          active: PosUser.is_active,
          role: PosUser.role,
          type: PosUser.user_type,
          staff: PosUser.is_staff,
          superuser: PosUser.is_superuser,
        })
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(options.operatorId)))
        .limit(1)
        .for('share');
      if (
        !actor?.active ||
        actor.role !== 1 ||
        actor.type !== 1 ||
        !actor.staff ||
        !actor.superuser
      )
        throw new AppError(
          403,
          'ADMIN_ACCESS_IMPORT_OPERATOR_DENIED',
          'Import requires a current internal staff superuser.',
        );
      const [previous] = await tx
        .select()
        .from(administrationAccessReconciliation)
        .where(eq(administrationAccessReconciliation.id, 'legacy'))
        .limit(1)
        .for('update');
      if (previous) {
        if (previous.snapshotHash !== hash || !previous.verified)
          throw new AppError(
            409,
            'ADMIN_ACCESS_ALREADY_RECONCILED',
            'Access has already been reconciled. Use an explicit reviewed migration for subsequent source changes.',
          );
        return { hash, counts: previous.counts, replay: true };
      }
      for (const table of [
        administrationPermissions,
        administrationGroups,
        administrationGroupPermissions,
        administrationMemberships,
        administrationDirectPermissions,
      ]) {
        const [row] = await tx.select({ count: count() }).from(table);
        if (row?.count)
          throw new AppError(
            409,
            'ADMIN_ACCESS_NOT_EMPTY',
            'Reconciliation requires empty rewrite access tables.',
          );
      }
      const accounts = await tx
        .select({ id: PosUser.id, isStaff: PosUser.is_staff, isSuperuser: PosUser.is_superuser })
        .from(PosUser)
        .limit(100001)
        .for('share');
      const byId = new Map(accounts.map((account) => [String(account.id), account]));
      if (
        accounts.length !== snapshot.operators.length ||
        accounts.length > 100000 ||
        snapshot.operators.some((account) => {
          const current = byId.get(account.id);
          return (
            !current ||
            current.isStaff !== account.isStaff ||
            current.isSuperuser !== account.isSuperuser
          );
        })
      )
        throw new AppError(
          409,
          'ADMIN_ACCESS_SOURCE_MISMATCH',
          'Reconcile every source operator and its current staff/superuser flags before importing grants.',
        );
      const groupIds = new Map(
        snapshot.groups.map((group) => [group.legacyId, crypto.randomUUID()]),
      );
      const groupRows = snapshot.groups.map((group) => ({
        id: groupIds.get(group.legacyId)!,
        legacyId: group.legacyId,
        name: group.name,
        updatedAt: new Date(),
      }));
      const groupPermissions = snapshot.groups.flatMap((group) =>
        group.permissionKeys.map((key) => ({
          groupId: groupIds.get(group.legacyId)!,
          permissionKey: key,
        })),
      );
      const memberships = snapshot.operators.flatMap((account) =>
        account.legacyGroupIds.map((id) => ({
          operatorId: account.id,
          groupId: groupIds.get(id)!,
        })),
      );
      const direct = snapshot.operators.flatMap((account) =>
        account.permissionKeys.map((key) => ({ operatorId: account.id, permissionKey: key })),
      );
      for (let start = 0; start < snapshot.permissions.length; start += 200)
        await tx
          .insert(administrationPermissions)
          .values(snapshot.permissions.slice(start, start + 200));
      for (let start = 0; start < groupRows.length; start += 200)
        await tx.insert(administrationGroups).values(groupRows.slice(start, start + 200));
      for (let start = 0; start < groupPermissions.length; start += 200)
        await tx
          .insert(administrationGroupPermissions)
          .values(groupPermissions.slice(start, start + 200));
      for (let start = 0; start < memberships.length; start += 200)
        await tx.insert(administrationMemberships).values(memberships.slice(start, start + 200));
      for (let start = 0; start < direct.length; start += 200)
        await tx.insert(administrationDirectPermissions).values(direct.slice(start, start + 200));
      await tx.insert(administrationAccessReconciliation).values({
        id: 'legacy',
        verified: true,
        sourceFingerprint: snapshot.sourceFingerprint,
        snapshotHash: hash,
        operatorId: options.operatorId,
        requestId: options.requestId || null,
        counts,
        completedAt: new Date(),
      });
      return { hash, counts, replay: false };
    }),
  );
}
