import { Secret, TOTP } from 'otpauth';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { AppError } from '../../src/domain/errors.js';
import { checkDjangoPassword } from '../../src/auth/crypto.js';
import { loginOtpDelivery, sandboxLoginOtpTransport } from '../../src/auth/delivery.js';
import type { IdentityService } from '../../src/auth/identity.js';
import { authKeys } from '../../src/auth/keys.js';
import { fixedOtpSettings, lockedMessage, loginOtpState } from '../../src/auth/login-otp.js';
import { pendingLogins, type PendingLogin } from '../../src/auth/login-pending.js';
import { loginChallengeService } from '../../src/auth/mfa.js';
import type { SessionAccount } from '../../src/auth/sessions.js';
import { goldenStdout } from '../golden/load.js';
import { memoryRedisPort } from '../helpers/memory-redis.js';
import {
  loginGoldenInput,
  type GoldenCode,
  type GoldenLoginScenario,
  type GoldenLoginUser,
} from './login-golden-input.js';

/**
 * Staff login (password step, OTP/TOTP step, resend, lockout) against
 * tests/golden/auth/login-flow.json, captured from the pinned legacy source
 * (users/login_otp.py, users/views.py, core/tasks.py send_login_otp; backend-pos-web 78d5b63).
 * The rewrite stores OTPs as HMACs (S3) and answers with fitting HTTP statuses, so behaviour,
 * Redis state and messages are compared, not storage. Every intentional difference below is
 * the documented mapping in parity/phase-c-auth-redis-spec.md ("Messages", 630-660).
 */
const step = z
  .object({
    op: z.enum(['password', 'resend', 'verify', 'advance']),
    context: z
      .object({ is_mfa: z.number(), otp_method: z.string(), mfa_message: z.string() })
      .passthrough()
      .optional(),
    httpStatus: z.number().optional(),
    body: z
      .object({
        status: z.number(),
        message: z.string(),
        otp_method_message: z.string().optional(),
      })
      .passthrough()
      .optional(),
    error: z.string().optional(),
    deliveries: z.array(
      z.object({ channel: z.string(), to: z.string(), text: z.string().optional() }).passthrough(),
    ),
    alerts: z.array(z.string()),
    loggedIn: z.boolean(),
    checkIn: z.number().nullable(),
    pendingSession: z.boolean(),
    state: z.object({
      otpPending: z.boolean(),
      locked: z.boolean(),
      failures: z.number().nullable(),
      retryWait: z.boolean(),
      resendWait: z.boolean(),
    }),
  })
  .strict();
const golden = z
  .object({
    sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
    sourceSha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    messages: z.object({ locked: z.string(), retryWait: z.string() }),
    scenarios: z.array(z.object({ name: z.string(), steps: z.array(step) })),
    passwords: z.array(
      z.union([
        z.object({ valid: z.boolean(), mustUpdate: z.boolean() }).strict(),
        z.object({ error: z.string(), message: z.string() }).strict(),
      ]),
    ),
  })
  .strict()
  .parse(
    JSON.parse(goldenStdout('auth', 'login-flow', JSON.stringify(loginGoldenInput))) as unknown,
  );
type LegacyStep = z.infer<typeof step>;

const config = readConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'v2-login-golden-fixture-secret-'.repeat(2),
  MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
});
const start = 1763600000 * 1000;

function account(row: GoldenLoginUser): SessionAccount {
  return {
    id: BigInt(row.id),
    username: `operator${row.id}`,
    password: '!',
    first_name: row.first_name,
    last_name: 'Fixture',
    is_active: row.is_active,
    is_staff: false,
    is_superuser: false,
    last_login: null,
    date_joined: '2026-01-01 00:00:00',
    role: row.role,
    gender: null,
    age: null,
    phone: row.phone,
    email: `operator${row.id}@example.test`,
    is_mfa: row.is_mfa === 1,
    mfa_hash: row.mfa_hash,
    profile_image: '',
    cover_image: '',
    contact_email: row.contact_email,
    otp_method: row.otp_method,
    user_type: 1,
  };
}

type Outcome =
  | { kind: 'ok'; message?: string; otpMethodMessage?: string; storeId?: string }
  | { kind: 'error'; status: number; code: string; message: string };

