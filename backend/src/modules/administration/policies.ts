import { AppError } from '../../domain/errors.js';
import { requireRole, type Principal, type Role } from '../../domain/access.js';

/** Some source foreign references are signed INT despite the target's BIGINT key. */
export function legacyIntegerReference(value: string | bigint): number {
  const integer = BigInt(value);
  if (integer < 1n || integer > 2_147_483_647n)
    throw new AppError(
      422,
      'LEGACY_REFERENCE_RANGE',
      'Identifier exceeds the supported legacy reference range.',
    );
  return Number(integer);
}

/** Source: users/views.py AssignStoreUserView.post scoped-diff behavior. */
export function scopedAssignmentDiff(
  existing: string[],
  submitted: string[],
  assignable: string[],
) {
  const previous = new Set(existing),
    allowed = new Set(assignable),
    requested = new Set(submitted.filter((id) => allowed.has(id)));
  const remove = [...previous].filter((id) => allowed.has(id) && !requested.has(id));
  const add = [...requested].filter((id) => !previous.has(id));
  const message =
    add.length && remove.length
      ? 'Store assignment has been updated for the selected user.'
      : add.length
        ? 'Store has been assigned to selected user.'
        : remove.length
          ? 'Store has been deleted for the selected user.'
          : 'No changes were made to store assignment.';
  return { add, remove, message };
}
/** Source: stores/views.py CreateStorageView.post. */
export function storageName(storeName: string, name: string): string {
  return `${storeName.split(' ')[0]}-strg-${name}`.toUpperCase();
}
/** Source counts active and archived counters when allocating C1, C2, ... */
export function counterName(existingCount: number): string {
  return `C${existingCount + 1}`;
}
export const storePublicUrl = (storeId: string) =>
  `https://thesouledstore.com/?store_id=${storeId}`;
export function manageableOperator(
  actor: Principal,
  targetId: string,
  targetRole: Role,
  nextRole: Role = targetRole,
) {
  requireRole(actor, [1, 2, 3]);
  if (actor.id === targetId)
    throw new AppError(
      403,
      'SELF_ADMINISTRATION_DENIED',
      'You cannot change your own administrative profile or store access.',
    );
  if (actor.role === 3 && (![4, 5].includes(targetRole) || ![4, 5].includes(nextRole)))
    throw new AppError(
      403,
      'OPERATOR_ROLE_DENIED',
      'OPM users can manage only SM and Staff accounts.',
    );
  // Security hardening: an administrator cannot promote an account above their own tier.
  if (actor.role !== 1 && (nextRole < actor.role || targetRole < actor.role))
    throw new AppError(
      403,
      'OPERATOR_ROLE_DENIED',
      'This account requires a higher administrative role.',
    );
}
export function stockChangeComment(before: number, after: number): string {
  return after === 0
    ? 'Product inventory reduced to zero from admin panel.'
    : after > before
      ? 'Product inventory added from admin panel.'
      : 'Product inventory reduced from admin panel.';
}
export function visibilityValue(kind: 'available' | 'listed', checked: boolean) {
  return kind === 'available' ? checked : !checked;
}
