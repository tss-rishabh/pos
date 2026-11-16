import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { verifyTotp } from './totp.js';
import type { Config } from '../config.js';
import type { Databases } from '../db/pools.js';
import { PosUser, Store } from '../db/legacy-schema.js';
import { AppError } from '../domain/errors.js';
import type { Principal } from '../domain/access.js';
import type { IdentityService, PasswordIdentity } from './identity.js';
import type { OtpDelivery } from './delivery.js';
import { loginChallenges, loginSecurity } from './mfa-schema.js';
import { retryTransaction } from '../db/retry.js';
import { currentAuthenticationVersion } from './revocation.js';
import { securityAlerts } from './security-schema.js';
import { currentRequestTrace } from '../observability/context.js';

type Transaction = Parameters<Parameters<ReturnType<Databases['get']>['transaction']>[0]>[0];
export interface PendingLogin {
  id: string;
  secret: string;
  expires: number;
}
export interface LoginChallengeDto {
  authentication: 'challenge';
  method: 'otp' | 'totp';
  expiresAt: number;
  stores: { id: string; name: string }[];
  delivery: 'not-needed' | 'submitted' | 'existing' | 'uncertain';
}
interface Options {
  now?: () => number;
  setCheckIn: (user: Principal, storeId: string, transaction: Transaction) => Promise<unknown>;
}
const proofHash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => {
  const one = Buffer.from(a, 'hex'),
    two = Buffer.from(b, 'hex');
  return one.length === two.length && timingSafeEqual(one, two);
};
export function loginChallengeService(
  config: Config,
  db: Databases,
  identity: IdentityService,
  delivery: OtpDelivery,
  options: Options,
) {
  const now = options.now || Date.now;
  const hashOtp = (userId: string, code: string) =>
    createHmac('sha256', config.SESSION_SECRET).update(`${userId}\0${code}`).digest('hex');
  async function pending(credential: PendingLogin, transaction?: Transaction) {
    const database = transaction || db.get('writer');
    const query = database
      .select()
      .from(loginChallenges)
      .where(and(eq(loginChallenges.id, credential.id), isNull(loginChallenges.completedAt)))
      .limit(1);
    const [row] = transaction ? await query.for('update') : await query;
    if (
      !row ||
      row.expiresAt.getTime() <= now() ||
      credential.expires <= now() ||
      !equal(row.proofHash, proofHash(credential.secret))
    )
      throw new AppError(401, 'LOGIN_CHALLENGE_EXPIRED', 'Sign in with your password again.');
    return row;
  }
  async function security(transaction: Transaction, userId: string) {
    await transaction
      .insert(loginSecurity)
      .values({ userId })
      .onDuplicateKeyUpdate({ set: { userId } });
    const [state] = await transaction
      .select()
      .from(loginSecurity)
      .where(eq(loginSecurity.userId, userId))
      .for('update');
    return state!;
  }
  async function currentAccount(
    challenge: typeof loginChallenges.$inferSelect,
    account: PasswordIdentity,
    transaction?: Transaction,
  ) {
    if (challenge.authVersion !== account.authVersion)
      throw new AppError(
        401,
        'LOGIN_CHALLENGE_EXPIRED',
        'Your credentials changed. Sign in with your password again.',
      );
    if (transaction) {
      const [current] = await transaction
        .select()
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(account.user.id)))
        .limit(1)
        .for('share');
      if (
        !current?.is_active ||
        (await currentAuthenticationVersion(transaction, current)) !== challenge.authVersion
      )
        throw new AppError(
          401,
          'LOGIN_CHALLENGE_EXPIRED',
          'Your credentials changed. Sign in with your password again.',
        );
    }
  }
  function locked(until: Date | null) {
    if (until && until.getTime() > now())
      throw new AppError(
        429,
        'LOGIN_LOCKED',
        `Too many wrong OTP attempts. Please try again after ${config.LOGIN_OTP_LOCK_SECONDS / 3600} hours.`,
      );
  }
  async function choices(account: PasswordIdentity) {
    if (account.user.role !== 1 && !account.user.storeIds.length) return [];
    const rows = await db
      .get('primary')
      .select({ id: Store.id, name: Store.store_name })
      .from(Store)
      .where(
        and(
          eq(Store.is_active, true),
          inArray(Store.type, ['STORE', 'CORE_WAREHOUSE']),
          account.user.role === 1
            ? undefined
            : inArray(Store.id, account.user.storeIds.map(BigInt)),
        ),
      )
      .orderBy(asc(Store.store_name));
    return rows.map((row) => ({ id: String(row.id), name: row.name || String(row.id) }));
  }
  async function send(credential: PendingLogin, account: PasswordIdentity, initial: boolean) {
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const result = await retryTransaction(() =>
      db.get('writer').transaction(async (transaction) => {
        const challenge = await pending(credential, transaction);
        await currentAccount(challenge, account, transaction);
        const state = await security(transaction, account.user.id);
        locked(state.lockedUntil);
        const cooldown =
          state.lastSentAt !== null &&
          state.lastSentAt.getTime() + config.LOGIN_OTP_RESEND_COOLDOWN * 1000 > now();
        const existing =
          state.otpHash !== null &&
          state.otpExpiresAt !== null &&
          state.otpExpiresAt.getTime() > now();
        if (cooldown && (!initial || existing)) {
          if (initial && existing) return { send: false, resend: false };
          throw new AppError(
            429,
            'LOGIN_RESEND_WAIT',
            'Please wait a few seconds before requesting another OTP.',
          );
        }
        const resend = challenge.sentCount > 0;
        delivery.assertReady(account, resend);
        await transaction
          .update(loginSecurity)
          .set({
            otpHash: hashOtp(account.user.id, code),
            otpExpiresAt: new Date(now() + config.LOGIN_OTP_EXPIRY * 1000),
            lastSentAt: new Date(now()),
          })
          .where(eq(loginSecurity.userId, account.user.id));
        await transaction
          .update(loginChallenges)
          .set({ sentCount: challenge.sentCount + 1 })
          .where(eq(loginChallenges.id, credential.id));
        return { send: true, resend };
      }),
    );
    if (!result.send) return 'existing' as const;
    try {
      await delivery.send(account, code, result.resend);
      return 'submitted' as const;
    } catch (error) {
      if (error instanceof AppError && error.code === 'OTP_DELIVERY_UNCERTAIN')
        return 'uncertain' as const;
      throw error;
    }
  }
  async function describe(
    credential: PendingLogin,
    deliveryStatus: LoginChallengeDto['delivery'] = 'existing',
    identify?: (userId: string) => void,
  ) {
    const challenge = await pending(credential),
      account = await identity.challengeIdentity(challenge.userId);
    if (!account)
      throw new AppError(401, 'LOGIN_CHALLENGE_EXPIRED', 'Your account is no longer available.');
    await currentAccount(challenge, account);
    identify?.(account.user.id);
    return {
      authentication: 'challenge' as const,
      method: account.useTotp ? ('totp' as const) : ('otp' as const),
      expiresAt: challenge.expiresAt.getTime(),
      stores: await choices(account),
      delivery: deliveryStatus,
    };
  }
  return {
    describe,
    async discard(credential: PendingLogin) {
      await db
        .get('writer')
        .delete(loginChallenges)
        .where(
          and(
            eq(loginChallenges.id, credential.id),
            eq(loginChallenges.proofHash, proofHash(credential.secret)),
          ),
        );
    },
    async begin(account: PasswordIdentity) {
      const credential: PendingLogin = {
        id: randomUUID(),
        secret: randomBytes(32).toString('base64url'),
        expires: now() + config.LOGIN_MFA_PENDING_TTL * 1000,
      };
      await db
        .get('writer')
        .insert(loginChallenges)
        .values({
          id: credential.id,
          userId: account.user.id,
          proofHash: proofHash(credential.secret),
          authVersion: account.authVersion,
          expiresAt: new Date(credential.expires),
        });
      const status = account.useTotp ? 'not-needed' : await send(credential, account, true);
      return { credential, view: await describe(credential, status) };
    },
    async resend(credential: PendingLogin, identify?: (userId: string) => void) {
      const row = await pending(credential),
        account = await identity.challengeIdentity(row.userId);
      if (!account) throw new AppError(401, 'LOGIN_CHALLENGE_EXPIRED', 'Sign in again.');
      await currentAccount(row, account);
      identify?.(account.user.id);
      const status = await send(credential, account, false);
      return describe(credential, status);
    },
    async verify(
      credential: PendingLogin,
      code: string,
      platform: 'otp' | 'totp',
      storeId: string,
      identify?: (userId: string) => void,
    ) {
      const row = await pending(credential),
        account = await identity.challengeIdentity(row.userId);
      if (!account) throw new AppError(401, 'LOGIN_CHALLENGE_EXPIRED', 'Sign in again.');
      await currentAccount(row, account);
      identify?.(account.user.id);
      if (platform === 'totp' && !account.useTotp)
        throw new AppError(400, 'INVALID_LOGIN_FACTOR', 'Use the delivered login OTP.');
      const result = await retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          const challenge = await pending(credential, transaction);
          await currentAccount(challenge, account, transaction);
          const state = await security(transaction, account.user.id);
          locked(state.lockedUntil);
          if (
            state.lastAttemptAt &&
            state.lastAttemptAt.getTime() + config.LOGIN_OTP_RETRY_INTERVAL * 1000 > now()
          )
            throw new AppError(
              429,
              'LOGIN_RETRY_WAIT',
              `Please wait ${config.LOGIN_OTP_RETRY_INTERVAL} seconds before trying again.`,
            );
          await transaction
            .update(loginSecurity)
            .set({ lastAttemptAt: new Date(now()) })
            .where(eq(loginSecurity.userId, account.user.id));
          let valid = false;
          if (platform === 'totp' && account.useTotp && account.totpSecret) {
            valid = verifyTotp(account.totpSecret, code, now());
          } else if (platform === 'otp')
            valid = Boolean(
              state.otpHash &&
              state.otpExpiresAt &&
              state.otpExpiresAt.getTime() > now() &&
              equal(state.otpHash, hashOtp(account.user.id, code)),
            );
          if (!valid) {
            const failures =
              (state.failureWindowUntil && state.failureWindowUntil.getTime() > now()
                ? state.failedCount
                : 0) + 1;
            const lock = failures >= config.LOGIN_OTP_MAX_ATTEMPTS;
            await transaction
              .update(loginSecurity)
              .set({
                failedCount: lock ? 0 : failures,
                failureWindowUntil: lock
                  ? null
                  : state.failureWindowUntil && state.failureWindowUntil.getTime() > now()
                    ? state.failureWindowUntil
                    : new Date(now() + config.LOGIN_OTP_LOCK_SECONDS * 1000),
                ...(lock
                  ? {
                      lockedUntil: new Date(now() + config.LOGIN_OTP_LOCK_SECONDS * 1000),
                      otpHash: null,
                      otpExpiresAt: null,
                      alertPending: true,
                    }
                  : {}),
              })
              .where(eq(loginSecurity.userId, account.user.id));
            if (lock)
              await transaction.insert(securityAlerts).values({
                id: randomUUID(),
                userId: account.user.id,
                requestId: currentRequestTrace()?.requestId || null,
                factor: platform,
                failedAttempts: failures,
                lockedUntil: new Date(now() + config.LOGIN_OTP_LOCK_SECONDS * 1000),
                createdAt: new Date(now()),
                state: 'pending',
                attempts: 0,
                availableAt: new Date(now()),
              });
            return {
              success: false as const,
              status: lock ? 429 : 401,
              code: lock ? 'LOGIN_LOCKED' : 'OTP_INVALID',
              message: lock
                ? 'Too many wrong OTP attempts. Try again after the lockout period.'
                : `Wrong OTP. ${config.LOGIN_OTP_MAX_ATTEMPTS - failures} attempts left.`,
            };
          }
          await transaction
            .update(loginSecurity)
            .set({
              lastAttemptAt: null,
              ...(platform === 'otp' ? { otpHash: null, otpExpiresAt: null } : {}),
            })
            .where(eq(loginSecurity.userId, account.user.id));
          try {
            await options.setCheckIn(account.user, storeId, transaction);
          } catch (error) {
            if (error instanceof AppError && [403, 409].includes(error.status))
              return {
                success: false as const,
                status: error.status,
                code: error.code,
                message: error.message,
              };
            throw error;
          }
          await transaction
            .update(loginSecurity)
            .set({ failedCount: 0, failureWindowUntil: null })
            .where(eq(loginSecurity.userId, account.user.id));
          await transaction
            .update(loginChallenges)
            .set({ completedAt: new Date(now()) })
            .where(eq(loginChallenges.id, credential.id));
          return { success: true as const, user: account.user, authVersion: account.authVersion };
        }),
      );
      if (!result.success) throw new AppError(result.status, result.code, result.message);
      return { user: result.user, authVersion: result.authVersion };
    },
  };
}
export type LoginChallengeService = ReturnType<typeof loginChallengeService>;