/** The rewrite answer the documented mapping requires for a legacy JSON reply. */
function expectedOutcome(legacy: LegacyStep): Outcome {
  if (legacy.error !== undefined)
    // Legacy: pyotp raises on an unusable mfa_hash (HTTP 500).
    return {
      kind: 'error',
      status: 409,
      code: 'TOTP_NOT_CONFIGURED',
      message:
        'Authenticator sign-in is not set up correctly for this account. Request an OTP instead, or ask an administrator to reset MFA.',
    };
  const body = legacy.body!;
  if (body.status === 200)
    return legacy.op === 'resend'
      ? { kind: 'ok', message: body.message, otpMethodMessage: body.otp_method_message! }
      : { kind: 'ok', storeId: String(legacy.checkIn) };
  if (body.message === 'Your login session has expired. Please sign in again.')
    return {
      kind: 'error',
      status: 401,
      code: 'LOGIN_SESSION_EXPIRED',
      message: 'Your sign-in step has expired. Enter your password again.',
    };
  if (body.message === golden.messages.locked)
    return { kind: 'error', status: 423, code: 'LOGIN_LOCKED', message: body.message };
  if (body.message === 'Please Provide Valid OTP.')
    return {
      kind: 'error',
      status: 400,
      code: 'OTP_INPUT_INVALID',
      message: 'Enter the OTP you received, then try again.',
    };
  const codes: Record<number, string> = {
    400: 'CHECK_IN_STORE_REQUIRED',
    401: 'OTP_INVALID',
    403: 'CHECK_IN_STORE_DENIED',
    429: legacy.op === 'resend' ? 'LOGIN_RESEND_WAIT' : 'LOGIN_RETRY_WAIT',
  };
  return { kind: 'error', status: body.status, code: codes[body.status]!, message: body.message };
}

async function runRewrite(scenario: GoldenLoginScenario) {
  let now = start;
  const clock = () => now;
  const redis = memoryRedisPort(clock);
  const users = new Map(scenario.users.map((row) => [String(row.id), row]));
  const identity: Pick<IdentityService, 'activeAccount' | 'loginStores'> = {
    async activeAccount(id) {
      const row = users.get(id);
      return row?.is_active ? account(row) : null;
    },
    async loginStores() {
      return [];
    },
  };
  const transport = sandboxLoginOtpTransport();
  const base = loginOtpDelivery(transport, () => {});
  const issued: string[] = [],
    alerts: string[] = [];
  const delivery = {
    ...base,
    async deliver(...args: Parameters<typeof base.deliver>) {
      issued.push(args[1]);
      return base.deliver(...args);
    },
    alert(message: string) {
      alerts.push(message);
      base.alert(message);
    },
  };
  const fixed = fixedOtpSettings(
    scenario.fixedOtp
      ? {
          LOGIN_FIXED_OTP_ENABLED: String(scenario.fixedOtp.enabled),
          LOGIN_FIXED_OTP: scenario.fixedOtp.otp,
          LOGIN_FIXED_OTP_USER_IDS: scenario.fixedOtp.userIds.join(','),
        }
      : {},
  );
  const pending = pendingLogins(redis, config.LOGIN_MFA_PENDING_TTL, clock);
  const otp = loginOtpState(redis, config);
  const stores = scenario.stores ?? [1];
  const challenges = loginChallengeService(
    config,
    identity as IdentityService,
    pending,
    otp,
    delivery,
    fixed,
    () => {},
    {
      now: clock,
      checkIn: {
        async allowed(userId, role, storeId) {
          const store = Number(storeId);
          if (store === 0) return true;
          return (
            stores.includes(store) && (role === 1 || users.get(userId)!.stores.includes(store))
          );
        },
      },
    },
  );
  const userId = String(scenario.user);
  let credential: PendingLogin | null = null;
  const resolveCode = (code: GoldenCode): string => {
    if (typeof code === 'string') return code;
    if (code.use !== 'totp') {
      if (code.use === 'last-sent') return issued.at(-1)!;
      if (code.use === 'previous-sent') return issued.at(-2)!;
      return issued.at(-1) !== '000000' ? '000000' : '999999';
    }
    return new TOTP({
      secret: Secret.fromBase32(users.get(userId)!.mfa_hash!),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    }).generate({ timestamp: now + code.offset * 1000 });
  };
  const results = [];
  for (const action of scenario.steps) {
    const sentBefore = transport.sent.length,
      alertsBefore = alerts.length,
      issuedBefore = issued.length;
    let outcome: Outcome | null = null,
      view: Awaited<ReturnType<typeof challenges.begin>>['view'] | null = null;
    if (action.op === 'advance') now += action.seconds * 1000;
    else if (action.op === 'password') {
      const begun = await challenges.begin(account(users.get(userId)!));
      credential = begun.credential;
      view = begun.view;
    } else {
      try {
        if (action.op === 'resend') {
          const reply = await challenges.resend(credential!);
          outcome = {
            kind: 'ok',
            message: reply.message,
            otpMethodMessage: reply.otpMethodMessage,
          };
        } else {
          const reply = await challenges.verify(credential!, {
            code: resolveCode(action.code),
            ...(action.platform === undefined ? {} : { factor: action.platform }),
            ...(action.store === undefined ? {} : { storeId: action.store }),
          });
          outcome = { kind: 'ok', storeId: reply.storeId };
        }
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        outcome = { kind: 'error', status: error.status, code: error.code, message: error.message };
      }
    }
    await delivery.drain();
    // Legacy SMS text carries its own deterministic code; compare the template only.
    const codeFree = (text: string, code: string | undefined) =>
      code ? text.split(code).join('{otp}') : text;
    const newCode = issued.length > issuedBefore ? issued.at(-1) : undefined;
    const failures = await redis.get(authKeys.failures(userId));
    results.push({
      op: action.op,
      view,
      outcome,
      deliveries: transport.sent
        .slice(sentBefore)
        .filter((message) => message.channel !== 'slack')
        .map((message) => ({
          channel: message.channel,
          to: message.to,
          ...(message.channel === 'sms' ? { text: codeFree(message.text, newCode) } : {}),
        })),
      alerts: alerts.slice(alertsBefore),
      pendingSession: credential ? (await pending.userId(credential)) !== null : false,
      state: {
        otpPending: await otp.hasPending(userId),
        locked: await otp.isLocked(userId),
        failures: failures === null ? null : Number(failures),
        retryWait: await redis.exists(authKeys.wait(userId)),
        resendWait: await redis.exists(authKeys.resend(userId)),
      },
    });
  }
  return { results, issued };
}

