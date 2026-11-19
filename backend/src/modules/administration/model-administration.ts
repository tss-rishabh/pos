import { eq } from 'drizzle-orm';
import { PosUser } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from './checkins.js';

export type ModelAdministrator = typeof PosUser.$inferSelect;

/**
 * Model administration (legacy Django admin `UserAdmin`, `users/admin.py:20`) without the
 * groups/permissions feature, which was deleted (AGENTS.md, Administration, 19 Nov 2026): there
 * are no production tables for auth groups or grants. Django grants every model permission to an
 * active staff superuser, and those are the only grants the rewrite can still prove, so model
 * administration requires a current active internal role-1 staff superuser, rechecked on the writer.
 */
export async function assertModelAdministrator(
  tx: AdministrationTransaction,
  user: Principal,
): Promise<ModelAdministrator> {
  const [account] = await tx
    .select()
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(user.id)))
    .limit(1)
    .for('share');
  if (!account?.is_active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  if (account.role !== 1 || account.user_type !== 1 || !account.is_staff || !account.is_superuser)
    throw new AppError(
      403,
      'MODEL_ADMINISTRATION_DENIED',
      'This action requires current internal model administration access.',
    );
  return account;
}
