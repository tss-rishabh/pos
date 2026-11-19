import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import mysql, { type Connection } from 'mysql2/promise';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { PosUser, Store, StoreCounter, UserStore } from '../../src/db/legacy-schema.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { memoryEphemeralStore } from '../../src/jobs/ephemeral.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { checkInRedis } from '../helpers/check-ins.js';
import {
  readApplicationLinkOptions,
  safeApplicationDestination,
} from '../../src/modules/application-links/contracts.js';
import {
  applicationLinkService,
  registerApplicationLinks,
} from '../../src/modules/application-links/index.js';
import { sourceApplicationScans } from '../../src/modules/application-links/schema.js';
import type {
  CustomerApplicationProvider,
  StaffApplicationPackage,
} from '../../src/modules/application-links/provider.js';
import { legacyFixtureRecord } from '../../tools/administration/mysql-fixture.js';
import { createProductionTables } from '../helpers/production-schema.js';

const template = process.env.APPLICATION_LINK_MYSQL_TEST_URL;
describe.skipIf(!template)(
  'application links against isolated writer MySQL and Redis state',
  () => {
    let connection: Connection,
      db: Databases,
      app: FastifyInstance,
      schemaName: string,
      config: ReturnType<typeof readConfig>,
      service: ReturnType<typeof applicationLinkService>;
    let timestamp = Date.now(),
      packageOpens = 0;
    const ephemeral = memoryEphemeralStore(() => timestamp);
    const providerCalls: string[] = [],
      bytes = Buffer.from('PK\x03\x04synthetic-package-fixture'),
      options = readApplicationLinkOptions({});
    const actor: Principal = {
        id: '1',
        name: 'Fixture operator',
        email: 'fixture@example.test',
        role: 1,
        userType: 1,
        storeIds: ['1', '2'],
      },
      franchise: Principal = { ...actor, id: '2', userType: 2, storeIds: ['2'] };
    const staffPackage: StaffApplicationPackage = {
      async open() {
        packageOpens++;
        return {
          stream: Readable.from([bytes]),
          contentType: 'application/vnd.android.package-archive',
          contentLength: String(bytes.length),
        };
      },
    };
    const provider: CustomerApplicationProvider = {
      fallback: 'https://www.thesouledstore.com',
      accepts(value) {
        return safeApplicationDestination(value, ['https://www.thesouledstore.com']);
      },
      async destination(storeId) {
        providerCalls.push(storeId);
        return `https://www.thesouledstore.com/?store_id=${storeId}`;
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
    async function consume(stream: Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
      return Buffer.concat(chunks);
    }
    async function scans() {
      return db
        .get('writer')
        .select({ storeId: sourceApplicationScans.storeId, at: sourceApplicationScans.scannedAt })
        .from(sourceApplicationScans);
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
      // Production snapshot DDL only (tests/golden/schema/production-schema.json).
      await createProductionTables(connection, [
        PosUser,
        Store,
        StoreCounter,
        UserStore,
        'pos_to_app_logs',
      ]);
      url.pathname = '/' + schemaName;
      config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'isolated-application-link-secret-'.repeat(2),
        WEB_ORIGIN: 'https://pos.example.test',
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        BUSINESS_TIMEZONE: 'Asia/Kolkata',
      });
      db = createDatabases(config);
      // Legacy check_in_* keys on an in-process Redis port.
      checkInRedis();
      service = applicationLinkService(
        config,
        db,
        options,
        { ephemeral, staffPackage, customerLink: provider },
        () => timestamp,
      );
      app = Fastify({ logger: false });
      app.decorateRequest('principal', null);
      app.addHook('preHandler', async (request) => {
        if (!request.routeOptions.url?.startsWith('/api/v1/auth/'))
          request.principal = request.headers['x-fixture-actor'] === '2' ? franchise : actor;
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
      registerApplicationLinks(app, config, db, { ephemeral }, options, {
        staffPackage,
        customerLink: provider,
      });
      await app.ready();
    });
    beforeEach(async () => {
      for (const table of ['pos_to_app_logs'])
        await connection.query('DELETE FROM ' + mysql.escapeId(table));
      for (const table of [UserStore, StoreCounter, Store, PosUser])
        await connection.query('DELETE FROM ' + mysql.escapeId(getTableConfig(table).name));
      for (const [id, role, userType] of [
        [1, 1, 1],
        [2, 1, 2],
      ] as const)
        await seed(PosUser, {
          id,
          role,
          user_type: userType,
          is_active: true,
          username: 'fixture' + id,
          email: 'fixture' + id + '@example.test',
        });
      for (const [id, active] of [
        [1, true],
        [2, false],
      ] as const) {
        await seed(Store, {
          id,
          store_name: 'Fixture store ' + id,
          category: 'IN_HOUSE',
          type: 'STORE',
          is_active: active,
        });
        await seed(StoreCounter, { id, store_id: id, is_active: true });
      }
      for (const key of await ephemeral.scanKeys('*')) await ephemeral.del(key);
      timestamp = Date.now();
      providerCalls.length = 0;
      packageOpens = 0;
    });
    afterAll(async () => {
      await app?.close();
      await db?.close();
      if (connection) {
        await connection.query('DROP DATABASE ' + mysql.escapeId(schemaName));
        await connection.end();
      }
    });
    it('returns the same staff QR within one period and keeps only ids and expiry in Redis', async () => {
      const first = await service.issueStaff(actor, { operationId: randomUUID() }),
        second = await service.issueStaff(actor, { operationId: randomUUID() });
      expect(second.url).toBe(first.url);
      expect(first.expiresAt % (options.MPOS_DOWNLOAD_QR_EXP_SEC * 1000)).toBe(0);
      const keys = (await ephemeral.scanKeys('pos:staff_download:*')).sort();
      expect(keys).toHaveLength(2);
      for (const key of keys) {
        const value = (await ephemeral.get(key))!;
        expect(value).not.toContain(token(first.url));
        expect(JSON.parse(value)).toEqual({
          grantId: first.id,
          operatorId: '1',
          expiresAt: first.expiresAt,
        });
        expect(await ephemeral.ttl(key)).toBeLessThanOrEqual(options.MPOS_DOWNLOAD_QR_EXP_SEC);
      }
      await expect(
        service.issueStaff(franchise, { operationId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'APPLICATION_LINK_DENIED' });
    });
    it('activates once per QR, rotates the QR, and allows one download per activation', async () => {
      const issued = await service.issueStaff(actor, { operationId: randomUUID() }),
        operationId = randomUUID();
      const activation = await service.activateStaff({ token: token(issued.url), operationId });
      expect(await service.activateStaff({ token: token(issued.url), operationId })).toEqual(
        activation,
      );
      await expect(
        service.activateStaff({ token: token(issued.url), operationId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'APPLICATION_LINK_EXPIRED' });
      expect((await service.issueStaff(actor, { operationId: randomUUID() })).url).not.toBe(
        issued.url,
      );
      const download = randomUUID();
      const first = await service.downloadStaff({
        activationToken: activation.activationToken,
        operationId: download,
      });
      expect(await consume(first.stream)).toEqual(bytes);
      await service.downloadStaff({
        activationToken: activation.activationToken,
        operationId: download,
      });
      await expect(
        service.downloadStaff({
          activationToken: activation.activationToken,
          operationId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'APPLICATION_LINK_EXPIRED' });
      expect(packageOpens).toBe(2);
      timestamp += options.MPOS_DOWNLOAD_LINK_EXP * 1000 + 1;
      await expect(
        service.downloadStaff({
          activationToken: activation.activationToken,
          operationId: download,
        }),
      ).rejects.toMatchObject({ code: 'APPLICATION_LINK_EXPIRED' });
    });
    it('issues a deterministic customer QR for the check-in store and logs each scan once', async () => {
      await checkInService(db, config).set(actor, '1', null);
      const first = await service.issueCustomer(actor),
        second = await service.issueCustomer(actor);
      expect(second.url).toBe(first.url);
      expect(token(first.url)).toMatch(/^1\.[A-Za-z0-9_-]{43}$/);
      const operationId = randomUUID(),
        result = await service.scanCustomer({ token: token(first.url), operationId });
      expect(result).toEqual({ destination: 'https://www.thesouledstore.com/?store_id=1' });
      expect(await service.scanCustomer({ token: token(first.url), operationId })).toEqual(result);
      await service.scanCustomer({ token: token(first.url), operationId: randomUUID() });
      expect(providerCalls).toEqual(['1']);
      expect(await ephemeral.get('dynamic_short_link_s_id_1')).toBe(result.destination);
      expect(await ephemeral.ttl('dynamic_short_link_s_id_1')).toBe(3600);
      expect(await ephemeral.ttl(`pos:idem:app_scan:${operationId}`)).toBe(3600);
      expect((await scans()).map((row) => row.storeId)).toEqual([1, 1]);
      await expect(
        service.scanCustomer({ token: '1.' + 'x'.repeat(43), operationId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'APPLICATION_LINK_EXPIRED' });
    });
    it('serves the legacy /user_to_app path for active stores only and requires same-origin public proof', async () => {
      const legacy = await app.inject('/user_to_app?store_id=1');
      expect(legacy.statusCode).toBe(302);
      expect(legacy.headers.location).toBe('https://www.thesouledstore.com/?store_id=1');
      expect((await app.inject('/user_to_app?store_id=2')).statusCode).toBe(410);
      expect((await app.inject('/user_to_app?store_id=1%20OR%201')).statusCode).toBe(400);
      expect((await scans()).map((row) => row.storeId)).toEqual([1]);
      const issue = await app.inject({
        method: 'POST',
        url: '/api/v1/operators/current/application-links/staff-qr',
        headers: { 'X-Operator-ID': '1' },
        payload: { operationId: randomUUID() },
      });
      expect(issue.statusCode).toBe(200);
      const input = { token: token(issue.json<{ url: string }>().url), operationId: randomUUID() };
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
      expect(result.headers['content-disposition']).toBe('attachment; filename="mpos.apk"');
    });
  },
);
