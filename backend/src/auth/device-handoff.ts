import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { z } from 'zod';
import type { Config } from '../config.js';
import { PosUser } from '../db/legacy-schema.js';
import type { Databases } from '../db/pools.js';
import type { Principal } from '../domain/access.js';
import { AppError } from '../domain/errors.js';
import { qrDataUrl } from '../domain/qr.js';
import { verifyDjangoPassword } from './crypto.js';
import { currentAuthenticationVersion } from './revocation.js';
import type { DeviceHandoffStore } from './device-handoff-store.js';

const optional = (value: unknown) => (value === '' ? undefined : value);
export function deviceHandoffOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      POS_DEVICE_HANDOFF_REDIS_URL: z.preprocess(optional, z.url().optional()),
      UPSTREAM_POS_DEVICE_HANDOFF_CONTRACT: z.preprocess(
        optional,
        z.literal('pos-auth-qr-v1').optional(),
      ),
      POS_DEVICE_HANDOFF_SERVICE_KEY: z.preprocess(
        optional,
        z
          .string()
          .regex(/^[\x21-\x7e]{32,4096}$/)
          .optional(),
      ),
      POS_AUTH_QR_EXP_SEC: z.coerce.number().int().min(30).max(300).default(60),
      POS_AUTH_USER_SECRET_EXP: z.coerce.number().int().min(300).max(3600).default(1800),
      MPOS_QR_TAKE_PASSWORD: z.preprocess(
        (value) =>
          value === undefined || value === '0' || value === 'false'
            ? false
            : value === '1' || value === 'true'
              ? true
              : value,
        z.boolean(),
      ),
    })
    .refine((value) => value.POS_AUTH_USER_SECRET_EXP >= value.POS_AUTH_QR_EXP_SEC)
    .parse(env);
}
export type DeviceHandoffOptions = ReturnType<typeof deviceHandoffOptions>;
export const deviceHandoffVerification = z
  .object({
    email: z.email().max(254),
    code: z.string().regex(/^\d{6}$/),
    password: z.string().max(1024).optional(),
  })
  .strict();
