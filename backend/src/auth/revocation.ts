import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { identifier } from '../domain/validation.js';
import { bigint, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import type { Databases } from '../db/pools.js';
import { credentialVersion } from './crypto.js';
import { operatorSessions } from './session-schema.js';
import { loginChallenges, loginSecurity } from './mfa-schema.js';
import { operatorMfaEnrollments } from '../modules/administration/mfa-schema.js';

export const operatorAuthEpochs = mysqlTable('pos_rewrite_operator_auth_epochs', {
  userId: varchar('operator_id', { length: 32 }).primaryKey(),
  epoch: bigint('epoch', { mode: 'bigint', unsigned: true }).notNull().default(0n),
});
type Database = ReturnType<Databases['get']>;
export type AuthenticationTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Reader = Pick<Database, 'select'>;
type Account = Parameters<typeof credentialVersion>[0] & { id: bigint };
export function authenticationVersion(account: Account, epoch: bigint = 0n): string {
  return createHash('sha256')
    .update(credentialVersion(account))
    .update(':')
    .update(String(epoch))
    .digest('hex');
}
export async function currentAuthenticationVersion(
  reader: Reader,
  account: Account,
): Promise<string> {
  const [row] = await reader
    .select({ epoch: operatorAuthEpochs.epoch })
    .from(operatorAuthEpochs)
    .where(eq(operatorAuthEpochs.userId, String(account.id)))
    .limit(1);
  return authenticationVersion(account, row?.epoch ?? 0n);
}
/** Caller holds the operator row lock. Keep this in the credential mutation TX. */
export async function invalidateOperatorAuthentication(
  tx: AuthenticationTransaction,
  userId: string,
): Promise<void> {
  return invalidateOperatorAuthenticationBatch(tx, [userId]);
}
/** At most500 already-locked operators, five bounded SQL statements per batch. */
export async function invalidateOperatorAuthenticationBatch(
  tx: AuthenticationTransaction,
  userIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(z.array(identifier).max(500).parse(userIds))].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : a === b ? 0 : 1,
  );
  if (!ids.length) return;
  await tx
    .insert(operatorAuthEpochs)
    .values(ids.map((userId) => ({ userId, epoch: 1n })))
    .onDuplicateKeyUpdate({ set: { epoch: sql`${operatorAuthEpochs.epoch}+1` } });
  await tx
    .update(operatorSessions)
    .set({ revokedAt: new Date() })
    .where(and(inArray(operatorSessions.userId, ids), isNull(operatorSessions.revokedAt)));
  await tx.delete(loginChallenges).where(inArray(loginChallenges.userId, ids));
  // Preserve failed attempts, resend cooldown and account lockout budgets.
  await tx
    .update(loginSecurity)
    .set({ otpHash: null, otpExpiresAt: null })
    .where(inArray(loginSecurity.userId, ids));
  await tx
    .update(operatorMfaEnrollments)
    .set({ state: 'CANCELLED' })
    .where(
      and(
        eq(operatorMfaEnrollments.state, 'PENDING'),
        or(
          inArray(operatorMfaEnrollments.operatorId, ids),
          inArray(operatorMfaEnrollments.actorId, ids),
        ),
      ),
    );
}
