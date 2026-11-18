import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import mysql, { type Connection } from 'mysql2/promise';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { PosUser, Store, StoreCounter, UserStore } from '../../src/db/legacy-schema.js';
import { invalidateOperatorAuthentication } from '../../src/auth/revocation.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import {
  readApplicationLinkOptions,
  safeApplicationDestination,
} from '../../src/modules/application-links/contracts.js';
import {
  applicationLinkService,
  pruneApplicationLinks,
  registerApplicationLinks,
} from '../../src/modules/application-links/index.js';
import {
  applicationScanReceipts,
  customerApplicationCache,
  customerApplicationLinks,
  sourceApplicationScans,
  staffDownloadGrants,
} from '../../src/modules/application-links/schema.js';
import { packageQrExpiry, scanWallTime } from '../../src/modules/application-links/domain.js';
import type { ApplicationPackage } from '../../src/modules/application-links/artifact.js';
import type { CustomerApplicationProvider } from '../../src/modules/application-links/provider.js';
import {
  legacyFixtureRecord,
  legacyFixtureTableSql,
} from '../../tools/administration/mysql-fixture.js';

const template = process.env.APPLICATION_LINK_MYSQL_TEST_URL;
describe.skipIf(!template)('application links against isolated writer MySQL', () => {
  let connection: Connection,
    db: Databases,
    app: FastifyInstance,
    schemaName: string,
    config: ReturnType<typeof readConfig>,
    service: ReturnType<typeof applicationLinkService>;
  let timestamp = Date.now(),
    artifactOpens = 0,
    providerFailure = false,
    duringDestination: (() => Promise<void>) | undefined;
  const providerCalls: { storeId: string; operationId: string }[] = [],
    bytes = Buffer.from('PK\x03\x04synthetic-approved-package-fixture'),
    checksum = createHash('sha256').update(bytes).digest('hex'),
    options = readApplicationLinkOptions({
      POS_STAFF_APK_ENABLED: 'true',
      POS_STAFF_APK_PATH: '/fixture/approved.apk',
      POS_STAFF_APK_SHA256: checksum,
      POS_STAFF_APK_BYTES: String(bytes.length),
      POS_CUSTOMER_APP_MODE: 'fallback',
    });
  const actor: Principal = {
      id: '1',
      name: 'Fixture operator',
      email: 'fixture@example.test',
      role: 1,
      userType: 1,
      storeIds: ['1', '2'],
    },
    franchise: Principal = { ...actor, id: '2', userType: 2, storeIds: ['2'] },
    staff: Principal = { ...actor, id: '3', role: 5, storeIds: ['1'] };
  const artifact: ApplicationPackage = {
    async describe() {
      return { filename: 'mpos.apk', checksum, bytes: bytes.length };
    },
    async open() {
      artifactOpens++;
      return {
        metadata: { bytes: bytes.length, checksum, filename: 'mpos.apk' },
        stream: Readable.from([bytes]),
      };
    },
    async close() {},
  };
  const provider: CustomerApplicationProvider = {
    configurationVersion: 'b'.repeat(64),
    accepts(value) {
      return safeApplicationDestination(value, ['https://www.thesouledstore.com']);
    },
    async destination(storeId, operationId) {
      providerCalls.push({ storeId, operationId });
      await duringDestination?.();
      if (providerFailure)
        throw new AppError(
          503,
          'CUSTOMER_APPLICATION_UNAVAILABLE',
          'The customer application link is temporarily unavailable.',
        );
      return `https://www.thesouledstore.com/app/store-${storeId}`;
    },
  };
  const token = (url: string) => new URL(url).hash.slice(1);
  async function seed(
    table: MySqlTable,
    values: Record<string, string | number | bigint | boolean | null>,
  ) {
    const record = legacyFixtureRecord(table, values),
      names = Object.keys(record);
    await connection.execute(
      `INSERT INTO ${mysql.escapeId(getTableConfig(table).name)} (${names.map(mysql.escapeId).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      names.map((name) => record[name]),
    );
  }
  async function script(path: string) {
    for (const statement of readFileSync(new URL(path, import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean))
      await connection.query(statement);
  }
  async function consume(stream: Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Expected package bytes.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function scanCount() {
    const [row] = await db
      .get('writer')
      .select({ value: sql<string>`cast(count(*) as char)` })
      .from(sourceApplicationScans);
    return row!.value;
  }
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_application_links_test'
    )
      throw new Error('Use the explicitly isolated local application-link schema template.');
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    schemaName = `pos_rewrite_application_links_test_${process.pid}_${randomUUID().slice(0, 8)}`;
    await connection.query(
      'CREATE DATABASE ' +
        mysql.escapeId(schemaName) +
        ' CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci',
    );
    await connection.changeUser({ database: schemaName });
    for (const table of [PosUser, Store, StoreCounter, UserStore])
      await connection.query(legacyFixtureTableSql(table));
    await connection.query(
      'CREATE TABLE pos_to_app_logs(id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,store_id INT NOT NULL DEFAULT 0,scanned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB',
    );
    await script('../../src/modules/administration/migration.sql');
    await script('../../src/modules/administration/mfa-migration.sql');
    await script('../../src/modules/application-links/migration.sql');
    url.pathname = '/' + schemaName;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'isolated-application-link-secret-'.repeat(2),
      WEB_ORIGIN: 'https://pos.example.test',
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      MYSQL_DATA_READER_URL: url.href,
    });
    db = createDatabases(config);
    service = applicationLinkService(
      config,
      db,
      options,
      { artifact, customerLink: provider },
      () => timestamp,
    );
    app = Fastify({ logger: false });
    app.decorateRequest('principal', null);
    app.addHook('preHandler', async (request) => {
      if (!request.routeOptions.url?.startsWith('/api/v1/auth/'))
        request.principal =
          request.headers['x-fixture-actor'] === '2'
            ? franchise
            : request.headers['x-fixture-actor'] === '3'
              ? staff
              : actor;
    });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError)
        return reply
          .code(error.status)
          .send({ error: { code: error.code, message: error.message } });
      if (error instanceof ZodError)
        return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
    });
    registerApplicationLinks(app, config, db, options, { artifact, customerLink: provider });
    await app.ready();
  });
  beforeEach(async () => {
    for (const table of [
      'pos_rewrite_staff_download_grants',
      'pos_rewrite_customer_application_links',
      'pos_rewrite_customer_application_cache',
      'pos_rewrite_application_scan_receipts',
      'pos_to_app_logs',
      'pos_rewrite_operator_checkins',
    ]) {
      await connection.query('DELETE FROM ' + mysql.escapeId(table));
    }
    for (const table of [UserStore, StoreCounter, Store, PosUser])
      await connection.query('DELETE FROM ' + mysql.escapeId(getTableConfig(table).name));
    for (const [id, role, userType] of [
      [1, 1, 1],
      [2, 1, 2],
      [3, 5, 1],
    ] as const)
      await seed(PosUser, {
        id,
        role,
        user_type: userType,
        is_active: true,
        username: 'fixture' + id,
        email: 'fixture' + id + '@example.test',
      });
    for (const [id, category] of [
      [1, 'IN_HOUSE'],
      [2, 'FRANCHISE'],
    ] as const) {
      await seed(Store, {
        id,
        store_name: 'Fixture store ' + id,
        category,
        type: 'STORE',
        is_active: true,
      });
      await seed(StoreCounter, { id, store_id: id, is_active: true });
    }
    await seed(UserStore, { django_user_id: 2, store_id: 2 });
    await seed(UserStore, { django_user_id: 3, store_id: 1 });
    timestamp = Date.now();
    providerFailure = false;
    duringDestination = undefined;
    providerCalls.length = 0;
    artifactOpens = 0;
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (connection) {
      await connection.query('DROP DATABASE ' + mysql.escapeId(schemaName));
      await connection.end();
    }
  });
  it('issues an opaque aligned expiring self QR and replays without duplicating stored capability material', async () => {
    const operationId = randomUUID(),
      first = await service.issueStaff(actor, { operationId }),
      replay = await service.issueStaff(actor, { operationId }),
      refresh = await service.issueStaff(actor, { operationId: randomUUID() });
    expect(replay).toMatchObject({ id: first.id, url: first.url });
    expect(refresh.id).toBe(first.id);
    expect(first.expiresAt).toBe(packageQrExpiry(timestamp, 60));
    expect(new URL(first.url).search).toBe('');
    expect(first.url).not.toContain('fixture@example.test');
    expect(token(first.url)).toMatch(/^[\w-]{43}$/);
    const saved = await db.get('writer').select().from(staffDownloadGrants);
    expect(saved).toHaveLength(1);
    expect(Object.values(saved[0]!).map(String).join('|')).not.toContain(token(first.url));
  });
  it('allows internal staff and denies current franchise/inactive authority and arbitrary operator selectors', async () => {
    await expect(
      service.issueStaff(franchise, { operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'APPLICATION_LINK_DENIED' });
    await expect(service.issueStaff(staff, { operationId: randomUUID() })).resolves.toHaveProperty(
      'url',
    );
    await db.get('writer').update(PosUser).set({ is_active: false }).where(eq(PosUser.id, 1n));
    await expect(service.issueStaff(actor, { operationId: randomUUID() })).rejects.toMatchObject({
      code: 'APPLICATION_LINK_DENIED',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operators/current/application-links/staff-qr',
      headers: { 'X-Operator-ID': '1' },
      payload: { operationId: randomUUID(), userId: '3' },
    });
    expect(response.statusCode).toBe(400);
  });
  it('activates once across concurrent scanners and recovers only the identical activation operation', async () => {
    const issued = await service.issueStaff(actor, { operationId: randomUUID() }),
      operations = [randomUUID(), randomUUID()],
      attempts = await Promise.allSettled(
        operations.map((operationId) =>
          service.activateStaff({ token: token(issued.url), operationId }),
        ),
      );
    const index = attempts.findIndex((value) => value.status === 'fulfilled');
    expect(attempts.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(artifactOpens).toBe(0);
    const accepted = attempts[index]!;
    if (accepted.status !== 'fulfilled') throw new Error('Expected one activation.');
    const replay = await service.activateStaff({
      token: token(issued.url),
      operationId: operations[index]!,
    });
    expect(replay.activationToken).toBe(accepted.value.activationToken);
    await expect(
      service.activateStaff({ token: token(issued.url), operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'APPLICATION_LINK_EXPIRED' });
  });
  it('claims one package download operation, supports identical byte retry and expires the activation', async () => {
    const issued = await service.issueStaff(actor, { operationId: randomUUID() }),
      activation = await service.activateStaff({
        token: token(issued.url),
        operationId: randomUUID(),
      }),
      operations = [randomUUID(), randomUUID()],
      attempts = await Promise.allSettled(
        operations.map((operationId) =>
          service.downloadStaff({ activationToken: activation.activationToken, operationId }),
        ),
      );
    expect(attempts.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(artifactOpens).toBe(1);
    const index = attempts.findIndex((value) => value.status === 'fulfilled'),
      accepted = attempts[index]!;
    if (accepted.status !== 'fulfilled') throw new Error('Expected one download.');
    expect(await consume(accepted.value.stream)).toEqual(bytes);
    const replay = await service.downloadStaff({
      activationToken: activation.activationToken,
      operationId: operations[index]!,
    });
    expect(await consume(replay.stream)).toEqual(bytes);
    timestamp = activation.expiresAt;
    await expect(
      service.downloadStaff({
        activationToken: activation.activationToken,
        operationId: operations[index]!,
      }),
    ).rejects.toMatchObject({ code: 'APPLICATION_LINK_EXPIRED' });
    expect(artifactOpens).toBe(2);
  });
  it('does not revive a staff capability after atomic account disable and restoration', async () => {
    const issued = await service.issueStaff(actor, { operationId: randomUUID() });
    for (const active of [false, true])
      await db.get('writer').transaction(async (tx) => {
        await tx.select({ id: PosUser.id }).from(PosUser).where(eq(PosUser.id, 1n)).for('update');
        await tx.update(PosUser).set({ is_active: active }).where(eq(PosUser.id, 1n));
        await invalidateOperatorAuthentication(tx, '1');
      });
    await expect(
      service.activateStaff({ token: token(issued.url), operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'APPLICATION_LINK_EXPIRED' });
    expect((await service.issueStaff(actor, { operationId: randomUUID() })).id).not.toBe(issued.id);
  });
  it('revokes only the current operator grant and rejects expired QR proof', async () => {
    const issued = await service.issueStaff(actor, { operationId: randomUUID() });
    await service.revokeStaff(staff, issued.id);
    expect((await db.get('writer').select().from(staffDownloadGrants))[0]?.state).toBe('ISSUED');
    await service.revokeStaff(actor, issued.id);
    await expect(
      service.activateStaff({ token: token(issued.url), operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'APPLICATION_LINK_EXPIRED' });
    const next = await service.issueStaff(actor, { operationId: randomUUID() });
    timestamp = next.expiresAt;
    await expect(
      service.activateStaff({ token: token(next.url), operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'APPLICATION_LINK_EXPIRED' });
  });
  it('uses actual server check-in and preserves one printable customer QR per valid store', async () => {
    await expect(service.issueCustomer(actor)).rejects.toMatchObject({ code: 'CHECK_IN_REQUIRED' });
    const checkIns = checkInService(db, config);
    await checkIns.set(actor, '1', null);
    const issued = await service.issueCustomer(actor),
      replay = await service.issueCustomer(actor);
    expect(replay).toEqual(issued);
    expect(issued.storeId).toBe('1');
    expect(new URL(issued.url).search).toBe('');
    expect(await scanCount()).toBe('0');
    expect(providerCalls).toHaveLength(0);
    await expect(checkIns.set(franchise, '1', null)).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await checkIns.set(franchise, '2', null);
    expect((await service.issueCustomer(franchise)).storeId).toBe('2');
  });
  it('records one source scan per operation and caches source-shaped provider work for one hour', async () => {
    await checkInService(db, config).set(actor, '1', null);
    const issued = await service.issueCustomer(actor),
      input = { token: token(issued.url), operationId: randomUUID() };
    const first = await service.scanCustomer(input);
    expect(await service.scanCustomer(input)).toEqual(first);
    expect(await scanCount()).toBe('1');
    expect(providerCalls).toHaveLength(1);
    const [log] = await db.get('writer').select().from(sourceApplicationScans);
    expect(log).toMatchObject({
      storeId: 1,
      scannedAt: scanWallTime(timestamp, config.BUSINESS_TIMEZONE),
    });
    await service.scanCustomer({ ...input, operationId: randomUUID() });
    expect(await scanCount()).toBe('2');
    expect(providerCalls).toHaveLength(1);
    timestamp += 3600000;
    await service.scanCustomer({ ...input, operationId: randomUUID() });
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[1]?.operationId).not.toBe(providerCalls[0]?.operationId);
  });
  it('retries a failed provider with the same durable operation and never silently loses the scan audit', async () => {
    await checkInService(db, config).set(actor, '1', null);
    const issued = await service.issueCustomer(actor),
      input = { token: token(issued.url), operationId: randomUUID() };
    providerFailure = true;
    await expect(service.scanCustomer(input)).rejects.toMatchObject({
      code: 'CUSTOMER_APPLICATION_UNAVAILABLE',
    });
    expect(await scanCount()).toBe('0');
    providerFailure = false;
    await service.scanCustomer(input);
    expect(providerCalls[1]?.operationId).toBe(providerCalls[0]?.operationId);
    expect(await scanCount()).toBe('1');
    await connection.query('RENAME TABLE pos_to_app_logs TO fixture_scan_log_unavailable');
    try {
      await expect(
        service.scanCustomer({ ...input, operationId: randomUUID() }),
      ).rejects.toBeDefined();
    } finally {
      await connection.query('RENAME TABLE fixture_scan_log_unavailable TO pos_to_app_logs');
    }
    expect(await scanCount()).toBe('1');
  });
  it('rejects store archival after provider I/O and prevents cross-store operation reuse', async () => {
    const checkIns = checkInService(db, config);
    await checkIns.set(actor, '1', null);
    const first = await service.issueCustomer(actor);
    duringDestination = async () => {
      await db.get('writer').update(Store).set({ is_active: false }).where(eq(Store.id, 1n));
    };
    await expect(
      service.scanCustomer({ token: token(first.url), operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'APPLICATION_LINK_EXPIRED' });
    expect(await scanCount()).toBe('0');
    duringDestination = undefined;
    await db.get('writer').update(Store).set({ is_active: true }).where(eq(Store.id, 1n));
    const input = { token: token(first.url), operationId: randomUUID() };
    await service.scanCustomer(input);
    await checkIns.set(actor, '2', null);
    const second = await service.issueCustomer(actor);
    await expect(
      service.scanCustomer({ ...input, token: token(second.url) }),
    ).rejects.toMatchObject({ code: 'APPLICATION_OPERATION_CONFLICT' });
    expect(await scanCount()).toBe('1');
  });
  it('bounds concurrent provider work and commits at most one audit for the same scan operation', async () => {
    await checkInService(db, config).set(actor, '1', null);
    const issued = await service.issueCustomer(actor),
      input = { token: token(issued.url), operationId: randomUUID() };
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => service.scanCustomer(input)),
    );
    expect(attempts.some((value) => value.status === 'fulfilled')).toBe(true);
    await service.scanCustomer(input);
    expect(await scanCount()).toBe('1');
    expect(providerCalls).toHaveLength(1);
  });
  it('fails explicitly for store IDs outside the verified legacy INT audit reference without rounding', async () => {
    await seed(Store, {
      id: 2147483648n,
      store_name: 'Big fixture',
      category: 'IN_HOUSE',
      type: 'STORE',
      is_active: true,
    });
    await checkInService(db, config).set(actor, '2147483648', null);
    await expect(service.issueCustomer(actor)).rejects.toMatchObject({
      code: 'APPLICATION_STORE_UNSUPPORTED',
    });
    expect(await scanCount()).toBe('0');
    expect(providerCalls).toHaveLength(0);
  });
  it('requires same-origin body-only public proof and streams a protected attachment without secrets in URLs', async () => {
    const issue = await app.inject({
      method: 'POST',
      url: '/api/v1/operators/current/application-links/staff-qr',
      headers: { 'X-Operator-ID': '1' },
      payload: { operationId: randomUUID() },
    });
    expect(issue.statusCode).toBe(200);
    const issued = issue.json<{ url: string }>(),
      input = { token: token(issued.url), operationId: randomUUID() };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/application-links/staff-download-activations',
          headers: { origin: 'https://attacker.example.test' },
          payload: input,
        })
      ).statusCode,
    ).toBe(403);
    const activated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/application-links/staff-download-activations',
      headers: { origin: config.WEB_ORIGIN },
      payload: input,
    });
    expect(activated.statusCode).toBe(200);
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/application-links/staff-download-content',
      headers: { origin: config.WEB_ORIGIN },
      payload: {
        activationToken: activated.json<{ activationToken: string }>().activationToken,
        operationId: randomUUID(),
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.rawPayload).toEqual(bytes);
    expect(result.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.headers['content-disposition']).toBe('attachment; filename="mpos.apk"');
    expect(
      (await app.inject('/api/v1/auth/application-links/staff-download-content?token=fixture'))
        .statusCode,
    ).toBe(404);
  });
  it('prunes only bounded old proof/receipt state while retaining source audit and printable customer links', async () => {
    await checkInService(db, config).set(actor, '1', null);
    const issued = await service.issueCustomer(actor);
    await service.scanCustomer({ token: token(issued.url), operationId: randomUUID() });
    await service.issueStaff(actor, { operationId: randomUUID() });
    await pruneApplicationLinks(db, timestamp + 86400000 + 600000);
    expect(await db.get('writer').select().from(staffDownloadGrants)).toHaveLength(0);
    expect(await db.get('writer').select().from(applicationScanReceipts)).toHaveLength(0);
    expect(await db.get('writer').select().from(customerApplicationLinks)).toHaveLength(1);
    expect(await db.get('writer').select().from(customerApplicationCache)).toHaveLength(1);
    expect(await scanCount()).toBe('1');
  });
});