export const deviceHandoffRevision = z
  .object({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const freshSecret = () => Secret.fromHex(randomBytes(20).toString('hex')).base32;
const sameCode = (actual: string, expected: string) =>
  Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
  timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
export function handoffTotp(secret: string, period: number, timestamp: number): string {
  return new TOTP({
    secret: Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period,
  }).generate({ timestamp });
}
export function deviceHandoffService(
  config: Config,
  db: Databases,
  options: DeviceHandoffOptions,
  store: DeviceHandoffStore | undefined,
  now: () => number = Date.now,
) {
  const digest = (value: string) =>
    createHmac('sha256', config.SESSION_SECRET).update(value).digest('hex');
  const available = Boolean(
    store && options.UPSTREAM_POS_DEVICE_HANDOFF_CONTRACT && options.POS_DEVICE_HANDOFF_SERVICE_KEY,
  );
  function ready() {
    if (!available || !store)
      throw new AppError(503, 'DEVICE_HANDOFF_UNAVAILABLE', 'Device sign-in is not configured.');
    return store;
  }
  function eligible(
    account: typeof PosUser.$inferSelect | undefined,
  ): account is typeof PosUser.$inferSelect & { email: string } {
    return Boolean(
      account?.is_active &&
      account.user_type === 1 &&
      [1, 2, 3, 4, 5].includes(account.role) &&
      account.email &&
      z.email().safeParse(account.email).success,
    );
  }
  async function current(reader: Pick<ReturnType<Databases['get']>, 'select'>, user: Principal) {
    const [account] = await reader
      .select()
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(user.id)))
      .limit(1)
      .for('share');
    if (!eligible(account))
      throw new AppError(
        403,
        'DEVICE_HANDOFF_DENIED',
        'Device sign-in requires an active internal account with an email address.',
      );
    return account;
  }
  return {
    capabilities(user: Principal) {
      return { available: available && user.userType === 1 };
    },
    authorizeService(key: unknown) {
      const expected = options.POS_DEVICE_HANDOFF_SERVICE_KEY;
      if (
        !expected ||
        typeof key !== 'string' ||
        Buffer.byteLength(key) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(key), Buffer.from(expected))
      )
        throw new AppError(
          401,
          'DEVICE_HANDOFF_SERVICE_DENIED',
          'Service authentication is required.',
        );
      ready();
    },
    async issue(user: Principal) {
      const cache = ready();
      return db.get('writer').transaction(async (tx) => {
        const account = await current(tx, user),
          issued = await cache.issue(
            user.id,
            digest(await currentAuthenticationVersion(tx, account)),
            freshSecret(),
            options.POS_AUTH_USER_SECRET_EXP,
          ),
          secret = issued.secret,
          timestamp = now(),
          code = handoffTotp(secret, options.POS_AUTH_QR_EXP_SEC, timestamp);
        return {
          code,
          revision: digest(`revision:${secret}`),
          serverNow: timestamp,
          expiresAt: Math.min(
            timestamp + issued.ttlMs,
            (Math.floor(timestamp / (options.POS_AUTH_QR_EXP_SEC * 1000)) + 1) *
              options.POS_AUTH_QR_EXP_SEC *
              1000,
          ),
          qrDataUrl: await qrDataUrl(JSON.stringify({ email_id: account.email, auth_otp: code })),
        };
      });
    },
    async revoke(user: Principal, revision: string) {
      const cache = ready();
      return db.get('writer').transaction(async (tx) => {
        await current(tx, user);
        const existing = await cache.read(user.id);
        if (existing) {
          if (digest(`revision:${existing.secret}`) !== revision)
            throw new AppError(
              409,
              'DEVICE_HANDOFF_CHANGED',
              'The device code changed. Refresh before revoking it.',
            );
          await cache.revoke(user.id, existing.secret);
        }
        return { status: 'revoked' as const };
      });
    },
    async verify(input: z.infer<typeof deviceHandoffVerification>) {
      const cache = ready(),
        email = input.email.trim().toLowerCase();
      if (!(await cache.attempt(digest(`attempt:${email}`), options.POS_AUTH_QR_EXP_SEC)))
        return { status: 'failed' as const, isAuthenticated: false as const };
      return db.get('writer').transaction(async (tx) => {
        const accounts = await tx
          .select()
          .from(PosUser)
          .where(and(sql`lower(${PosUser.email})=${email}`, eq(PosUser.is_active, true)))
          .limit(2)
          .for('share');
        const account = accounts.length === 1 ? accounts[0] : undefined;
        if (!eligible(account))
          return { status: 'failed' as const, isAuthenticated: false as const };
        const existing = await cache.read(String(account.id)),
          version = digest(await currentAuthenticationVersion(tx, account)),
          timestamp = now();
        if (
          !existing ||
          existing.version !== version ||
          !sameCode(
            input.code,
            handoffTotp(existing.secret, options.POS_AUTH_QR_EXP_SEC, timestamp),
          ) ||
          (options.MPOS_QR_TAKE_PASSWORD &&
            !(await verifyDjangoPassword(input.password || '', account.password)))
        )
          return { status: 'failed' as const, isAuthenticated: false as const };
        const used = digest(
            `used:${account.id}:${Math.floor(timestamp / (options.POS_AUTH_QR_EXP_SEC * 1000))}:${input.code}`,
          ),
          consumed = await cache.consume(
            String(account.id),
            version,
            existing.secret,
            freshSecret(),
            used,
            options.POS_AUTH_USER_SECRET_EXP,
            options.POS_AUTH_QR_EXP_SEC * 2,
          );
        return consumed
          ? {
              status: 'success' as const,
              isAuthenticated: true as const,
              operatorId: String(account.id),
            }
          : { status: 'failed' as const, isAuthenticated: false as const };
      });
    },
  };
}
export type DeviceHandoffService = ReturnType<typeof deviceHandoffService>;
