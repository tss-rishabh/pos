import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Databases } from '../db/pools.js';
import { PosUser } from '../db/legacy-schema.js';
import {
  authenticationVersion,
  currentAuthenticationVersion,
  operatorAuthEpochs,
} from './revocation.js';
import { operatorSessions as sessions } from './session-schema.js';
import { AppError } from '../domain/errors.js';

export interface SessionCredential {
  sessionId: string;
  secret: string;
  expires: number;
}
export type SessionTransaction = Parameters<
  Parameters<ReturnType<Databases['get']>['transaction']>[0]
>[0];
export interface SessionService {
  create(
    userId: string,
    expiresAt?: number,
    expectedAuthVersion?: string,
    recordLoginAt?: string,
  ): Promise<SessionCredential>;
  createInTransaction?(
    transaction: SessionTransaction,
    userId: string,
    expiresAt?: number,
    expectedAuthVersion?: string,
    recordLoginAt?: string,
  ): Promise<SessionCredential>;
  valid(
    userId: string,
    credential: SessionCredential,
    transaction?: SessionTransaction,
  ): Promise<boolean>;
  revoke(sessionId: string): Promise<void>;
}
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
export async function pruneExpiredSessions(db: Databases, before: Date, limit = 500) {
  return db.get('writer').delete(sessions).where(lt(sessions.expiresAt, before)).limit(limit);
}
function newCredential(expiresAt = Date.now() + 8 * 3600000): SessionCredential {
  return {
    sessionId: randomUUID(),
    secret: randomBytes(32).toString('base64url'),
    expires: expiresAt,
  };
}
export function mysqlSessions(db: Databases): SessionService {
  async function create(
    transaction: SessionTransaction,
    userId: string,
    expiresAt?: number,
    expectedAuthVersion?: string,
    recordLoginAt?: string,
  ): Promise<SessionCredential> {
    const [account] = await transaction
      .select()
      .from(PosUser)
      .where(and(eq(PosUser.id, BigInt(userId)), eq(PosUser.is_active, true)))
      .limit(1)
      .for(recordLoginAt ? 'update' : 'share');
    if (!account)
      throw new AppError(401, 'ACCOUNT_DISABLED', 'Your account is no longer available.');
    const version = await currentAuthenticationVersion(transaction, account);
    if (expectedAuthVersion !== undefined && version !== expectedAuthVersion)
      throw new AppError(
        401,
        'LOGIN_CHALLENGE_EXPIRED',
        'Your credentials changed. Sign in with your password again.',
      );
    const credential = newCredential(expiresAt);
    await transaction.insert(sessions).values({
      id: credential.sessionId,
      userId,
      secretHash: digest(credential.secret),
      authVersion: version,
      expiresAt: new Date(credential.expires),
    });
    if (recordLoginAt)
      await transaction
        .update(PosUser)
        .set({ last_login: recordLoginAt })
        .where(eq(PosUser.id, account.id));
    return credential;
  }
  return {
    async create(userId, expiresAt, expectedAuthVersion, recordLoginAt) {
      return db
        .get('writer')
        .transaction((transaction) =>
          create(transaction, userId, expiresAt, expectedAuthVersion, recordLoginAt),
        );
    },
    createInTransaction: create,
    async valid(userId, credential, transaction) {
      if (credential.expires <= Date.now()) return false;
      const query = (transaction ?? db.get('writer'))
        .select({
          hash: sessions.secretHash,
          version: sessions.authVersion,
          account: PosUser,
          epoch: operatorAuthEpochs.epoch,
        })
        .from(sessions)
        .innerJoin(PosUser, eq(PosUser.id, BigInt(userId)))
        .leftJoin(operatorAuthEpochs, eq(operatorAuthEpochs.userId, sessions.userId))
        .where(
          and(
            eq(sessions.id, credential.sessionId),
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date()),
            eq(PosUser.is_active, true),
          ),
        )
        .limit(1);
      const [row] = transaction ? await query.for('share') : await query;
      return Boolean(
        row &&
        row.version === authenticationVersion(row.account, row.epoch ?? 0n) &&
        timingSafeEqual(
          Buffer.from(row.hash, 'hex'),
          Buffer.from(digest(credential.secret), 'hex'),
        ),
      );
    },
    async revoke(id) {
      await db
        .get('writer')
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, id));
    },
  };
}
export function memorySessions(): SessionService {
  const records = new Map<string, { userId: string; hash: string; expires: number }>();
  return {
    async create(userId, expiresAt) {
      const credential = newCredential(expiresAt);
      records.set(credential.sessionId, {
        userId,
        hash: digest(credential.secret),
        expires: credential.expires,
      });
      return credential;
    },
    async valid(userId, credential) {
      const row = records.get(credential.sessionId);
      return Boolean(
        row &&
        row.userId === userId &&
        row.expires > Date.now() &&
        credential.expires > Date.now() &&
        timingSafeEqual(
          Buffer.from(row.hash, 'hex'),
          Buffer.from(digest(credential.secret), 'hex'),
        ),
      );
    },
    async revoke(id) {
      records.delete(id);
    },
  };
}
