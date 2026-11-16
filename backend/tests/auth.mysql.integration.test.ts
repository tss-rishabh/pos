import { readFileSync } from 'node:fs';
import { pbkdf2Sync, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import mysql, { type Connection } from 'mysql2/promise';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { TOTP, Secret } from 'otpauth';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { readConfig, type Config } from '../src/config.js';
import { createDatabases, type Databases } from '../src/db/pools.js';
import { PosUser, Store, StoreCounter, UserStore } from '../src/db/legacy-schema.js';
import { identityService, type IdentityService } from '../src/auth/identity.js';
import {
  mysqlSessions,
  type SessionService,
  type SessionCredential,
} from '../src/auth/sessions.js';
import { googleIdentities } from '../src/auth/google-identity-schema.js';
import { operatorSessions } from '../src/auth/session-schema.js';
import { googleIssuer, type GoogleSsoProvider, type SsoState } from '../src/auth/google-sso.js';
import { desktopSsoService, pruneDesktopSsoFlows } from '../src/auth/desktop-sso.js';
import { desktopSsoFlows } from '../src/auth/desktop-sso-schema.js';
import { registerDesktopSso } from '../src/auth/desktop-sso-routes.js';
import { loginChallengeService, type LoginChallengeService } from '../src/auth/mfa.js';
import { loginChallenges, loginSecurity } from '../src/auth/mfa-schema.js';
import { securityAlerts } from '../src/auth/security-schema.js';
import {
  securityAlertWorker,
  securityWorkerOptions,
  type SecurityWorkerEvent,
} from '../src/auth/security-worker.js';
import { setTimeout } from 'node:timers/promises';
import { assertDailyReportingEnabled } from '../src/modules/reports.js';
import { registerAuth } from '../src/auth/routes.js';
import { registerProfile } from '../src/auth/profile-routes.js';
import { profileService, profileInput } from '../src/auth/profile.js';
import { seal, verifyDjangoPassword } from '../src/auth/crypto.js';
import { invalidateOperatorAuthentication } from '../src/auth/revocation.js';
import { profileMediaService, profileUploadInput } from '../src/auth/profile-media.js';
import { profileMediaCleanup, type ProfileMediaEvent } from '../src/auth/profile-media-worker.js';
import { profileMediaJobs } from '../src/auth/profile-media-schema.js';
import { registerProfileMedia } from '../src/auth/profile-media-routes.js';
import type {
  DocumentationMediaStore,
  ReservedMedia,
} from '../src/modules/administration/media-storage.js';
import { registerRequestTrace } from '../src/observability/context.js';
import { checkInService } from '../src/modules/administration/checkins.js';
import { demoUser } from '../src/modules/demo.js';
import { AppError } from '../src/domain/errors.js';
import {
  legacyFixtureRecord,
  legacyFixtureTableSql,
} from '../tools/administration/mysql-fixture.js';

const template = process.env.AUTH_MYSQL_TEST_URL;
const encode = (password: string) =>
  `pbkdf2_sha256$10000$fixture-salt$${pbkdf2Sync(password, 'fixture-salt', 10000, 32, 'sha256').toString('base64')}`;
describe.skipIf(!template)('password, MFA and session authority against isolated MySQL', () => {
  const tables: MySqlTable[] = [PosUser, Store, StoreCounter, UserStore];
  let connection: Connection,
    db: Databases,
    config: Config,
    identity: IdentityService,
    sessions: SessionService,
    challenges: LoginChallengeService,
    app: FastifyInstance,
    schema: string;
  let timestamp = Date.now(),
    deliveryUncertain = false;
  const sent: { code: string; resend: boolean }[] = [];
  const imageBytes = readFileSync('tests/fixtures/profile-image.png');
  const imageChecksum = createHash('sha256').update(imageBytes).digest('base64');
  let verificationFails = false,
    deletionFails = false;
  const removed: string[] = [],
    verifiedImages: ReservedMedia[] = [];
  const imageStore: DocumentationMediaStore = {
    keyFor: (input) =>
      `uploads/users/${input.kind === 'image' ? 'profile_image' : 'cover_image'}/${input.id}.png`,
    assertKey(key) {
      if (!key.startsWith('uploads/users/'))
        throw new AppError(403, 'PROFILE_SCOPE_DENIED', 'Image is outside its location.');
    },
    async upload(input) {
      return { url: 'https://upload.example.test/', fields: { key: input.objectKey } };
    },
    async verify(input) {
      verifiedImages.push(input);
      if (verificationFails)
        throw new AppError(400, 'DOCUMENTATION_UPLOAD_MISMATCH', 'Private fixture mismatch.');
    },
    async stream() {
      const body = imageBytes;
      return { body: Readable.from([body]), contentType: 'image/png', size: body.length };
    },
    async remove(key) {
      if (deletionFails) throw new Error('private-image-canary@example.test');
      removed.push(key);
    },
    close() {},
  };
  async function seed(
    table: MySqlTable,
    values: Record<string, string | number | bigint | boolean | null>,
  ) {
    const record = legacyFixtureRecord(table, values),
      keys = Object.keys(record);
    await connection.execute(
      `INSERT INTO ${mysql.escapeId(getTableConfig(table).name)} (${keys.map((key) => mysql.escapeId(key)).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((key) => {
        const value = record[key];
        if (value === undefined) throw new Error('Fixture column has no value');
        return value;
      }),
    );
  }
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_auth_test'
    )
      throw new Error(
        'Auth integration tests require the explicit isolated local schema template.',
      );
    schema = `pos_rewrite_auth_test_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    for (const table of tables) await connection.query(legacyFixtureTableSql(table));
    for (const file of [
      'migrations/0002_auth_sessions.sql',
      'migrations/0003_login_challenges.sql',
      'migrations/0004_auth_security_alerts.sql',
      'migrations/0005_profile_media.sql',
      'migrations/0006_operator_auth_epochs.sql',
      'migrations/0007_google_identities.sql',
      'migrations/0008_desktop_sso.sql',
      'src/modules/administration/migration.sql',
      'src/modules/administration/mfa-migration.sql',
      'src/modules/administration/slack-migration.sql',
      'src/modules/application-links/migration.sql',
    ]) {
      for (const statement of readFileSync(file, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((value) => value.trim()))
        await connection.query(statement);
    }
    url.pathname = '/' + schema;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'isolated-auth-fixture-secret-'.repeat(3),
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    });
    db = createDatabases(config);
    identity = identityService(config, db);
    sessions = mysqlSessions(db);
    const checkins = checkInService(db, config);
    challenges = loginChallengeService(
      config,
      db,
      identity,
      {
        assertReady() {},
        async send(_account, code, resend) {
          sent.push({ code, resend });
          if (deliveryUncertain)
            throw new AppError(
              502,
              'OTP_DELIVERY_UNCERTAIN',
              'Fixture delivery could not be confirmed.',
            );
        },
      },
      {
        now: () => timestamp,
        setCheckIn: (user, storeId, transaction) => checkins.set(user, storeId, null, transaction),
      },
    );
    app = Fastify({ logger: false, genReqId: () => crypto.randomUUID() });
    registerRequestTrace(app);
    await app.register(cookie);
    const auth = registerAuth(app, config, identity, demoUser, sessions, challenges);
    const profiles = profileService(config, db, { imagesAvailable: true });
    registerProfile(app, profiles, identity, auth.rotateSession);
    registerProfileMedia(
      app,
      profileMediaService(config, db, imageStore, () => timestamp),
      profiles,
    );
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError)
        return reply
          .code(error.status)
          .send({ error: { code: error.code, message: error.message } });
      if (error instanceof ZodError)
        return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
    });
    await app.ready();
  });
  beforeEach(async () => {
    timestamp = Date.now();
    sent.length = 0;
    deliveryUncertain = false;
    verificationFails = false;
    deletionFails = false;
    removed.length = 0;
    verifiedImages.length = 0;
    for (const name of [
      'pos_rewrite_sessions',
      'pos_rewrite_operator_google_identities',
      'pos_rewrite_desktop_sso_flows',
      'pos_rewrite_login_security_alerts',
      'pos_rewrite_login_challenges',
      'pos_rewrite_login_security',
      'pos_rewrite_operator_checkins',
      'pos_rewrite_profile_media_jobs',
      'pos_rewrite_profile_uploads',
      ...tables.map((table) => getTableConfig(table).name),
    ])
      await connection.query('DELETE FROM ' + mysql.escapeId(name));
    await seed(PosUser, {
      id: 101,
      username: 'fixture',
      password: encode('fixture-password'),
      first_name: 'Fixture',
      email: 'fixture@example.test',
      role: 5,
      user_type: 1,
      is_active: true,
      is_mfa: false,
      phone: '1000000000',
      contact_email: 'fixture@example.test',
      otp_method: 1,
    });
    for (const id of [1, 2])
      await seed(Store, { id, store_name: `Store ${id}`, is_active: true, type: 'STORE' });
    await seed(UserStore, { id: 1, django_user_id: 101, store_id: 1 });
  });
  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.close();
    if (connection) {
      if (schema) await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });
  const begin = async () => challenges.begin(await identity.login('fixture', 'fixture-password'));
  const googleProof = () => ({
    email: 'fixture@example.test',
    subject: '1000000000001',
    hostedDomain: 'example.test',
  });
  function ssoConfig() {
    return {
      ...config,
      OIDC_ISSUER: googleIssuer,
      OIDC_CLIENT_ID: 'fixture.apps.googleusercontent.com',
      OIDC_CLIENT_SECRET: 'fixture-google-client-secret',
      OIDC_REDIRECT_URI: 'http://localhost:5173/api/v1/auth/sso/callback',
      OIDC_EMAIL_DOMAINS: ['example.test'],
      DESKTOP_SSO_ENABLED: true,
    };
  }
  function desktopService() {
    return desktopSsoService(ssoConfig(), db, identity, sessions, () => timestamp);
  }
  async function desktopFlow() {
    const service = desktopService(),
      created = await service.create();
    await service.start(created.id, created.ticket);
    const account = await identity.byGoogleIdentity!(googleProof());
    if (!account) throw new Error('Fixture work identity is unavailable');
    const approval = await service.bindIdentity(created.id, account);
    return { service, created, approval };
  }
  it('separates desktop/browser/approval secrets, consumes the start ticket once and stores only hashes', async () => {
    const service = desktopService(),
      created = await service.create();
    const [row] = await db.get('writer').select().from(desktopSsoFlows);
    expect(row).toMatchObject({ status: 'pending', approvalAttempts: 0, operatorId: null });
    for (const hash of [row?.desktopSecretHash, row?.browserTicketHash, row?.pairingCodeHash])
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(row!)).not.toContain(created.secret);
    expect(Object.values(row!)).not.toContain(created.ticket);
    expect(Object.values(row!)).not.toContain(created.code);
    expect(created.code).toMatch(/^\d{6}$/);
    await expect(service.status(created.id, created.ticket)).rejects.toMatchObject({
      code: 'DESKTOP_SSO_NOT_FOUND',
    });
    await service.start(created.id, created.ticket);
    await expect(service.start(created.id, created.ticket)).rejects.toMatchObject({
      code: 'DESKTOP_SSO_EXPIRED',
    });
    const account = (await identity.challengeIdentity('101'))!;
    const approval = await service.bindIdentity(created.id, account);
    await expect(service.status(created.id, approval.secret)).rejects.toMatchObject({
      code: 'DESKTOP_SSO_NOT_FOUND',
    });
    expect((await service.approval(approval)).user.id).toBe('101');
  });
  it('requires explicit matching browser code and commits failed attempts/lockout', async () => {
    const { service, created, approval } = await desktopFlow();
    await expect(service.consume(created.id, created.secret)).rejects.toMatchObject({
      code: 'DESKTOP_SSO_NOT_APPROVED',
    });
    const wrong = created.code === '000000' ? '111111' : '000000';
    for (let index = 0; index < 4; index++)
      await expect(service.approve(approval, wrong)).rejects.toMatchObject({
        code: 'DESKTOP_SSO_CODE_INVALID',
      });
    await expect(service.approve(approval, wrong)).rejects.toMatchObject({
      code: 'DESKTOP_SSO_LOCKED',
    });
    const [row] = await db
      .get('writer')
      .select()
      .from(desktopSsoFlows)
      .where(eq(desktopSsoFlows.id, created.id));
    expect(row).toMatchObject({ status: 'locked', approvalAttempts: 5 });
    await expect(service.approve(approval, created.code)).rejects.toMatchObject({
      code: 'DESKTOP_SSO_EXPIRED',
    });
    expect(await db.get('writer').select().from(operatorSessions)).toEqual([]);
  });
  it('authorizes a paired browser and returns exactly one session under20 simultaneous consumptions', async () => {
    const { service, created, approval } = await desktopFlow();
    await service.approve(approval, created.code);
    expect((await service.status(created.id, created.secret)).status).toBe('authorized');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.consume(created.id, created.secret)),
    );
    expect(new Set(results.map((value) => value.credential.sessionId)).size).toBe(1);
    expect(new Set(results.map((value) => value.credential.secret)).size).toBe(1);
    expect(results.every((value) => value.user.id === '101')).toBe(true);
    expect(await db.get('writer').select().from(operatorSessions)).toHaveLength(1);
    expect(await sessions.valid('101', results[0]!.credential)).toBe(true);
    const [row] = await db
      .get('writer')
      .select()
      .from(desktopSsoFlows)
      .where(eq(desktopSsoFlows.id, created.id));
    expect(row).toMatchObject({ status: 'consumed' });
    expect(row?.consumedCredential).not.toContain(results[0]!.credential.secret);
  }, 20_000);
  it('rechecks current authentication versions and archived accounts at approval and consumption', async () => {
    const first = await desktopFlow();
    await db.get('writer').update(PosUser).set({ role: 4 }).where(eq(PosUser.id, 101n));
    await expect(first.service.approve(first.approval, first.created.code)).rejects.toMatchObject({
      code: 'DESKTOP_SSO_ACCOUNT_CHANGED',
    });
    const next = await desktopFlow();
    await next.service.approve(next.approval, next.created.code);
    await db.get('writer').update(PosUser).set({ is_active: false }).where(eq(PosUser.id, 101n));
    await expect(next.service.consume(next.created.id, next.created.secret)).rejects.toMatchObject({
      code: 'DESKTOP_SSO_ACCOUNT_CHANGED',
    });
    expect(await db.get('writer').select().from(operatorSessions)).toEqual([]);
  });
  it('rolls back session creation when the late consumption receipt fails and retries without an orphan session', async () => {
    const { service, created, approval } = await desktopFlow();
    await service.approve(approval, created.code);
    await connection.query(
      "CREATE TRIGGER fixture_sso_late_failure BEFORE UPDATE ON pos_rewrite_desktop_sso_flows FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture rollback'",
    );
    try {
      await expect(service.consume(created.id, created.secret)).rejects.toThrow();
      expect(await db.get('writer').select().from(operatorSessions)).toEqual([]);
      const [row] = await db
        .get('writer')
        .select()
        .from(desktopSsoFlows)
        .where(eq(desktopSsoFlows.id, created.id));
      expect(row).toMatchObject({ status: 'authorized', consumedCredential: null });
    } finally {
      await connection.query('DROP TRIGGER fixture_sso_late_failure');
    }
    const saved = await service.consume(created.id, created.secret);
    expect(await sessions.valid('101', saved.credential)).toBe(true);
    expect(await db.get('writer').select().from(operatorSessions)).toHaveLength(1);
  });
  it('never mints a replacement from a revoked receipt and atomically cancels a consumed session', async () => {
    const first = await desktopFlow();
    await first.service.approve(first.approval, first.created.code);
    const saved = await first.service.consume(first.created.id, first.created.secret);
    await sessions.revoke(saved.credential.sessionId);
    await expect(
      first.service.consume(first.created.id, first.created.secret),
    ).rejects.toMatchObject({ code: 'DESKTOP_SSO_EXPIRED' });
    const next = await desktopFlow();
    await next.service.approve(next.approval, next.created.code);
    const active = await next.service.consume(next.created.id, next.created.secret);
    await next.service.cancel(next.created.id, next.created.secret);
    expect(await sessions.valid('101', active.credential)).toBe(false);
    expect((await next.service.status(next.created.id, next.created.secret)).status).toBe(
      'cancelled',
    );
    await expect(next.service.consume(next.created.id, next.created.secret)).rejects.toMatchObject({
      code: 'DESKTOP_SSO_NOT_APPROVED',
    });
  });
  it('expires and bounds cleanup without accepting a guessed or cross-flow proof', async () => {
    const first = await desktopFlow(),
      next = await desktopFlow();
    await expect(first.service.status(first.created.id, next.created.secret)).rejects.toMatchObject(
      { code: 'DESKTOP_SSO_NOT_FOUND' },
    );
    timestamp += 600001;
    await expect(
      first.service.status(first.created.id, first.created.secret),
    ).rejects.toMatchObject({ code: 'DESKTOP_SSO_EXPIRED' });
    await pruneDesktopSsoFlows(db, timestamp, 1);
    expect(await db.get('writer').select().from(desktopSsoFlows)).toHaveLength(1);
    await pruneDesktopSsoFlows(db, timestamp, 1);
    expect(await db.get('writer').select().from(desktopSsoFlows)).toEqual([]);
  });
  it('pairs a separate browser cookie jar and recovers the same desktop session without revoking itself', async () => {
    const configured = ssoConfig(),
      service = desktopService();
    let initiated: SsoState | undefined;
    const provider: GoogleSsoProvider = {
      async authorization(state) {
        initiated = state;
        return new URL(googleIssuer + '/o/oauth2/v2/auth?state=' + state.state);
      },
      async verify(_callback, state) {
        expect(state).toEqual(initiated);
        return googleProof();
      },
    };
    const local = Fastify({ logger: false });
    await local.register(cookie);
    registerAuth(local, configured, identity, demoUser, sessions, challenges, {
      sso: provider,
      desktopSso: service,
    });
    registerDesktopSso(local, configured, service, sessions);
    local.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof AppError ? error.status : 500)
        .send({ error: 'Fixture sign-in rejected' }),
    );
    try {
      const create = await local.inject({
        method: 'POST',
        url: '/api/v1/auth/desktop-sso-sessions',
        payload: {},
        headers: { origin: config.WEB_ORIGIN },
      });
      expect(create.statusCode).toBe(200);
      const created = create.json<{
        id: string;
        code: string;
        expires: number;
        browserUrl: string;
      }>();
      expect(create.json()).not.toHaveProperty('secret');
      const clientCookie = create.cookies.find((entry) => entry.name === 'pos_desktop_sso_client')!;
      expect(clientCookie.httpOnly).toBe(true);
      expect(create.headers['cache-control']).toBe('private, no-store');
      const browserUrl = new URL(created.browserUrl);
      expect(browserUrl.origin).toBe(config.WEB_ORIGIN);
      expect(browserUrl.searchParams.has('secret')).toBe(false);
      expect(browserUrl.searchParams.has('code')).toBe(false);
      const start = await local.inject(browserUrl.pathname + browserUrl.search);
      expect(start.statusCode).toBe(302);
      const oidcCookie = start.cookies.find((entry) => entry.name === 'pos_oidc')!;
      const verified = await local.inject({
        url: '/api/v1/auth/sso/callback?code=fixture&state=' + initiated!.state,
        cookies: { pos_oidc: oidcCookie.value },
      });
      expect(verified.statusCode).toBe(302);
      expect(verified.headers.location).toBe(config.WEB_ORIGIN + '/desktop-sign-in');
      expect(verified.cookies.some((entry) => entry.name === 'pos_session')).toBe(false);
      const approvalCookie = verified.cookies.find((entry) => entry.name === 'pos_desktop_sso')!;
      expect(approvalCookie.httpOnly).toBe(true);
      const browser = { pos_desktop_sso: approvalCookie.value };
      expect(
        (await local.inject({ url: '/api/v1/auth/desktop-sso/approval', cookies: browser })).json<{
          user: { id: string };
        }>().user.id,
      ).toBe('101');
      const approved = await local.inject({
        method: 'POST',
        url: '/api/v1/auth/desktop-sso/approval',
        cookies: browser,
        headers: { origin: config.WEB_ORIGIN },
        payload: { code: created.code },
      });
      expect(approved.statusCode).toBe(200);
      const headers = { origin: config.WEB_ORIGIN };
      const first = await local.inject({
        method: 'POST',
        url: `/api/v1/auth/desktop-sso-sessions/${created.id}/consumptions`,
        headers,
        cookies: { pos_desktop_sso_client: clientCookie.value },
        payload: {},
      });
      expect(first.statusCode).toBe(200);
      const firstCookie = first.cookies.find((entry) => entry.name === 'pos_session')!;
      const again = await local.inject({
        method: 'POST',
        url: `/api/v1/auth/desktop-sso-sessions/${created.id}/consumptions`,
        headers,
        cookies: { pos_session: firstCookie.value, pos_desktop_sso_client: clientCookie.value },
        payload: {},
      });
      expect(again.statusCode).toBe(200);
      const secondCookie = again.cookies.find((entry) => entry.name === 'pos_session')!;
      expect(
        (
          await local.inject({
            url: '/api/v1/auth/sessions/current',
            cookies: { pos_session: secondCookie.value },
          })
        ).statusCode,
      ).toBe(200);
      expect(await db.get('writer').select().from(operatorSessions)).toHaveLength(1);
    } finally {
      await local.close();
    }
  });
  it('rejects cross-origin desktop creation, missing browser proof and malformed private selectors', async () => {
    const configured = ssoConfig(),
      local = Fastify({ logger: false });
    await local.register(cookie);
    registerAuth(local, configured, identity, demoUser, sessions, challenges);
    registerDesktopSso(local, configured, desktopService(), sessions);
    local.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500)
        .send({ error: 'Fixture request rejected' }),
    );
    try {
      expect(
        (
          await local.inject({
            method: 'POST',
            url: '/api/v1/auth/desktop-sso-sessions',
            payload: {},
            headers: { origin: 'https://attacker.example.test' },
          })
        ).statusCode,
      ).toBe(403);
      expect((await local.inject('/api/v1/auth/desktop-sso/approval')).statusCode).toBe(401);
      expect((await local.inject('/api/v1/auth/sso/login?desktop=invalid')).statusCode).toBe(400);
      expect(await db.get('writer').select().from(desktopSsoFlows)).toEqual([]);
    } finally {
      await local.close();
    }
  });
  it('enrolls a stable Google subject only for an existing active POS operator', async () => {
    expect(identity.byGoogleIdentity).toBeDefined();
    const account = await identity.byGoogleIdentity!(googleProof());
    expect(account?.user).toMatchObject({ id: '101', role: 5, userType: 1, storeIds: ['1'] });
    const [binding] = await db.get('writer').select().from(googleIdentities);
    expect(binding).toMatchObject({ subject: '1000000000001', operatorId: '101' });
    expect(JSON.stringify(binding)).not.toContain('example.test');
    await expect(
      identity.byGoogleIdentity!({ ...googleProof(), email: 'unprovisioned@example.test' }),
    ).resolves.toBeNull();
  });
  it('serializes20 identical Google enrollments and never replaces an enrolled subject', async () => {
    const accounts = await Promise.all(
      Array.from({ length: 20 }, () => identity.byGoogleIdentity!(googleProof())),
    );
    expect(accounts.every((account) => account?.user.id === '101')).toBe(true);
    expect(await db.get('writer').select().from(googleIdentities)).toHaveLength(1);
    await expect(
      identity.byGoogleIdentity!({ ...googleProof(), subject: 'different-google-subject' }),
    ).rejects.toMatchObject({ code: 'SSO_IDENTITY_CHANGED' });
  }, 20_000);
  it('rejects a Google subject already linked to a different operator', async () => {
    await identity.byGoogleIdentity!(googleProof());
    await seed(PosUser, {
      id: 102,
      username: 'other-google-operator',
      email: 'other@example.test',
      role: 4,
      user_type: 1,
      is_active: true,
      phone: '1000000001',
    });
    await expect(
      identity.byGoogleIdentity!({ ...googleProof(), email: 'other@example.test' }),
    ).rejects.toMatchObject({ code: 'SSO_IDENTITY_CHANGED' });
    expect(await db.get('writer').select().from(googleIdentities)).toHaveLength(1);
  });
  it('denies inactive/invalid operator roles and ambiguous or accent-equivalent email rows', async () => {
    for (const patch of [{ is_active: false }, { role: 0 }, { user_type: 0 }]) {
      await db
        .get('writer')
        .update(PosUser)
        .set({ is_active: true, role: 5, user_type: 1, ...patch })
        .where(eq(PosUser.id, 101n));
      expect(await identity.byGoogleIdentity!(googleProof())).toBeNull();
    }
    await db
      .get('writer')
      .update(PosUser)
      .set({ is_active: true, role: 5, user_type: 1 })
      .where(eq(PosUser.id, 101n));
    await seed(PosUser, {
      id: 102,
      username: 'duplicate-google-email',
      email: 'FIXTURE@example.test',
      role: 4,
      user_type: 1,
      is_active: true,
      phone: '1000000001',
    });
    expect(await identity.byGoogleIdentity!(googleProof())).toBeNull();
    await db.get('writer').delete(PosUser).where(eq(PosUser.id, 102n));
    await db
      .get('writer')
      .update(PosUser)
      .set({ email: 'fixturé@example.test' })
      .where(eq(PosUser.id, 101n));
    expect(await identity.byGoogleIdentity!(googleProof())).toBeNull();
    expect(await db.get('writer').select().from(googleIdentities)).toEqual([]);
  });
  it('rolls back nested session creation and login timestamp with its caller transaction', async () => {
    const current = await identity.challengeIdentity('101');
    if (!current || !sessions.createInTransaction)
      throw new Error('Native session primitive is unavailable');
    const create = sessions.createInTransaction;
    const [before] = await db
      .get('writer')
      .select({ lastLogin: PosUser.last_login })
      .from(PosUser)
      .where(eq(PosUser.id, 101n));
    const issued: SessionCredential[] = [];
    await expect(
      db.get('writer').transaction(async (tx) => {
        issued.push(
          await create(tx, '101', Date.now() + 60000, current.authVersion, '2026-11-16 12:00:00'),
        );
        throw new Error('Fixture late caller rollback');
      }),
    ).rejects.toThrow('Fixture late caller rollback');
    expect(issued).toHaveLength(1);
    expect(
      await db
        .get('writer')
        .select()
        .from(operatorSessions)
        .where(eq(operatorSessions.id, issued[0]!.sessionId)),
    ).toEqual([]);
    const [after] = await db
      .get('writer')
      .select({ lastLogin: PosUser.last_login })
      .from(PosUser)
      .where(eq(PosUser.id, 101n));
    expect(after).toEqual(before);
  });
  it('runs the web SSO cookie callback through native subject binding, session creation and access revocation', async () => {
    let initiated: SsoState | undefined;
    const google: GoogleSsoProvider = {
      async authorization(value) {
        initiated = value;
        return new URL(googleIssuer + '/o/oauth2/v2/auth?state=' + value.state);
      },
      async verify(url, state) {
        expect(state).toEqual(initiated);
        expect(url.searchParams.get('state')).toBe(state.state);
        return googleProof();
      },
    };
    const local = Fastify({ logger: false });
    await local.register(cookie);
    const configured = {
      ...config,
      OIDC_ISSUER: googleIssuer,
      OIDC_CLIENT_ID: 'fixture.apps.googleusercontent.com',
      OIDC_CLIENT_SECRET: 'fixture-google-client-secret',
      OIDC_REDIRECT_URI: 'http://localhost:5173/api/v1/auth/sso/callback',
      OIDC_EMAIL_DOMAINS: ['example.test'],
    };
    registerAuth(local, configured, identity, demoUser, sessions, challenges, { sso: google });
    local.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof AppError ? error.status : 500)
        .send({ error: 'Fixture authentication rejected' }),
    );
    try {
      const start = await local.inject('/api/v1/auth/sso/login');
      expect(start.statusCode).toBe(302);
      const stateCookie = start.cookies.find((entry) => entry.name === 'pos_oidc')!;
      expect(stateCookie.httpOnly).toBe(true);
      const callback = await local.inject({
        url: '/api/v1/auth/sso/callback?code=fixture&state=' + initiated!.state,
        cookies: { pos_oidc: stateCookie.value },
      });
      expect(callback.statusCode).toBe(302);
      const sessionCookie = callback.cookies.find((entry) => entry.name === 'pos_session')!;
      expect(sessionCookie.httpOnly).toBe(true);
      const read = () =>
        local.inject({
          url: '/api/v1/auth/sessions/current',
          cookies: { pos_session: sessionCookie.value },
        });
      expect(
        (await read()).json<{ user: { id: string; storeIds: string[] } }>().user,
      ).toMatchObject({ id: '101', storeIds: ['1'] });
      await db.get('writer').update(PosUser).set({ is_active: false }).where(eq(PosUser.id, 101n));
      expect((await read()).statusCode).toBe(401);
    } finally {
      await local.close();
    }
  });
  it('gates daily reports by the checked-in store and exact ALL rollout for all authenticated roles', async () => {
    const user = (await identity.get('101'))!;
    await expect(assertDailyReportingEnabled(config, db, user)).rejects.toMatchObject({
      code: 'FEATURE_NOT_ENABLED',
    });
    await expect(
      assertDailyReportingEnabled({ ...config, DAY_CLOSE_ENABLED_STORE_IDS: 'ALL' }, db, user),
    ).resolves.toBeUndefined();
    await expect(
      assertDailyReportingEnabled({ ...config, DAY_CLOSE_ENABLED_STORE_IDS: 'ALL,COCO' }, db, user),
    ).rejects.toMatchObject({ code: 'FEATURE_NOT_ENABLED' });
    await expect(
      assertDailyReportingEnabled(config, db, { ...user, role: 1 }),
    ).resolves.toBeUndefined();
    await checkInService(db, config).set(user, '1', null);
    await db.get('writer').update(Store).set({ category: 'IN_HOUSE' }).where(eq(Store.id, 1n));
    await expect(assertDailyReportingEnabled(config, db, user)).resolves.toBeUndefined();
    await expect(
      assertDailyReportingEnabled({ ...config, DAY_CLOSE_ENABLED_STORE_IDS: '001' }, db, user),
    ).resolves.toBeUndefined();
  });
  it('issues no session before OTP and checks into the authorized store before issuing a revocable session', async () => {
    const password = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions',
      payload: { username: 'fixture', password: 'fixture-password' },
    });
    expect(password.statusCode).toBe(202);
    expect(password.cookies.some((value) => value.name === 'pos_session')).toBe(false);
    const pending = password.cookies.find((value) => value.name === 'pos_pending_login')!;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/sessions/current',
          cookies: { pos_pending_login: pending.value },
        })
      ).statusCode,
    ).toBe(401);
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/challenges/current/verifications',
      cookies: { pos_pending_login: pending.value },
      payload: { code: sent[0]!.code, factor: 'otp', storeId: '1' },
    });
    expect(verified.statusCode).toBe(200);
    const full = verified.cookies.find((value) => value.name === 'pos_session')!;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/sessions/current',
          cookies: { pos_session: full.value },
        })
      ).statusCode,
    ).toBe(200);
    expect(await checkInService(db, config).checkedInStore('101')).toBe('1');
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/v1/auth/sessions/current',
          cookies: { pos_session: full.value },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/sessions/current',
          cookies: { pos_session: full.value },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('permanently discards pending password proof when signing out before completing MFA', async () => {
    const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions',
        payload: { username: 'fixture', password: 'fixture-password' },
      }),
      cookie = response.cookies.find((value) => value.name === 'pos_pending_login');
    if (!cookie) throw new Error('Expected pending fixture cookie.');
    const logout = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions/current',
      cookies: {
        pos_pending_login: cookie.value,
        pos_oidc: seal(
          {
            state: 'fixture-state',
            nonce: 'fixture-nonce',
            verifier: 'fixture-verifier',
            expires: Date.now() + 600000,
          },
          config.SESSION_SECRET,
        ),
      },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.cookies.find((value) => value.name === 'pos_oidc')).toMatchObject({
      value: '',
      path: '/api/v1/auth',
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/challenges/current/verifications',
      cookies: { pos_pending_login: cookie.value },
      payload: { code: sent.at(-1)!.code, factor: 'otp', storeId: '1' },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: 'LOGIN_CHALLENGE_EXPIRED' } });
  });
  it('records last_login only after a completed authenticated login, preserving it during ordinary session rotation', async () => {
    const [before] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT CAST(last_login AS CHAR) AS value FROM pos_user WHERE id=101',
    );
    expect(before[0]?.value).toBeNull();
    const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions',
        payload: { username: 'fixture', password: 'fixture-password' },
      }),
      cookie = response.cookies.find((value) => value.name === 'pos_pending_login');
    expect(response.statusCode).toBe(202);
    if (!cookie) throw new Error('Expected pending login fixture.');
    const [pending] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT CAST(last_login AS CHAR) AS value FROM pos_user WHERE id=101',
    );
    expect(pending[0]?.value).toBeNull();
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/challenges/current/verifications',
      cookies: { [cookie.name]: cookie.value },
      payload: { code: sent.at(-1)!.code, factor: 'otp', storeId: '1' },
    });
    expect(verified.statusCode).toBe(200);
    const [completed] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT CAST(last_login AS CHAR) AS value FROM pos_user WHERE id=101',
    );
    expect(completed[0]?.value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    await connection.execute("UPDATE pos_user SET last_login='2000-01-01 01:02:03' WHERE id=101");
    await sessions.create('101');
    const [rotated] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT CAST(last_login AS CHAR) AS value FROM pos_user WHERE id=101',
    );
    expect(rotated[0]?.value).toBe('2000-01-01 01:02:03');
  });
  it('enforces shared failures, retry pauses, resend cooldown and account lockout across challenges', async () => {
    const one = await begin();
    const wrong = sent[0]!.code === '999999' ? '888888' : '999999';
    await expect(challenges.verify(one.credential, wrong, 'otp', '1')).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
    await expect(challenges.verify(one.credential, wrong, 'otp', '1')).rejects.toMatchObject({
      code: 'LOGIN_RETRY_WAIT',
    });
    await expect(challenges.resend(one.credential)).rejects.toMatchObject({
      code: 'LOGIN_RESEND_WAIT',
    });
    timestamp += 31000;
    const two = await begin();
    await expect(
      challenges.verify(
        two.credential,
        sent.at(-1)!.code === '999999' ? '888888' : '999999',
        'otp',
        '1',
      ),
    ).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
    timestamp += 31000;
    await challenges.resend(two.credential);
    const wrongAgain = sent.at(-1)!.code === '999999' ? '888888' : '999999';
    await expect(challenges.verify(two.credential, wrongAgain, 'otp', '1')).rejects.toMatchObject({
      code: 'LOGIN_LOCKED',
    });
    expect((await db.get('writer').select().from(loginSecurity))[0]).toMatchObject({
      failedCount: 0,
      otpHash: null,
      alertPending: true,
    });
    await expect(begin()).rejects.toMatchObject({ code: 'LOGIN_LOCKED' });
    const alerts = await db.get('writer').select().from(securityAlerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ userId: '101', failedAttempts: 3, state: 'pending' });
    let sends = 0;
    const events: SecurityWorkerEvent[] = [];
    const options = securityWorkerOptions({
      AUTH_SECURITY_WORKER_ENABLED: 'true',
      LOGIN_SECURITY_SLACK_WEBHOOK: 'https://hooks.slack.com/services/fixture-token',
    });
    const fetcher: typeof fetch = async () => {
      sends++;
      await setTimeout(10);
      return new Response('ok');
    };
    const workers = [
      securityAlertWorker(
        db,
        options,
        (event) => events.push(event),
        fetcher,
        () => timestamp,
      ),
      securityAlertWorker(
        db,
        options,
        (event) => events.push(event),
        fetcher,
        () => timestamp,
      ),
    ];
    await Promise.all(workers.map((worker) => worker.runOnce()));
    expect(sends).toBe(1);
    expect((await db.get('writer').select().from(securityAlerts))[0]!.state).toBe('sent');
    expect(events.find((event) => event.alertId)).toMatchObject({
      userId: '101',
      resource: 'login-security-alert',
    });
    expect(JSON.stringify(events)).not.toContain('fixture-token');
    await Promise.all(workers.map((worker) => worker.stop()));
  });
  it('consumes a delivered code exactly once under ten simultaneous verifications', async () => {
    const challenge = await begin();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        challenges.verify(challenge.credential, sent[0]!.code, 'otp', '1'),
      ),
    );
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    const [row] = await db
      .get('writer')
      .select()
      .from(loginChallenges)
      .where(eq(loginChallenges.id, challenge.credential.id));
    expect(row!.completedAt).not.toBeNull();
    expect((await db.get('writer').select().from(loginSecurity))[0]!.otpHash).toBeNull();
  });
  it('retries only due security alerts and never logs transport details', async () => {
    const alertId = crypto.randomUUID(),
      requestId = crypto.randomUUID(),
      events: SecurityWorkerEvent[] = [];
    await db
      .get('writer')
      .insert(securityAlerts)
      .values({
        id: alertId,
        userId: '101',
        requestId,
        factor: 'otp',
        failedAttempts: 3,
        lockedUntil: new Date(timestamp + 10800000),
        createdAt: new Date(timestamp),
        state: 'pending',
        attempts: 0,
        availableAt: new Date(timestamp),
      });
    let requests = 0;
    const worker = securityAlertWorker(
      db,
      securityWorkerOptions({
        AUTH_SECURITY_WORKER_ENABLED: 'true',
        LOGIN_SECURITY_SLACK_WEBHOOK: 'https://hooks.slack.com/services/fixture-token',
      }),
      (event) => events.push(event),
      async () => {
        requests++;
        if (requests === 1) throw new Error('PRIVATE-PROVIDER-CANARY fixture@example.test');
        return new Response('ok');
      },
      () => timestamp,
    );
    expect(await worker.runOnce()).toBe(0);
    expect(await worker.runOnce()).toBe(0);
    expect(requests).toBe(1);
    timestamp += 60000;
    expect(await worker.runOnce()).toBe(1);
    expect(requests).toBe(2);
    expect(events.every((event) => event.userId === '101' && event.requestId === requestId)).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toMatch(
      /PRIVATE-PROVIDER-CANARY|fixture@example|fixture-token/,
    );
    await worker.stop();
  });
  it('prunes expired proofs and sessions in bounded batches while keeping current sessions usable', async () => {
    await sessions.create('101', timestamp - 2 * 86400000);
    const current = await sessions.create('101', timestamp + 60000),
      proof = await begin();
    await db
      .get('writer')
      .insert(loginChallenges)
      .values({
        id: crypto.randomUUID(),
        userId: '101',
        proofHash: 'f'.repeat(64),
        authVersion: 'a'.repeat(64),
        expiresAt: new Date(timestamp - 2 * 86400000),
      });
    const worker = securityAlertWorker(
      db,
      securityWorkerOptions({
        AUTH_SECURITY_WORKER_ENABLED: 'true',
        LOGIN_SECURITY_SLACK_WEBHOOK: 'https://hooks.slack.com/services/fixture-token',
      }),
      () => {},
      async () => new Response('ok'),
      () => timestamp,
    );
    await worker.runOnce();
    expect(await sessions.valid('101', current)).toBe(true);
    expect(await db.get('writer').select().from(loginChallenges)).toHaveLength(1);
    expect((await db.get('writer').select().from(loginChallenges))[0]!.id).toBe(
      proof.credential.id,
    );
    await worker.stop();
  });
  it('consumes the correct code before a denied store check-in without granting a session or clearing earlier failures', async () => {
    const challenge = await begin(),
      code = sent[0]!.code;
    await db
      .get('writer')
      .update(loginSecurity)
      .set({ failedCount: 1, failureWindowUntil: new Date(timestamp + 100000) })
      .where(eq(loginSecurity.userId, '101'));
    await expect(challenges.verify(challenge.credential, code, 'otp', '2')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    expect(await checkInService(db, config).checkedInStore('101')).toBeNull();
    const [state] = await db.get('writer').select().from(loginSecurity);
    expect(state).toMatchObject({ otpHash: null, lastAttemptAt: null, failedCount: 1 });
    await expect(challenges.verify(challenge.credential, code, 'otp', '1')).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
  });
  it('accepts source-compatible TOTP while requiring a password-bound challenge', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    await db
      .get('writer')
      .update(PosUser)
      .set({ is_mfa: true, mfa_hash: secret })
      .where(eq(PosUser.id, 101n));
    const challenge = await begin();
    expect(challenge.view.method).toBe('totp');
    expect(sent).toHaveLength(0);
    const code = new TOTP({
      secret: Secret.fromBase32(secret),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    }).generate({ timestamp });
    expect((await challenges.verify(challenge.credential, code, 'totp', '1')).user.id).toBe('101');
  });
  it('invalidates pending challenges and full sessions after a password or MFA contact change', async () => {
    const challenge = await begin(),
      account = await identity.challengeIdentity('101');
    const session = await sessions.create('101', Date.now() + 60000, account!.authVersion);
    expect(await sessions.valid('101', session)).toBe(true);
    await db.get('writer').update(PosUser).set({ phone: '1000000001' }).where(eq(PosUser.id, 101n));
    expect(await sessions.valid('101', session)).toBe(false);
    await expect(challenges.describe(challenge.credential)).rejects.toMatchObject({
      code: 'LOGIN_CHALLENGE_EXPIRED',
    });
    await expect(challenges.resend(challenge.credential)).rejects.toMatchObject({
      code: 'LOGIN_CHALLENGE_EXPIRED',
    });
    await expect(
      challenges.verify(challenge.credential, sent[0]!.code, 'otp', '1'),
    ).rejects.toMatchObject({ code: 'LOGIN_CHALLENGE_EXPIRED' });
    await expect(
      sessions.create('101', Date.now() + 60000, account!.authVersion),
    ).rejects.toMatchObject({ code: 'LOGIN_CHALLENGE_EXPIRED' });
  });
  it('invalidates both pending password proof and current sessions after staff or superuser flag changes', async () => {
    for (const flags of [{ is_staff: true }, { is_superuser: true }]) {
      const challenge = await begin(),
        account = await identity.challengeIdentity('101'),
        session = await sessions.create('101', Date.now() + 60000, account!.authVersion);
      expect(await sessions.valid('101', session)).toBe(true);
      await db.get('writer').update(PosUser).set(flags).where(eq(PosUser.id, 101n));
      expect(await sessions.valid('101', session)).toBe(false);
      await expect(challenges.describe(challenge.credential)).rejects.toMatchObject({
        code: 'LOGIN_CHALLENGE_EXPIRED',
      });
      await expect(
        sessions.create('101', Date.now() + 60000, account!.authVersion),
      ).rejects.toMatchObject({ code: 'LOGIN_CHALLENGE_EXPIRED' });
    }
  });
  it('never revives sessions or pending proofs when credential settings are restored', async () => {
    const challenge = await begin(),
      account = await identity.challengeIdentity('101'),
      session = await sessions.create('101', Date.now() + 60000, account!.authVersion);
    for (const phone of ['1000000001', '1000000000'])
      await db.get('writer').transaction(async (tx) => {
        await tx.select({ id: PosUser.id }).from(PosUser).where(eq(PosUser.id, 101n)).for('update');
        await tx.update(PosUser).set({ phone }).where(eq(PosUser.id, 101n));
        await invalidateOperatorAuthentication(tx, '101');
      });
    expect(await sessions.valid('101', session)).toBe(false);
    await expect(challenges.describe(challenge.credential)).rejects.toMatchObject({
      code: 'LOGIN_CHALLENGE_EXPIRED',
    });
    await expect(
      sessions.create('101', Date.now() + 60000, account!.authVersion),
    ).rejects.toMatchObject({ code: 'LOGIN_CHALLENGE_EXPIRED' });
    const fresh = await identity.challengeIdentity('101');
    expect(fresh!.authVersion).not.toBe(account!.authVersion);
    const next = await sessions.create('101', Date.now() + 60000, fresh!.authVersion);
    expect(await sessions.valid('101', next)).toBe(true);
  });
  it('retains a code after ambiguous delivery and refuses expired password proof', async () => {
    deliveryUncertain = true;
    const challenge = await begin();
    expect(challenge.view.delivery).toBe('uncertain');
    expect((await challenges.verify(challenge.credential, sent[0]!.code, 'otp', '1')).user.id).toBe(
      '101',
    );
    timestamp += 31000;
    const expired = await begin();
    timestamp += config.LOGIN_MFA_PENDING_TTL * 1000;
    await expect(
      challenges.verify(expired.credential, sent.at(-1)!.code, 'otp', '1'),
    ).rejects.toMatchObject({ code: 'LOGIN_CHALLENGE_EXPIRED' });
  });
  it('rejects undeclared or malformed verification inputs at the HTTP boundary', async () => {
    for (const payload of [
      { code: '123456', factor: 'otp', storeId: 'not-an-id' },
      { code: '12345', factor: 'otp', storeId: '1' },
      { code: '123456', factor: 'otp', storeId: '1', userId: 'other-user' },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/challenges/current/verifications',
            payload,
          })
        ).statusCode,
      ).toBe(400);
    await expect(identity.login('fixture', 'wrong-password')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
  });
  it('changes a password through HTTP and invalidates every prior session', async () => {
    const first = await sessions.create('101', Date.now() + 60000);
    const other = await sessions.create('101', Date.now() + 60000);
    const cookies = { pos_session: seal({ id: '101', ...first }, config.SESSION_SECRET) };
    const payload = {
      currentPassword: 'fixture-password',
      newPassword: 'A different safe phrase! 47',
      confirmation: 'A different safe phrase! 47',
    };
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/v1/operators/current/password',
      cookies,
      payload: { ...payload, confirmation: 'does not match' },
    });
    expect(invalid.statusCode).toBe(400);
    const weak = await app.inject({
      method: 'PUT',
      url: '/api/v1/operators/current/password',
      cookies,
      payload: { ...payload, newPassword: 'password123', confirmation: 'password123' },
    });
    expect(weak.statusCode).toBe(400);
    const changed = await app.inject({
      method: 'PUT',
      url: '/api/v1/operators/current/password',
      cookies,
      payload,
    });
    expect(changed.statusCode).toBe(200);
    expect(await sessions.valid('101', first)).toBe(false);
    expect(await sessions.valid('101', other)).toBe(false);
    const renewed = changed.cookies.find((value) => value.name === 'pos_session')!;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/sessions/current',
          cookies: { pos_session: renewed.value },
        })
      ).statusCode,
    ).toBe(200);
    const [row] = await db.get('writer').select().from(PosUser);
    expect(await verifyDjangoPassword(payload.newPassword, row!.password)).toBe(true);
    expect(changed.body).not.toContain(row!.password);
    expect(changed.body).not.toContain(payload.newPassword);
    expect(changed.body).not.toContain('mfa_hash');
  });
  it('enforces self-profile contact rules, password proof, uniqueness and stale revisions', async () => {
    await db.get('writer').update(PosUser).set({ phone: '2222222222' }).where(eq(PosUser.id, 101n));
    const service = profileService(config, db);
    const actor = (await identity.get('101'))!;
    const view = await service.get(actor);
    const fields = profileInput.parse({
      revision: view.revision,
      firstName: view.firstName,
      lastName: view.lastName,
      gender: view.gender,
      age: view.age,
      email: view.email,
      phone: view.phone,
      contactEmail: view.contactEmail,
      otpMethod: view.otpMethod,
    });
    await expect(
      service.update(actor, { ...fields, email: 'another@example.test' }),
    ).rejects.toMatchObject({ code: 'PROFILE_CONTACT_CHANGE_DENIED' });
    await expect(
      service.update(actor, { ...fields, contactEmail: 'another@example.test' }),
    ).rejects.toMatchObject({ code: 'CURRENT_PASSWORD_INVALID' });
    const renamed = await service.update(actor, { ...fields, firstName: 'Updated' });
    expect(renamed.profile.firstName).toBe('Updated');
    expect(renamed.credentialsChanged).toBe(false);
    await expect(service.update(actor, fields)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' });
    await seed(PosUser, {
      id: 102,
      username: 'second',
      contact_email: 'occupied@example.test',
      role: 5,
      user_type: 1,
      is_active: true,
    });
    await expect(
      service.update(actor, {
        ...fields,
        revision: renamed.profile.revision,
        contactEmail: 'occupied@example.test',
        currentPassword: 'fixture-password',
      }),
    ).rejects.toMatchObject({ code: 'PROFILE_CONTACT_UNAVAILABLE' });
    const prior = await sessions.create('101', Date.now() + 60000);
    const updated = await service.update(actor, {
      ...fields,
      revision: renamed.profile.revision,
      contactEmail: 'another@example.test',
      currentPassword: 'fixture-password',
    });
    expect(updated.credentialsChanged).toBe(true);
    expect(await sessions.valid('101', prior)).toBe(false);
  });
  it('binds image uploads to the owner and revision, verifies before attachment, and streams privately', async () => {
    const actor = (await identity.get('101'))!,
      profiles = profileService(config, db),
      media = profileMediaService(config, db, imageStore, () => timestamp);
    await db
      .get('writer')
      .update(PosUser)
      .set({ profile_image: 'uploads/users/profile_image/default_profile_image.png' })
      .where(eq(PosUser.id, 101n));
    const profile = await profiles.get(actor),
      id = crypto.randomUUID();
    const input = profileUploadInput.parse({
      revision: profile.revision,
      upload: {
        id,
        kind: 'image',
        name: 'fixture.png',
        contentType: 'image/png',
        size: imageBytes.length,
        checksum: imageChecksum,
      },
    });
    const credential = await sessions.create('101', Date.now() + 60000);
    const cookies = { pos_session: seal({ id: '101', ...credential }, config.SESSION_SECRET) };
    const reserved = await app.inject({
      method: 'POST',
      url: '/api/v1/operators/current/profile/image-uploads',
      cookies,
      payload: input,
    });
    expect(reserved.statusCode).toBe(200);
    await expect(media.attach({ ...actor, id: '102' }, id, profile.revision)).rejects.toMatchObject(
      { code: 'PROFILE_UPLOAD_NOT_FOUND' },
    );
    verificationFails = true;
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/operators/current/profile/image-uploads/${id}/attachment`,
      cookies,
      payload: { revision: profile.revision },
    });
    expect(rejected.statusCode).toBe(400);
    expect((await db.get('writer').select().from(PosUser))[0]!.profile_image).toContain(
      'default_profile_image',
    );
    verificationFails = false;
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/operators/current/profile/image-uploads/${id}/attachment`,
      cookies,
      payload: { revision: profile.revision },
    });
    expect(accepted.statusCode).toBe(200);
    await media.attach(actor, id, profile.revision);
    expect(verifiedImages).toHaveLength(2);
    const image = await app.inject({
      method: 'GET',
      url: '/api/v1/operators/current/profile/images/image',
      cookies,
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['content-security-policy']).toContain("default-src 'none'");
    expect(image.headers['cache-control']).toBe('private, no-store');
    const next = profileUploadInput.parse({
      ...input,
      revision: (await profiles.get(actor)).revision,
      upload: { ...input.upload, id: crypto.randomUUID() },
    });
    await media.reserve(actor, next);
    await db
      .get('writer')
      .update(PosUser)
      .set({ first_name: 'Changed while uploading' })
      .where(eq(PosUser.id, 101n));
    await expect(media.attach(actor, next.upload.id, next.revision)).rejects.toMatchObject({
      code: 'PROFILE_CHANGED',
    });
    expect((await db.get('writer').select().from(PosUser))[0]!.profile_image).toContain(id);
    expect(await db.get('writer').select().from(profileMediaJobs)).toHaveLength(2);
  });
  it('retries orphan cleanup, retains all referenced images, and never deletes default or legacy objects', async () => {
    const actor = (await identity.get('101'))!,
      profiles = profileService(config, db),
      media = profileMediaService(config, db, imageStore, () => timestamp);
    const ids: string[] = [];
    for (let index = 0; index < 2; index++) {
      const id = crypto.randomUUID(),
        revision = (await profiles.get(actor)).revision;
      await media.reserve(
        actor,
        profileUploadInput.parse({
          revision,
          upload: {
            id,
            kind: 'image',
            name: 'fixture.png',
            contentType: 'image/png',
            size: imageBytes.length,
            checksum: imageChecksum,
          },
        }),
      );
      await media.attach(actor, id, revision);
      ids.push(id);
    }
    expect(await db.get('writer').select().from(profileMediaJobs)).toHaveLength(2);
    timestamp += 16 * 60000 + 1;
    const events: ProfileMediaEvent[] = [];
    const first = profileMediaCleanup(
      db,
      imageStore,
      (event) => events.push(event),
      () => timestamp,
    );
    const second = profileMediaCleanup(
      db,
      imageStore,
      (event) => events.push(event),
      () => timestamp,
    );
    deletionFails = true;
    await Promise.all([first.runOnce(), second.runOnce()]);
    expect(removed).toHaveLength(0);
    expect(
      (await db.get('writer').select().from(profileMediaJobs)).some(
        (job) => job.state === 'pending',
      ),
    ).toBe(true);
    deletionFails = false;
    timestamp += 60000;
    await first.runOnce();
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain(ids[0]);
    expect(removed[0]).not.toContain(ids[1]);
    expect(JSON.stringify(events)).not.toMatch(/private-image-canary|example.test|uploads\/users/);
    expect(events.every((event) => event.userId === '101')).toBe(true);
    await expect(
      media.attach(actor, ids[0]!, (await profiles.get(actor)).revision),
    ).rejects.toMatchObject({ code: 'PROFILE_UPLOAD_EXPIRED' });
    await Promise.all([first.stop(), second.stop()]);
  });
  it('allows only one simultaneous save from a shared profile revision', async () => {
    await db
      .get('writer')
      .update(PosUser)
      .set({ phone: '2222222222', role: 1 })
      .where(eq(PosUser.id, 101n));
    const service = profileService(config, db),
      actor = (await identity.get('101'))!,
      view = await service.get(actor);
    const fields = profileInput.parse({
      revision: view.revision,
      firstName: view.firstName,
      lastName: view.lastName,
      gender: view.gender,
      age: view.age,
      email: view.email,
      phone: view.phone,
      contactEmail: view.contactEmail,
      otpMethod: view.otpMethod,
    });
    const results = await Promise.allSettled(
      ['First', 'Second'].map((firstName) => service.update(actor, { ...fields, firstName })),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'PROFILE_CHANGED' });
  });
});
