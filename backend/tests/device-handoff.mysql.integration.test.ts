import { pbkdf2Sync, randomBytes } from 'node:crypto';
import mysql, { type Connection } from 'mysql2/promise';
import { createClient } from 'redis';
import { Secret } from 'otpauth';
import Fastify from 'fastify';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { readConfig, type Config } from '../src/config.js';
import { createDatabases, type Databases } from '../src/db/pools.js';
import { PosUser } from '../src/db/legacy-schema.js';
import type { Principal } from '../src/domain/access.js';
import { AppError } from '../src/domain/errors.js';
import { eq } from 'drizzle-orm';
import {
  deviceHandoffOptions,
  deviceHandoffService,
  type DeviceHandoffOptions,
} from '../src/auth/device-handoff.js';
import {
  redisDeviceHandoffStore,
  type DeviceHandoffStore,
} from '../src/auth/device-handoff-store.js';
import { registerDeviceHandoffs } from '../src/auth/device-handoff-routes.js';
import { connectRedisPort } from '../src/redis/node-client.js';
import type { RedisPort } from '../src/redis/port.js';
import { registerEventCatalog, requestEvent } from '../src/observability/events.js';
import { privateRedisFixture } from './helpers/private-redis.js';
import {
  legacyFixtureRecord,
  legacyFixtureTableSql,
} from '../tools/administration/mysql-fixture.js';

