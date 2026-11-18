import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { identifier } from '../domain/validation.js';
import { defineScript, type RedisPort } from '../redis/port.js';
import { authKeys } from './keys.js';

/**
 * The password step → OTP step binding (legacy anonymous-session keys `pending_mfa_uid`,
 * `pending_mfa_at`, `pending_mfa_otp_sent`, users/login_otp.py:29-96). The browser holds a
 * sealed cookie with `{id, secret, expires}`; Redis holds the user and a hash of the secret
 * for LOGIN_MFA_PENDING_TTL seconds from the password step, never refreshed.
 */
export interface PendingLogin {
  id: string;
  secret: string;
  expires: number;
}
const stored = z
  .object({
    userId: identifier,
    proofHash: z.string().regex(/^[a-f0-9]{64}$/),
    startedAt: z.number().int().positive(),
  })
  .strict();
const proofHash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const sameHex = (one: string, two: string) => {
  const a = Buffer.from(one, 'hex'),
    b = Buffer.from(two, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
/** Sets the flag and returns its previous value; -1 when the pending login is gone. */
const markSentScript = defineScript<number>({
  name: 'login-pending-mark-sent',
  lua: `local v=redis.call('GET',KEYS[1])
if not v then return -1 end
redis.call('SET',KEYS[1],'1','KEEPTTL')
return tonumber(v)`,
  emulate(store, keys) {
    const value = store.get(keys[0]!);
    if (value === null) return -1;
    store.set(keys[0]!, '1', 'keep');
    return Number(value);
  },
  parse: (reply) => z.union([z.literal(-1), z.literal(0), z.literal(1)]).parse(reply),
});
export function pendingLogins(redis: RedisPort, ttlSeconds: number, now: () => number = Date.now) {
  return {
    /** legacy set_pending_user: a new password step starts with otp_sent cleared. */
    async begin(userId: string): Promise<PendingLogin> {
      const credential: PendingLogin = {
        id: randomUUID(),
        secret: randomBytes(32).toString('base64url'),
        expires: now() + ttlSeconds * 1000,
      };
      const value = JSON.stringify({
        userId,
        proofHash: proofHash(credential.secret),
        startedAt: Math.floor(now() / 1000),
      });
      await redis.multi([
        {
          command: 'SET',
          key: authKeys.pending(credential.id),
          value,
          options: { EX: ttlSeconds, NX: true },
        },
        {
          command: 'SET',
          key: authKeys.pendingSent(credential.id),
          value: '0',
          options: { EX: ttlSeconds, NX: true },
        },
      ]);
      return credential;
    },
    /** legacy get_pending_user_id: the user id, or null when absent or expired. */
    async userId(credential: PendingLogin): Promise<string | null> {
      if (credential.expires <= now()) return null;
      const raw = await redis.get(authKeys.pending(credential.id));
      if (!raw) return null;
      let parsed;
      try {
        parsed = stored.parse(JSON.parse(raw));
      } catch {
        return null;
      }
      if (!sameHex(parsed.proofHash, proofHash(credential.secret))) return null;
      if (now() / 1000 - parsed.startedAt > ttlSeconds) return null;
      return parsed.userId;
    },
    /** legacy mark_otp_sent: true when an OTP had already gone out (this send is a resend). */
    async markOtpSent(credential: PendingLogin): Promise<boolean> {
      return (await redis.run(markSentScript, [authKeys.pendingSent(credential.id)], [])) === 1;
    },
    /** legacy clear_pending_user. Only the holder of the secret can discard it. */
    async discard(credential: PendingLogin) {
      const raw = await redis.get(authKeys.pending(credential.id));
      if (raw) {
        let value: unknown = null;
        try {
          value = JSON.parse(raw);
        } catch {
          /* A malformed record is discarded below. */
        }
        const parsed = stored.safeParse(value);
        if (parsed.success && !sameHex(parsed.data.proofHash, proofHash(credential.secret))) return;
      }
      await redis.del([authKeys.pending(credential.id), authKeys.pendingSent(credential.id)]);
    },
  };
}
export type PendingLogins = ReturnType<typeof pendingLogins>;
