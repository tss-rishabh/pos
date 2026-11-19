import { registerRouteValidation } from '../../src/domain/route-validation.js';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import Fastify, { type FastifyInstance } from 'fastify';
import { getTableName } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { readConfig, type Config } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  PosUser,
  Store,
  UserStore,
  StoreCounter,
  PosMachine,
  PosPaytmMachine,
} from '../../src/db/legacy-schema.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { registerTerminalDirectory } from '../../src/modules/administration/terminal-directory.js';
import { terminalService } from '../../src/modules/administration/terminals.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';

const template = process.env.ADMINISTRATION_MYSQL_TEST_URL;
describe.skipIf(!template)('native terminal directory and current authority', () => {
  let connection: mysql.Connection,
    db: Databases,
    config: Config,
    schema: string,
    app: FastifyInstance,
    fixture: ReturnType<typeof verifiedMysqlFixture>;
  const global: Principal = {
    id: '1',
    name: 'Synthetic operator',
    email: 'fixture@example.test',
    role: 1,
    userType: 1,
    storeIds: [],
  };
  let current = global;
  const tables = [PosUser, Store, UserStore, StoreCounter, PosMachine, PosPaytmMachine].map(
    getTableName,
  );
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_administration_test' ||
      url.search ||
      url.hash
    )
      throw new Error('Explicit isolated local administration template required.');
    schema = 'pos_terminal_directory_' + randomUUID().replaceAll('-', '').slice(0, 12);
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    await connection.query('CREATE DATABASE ' + mysql.escapeId(schema));
    await connection.changeUser({ database: schema });
    fixture = verifiedMysqlFixture(connection);
    await fixture.create(tables);
    url.pathname = '/' + schema;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'terminal-native-only-fixture-'.repeat(3),
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_POOL_SIZE: '6',
    });
    db = createDatabases(config);
    app = Fastify({ logger: false });
    app.decorateRequest('principal', null);
    registerRouteValidation(app);
    app.addHook('preHandler', async (request) => {
      request.principal = current;
    });
    app.setErrorHandler((error, _request, reply) => {
      const code = z.object({ code: z.string() }).safeParse(error),
        cause = z.object({ cause: z.object({ code: z.string() }) }).safeParse(error);
      return reply
        .code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500)
        .send({
          code:
            error instanceof AppError
              ? error.code
              : code.success
                ? code.data.code
                : cause.success
                  ? cause.data.cause.code
                  : 'SYNTHETIC_UNKNOWN_ERROR',
        });
    });
    registerTerminalDirectory(app, db);
  }, 20000);
  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (connection) {
      await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
      await connection.end();
    }
  });
  beforeEach(async () => {
    current = global;
    await connection.rollback();
    for (const table of tables) await connection.query('DELETE FROM ' + mysql.escapeId(table));
    await fixture.insert(getTableName(PosUser), {
      id: 1,
      username: 'operator-fixture',
      role: 1,
      user_type: 1,
      is_active: 1,
    });
    for (const [id, category, active] of [
      [1, 'IN_HOUSE', 1],
      [2, 'FRANCHISE', 1],
      [3, 'FRANCHISE', 0],
    ] as const) {
      await fixture.insert(getTableName(Store), {
        id,
        store_name: 'Store ' + id,
        type: 'STORE',
        category,
        is_active: active,
      });
      await fixture.insert(getTableName(StoreCounter), {
        id,
        store_id: id,
        counter_name: 'C1',
        is_active: 1,
      });
    }
    for (const [id, store, active] of [
      [1, 1, 1],
      [2, 2, 0],
      [3, 3, 1],
    ] as const) {
      await fixture.insert(getTableName(PosMachine), {
        id,
        store_id: store,
        counter_id: store,
        machine_name: 'Pine ' + id,
        merchant_name: 'Synthetic Pine',
        hardware_id: 'hardware_' + id,
        tid: 'P-' + id,
        security_token: 'synthetic-pine-secret',
        is_active: active,
      });
      await fixture.insert(getTableName(PosPaytmMachine), {
        id,
        store_id: store,
        counter_id: store,
        machine_name: 'Paytm ' + id,
        merchant_name: 'Synthetic Paytm',
        paytm_mid: 'mid_' + id,
        paytm_tid: 'T-' + id,
        merchant_key: 'synthetic-paytm-secret',
        device_serial_no: '9223372036854775807',
        is_active: active,
      });
    }
  });
  const search = (payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/v1/admin/payment-terminals/search', payload });
  const result = z.object({
    data: z.array(
      z.object({
        id: z.string(),
        provider: z.enum(['pine-labs', 'paytm']),
        name: z.string(),
        storeId: z.string(),
        storeName: z.string(),
        deviceSerialNumber: z.string(),
        active: z.number(),
        merchantId: z.string(),
      }),
    ),
    total: z.number(),
    start: z.number(),
    length: z.number(),
  });
  it('executes the actual provider union, keeps exact serials, archived rows and credential-free fields', async () => {
    const response = await search();
    expect(response.statusCode, response.body).toBe(200);
    const value = result.parse(response.json());
    expect(value.total).toBe(6);
    expect(value.data.filter((row) => row.id === '2').map((row) => row.active)).toEqual([0, 0]);
    expect(value.data.filter((row) => row.id === '3').every((row) => row.storeName === '')).toBe(
      true,
    );
    expect(value.data.find((row) => row.provider === 'paytm')?.deviceSerialNumber).toBe(
      '9223372036854775807',
    );
    expect(response.body).not.toMatch(
      /synthetic-(?:pine|paytm)-secret|security_token|merchant_key/,
    );
    expect(value.data.find((row) => row.provider === 'paytm')?.merchantId).toBe('mid_3');
  });
  it('keeps duplicate provider IDs stable across every bounded page and provider selection', async () => {
    const seen: string[] = [];
    for (let start = 0; start < 6; start++) {
      const response = await search({ start, length: 1, sort: 'id', direction: 'asc' });
      expect(response.statusCode, response.body).toBe(200);
      const value = result.parse(response.json());
      seen.push(...value.data.map((row) => row.provider + ':' + row.id));
    }
    expect(seen).toEqual([
      'paytm:1',
      'pine-labs:1',
      'paytm:2',
      'pine-labs:2',
      'paytm:3',
      'pine-labs:3',
    ]);
    for (const provider of ['pine-labs', 'paytm']) {
      const value = result.parse((await search({ provider, length: 500 })).json());
      expect(value.total).toBe(3);
      expect(value.data.every((row) => row.provider === provider)).toBe(true);
    }
  });
  it('uses bound literal search and refuses malformed sort/provider/IDs/pagination or query values', async () => {
    const literal = await search({ search: 'hardware_1' });
    expect(literal.statusCode, literal.body).toBe(200);
    expect(result.parse(literal.json()).total).toBe(1);
    expect(result.parse((await search({ search: 'hardware%' })).json()).total).toBe(0);
    for (const payload of [
      { sort: 'id desc; DROP TABLE stores' },
      { provider: 'other' },
      { storeId: '9007199254740993' },
      { start: -1 },
      { length: 501 },
      { unknown: 'x' },
    ])
      expect((await search(payload)).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/payment-terminals/search?search=synthetic',
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
  });
  it('uses native current roles, organization and assignments even with a cached elevated principal', async () => {
    await connection.query('UPDATE pos_user SET role=2,user_type=2 WHERE id=1');
    expect(result.parse((await search()).json()).data).toEqual([]);
    await fixture.insert(getTableName(UserStore), { django_user_id: 1, store_id: 1 });
    await fixture.insert(getTableName(UserStore), { django_user_id: 1, store_id: 2 });
    const value = result.parse((await search()).json());
    expect(value.total).toBe(2);
    expect(value.data.every((row) => row.storeId === '2')).toBe(true);
    expect((await search({ storeId: '1' })).statusCode).toBe(403);
    await connection.query('DELETE FROM user_stores WHERE django_user_id=1');
    expect(result.parse((await search()).json()).total).toBe(0);
    await connection.query('UPDATE pos_user SET role=5 WHERE id=1');
    expect((await search()).statusCode).toBe(403);
    await connection.query('UPDATE pos_user SET role=1,is_active=0 WHERE id=1');
    expect((await search()).statusCode).toBe(401);
  });
  it('executes a mixed native charset/collation union and literal Unicode search', async () => {
    await connection.query(
      'ALTER TABLE pos_machines MODIFY machine_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL',
    );
    await connection.query(
      'ALTER TABLE pos_paytm_machines MODIFY machine_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL',
    );
    try {
      await connection.query('UPDATE pos_machines SET machine_name=? WHERE id=1', ['Éclair']);
      await connection.query('UPDATE pos_paytm_machines SET machine_name=? WHERE id=1', [
        'Ångström',
      ]);
      const response = await search({ search: 'Éclair', sort: 'name' });
      expect(response.statusCode, response.body).toBe(200);
      expect(result.parse(response.json()).data.map((row) => row.name)).toEqual(['Éclair']);
    } finally {
      await connection.query(
        'ALTER TABLE pos_machines MODIFY machine_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL',
      );
      await connection.query(
        'ALTER TABLE pos_paytm_machines MODIFY machine_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL',
      );
    }
  });
  it('rejects terminal writes using revoked actor scope and preserves existing credentials', async () => {
    const service = terminalService(config, db),
      input = {
        provider: 'paytm' as const,
        merchantId: 'next-mid',
        terminalId: 'next-tid',
        deviceSerialNumber: '9223372036854775807',
        active: true,
      };
    await connection.query('UPDATE pos_user SET role=2 WHERE id=1');
    await expect(service.update(global, '1', '1', input)).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT paytm_mid,merchant_key FROM pos_paytm_machines WHERE id=1',
    );
    expect(rows.map((row) => row.paytm_mid)).toEqual(['mid_1']);
    expect(rows.every((row) => row.merchant_key === 'synthetic-paytm-secret')).toBe(true);
    await connection.query('UPDATE pos_user SET role=1,is_active=0 WHERE id=1');
    await expect(service.remove(global, '1', 'paytm', '1')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });
});
