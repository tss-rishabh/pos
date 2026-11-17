import { and, eq, gt, isNull } from 'drizzle-orm';
import { operatorSessions } from '../../auth/session-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { contactActorVersion } from '../customer-contacts/authority.js';
import { financialImportHash } from './financial-adapter-crypto.js';

export async function currentCorrectionManager(
  tx: AdministrationTransaction,
  user: Principal,
  sessionId: string,
  secret: string,
) {
  if (user.userType !== 1 || ![1, 2, 3].includes(user.role))
    throw new AppError(
      403,
      'ORDER_IMPORT_CORRECTION_ACCESS_DENIED',
      'Internal manager access is required.',
    );
  const actorVersion = await contactActorVersion(tx, user.id),
    [session] = await tx
      .select({ version: operatorSessions.authVersion })
      .from(operatorSessions)
      .where(
        and(
          eq(operatorSessions.id, sessionId),
          eq(operatorSessions.userId, user.id),
          isNull(operatorSessions.revokedAt),
          gt(operatorSessions.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for('share');
  if (!session || session.version !== actorVersion)
    throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  return {
    actorVersion,
    sessionHash: financialImportHash(secret, 'correction-session', { userId: user.id, sessionId }),
  };
}