describe('staff login against the pinned legacy OTP/TOTP flow', () => {
  it('pins the source files the golden executed', () => {
    expect(Object.keys(golden.sourceSha256).sort()).toEqual([
      'core/tasks.py',
      'helpers/helpers.py',
      'users/login_otp.py',
      'users/views.py',
    ]);
    expect(golden.messages.locked).toBe(lockedMessage(config));
    expect(golden.scenarios.map((scenario) => scenario.name)).toEqual(
      loginGoldenInput.scenarios.map((scenario) => scenario.name),
    );
  });
  it.each(loginGoldenInput.scenarios.map((scenario, index) => [scenario.name, index] as const))(
    '%s',
    async (_name, index) => {
      const scenario = loginGoldenInput.scenarios[index]!;
      const legacy = golden.scenarios[index]!.steps;
      const { results } = await runRewrite(scenario);
      expect(results).toHaveLength(legacy.length);
      results.forEach((actual, position) => {
        const expected = legacy[position]!;
        const where = `${scenario.name} step ${position} (${expected.op})`;
        if (expected.op === 'password') {
          const context = expected.context!;
          expect(actual.view, where).toMatchObject({
            method: context.is_mfa === 1 ? 'totp' : 'otp',
            otpChannel: context.otp_method === 'SMS' ? 'sms' : 'email',
            message: context.mfa_message,
            locked: context.mfa_message === golden.messages.locked,
          });
        } else if (expected.op !== 'advance')
          expect(actual.outcome, where).toEqual(expectedOutcome(expected));
        const legacyCode = expected.deliveries.find((entry) => entry.channel === 'sms')?.text;
        expect(actual.deliveries, where).toEqual(
          expected.deliveries.map((entry) => ({
            channel: entry.channel,
            to: entry.to,
            ...(entry.channel === 'sms' ? { text: legacyCode!.replace(/^\d{6}/, '{otp}') } : {}),
          })),
        );
        expect(actual.alerts, where).toEqual(expected.alerts);
        expect(actual.state, where).toEqual(expected.state);
        expect(actual.pendingSession, where).toBe(expected.pendingSession);
      });
    },
  );
  it('verifies Django password hashes as Django 4.2.5 check_password does', async () => {
    expect(golden.passwords).toHaveLength(loginGoldenInput.passwords.length);
    for (const [index, item] of loginGoldenInput.passwords.entries()) {
      const legacy = golden.passwords[index]!;
      const actual = await checkDjangoPassword(item.password, item.encoded);
      // Legacy raises (HTTP 500) on a malformed iteration count or a hasher whose library is
      // not installed (argon2); the rewrite refuses the password instead (S7).
      expect(actual, `password case ${index}`).toEqual(
        'error' in legacy ? { valid: false, mustUpdate: false } : legacy,
      );
    }
  });
});
