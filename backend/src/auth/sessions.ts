import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Databases } from '../db/pools.js';
import { PosUser } from '../db/legacy-schema.js';
import { AppError } from '../domain/errors.js';
import { identifier } from '../domain/validation.js';
import type { RedisPort } from '../redis/port.js';
import { authKeys } from './keys.js';

/**
 * Staff sessions in Redis (`pos:session:{sessionId}`), replacing the legacy
 * `django_session` row and the rewrite's `pos_rewrite_sessions` table.
 *
 * Lifetime is legacy: the session ends at 23:59:59 business-local time on the login day
 * (`set_expiry(time_until_end_of_day() - 1)`, users/views.py:240-241). Validity is legacy:
 * every request re-reads `pos_user` on the writer and requires `is_active` and an unchanged
 * password hash (Django's `_auth_user_hash`). Nothing else revokes a session (S5).
 */
export interface SessionCredential {
  sessionId: string;
  secret: string;
  expires: number;
}
export type SessionTransaction = Parameters<
  Parameters<ReturnType<Databases['get']>['transaction']>[0]
>[0];
export type SessionAccount = typeof PosUser.$inferSelect;
export interface SessionService {
  /** Creates a session for an active user. `expiresAt` defaults to the end of the business day. */
  create(userId: string, expiresAt?: number): Promise<SessionCredential>;
  /** The current account when the credential is a live session of this user, else null. */
  resolve(
    userId: string,
    credential: SessionCredential,
    transaction?: SessionTransaction,
  ): Promise<SessionAccount | null>;
  valid(
    userId: string,
    credential: SessionCredential,
    transaction?: SessionTransaction,
  ): Promise<boolean>;
  /** legacy update_session_auth_hash: the session that changed the password stays signed in. */
  refreshPasswordHash(sessionId: string, password: string): Promise<void>;
  revoke(sessionId: string): Promise<void>;
  /**
   * Liveness of a session known only by id (no cookie secret), for grants that must end
   * with the POS session that created them: present, same user, active, password unchanged.
   */
  alive(sessionId: string, userId: string, transaction?: SessionTransaction): Promise<boolean>;
}
const stored = z
  .object({
    userId: identifier,
    secretHash: z.string().regex(/^[a-f0-9]{64}$/),
    authHash: z.string().regex(/^[a-f0-9]{64}$/),
    expirySeconds: z.number().int().positive(),
    createdAt: z.number().int().positive(),
  })
  .strict();
type StoredSession = z.infer<typeof stored>;
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
const sameHex = (one: string, two: string) => {
  const a = Buffer.from(one, 'hex'),
    b = Buffer.from(two, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
/** Seconds to 23:59:59 business-local today: legacy `time_until_end_of_day() - 1`. */
export function endOfDaySeconds(timeZone: string, now: number = Date.now()): number {
  const local = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone);
  const untilMidnight =
    (24 - local.hour - 1) * 3600 + (60 - local.minute - 1) * 60 + (60 - local.second);
  // Legacy set_expiry(0) at 23:59:59 would make a browser-session cookie; keep one second.
  return Math.max(1, untilMidnight - 1);
}
/** Reads the active account on the writer (FOR SHARE inside a caller transaction). */
export type ActiveAccountReader = (
  userId: string,
  transaction?: SessionTransaction,
) => Promise<SessionAccount | undefined>;
export function activeAccountReader(db: Databases): ActiveAccountReader {
  return async (userId, transaction) => {
    const query = (transaction ?? db.get('writer'))
      .select()
      .from(PosUser)
      .where(and(eq(PosUser.id, BigInt(userId)), eq(PosUser.is_active, true)))
      .limit(1);
    const [row] = transaction ? await query.for('share') : await query;
    return row;
  };
}
export function redisSessions(
  config: Pick<Config, 'SESSION_SECRET' | 'BUSINESS_TIMEZONE'>,
  account: ActiveAccountReader,
  redis: RedisPort,
  now: () => number = Date.now,
): SessionService & {
  /** Django `get_session_auth_hash` analogue: HMAC of the stored password hash. */
  authHash(password: string): string;
} {
  const authKey = createHash('sha256')
    .update('pos.session-auth-hash:')
    .update(config.SESSION_SECRET)
    .digest();
  const authHash = (password: string) =>
    createHmac('sha256', authKey).update(password).digest('hex');
  async function read(sessionId: string): Promise<StoredSession | null> {
    const raw = await redis.get(authKeys.session(sessionId));
    if (!raw) return null;
    try {
      return stored.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  async function resolve(
    userId: string,
    credential: SessionCredential,
    transaction?: SessionTransaction,
  ) {
    if (credential.expires <= now()) return null;
    const session = await read(credential.sessionId);
    if (
      !session ||
      session.userId !== userId ||
      !sameHex(session.secretHash, digest(credential.secret))
    )
      return null;
    const row = await account(userId, transaction);
    if (!row || !sameHex(session.authHash, authHash(row.password))) return null;
    return row;
  }
  return {
    authHash,
    async create(userId, expiresAt) {
      const row = await account(userId);
      if (!row) throw new AppError(401, 'ACCOUNT_INACTIVE', 'This account is no longer active.');
      const expirySeconds =
        expiresAt === undefined
          ? endOfDaySeconds(config.BUSINESS_TIMEZONE, now())
          : Math.max(1, Math.floor((expiresAt - now()) / 1000));
      const credential: SessionCredential = {
        sessionId: randomUUID(),
        secret: randomBytes(32).toString('base64url'),
        expires: now() + expirySeconds * 1000,
      };
      const value: StoredSession = {
        userId,
        secretHash: digest(credential.secret),
        authHash: authHash(row.password),
        expirySeconds,
        createdAt: Math.floor(now() / 1000),
      };
      if (
        !(await redis.set(authKeys.session(credential.sessionId), JSON.stringify(value), {
          EX: expirySeconds,
          NX: true,
        }))
      )
        throw new AppError(503, 'AUTH_STORE_UNAVAILABLE', 'Sign-in is temporarily unavailable.');
      return credential;
    },
    resolve,
    async valid(userId, credential, transaction) {
      return (await resolve(userId, credential, transaction)) !== null;
    },
    async refreshPasswordHash(sessionId, password) {
      const session = await read(sessionId);
      if (!session) return;
      await redis.set(
        authKeys.session(sessionId),
        JSON.stringify({ ...session, authHash: authHash(password) }),
        { XX: true, KEEPTTL: true },
      );
    },
    async alive(sessionId, userId, transaction) {
      const session = await read(sessionId);
      if (!session || session.userId !== userId) return false;
      const row = await account(userId, transaction);
      return Boolean(row && sameHex(session.authHash, authHash(row.password)));
    },
    async revoke(sessionId) {
      await redis.del([authKeys.session(sessionId)]);
    },
  };
}
export type RedisSessionService = ReturnType<typeof redisSessions>;
