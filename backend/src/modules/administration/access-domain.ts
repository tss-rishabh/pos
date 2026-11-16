import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';

export const permissionKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}\.[A-Za-z0-9_]{1,100}$/);
const version = z.string().regex(/^[a-f0-9]{64}$/);
const distinct = <T>(values: T[]) => new Set(values).size === values.length;
const permissionKeys = z
  .array(permissionKey)
  .max(5000)
  .refine(distinct, 'Choose each permission once.');
const groupIds = z.array(z.uuid()).max(1000).refine(distinct, 'Choose each group once.');
export const administrationGroupInput = z
  .object({
    operationId: z.uuid(),
    expectedVersion: version.nullable(),
    name: z.string().trim().min(1).max(150),
    permissionKeys,
  })
  .strict();
export const administrationGroupDeleteInput = z
  .object({ operationId: z.uuid(), expectedVersion: version })
  .strict();
const selectedGroupIds = z
  .array(z.uuid().transform((value) => value.toLowerCase()))
  .min(1)
  .max(100)
  .refine(distinct, 'Choose each group once.');
export const administrationGroupDeletionPreviewInput = z
  .object({ groupIds: selectedGroupIds })
  .strict();
export const administrationGroupBulkDeleteInput = z
  .object({
    operationId: z.uuid(),
    groups: z
      .array(
        z
          .object({
            id: z.uuid().transform((value) => value.toLowerCase()),
            expectedVersion: version,
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine((values) => distinct(values.map((value) => value.id)), 'Choose each group once.'),
  })
  .strict();
export const operatorAccessInput = z
  .object({
    operationId: z.uuid(),
    expectedVersion: version,
    isStaff: z.boolean(),
    isSuperuser: z.boolean(),
    groupIds,
    permissionKeys,
  })
  .strict()
  .refine((value) => !value.isSuperuser || value.isStaff, 'Superusers must have staff access.');
export const accessPageInput = z
  .object({
    after: z.string().max(201).default(''),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    search: z.string().trim().max(100).default(''),
  })
  .strict();
export function accessVersion(value: unknown) {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === 'bigint' ? item.toString() : item,
      ),
    )
    .digest('hex');
}
export function administrationGroupVersion(
  group: { id: string; name: string; revision: bigint },
  permissionKeys: readonly string[],
) {
  return accessVersion([group.id, group.name, group.revision, permissionKeys]);
}
export function hasModelPermission(
  account: { isActive: boolean; isSuperuser: boolean },
  permissions: ReadonlySet<string>,
  permission: string,
): boolean {
  return account.isActive && (account.isSuperuser || permissions.has(permission));
}
export function mayEnterModelAdministration(account: {
  isActive: boolean;
  isStaff: boolean;
}): boolean {
  return account.isActive && account.isStaff;
}
const catalogPermission = z
  .object({
    key: permissionKey,
    appLabel: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/),
    model: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/),
    codename: z.string().regex(/^[A-Za-z0-9_]{1,100}$/),
    name: z.string().min(1).max(255),
  })
  .strict()
  .refine(
    (value) => value.key === `${value.appLabel}.${value.codename}`,
    'Permission keys must match their source app and codename.',
  );
export const accessSnapshotInput = z
  .object({
    version: z.literal(1),
    sourceFingerprint: version,
    sourceVerified: z.literal(true),
    exportedAt: z.iso.datetime(),
    permissions: z.array(catalogPermission).min(1).max(10000),
    groups: z
      .array(
        z
          .object({ legacyId: identifier, name: z.string().min(1).max(150), permissionKeys })
          .strict(),
      )
      .max(5000),
    operators: z
      .array(
        z
          .object({
            id: identifier,
            isStaff: z.boolean(),
            isSuperuser: z.boolean(),
            legacyGroupIds: z.array(identifier).max(1000).refine(distinct),
            permissionKeys,
          })
          .strict(),
      )
      .min(1)
      .max(100000),
  })
  .strict();
export type AccessSnapshot = z.infer<typeof accessSnapshotInput>;
/** Reject inconsistent/truncated joins instead of silently dropping grants during migration. */
export function validateAccessSnapshot(input: unknown) {
  const snapshot = accessSnapshotInput.parse(input);
  const keys = new Set(snapshot.permissions.map((permission) => permission.key)),
    groups = new Set(snapshot.groups.map((group) => group.legacyId));
  if (
    keys.size !== snapshot.permissions.length ||
    groups.size !== snapshot.groups.length ||
    !distinct(snapshot.groups.map((group) => group.name)) ||
    !distinct(snapshot.operators.map((operator) => operator.id))
  )
    throw new AppError(
      400,
      'ADMIN_ACCESS_SNAPSHOT_DUPLICATE',
      'The source access snapshot contains duplicate or ambiguous identities.',
    );
  if (
    snapshot.groups.some((group) => group.permissionKeys.some((key) => !keys.has(key))) ||
    snapshot.operators.some(
      (operator) =>
        operator.permissionKeys.some((key) => !keys.has(key)) ||
        operator.legacyGroupIds.some((id) => !groups.has(id)) ||
        (operator.isSuperuser && !operator.isStaff),
    )
  )
    throw new AppError(
      400,
      'ADMIN_ACCESS_SNAPSHOT_REFERENCE',
      'The source access snapshot contains unresolved grants or invalid account flags.',
    );
  return {
    snapshot,
    hash: accessVersion({
      permissions: [...snapshot.permissions].sort((a, b) => a.key.localeCompare(b.key)),
      groups: snapshot.groups
        .map((group) => ({ ...group, permissionKeys: [...group.permissionKeys].sort() }))
        .sort((a, b) => a.legacyId.localeCompare(b.legacyId)),
      operators: snapshot.operators
        .map((operator) => ({
          ...operator,
          permissionKeys: [...operator.permissionKeys].sort(),
          legacyGroupIds: [...operator.legacyGroupIds].sort(),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      sourceFingerprint: snapshot.sourceFingerprint,
    }),
    counts: {
      permissions: snapshot.permissions.length,
      groups: snapshot.groups.length,
      operators: snapshot.operators.length,
      memberships: snapshot.operators.reduce(
        (sum, operator) => sum + operator.legacyGroupIds.length,
        0,
      ),
      groupPermissions: snapshot.groups.reduce(
        (sum, group) => sum + group.permissionKeys.length,
        0,
      ),
      directPermissions: snapshot.operators.reduce(
        (sum, operator) => sum + operator.permissionKeys.length,
        0,
      ),
    },
  };
}