const template = process.env.AUTH_MYSQL_TEST_URL;
describe.skipIf(!template)('device handoff against private Redis and isolated MySQL', () => {
  let db: Databases,
    connection: Connection,
    config: Config,
    store: DeviceHandoffStore,
    port: RedisPort | undefined,
    options: DeviceHandoffOptions,
    cache: ReturnType<typeof createClient>,
    redis: Awaited<ReturnType<typeof privateRedisFixture>>,
    schema: string,
    created = false;
  const principal: Principal = {
    id: '101',
    name: 'Fixture operator',
    email: 'fixture@example.test',
    role: 5,
    userType: 1,
    storeIds: [],
  };
  const password = 'fixture-private-password',
    encoded = `pbkdf2_sha256$10000$fixture-salt$${pbkdf2Sync(password, 'fixture-salt', 10000, 32, 'sha256').toString('base64')}`;
  let clock = 1794787200000;
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_auth_test'
    )
      throw new Error(
        'Device handoff tests require the explicit isolated local auth schema template.',
      );
    schema = `pos_rewrite_auth_test_handoff_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    created = true;
    await connection.changeUser({ database: schema });
    await connection.query(legacyFixtureTableSql(PosUser));
    url.pathname = '/' + schema;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'handoff-integration-fixture-'.repeat(3),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
    });
    db = createDatabases(config);
    redis = await privateRedisFixture();
    cache = createClient({ url: redis.url });
    cache.on('error', () => {});
    await cache.connect();
    port = connectRedisPort(redis.url, 'test');
    store = redisDeviceHandoffStore(port);
    options = deviceHandoffOptions({
      POS_DEVICE_HANDOFF_SERVICE_KEY: 'handoff-fixture-service-key-'.repeat(3),
      UPSTREAM_POS_DEVICE_HANDOFF_CONTRACT: 'pos-auth-qr-v1',
    });
  });
  async function seed(id: number, extra: Record<string, string | number | boolean | null> = {}) {
    const row = legacyFixtureRecord(PosUser, {
        id,
        username: `fixture${id}`,
        email: `fixture${id}@example.test`,
        password: encoded,
        role: 5,
        user_type: 1,
        is_active: true,
        ...extra,
      }),
      keys = Object.keys(row);
    await connection.execute(
      `INSERT INTO pos_user (${keys.map(mysql.escapeId).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((key) => row[key]),
    );
  }
  beforeEach(async () => {
    // This client exists only inside the freshly spawned private Redis process.
    await cache.flushDb();
    await connection.query('DELETE FROM pos_user');
    clock = 1794787200000;
    await seed(101, { email: principal.email });
    await seed(102, { user_type: 2 });
    await seed(103, { is_active: false });
  });
  afterAll(async () => {
    await port?.close();
    if (cache?.isOpen) await cache.close();
    await redis?.close();
    await db?.close();
    if (connection) {
      if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });
  const service = (overrides: Partial<DeviceHandoffOptions> = {}) =>
    deviceHandoffService(
      config,
      db,
      { ...options, ...overrides },
      store,
      { authenticate: async () => null },
      () => clock,
    );
  it('reuses one source-compatible secret and permits exactly one concurrent consumption', async () => {
    const auth = service(),
      issued = await auth.issue(principal),
      first = await cache.get('auth_qr_101');
    expect(first).toMatch(/^[A-Z2-7]{32}$/);
    expect(issued.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(issued.expiresAt - clock).toBe(60000);
    expect((await auth.issue(principal)).revision).toBe(issued.revision);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => auth.verify({ email: principal.email, code: issued.code })),
    );
    expect(results.filter((result) => result.isAuthenticated)).toHaveLength(1);
    expect(results.find((result) => result.isAuthenticated)).toMatchObject({
      operatorId: principal.id,
    });
    expect(await cache.get('auth_qr_101')).not.toBe(first);
    expect(await cache.ttl('auth_qr_101')).toBeGreaterThan(1790);
    expect((await auth.verify({ email: principal.email, code: issued.code })).isAuthenticated).toBe(
      false,
    );
  });
  it('executes the Lua comparison atomically even without the per-account request limiter', async () => {
    const auth = service();
    await auth.issue(principal);
    const current = await store.read(principal.id);
    if (!current) throw new Error('Expected private fixture code.');
    const next = Secret.fromHex(randomBytes(20).toString('hex')).base32;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.consume(
          principal.id,
          current.version,
          current.secret,
          next,
          'fixture-replay-ledger',
          1800,
          120,
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it('rejects password changes, inactive/internal-type changes and ambiguous source email matches', async () => {
    for (const query of [
      "UPDATE pos_user SET password='pbkdf2_sha256$1$changed$hash' WHERE id=101",
      'UPDATE pos_user SET is_active=0 WHERE id=101',
      'UPDATE pos_user SET user_type=2 WHERE id=101',
    ]) {
      await connection.execute(
        'UPDATE pos_user SET password=?,is_active=1,user_type=1 WHERE id=101',
        [encoded],
      );
      const auth = service(),
        issued = await auth.issue(principal);
      await connection.execute(query);
      expect(
        (await auth.verify({ email: principal.email, code: issued.code })).isAuthenticated,
      ).toBe(false);
    }
    await connection.execute('UPDATE pos_user SET user_type=1 WHERE id=101');
    const auth = service(),
      issued = await auth.issue(principal);
    await seed(104, { email: principal.email });
    expect((await auth.verify({ email: principal.email, code: issued.code })).isAuthenticated).toBe(
      false,
    );
    await expect(auth.issue({ ...principal, id: '102' })).rejects.toMatchObject({
      code: 'DEVICE_HANDOFF_DENIED',
    });
    await expect(auth.issue({ ...principal, id: '103' })).rejects.toMatchObject({
      code: 'DEVICE_HANDOFF_DENIED',
    });
  });
  it('requires the source password option and rejects a prior time-step code', async () => {
    const auth = service({ MPOS_QR_TAKE_PASSWORD: true }),
      issued = await auth.issue(principal);
    expect(
      (await auth.verify({ email: principal.email, code: issued.code, password: 'wrong' }))
        .isAuthenticated,
    ).toBe(false);
    expect(
      (await auth.verify({ email: principal.email, code: issued.code, password })).isAuthenticated,
    ).toBe(true);
    const next = await auth.issue(principal);
    clock += 60000;
    expect(
      (await auth.verify({ email: principal.email, code: next.code, password })).isAuthenticated,
    ).toBe(false);
  });
  it('shares the attempt budget across email casing and keeps stale revocation from deleting a newer code', async () => {
    const auth = service(),
      issued = await auth.issue(principal),
      wrong = issued.code === '000000' ? '111111' : '000000';
    for (let index = 0; index < 5; index++)
      expect(
        (
          await auth.verify({
            email: index % 2 ? principal.email.toUpperCase() : principal.email,
            code: wrong,
          })
        ).isAuthenticated,
      ).toBe(false);
    expect((await auth.verify({ email: principal.email, code: issued.code })).isAuthenticated).toBe(
      false,
    );
    await connection.execute(
      "UPDATE pos_user SET password='pbkdf2_sha256$1$rotated$hash' WHERE id=101",
    );
    const next = await auth.issue(principal),
      secret = await cache.get('auth_qr_101');
    expect(next.revision).not.toBe(issued.revision);
    await expect(auth.revoke(principal, issued.revision)).rejects.toMatchObject({
      code: 'DEVICE_HANDOFF_CHANGED',
    });
    expect(await cache.get('auth_qr_101')).toBe(secret);
    await auth.revoke(principal, next.revision);
    await auth.revoke(principal, next.revision);
    expect(await cache.get('auth_qr_101')).toBe(null);
  });
  it('never revives an old QR after the password changes again', async () => {
    const auth = service(),
      issued = await auth.issue(principal);
    for (const password of ['pbkdf2_sha256$1$first$hash', 'pbkdf2_sha256$1$second$hash'])
      await db.get('writer').transaction(async (tx) => {
        await tx.select({ id: PosUser.id }).from(PosUser).where(eq(PosUser.id, 101n)).for('update');
        await tx.update(PosUser).set({ password }).where(eq(PosUser.id, 101n));
      });
    expect((await auth.verify({ email: principal.email, code: issued.code })).isAuthenticated).toBe(
      false,
    );
    expect((await auth.issue(principal)).revision).not.toBe(issued.revision);
  });
  it('limits the displayed lifetime to the earlier source secret expiry', async () => {
    const auth = service();
    await auth.issue(principal);
    await cache.pExpire('auth_qr_101', 500);
    const current = await auth.issue(principal);
    expect(current.expiresAt - clock).toBeLessThanOrEqual(500);
    expect(current.expiresAt - clock).toBeGreaterThanOrEqual(0);
  });
  it('authenticates the service before parsing its body and logs only resource/actor/request identifiers', async () => {
    const auth = service(),
      issued = await auth.issue(principal),
      app = Fastify({ logger: false }),
      events: unknown[] = [];
    app.decorateRequest('principal', null);
    app.decorateRequest('auditUserId', null);
    registerEventCatalog(app);
    app.addHook('preHandler', async (request) => {
      if (request.routeOptions.config.authentication !== 'service') request.principal = principal;
    });
    app.addHook('onResponse', async (request, reply) => {
      events.push(requestEvent(request, reply));
    });
    app.setErrorHandler((error, _request, reply) =>
      error instanceof AppError
        ? reply.code(error.status).send({ code: error.code })
        : reply.code(error instanceof ZodError ? 400 : 500).send({ code: 'INVALID_REQUEST' }),
    );
    registerDeviceHandoffs(app, auth);
    try {
      const path = '/api/v1/auth/device-handoff-verifications',
        body = { email: principal.email, code: issued.code };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path,
            payload: { invalid: 'private-body-canary' },
          })
        ).statusCode,
      ).toBe(401);
      const verified = await app.inject({
        method: 'POST',
        url: path,
        headers: { 'x-pos-auth-key': options.POS_DEVICE_HANDOFF_SERVICE_KEY! },
        payload: body,
      });
      expect(verified.json()).toMatchObject({ isAuthenticated: true, operatorId: principal.id });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/operators/current/device-handoffs',
            payload: { userId: '102' },
          })
        ).statusCode,
      ).toBe(400);
      const text = JSON.stringify(events);
      for (const privateValue of [
        principal.email,
        issued.code,
        options.POS_DEVICE_HANDOFF_SERVICE_KEY!,
        'private-body-canary',
      ])
        expect(text).not.toContain(privateValue);
      expect(text).toContain('identity.device-handoff-verification.create.completed');
      expect(text).toContain('"userId":"101"');
    } finally {
      await app.close();
    }
  });
});
