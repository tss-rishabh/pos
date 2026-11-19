import { pbkdf2Sync } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { readConfig, type Config } from '../../src/config.js';
import { AppError } from '../../src/domain/errors.js';
import type { Principal } from '../../src/domain/access.js';
import { registerAuth } from '../../src/auth/routes.js';
import { redisSessions, type SessionAccount } from '../../src/auth/sessions.js';
import { loginChallengeService } from '../../src/auth/mfa.js';
import { loginOtpDelivery, sandboxLoginOtpTransport } from '../../src/auth/delivery.js';
import { fixedOtpSettings, loginOtpState } from '../../src/auth/login-otp.js';
import { pendingLogins } from '../../src/auth/login-pending.js';
import { loginCheckIns } from '../../src/auth/checkin.js';
import { checkDjangoPassword } from '../../src/auth/crypto.js';
import type { AuthEvent } from '../../src/auth/events.js';
import type { IdentityService } from '../../src/auth/identity.js';
import type { RedisPort } from '../../src/redis/port.js';
import { authRedisBackends } from '../helpers/auth-redis.js';

const origin = 'http://localhost:5173';
const hash = (password: string) =>
  `pbkdf2_sha256$1000$fixture-salt$${pbkdf2Sync(password, 'fixture-salt', 1000, 32, 'sha256').toString('base64')}`;
