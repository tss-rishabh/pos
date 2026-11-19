import { Temporal } from '@js-temporal/polyfill';
import { eq } from 'drizzle-orm';
import { currentAuthenticationVersion } from '../../auth/revocation.js';
import { PosUser } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';

/** Shared helpers kept for checkout, customer OTP and global vouchers (W4). */
export async function contactActorVersion(tx: AdministrationTransaction, operatorId: string) {
  const [actor] = await tx
    .select({
      id: PosUser.id,
      is_active: PosUser.is_active,
      username: PosUser.username,
      email: PosUser.email,
      password: PosUser.password,
      is_mfa: PosUser.is_mfa,
      mfa_hash: PosUser.mfa_hash,
      phone: PosUser.phone,
      contact_email: PosUser.contact_email,
      otp_method: PosUser.otp_method,
      role: PosUser.role,
      user_type: PosUser.user_type,
      is_staff: PosUser.is_staff,
      is_superuser: PosUser.is_superuser,
    })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(operatorId)))
    .limit(1)
    .for('share');
  if (!actor?.is_active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  return currentAuthenticationVersion(tx, actor);
}
export function contactWallTime(now: number, zone: string) {
  return Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })
    .replace('T', ' ');
}
