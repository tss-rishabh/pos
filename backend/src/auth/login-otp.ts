import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import { pythonIntLiteral } from '../domain/python-compat.js';
import { defineScript, type RedisPort } from '../redis/port.js';
import { authKeys } from './keys.js';

/**
 * Staff login OTP state, ported from legacy users/login_otp.py onto `pos:` keys.
 * Semantics are legacy: a new OTP replaces the old one, the failure window starts at the
 * first failure and is not reset by a resend, one attempt per retry interval is claimed
 * before the code is checked, and the last allowed failure locks the OTP step.
 * The OTP itself is stored as an HMAC (S3), never in plaintext.
 */
export type LoginOtpSettings = Pick<
  Config,
  | 'SESSION_SECRET'
  | 'LOGIN_OTP_EXPIRY'
  | 'LOGIN_OTP_MAX_ATTEMPTS'
  | 'LOGIN_OTP_RETRY_INTERVAL'
  | 'LOGIN_OTP_LOCK_SECONDS'
  | 'LOGIN_OTP_RESEND_COOLDOWN'
>;
/** Legacy `LOCKED_MESSAGE` (users/login_otp.py:35), computed from the configured lock. */
export const lockedMessage = (settings: Pick<Config, 'LOGIN_OTP_LOCK_SECONDS'>) =>
  `Too many wrong OTP attempts. Please try again after ${Math.floor(settings.LOGIN_OTP_LOCK_SECONDS / 3600)} hours.`;
/** Legacy `RETRY_WAIT_MESSAGE` (users/login_otp.py:36). */
export const retryWaitMessage = (settings: Pick<Config, 'LOGIN_OTP_RETRY_INTERVAL'>) =>
  `Please wait ${settings.LOGIN_OTP_RETRY_INTERVAL} seconds before trying again.`;

/** Deletes the key only when it still holds the expected HMAC (single use). */
const consumeScript = defineScript<boolean>({
  name: 'login-otp-consume',
  lua: `local v=redis.call('GET',KEYS[1])
if v and v==ARGV[1] then redis.call('DEL',KEYS[1]) return 1 end
return 0`,
  emulate(store, keys, args) {
    const value = store.get(keys[0]!);
    if (value !== null && value === args[0]) {
      store.del(keys[0]!);
      return 1;
    }
    return 0;
  },
  parse: (reply) => z.union([z.literal(0), z.literal(1)]).parse(reply) === 1,
});

export function loginOtpState(redis: RedisPort, settings: LoginOtpSettings) {
  const key = createHash('sha256')
    .update('pos.login-otp.hmac:')
    .update(settings.SESSION_SECRET)
    .digest();
  /** HMAC-SHA256(server secret, uid + ":" + otp). A plain hash of 10^6 codes is reversible. */
  const digest = (userId: string, code: string) =>
    createHmac('sha256', key).update(`${userId}:${code}`).digest('hex');
  return {
    digest,
    /** legacy store_otp: replaces any previous OTP; the failure count carries over. */
    async store(userId: string, code: string) {
      await redis.set(authKeys.otp(userId), digest(userId, code), {
        EX: settings.LOGIN_OTP_EXPIRY,
      });
    },
    /** legacy has_pending_otp. */
    hasPending: (userId: string) => redis.exists(authKeys.otp(userId)),
    /**
     * legacy check_otp: compares `code.strip()` and consumes the OTP on a match. A miss
     * leaves the OTP in place and does not count a failure (the caller does).
     */
    async check(userId: string, code: string) {
      const trimmed = code.trim();
      if (!code) return false;
      return redis.run(consumeScript, [authKeys.otp(userId)], [digest(userId, trimmed)]);
    },
    isLocked: (userId: string) => redis.exists(authKeys.lock(userId)),
    /** legacy claim_attempt: one attempt per retry interval, claimed before checking. */
    claimAttempt: (userId: string) =>
      redis.set(authKeys.wait(userId), '1', { EX: settings.LOGIN_OTP_RETRY_INTERVAL, NX: true }),
    /** legacy release_attempt: a correct code needs no pause. */
    async releaseAttempt(userId: string) {
      await redis.del([authKeys.wait(userId)]);
    },
    /**
     * legacy record_failure: counts a wrong OTP/TOTP; the last allowed one sets the lock and
     * deletes the OTP and the counter. Returns attempts left (0 = now locked) and the count.
     */
    async recordFailure(userId: string) {
      const [, count] = await redis.multi([
        {
          command: 'SET',
          key: authKeys.failures(userId),
          value: '0',
          options: { EX: settings.LOGIN_OTP_LOCK_SECONDS, NX: true },
        },
        { command: 'INCR', key: authKeys.failures(userId) },
      ]);
      const failures = z.number().int().positive().parse(count);
      if (failures >= settings.LOGIN_OTP_MAX_ATTEMPTS) {
        await redis.multi([
          {
            command: 'SET',
            key: authKeys.lock(userId),
            value: '1',
            options: { EX: settings.LOGIN_OTP_LOCK_SECONDS },
          },
          { command: 'DEL', keys: [authKeys.otp(userId), authKeys.failures(userId)] },
        ]);
        return { attemptsLeft: 0, failures };
      }
      return { attemptsLeft: settings.LOGIN_OTP_MAX_ATTEMPTS - failures, failures };
    },
    /** legacy reset_failures. */
    async resetFailures(userId: string) {
      await redis.del([authKeys.failures(userId)]);
    },
    /** legacy claim_resend_slot. */
    claimResendSlot: (userId: string) =>
      redis.set(authKeys.resend(userId), '1', {
        EX: settings.LOGIN_OTP_RESEND_COOLDOWN,
        NX: true,
      }),
  };
}
export type LoginOtpState = ReturnType<typeof loginOtpState>;

/** Python `int(value)` for the ASCII forms legacy settings accept (sign, `_` separators). */
function pythonInt(name: string, value: string): number {
  const literal = pythonIntLiteral(value);
  if (literal === null) throw new Error(`${name} must be an integer, as legacy int() requires.`);
  return Number(literal);
}
/**
 * Fixed OTP settings parsed exactly as legacy POSAdmin/settings.py:494-496:
 * `int(env or 0)`, `env.strip()`, and the comma list keeping entries whose `strip()` is
 * all digits (spaces tolerated, other entries dropped). Unicode digits, which Python's
 * `isdigit()` accepts, are dropped here.
 */
export function fixedOtpSettings(env: NodeJS.ProcessEnv = process.env) {
  const enabledRaw = env.LOGIN_FIXED_OTP_ENABLED;
  const enabled = enabledRaw === undefined ? 0 : pythonInt('LOGIN_FIXED_OTP_ENABLED', enabledRaw);
  const otp = (env.LOGIN_FIXED_OTP ?? '').trim();
  const userIds = new Set(
    (env.LOGIN_FIXED_OTP_USER_IDS ?? '')
      .split(',')
      .filter((entry) => /^\d+$/.test(entry.trim()))
      .map((entry) => BigInt(entry.trim()).toString()),
  );
  return {
    enabled: enabled !== 0,
    otp,
    userIds,
    /** legacy `LOGIN_FIXED_OTP_ENABLED and LOGIN_FIXED_OTP and user_id in LOGIN_FIXED_OTP_USER_IDS`. */
    appliesTo(userId: string) {
      return enabled !== 0 && otp !== '' && userIds.has(BigInt(userId).toString());
    },
  };
}
export type FixedOtpSettings = ReturnType<typeof fixedOtpSettings>;