function account(id: number, extra: Partial<SessionAccount> = {}): SessionAccount {
  return {
    id: BigInt(id),
    username: `operator${id}`,
    password: hash('correct-horse'),
    first_name: 'Fixture',
    last_name: 'Operator',
    is_active: true,
    is_staff: false,
    is_superuser: false,
    last_login: null,
    date_joined: '2026-01-01 00:00:00',
    role: 5,
    gender: null,
    age: null,
    phone: '9000000001',
    email: `operator${id}@example.test`,
    is_mfa: false,
    mfa_hash: null,
    profile_image: '',
    cover_image: '',
    contact_email: null,
    otp_method: 1,
    user_type: 1,
    ...extra,
  };
}
const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
function cookieHeader(
  response: { cookies: { name: string; value: string }[] },
  jar: Map<string, string>,
) {
  for (const entry of response.cookies)
    if (entry.value) jar.set(entry.name, entry.value);
    else jar.delete(entry.name);
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}
describe.each(authRedisBackends)('staff login on $name', (backend) => {
  let redis: Awaited<ReturnType<typeof backend.open>>;
  beforeAll(async () => {
    redis = await backend.open();
  });
  afterAll(async () => {
    await redis.close();
  });
  let app: FastifyInstance,
    config: Config,
    accounts: Map<string, SessionAccount>,
    transport: ReturnType<typeof sandboxLoginOtpTransport>,
    delivery: ReturnType<typeof loginOtpDelivery>,
    events: AuthEvent[],
    logins: string[],
    jar: Map<string, string>;
  async function build(env: Record<string, string> = {}) {
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'w3-login-flow-fixture-secret-'.repeat(2),
      MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
      ...env,
    });
    const port: RedisPort = redis.port;
    const identity: IdentityService = {
      async get(id) {
        const row = accounts.get(id);
        return row ? this.principal(row) : null;
      },
      async principal(row): Promise<Principal | null> {
        return row.is_active
          ? {
              id: String(row.id),
              name: 'Fixture Operator',
              email: row.email ?? '',
              role: 5,
              userType: 1,
              storeIds: ['1'],
            }
          : null;
      },
      async authenticate(username, password) {
        const row = [...accounts.values()].find(
          (candidate) => candidate.username === username || candidate.email === username,
        );
        return row && row.is_active && (await checkDjangoPassword(password, row.password)).valid
          ? row
          : null;
      },
      async activeAccount(id) {
        const row = accounts.get(id);
        return row?.is_active ? { ...row } : null;
      },
      async loginStores() {
        return [{ id: '1', name: 'Andheri' }];
      },
      async recordLogin(id) {
        logins.push(id);
      },
      async close() {},
    };
    transport = sandboxLoginOtpTransport();
    events = [];
    delivery = loginOtpDelivery(transport, (event) => events.push(event));
    const sessions = redisSessions(
      config,
      async (id) => {
        const row = accounts.get(id);
        return row?.is_active ? { ...row } : undefined;
      },
      port,
    );
    const checkIns = loginCheckIns(
      {
        eligible: async (_user, _role, storeId) => storeId === '1',
        name: async (storeId) => (storeId === '1' ? 'Andhéri' : ''),
      },
      port,
    );
    const challenges = loginChallengeService(
      config,
      identity,
      pendingLogins(port, config.LOGIN_MFA_PENDING_TTL),
      loginOtpState(port, config),
      delivery,
      fixedOtpSettings(env),
      (event) => events.push(event),
      { checkIn: checkIns },
    );
    app = Fastify({ logger: false });
    await app.register(cookie);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError)
        return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
      if (error instanceof AppError)
        return reply
          .code(error.status)
          .send({ error: { code: error.code, message: error.message } });
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
    });
    registerAuth(app, {
      config,
      identity,
      sessions,
      challenges,
      checkIns,
      log: (e) => events.push(e),
    });
    app.get('/protected', async (request) => ({ user: request.principal?.id ?? null }));
  }
  beforeEach(async () => {
    await redis.flush();
    accounts = new Map([
      ['11', account(11)],
      ['12', account(12, { otp_method: 2, contact_email: 'otp12@example.test' })],
      ['13', account(13, { is_mfa: true, mfa_hash: totpSecret })],
      ['14', account(14, { phone: null })],
    ]);
    logins = [];
    jar = new Map();
    await build();
  });
  const post = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { origin, cookie: cookieHeader({ cookies: [] }, jar) },
      payload: payload as object,
    });
  async function passwordStep(username: string, password = 'correct-horse') {
    const response = await post('/api/v1/auth/sessions', { username, password });
    cookieHeader(response, jar);
    return response;
  }
  const lastSms = () => transport.sent.filter((m) => m.channel === 'sms').at(-1)!;
  const smsCode = () => /^(\d{6}) is your OTP/.exec(lastSms().text)![1]!;
  async function verify(code: string, storeId: number | string = 1, factor = 'otp') {
    const response = await post('/api/v1/auth/challenges/current/verifications', {
      code,
      factor,
      storeId,
    });
    cookieHeader(response, jar);
    return response;
  }
  const release = (userId: string) => redis.port.del([`pos:login_otp_wait:${userId}`]);

  it('signs in with password + SMS OTP, stores only an HMAC, and writes legacy check-in keys', async () => {
    const step = await passwordStep('operator11');
    expect(step.statusCode).toBe(202);
    expect(step.json()).toMatchObject({
      method: 'otp',
      otpChannel: 'sms',
      locked: false,
      message: 'One Time Password (OTP) has been sent on your registered mobile number',
      stores: [{ id: '1', name: 'Andheri' }],
    });
    const code = smsCode();
    expect(lastSms().text).toBe(`${code} is your OTP to log in to The Souled Store.`);
    const stored = await redis.port.get('pos:login_otp:11');
    expect(stored).toMatch(/^[a-f0-9]{64}$/);
    expect(stored).not.toContain(code);
    expect(await redis.port.get('login_otp:11')).toBeNull();
    const done = await verify(code);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ user: { id: '11' }, checkInStoreId: '1' });
    const session = done.cookies.find((entry) => entry.name === 'pos_session')!;
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(session.maxAge).toBeGreaterThan(0);
    expect(await redis.port.get('pos:login_otp:11')).toBeNull();
    expect(await redis.port.get('check_in_11')).toBe('[1, "Andh\\u00e9ri"]');
    expect(await redis.port.lRange('check_in_list_1', 0, -1)).toEqual(['11']);
    expect(logins).toEqual(['11']);
    expect(
      (
        await app.inject({
          url: '/protected',
          headers: { cookie: cookieHeader({ cookies: [] }, jar) },
        })
      ).json(),
    ).toEqual({ user: '11' });
    expect(events.map((event) => JSON.stringify(event)).join('')).not.toContain(code);
  });

  it('counts wrong codes with a retry pause, locks on the third, alerts Slack without the OTP', async () => {
    await passwordStep('operator11');
    const code = smsCode(),
      wrong = code === '000000' ? '111111' : '000000';
    const first = await verify(wrong);
    expect(first.statusCode).toBe(401);
    expect(first.json().error.message).toBe(
      'Wrong OTP. 2 attempts left. Please wait 30 seconds before trying again.',
    );
    const paused = await verify(code);
    expect(paused.statusCode).toBe(429);
    expect(paused.json().error.message).toBe('Please wait 30 seconds before trying again.');
    await release('11');
    expect((await verify(wrong)).json().error.message).toBe(
      'Wrong OTP. 1 attempt left. Please wait 30 seconds before trying again.',
    );
    await release('11');
    const locked = await verify(wrong);
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error.message).toBe(
      'Too many wrong OTP attempts. Please try again after 3 hours.',
    );
    expect(await redis.port.get('pos:login_otp:11')).toBeNull();
    expect(await redis.port.get('pos:login_otp_fail:11')).toBeNull();
    expect(await redis.port.pTtl('pos:login_otp_lock:11')).toBeGreaterThan(10_000_000);
    await delivery.drain();
    const alert = transport.sent.find((m) => m.channel === 'slack')!;
    expect(alert).toMatchObject({ to: 'login-security' });
    expect(alert.text).toBe(
      ':lock: *[backend-pos-web]* Staff login: user_id `11` locked for 3h after 3 wrong OTP attempts.',
    );
    expect(alert.text).not.toContain(code);
    // The password step still succeeds while locked, and sends nothing (legacy).
    const sent = transport.sent.length;
    const again = await passwordStep('operator11');
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({ locked: true });
    expect(transport.sent).toHaveLength(sent);
    await release('11');
    expect((await verify(code)).statusCode).toBe(423);
  });

  it('keeps the OTP inside the resend cooldown, sends a resend on WhatsApp, and enforces the cooldown', async () => {
    await passwordStep('operator11');
    const first = smsCode();
    await passwordStep('operator11');
    expect(transport.sent.filter((m) => m.channel === 'sms')).toHaveLength(1);
    await redis.port.del(['pos:login_otp_resend:11']);
    const resend = await post('/api/v1/auth/challenges/current/resends', {});
    expect(resend.statusCode).toBe(200);
    expect(resend.json().message).toBe(
      'One Time Password (OTP) has been sent on your registered mobile number.',
    );
    await delivery.drain();
    const second = smsCode();
    const whatsapp = transport.sent.filter((m) => m.channel === 'whatsapp');
    expect(whatsapp).toHaveLength(1);
    expect(whatsapp[0]!.text).toBe(
      `${second} is your verification code. For your security, do not share this code.`,
    );
    const cooled = await post('/api/v1/auth/challenges/current/resends', {});
    expect(cooled.statusCode).toBe(429);
    expect(cooled.json().error.message).toBe(
      'Please wait a few seconds before requesting another OTP.',
    );
    if (first !== second) expect((await verify(first)).statusCode).toBe(401);
  });

  it('alerts with a masked phone when WhatsApp does not confirm a resend', async () => {
    transport = sandboxLoginOtpTransport(() => false);
    const failing = loginOtpDelivery(transport, (event) => events.push(event));
    await failing.deliver(
      { userId: '11', phone: '9000000001', contactEmail: null, firstName: 'F', otpMethod: 1 },
      '123456',
      true,
    );
    await failing.drain();
    const alert = transport.sent.find((m) => m.channel === 'slack')!;
    expect(alert.to).toBe('whatsapp-alert');
    expect(alert.text).toBe(
      ':warning: *[backend-pos-web]* WhatsApp OTP delivery failed | flow: `staff_login|user_id:11` | phone: `90****01`',
    );
    expect(alert.text).not.toContain('123456');
  });

  it('emails email-method users and stores no OTP for users without a phone', async () => {
    await passwordStep('operator12');
    const email = transport.sent.find((m) => m.channel === 'email')!;
    expect(email.to).toBe('otp12@example.test');
    expect(email.text).toMatch(
      /^Hey Fixture,\n\n {8}\d{6} is your OTP to login into the POS Admin\./,
    );
    jar.clear();
    const noPhone = await passwordStep('operator14');
    expect(noPhone.statusCode).toBe(202);
    expect(await redis.port.get('pos:login_otp:14')).toBeNull();
    expect(events.some((event) => event.eventId === 'identity.login-otp.contact-missing')).toBe(
      true,
    );
  });

  it('issues the configured fixed OTP only to listed users, hashed, without sending', async () => {
    await build({
      LOGIN_FIXED_OTP_ENABLED: '1',
      LOGIN_FIXED_OTP: ' 424242 ',
      LOGIN_FIXED_OTP_USER_IDS: '7, 11,x',
    });
    await passwordStep('operator11');
    expect(transport.sent).toHaveLength(0);
    expect(await redis.port.get('pos:login_otp:11')).not.toBe('424242');
    expect((await verify('424242', 0)).statusCode).toBe(200);
    expect(await redis.port.get('check_in_11')).toBe('[0, ""]');
  });

  it('verifies TOTP for MFA users, rejects TOTP for others, and refuses unassigned stores after the code', async () => {
    await passwordStep('operator13');
    expect(transport.sent).toHaveLength(0);
    const now = new TOTP({
      secret: Secret.fromBase32(totpSecret),
      digits: 6,
      period: 30,
    }).generate();
    const denied = await verify(now, 99, 'totp');
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe('You are not assigned to this store.');
    const fullWidth = [...now].map((digit) => String.fromCharCode(0xff10 + Number(digit))).join('');
    expect((await verify(fullWidth, 1, 'totp')).statusCode).toBe(200);
    jar.clear();
    await passwordStep('operator11');
    const invalid = await verify(smsCode(), 1, 'totp');
    expect(invalid.statusCode).toBe(400);
    expect((await verify('', 1)).statusCode).toBe(400);
    expect((await verify(smsCode(), 'not-a-store')).json().error.message).toBe(
      'Please select a store to check in to.',
    );
  });

  it('ends sessions only on password change or deactivation, and logout leaves check-in lists', async () => {
    await passwordStep('operator11');
    await verify(smsCode());
    const cookieValue = cookieHeader({ cookies: [] }, jar);
    const me = () =>
      app.inject({ url: '/api/v1/auth/sessions/current', headers: { cookie: cookieValue } });
    expect((await me()).statusCode).toBe(200);
    accounts.set('11', {
      ...accounts.get('11')!,
      role: 3,
      phone: '9000000099',
      email: 'x@example.test',
    });
    expect((await me()).statusCode).toBe(200);
    accounts.set('11', { ...accounts.get('11')!, is_active: false });
    expect((await me()).statusCode).toBe(401);
    accounts.set('11', { ...accounts.get('11')!, is_active: true });
    expect((await me()).statusCode).toBe(200);
    accounts.set('11', { ...accounts.get('11')!, password: hash('new-password') });
    expect((await me()).statusCode).toBe(401);
    accounts.set('11', account(11));
    const out = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions/current',
      headers: { origin, cookie: cookieValue },
    });
    expect(out.statusCode).toBe(204);
    expect((await me()).statusCode).toBe(401);
    expect(await redis.port.lRange('check_in_list_1', 0, -1)).toEqual([]);
    expect(await redis.port.get('check_in_11')).toBe('[1, "Andh\\u00e9ri"]');
  });

  it('reports signed-out and pending-challenge state with 200 while the session resource stays 401', async () => {
    const state = async () => {
      const response = await app.inject({
        url: '/api/v1/auth/session-state',
        headers: { cookie: cookieHeader({ cookies: [] }, jar) },
      });
      expect(response.statusCode).toBe(200);
      return response.json<{
        session: { user: { id: string } } | null;
        loginChallengePending: boolean;
      }>();
    };
    expect(await state()).toEqual({ session: null, loginChallengePending: false });
    expect((await app.inject({ url: '/api/v1/auth/sessions/current' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/auth/session-state?probe=1' })).statusCode).toBe(400);
    await passwordStep('operator11');
    expect(await state()).toEqual({ session: null, loginChallengePending: true });
    await verify(smsCode());
    const signedIn = await state();
    expect(signedIn.session?.user.id).toBe('11');
    expect(signedIn.loginChallengePending).toBe(false);
    jar.set('pos_pending_login', 'not-a-sealed-value');
    for (const name of [...jar.keys()]) if (name !== 'pos_pending_login') jar.delete(name);
    expect(await state()).toEqual({ session: null, loginChallengePending: false });
  });

  it('rejects bad credentials and expired or missing password steps with clear statuses', async () => {
    const bad = await passwordStep('operator11', 'wrong');
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('INVALID_CREDENTIALS');
    expect((await passwordStep('', '')).statusCode).toBe(400);
    jar.clear();
    const none = await verify('123456');
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('LOGIN_SESSION_EXPIRED');
    await passwordStep('operator11');
    for (const key of await redis.port.scanKeys('pos:login_pending:*')) await redis.port.del([key]);
    expect((await verify(smsCode())).statusCode).toBe(401);
  });
});
