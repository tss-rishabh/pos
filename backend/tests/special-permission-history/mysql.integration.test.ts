import { randomUUID } from 'node:crypto';
import mysql, { type Connection } from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { Temporal } from '@js-temporal/polyfill';
import { asc, eq, sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { PosUser } from '../../src/db/legacy-schema.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { legacyFixtureRecord } from '../../tools/administration/mysql-fixture.js';
import { createProductionTables } from '../helpers/production-schema.js';
import {
  registerSpecialPermissionHistory,
  specialPermissionHistoryService,
} from '../../src/modules/special-permission-history/index.js';
import {
  activitySearchInput,
  activityProjection,
} from '../../src/modules/special-permission-history/contracts.js';
import { specialPermissionActivity as activity } from '../../src/modules/special-permission-history/schema.js';
import { goldenSpawnResult } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';

const template = process.env.SPECIAL_PERMISSION_MYSQL_TEST_URL;
const clock = () => Temporal.Instant.from('2026-11-16T12:00:00Z');
const sourceRow = z.object({
  id: z.string(),
  added_by: z.string(),
  platform: z.string(),
  comment: z.string().nullable(),
  created_at: z.string(),
  recipient: z.string(),
});
const sourceResponse = z.object({
  draw: z.number(),
  recordsTotal: z.string(),
  recordsFiltered: z.string(),
  data: z.array(sourceRow),
  queryCount: z.number(),
});
describe.skipIf(!template)('source SpecialPermission activity against isolated MySQL', () => {
  let connection: Connection,
    db: Databases,
    app: FastifyInstance,
    schemaName: string,
    databaseUrl: string,
    config: ReturnType<typeof readConfig>;
  let actor: Principal = {
    id: '1',
    name: 'Fixture administrator',
    email: 'fixture@example.test',
    role: 1,
    userType: 1,
    storeIds: [],
  };
  const readerQueries: string[] = [];
  const source = (cases: unknown[]) => {
    const run = goldenSpawnResult(
      'special-permission-history',
      'mysql-integration',
      JSON.stringify({ database: databaseUrl, cases }),
      undefined,
      fixturePlaceholders(databaseUrl),
    );
    const decoded: unknown = JSON.parse(run.stdout);
    if (run.status !== 0) {
      const failure = z
        .object({ kind: z.string(), caseIndex: z.number().nullable() })
        .parse(decoded);
      throw new Error(`Isolated source oracle failed: ${failure.kind}, case ${failure.caseIndex}.`);
    }
    return z
      .object({ djangoVersion: z.literal('4.2.5'), cases: z.array(sourceResponse) })
      .parse(decoded).cases;
  };
  const comparable = (
    value: Awaited<ReturnType<ReturnType<typeof specialPermissionHistoryService>['search']>>,
  ) => ({
    draw: value.draw,
    recordsTotal: value.recordsTotal,
    recordsFiltered: value.recordsFiltered,
    data: value.data.map((row) => ({
      id: row.id,
      added_by: row.addedBy,
      platform: row.platform,
      comment: row.comment,
      created_at: row.createdAt,
      recipient: row.recipient,
    })),
  });
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_activity_history_test'
    )
      throw new Error('Use the explicitly isolated local activity-history schema template.');
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
    schemaName = `pos_rewrite_activity_history_test_${process.pid}_${randomUUID().slice(0, 8)}`;
    await connection.query(
      `CREATE DATABASE ${mysql.escapeId(schemaName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
    );
    await connection.changeUser({ database: schemaName });
    await createProductionTables(connection, [PosUser, 'pos_special_permission_activity_log']);
    url.pathname = '/' + schemaName;
    databaseUrl = url.href;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'isolated-special-activity-secret-'.repeat(2),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      MYSQL_DATA_READER_URL: url.href,
    });
    db = createDatabases(config);
    app = Fastify({ logger: false });
    app.decorateRequest('principal', null);
    app.addHook('preHandler', async (request) => {
      request.principal = actor;
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
    registerSpecialPermissionHistory(app, config, db, {}, undefined, clock);
    await app.ready();
  });
  beforeEach(async () => {
    await connection.query('DELETE FROM pos_special_permission_activity_log');
    await connection.query('DELETE FROM pos_user');
    readerQueries.length = 0;
    for (const [id, role, userType, active, firstName, lastName] of [
      [1, 1, 1, true, 'Admin', 'Fixture'],
      [2, 2, 1, true, 'Second', 'Admin'],
      [3, 3, 1, true, '', ''],
      [4, 4, 1, true, 'Store', 'Manager'],
      [5, 1, 2, true, 'Franchise', 'Admin'],
      [6, 1, 1, false, 'Inactive', 'Admin'],
      [7, 5, 1, false, '  Saved', 'Actor  '],
    ] as const) {
      const row = legacyFixtureRecord(PosUser, {
        id,
        role,
        user_type: userType,
        is_active: active,
        username: 'fixture' + id,
        first_name: firstName,
        last_name: lastName,
      });
      const names = Object.keys(row);
      await connection.execute(
        `INSERT INTO pos_user (${names.map(mysql.escapeId).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
        names.map((name) => row[name]),
      );
    }
    const rows = [
      {
        id: -1n,
        actorId: 1n,
        platform: 'barcode',
        recipient: 'root-fixture',
        comment: 'start',
        createdAt: '2026-11-16 00:00:00',
      },
      {
        id: 9007199254740993n,
        actorId: 3n,
        platform: 'barcode',
        recipient: null,
        comment: "percent% under_ slash\\ quote' Café ÅÄÖ",
        createdAt: '2026-11-16 01:02:03',
      },
      {
        id: 9007199254740994n,
        actorId: 7n,
        platform: 'Tss Money',
        recipient: '',
        comment: 'CAFÉ',
        createdAt: '2026-11-16 10:00:00',
      },
      {
        id: 9007199254740995n,
        actorId: 999999n,
        platform: 'Tss Points',
        recipient: 'customer.fixture@example.test',
        comment: 'ångström',
        createdAt: '2026-11-16 12:00:00',
      },
      {
        id: 9007199254740996n,
        actorId: 1n,
        platform: 'Gift Voucher ',
        recipient: 'Änne',
        comment: "quoted ' value",
        createdAt: '2026-11-16 23:59:59',
      },
      {
        id: 9007199254740997n,
        actorId: 1n,
        platform: 'Gift Card',
        recipient: '  ',
        comment: 'ordinary',
        createdAt: '2026-11-16 20:00:00',
      },
      {
        id: 9007199254740998n,
        actorId: 1n,
        platform: 'CUSTOM',
        recipient: 'na',
        comment: 'old row',
        createdAt: '2026-11-15 23:59:59',
      },
      {
        id: 9007199254740999n,
        actorId: 1n,
        platform: 'barcode',
        recipient: 'tomorrow',
        comment: 'future row',
        createdAt: '2026-11-17 00:00:00',
      },
    ];
    for (const row of rows)
      await connection.execute(
        'INSERT INTO pos_special_permission_activity_log(id,pos_user_id,platform,recipient,comment,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        [
          String(row.id),
          String(row.actorId),
          row.platform,
          row.recipient,
          row.comment,
          row.createdAt,
          row.createdAt,
        ],
      );
    actor = {
      id: '1',
      name: 'Fixture administrator',
      email: 'fixture@example.test',
      role: 1,
      userType: 1,
      storeIds: [],
    };
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (connection) {
      await connection.query('DROP DATABASE ' + mysql.escapeId(schemaName));
      await connection.end();
    }
  });
  it('matches real pinned Django datatable field/count/search/platform/paging behavior with physical Swedish collations', async () => {
    const base = {
      from: '2026-11-16',
      to: '2026-11-16',
      platforms: [],
      search: '',
      start: 0,
      length: 50,
      draw: 7,
    };
    const cases = [
      base,
      ...[
        'cafe',
        'Å',
        'a',
        'Ä',
        'Ö',
        '%',
        '_',
        '\\',
        '"',
        '2026-11-16',
        'customer.fixture',
        'Saved',
        '9007199254740993',
        '  ',
      ].map((search) => ({ ...base, search })),
      { ...base, platforms: [' gift voucher '] },
      { ...base, platforms: ['tss money', 'TSS POINTS'] },
      { ...base, platforms: [''] },
      { ...base, platforms: ['   '] },
      { ...base, platforms: ['barcode', '', 'barcode'] },
      { ...base, platforms: ['barcode,Tss Money'] },
      { ...base, length: 500 },
      { ...base, start: 1, length: 2 },
      { ...base, start: 2, length: 2 },
      { ...base, start: 3, length: 2 },
      { ...base, start: 1000000, length: 2 },
      { ...base, start: -2, length: 2 },
      { ...base, order: { column: 5, direction: 'desc' } },
      { ...base, search: 'no-such-fixture' },
    ];
    const expected = source(cases),
      service = specialPermissionHistoryService(config, db, {}, undefined, clock);
    for (const [index, value] of cases.entries()) {
      const actual = await service.search(actor, activitySearchInput.parse(value));
      const { queryCount, ...response } = expected[index]!;
      expect(comparable(actual), `source case ${index}`).toEqual(response);
      expect(actual.reader).toBe('data-reader');
      expect(queryCount).toBeGreaterThanOrEqual(1 + response.data.length);
    }
    expect(expected[0]?.data.find((row) => row.id === '9007199254740993')?.added_by).toBe(' ');
    expect(expected[0]?.data.find((row) => row.id === '9007199254740994')?.added_by).toBe(
      '  Saved Actor  ',
    );
    expect(expected[0]?.data.find((row) => row.id === '9007199254740995')?.added_by).toBe(
      'unknown',
    );
    expect(expected[0]?.data.find((row) => row.id === '9007199254740997')?.recipient).toBe('  ');
  }, 15000);
  it('uses one joined bounded data page and one count while preserving global scope without a store table', async () => {
    const reader = drizzle(connection, {
      logger: {
        logQuery(query) {
          readerQueries.push(query);
        },
      },
    });
    const service = specialPermissionHistoryService(
      config,
      {
        get(name) {
          return name === 'data' ? reader : db.get('writer');
        },
      },
      {},
      undefined,
      clock,
    );
    const user: Principal = { ...actor, id: '3', role: 3, storeIds: [] };
    const result = await service.search(
      user,
      activitySearchInput.parse({ from: '2026-11-16', to: '2026-11-16', length: 3 }),
    );
    expect(result.data).toHaveLength(3);
    expect(result.recordsTotal).toBe('6');
    expect(readerQueries.filter((query) => /^select/i.test(query))).toHaveLength(2);
    expect(readerQueries.some((query) => /left join .*pos_user/i.test(query))).toBe(true);
    expect(readerQueries.some((query) => /limit \?/i.test(query))).toBe(true);
    expect(readerQueries.join('\n')).not.toContain('customer.fixture');
  });
  it('retains the source collation boundary without returning database errors or requested values to the client', async () => {
    const value = {
      from: '2026-11-16',
      to: '2026-11-16',
      platforms: ['\u0085barcode\u001c', '\ufeffbarcode'],
    };
    expect(() => source([value])).toThrow(
      'Isolated source oracle failed: OperationalError, case 0.',
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/special-permission-activity/search',
      payload: value,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: 'INTERNAL_ERROR' } });
    expect(response.body).not.toMatch(/barcode|SELECT|collation|parameters|pos_special/);
  });
  it('rejects current franchise, inactive or non-administrative actors before touching report readers', async () => {
    let dataReads = 0;
    const service = specialPermissionHistoryService(
        config,
        {
          get(name) {
            if (name === 'data') dataReads++;
            return db.get(name);
          },
        },
        {},
        undefined,
        clock,
      ),
      input = activitySearchInput.parse({ from: '2026-11-16', to: '2026-11-16' });
    for (const id of ['4', '5', '6'])
      await expect(service.search({ ...actor, id }, input)).rejects.toMatchObject({
        status: id === '6' ? 401 : 403,
      });
    await db.get('writer').update(PosUser).set({ role: 5 }).where(eq(PosUser.id, 1n));
    await expect(service.search(actor, input)).rejects.toMatchObject({
      code: 'SPECIAL_PERMISSION_HISTORY_DENIED',
    });
    expect(dataReads).toBe(0);
  });
  it('routes every no-date, previous-day and mixed-day request only to a configured historical adapter', async () => {
    let dataReads = 0,
      warehouseCalls = 0;
    const service = specialPermissionHistoryService(
      config,
      {
        get(name) {
          if (name === 'data') dataReads++;
          return db.get(name);
        },
      },
      {},
      {
        async queryReport() {
          warehouseCalls++;
          return [];
        },
      },
      clock,
    );
    for (const value of [
      {},
      { from: '2026-11-15', to: '2026-11-15' },
      { from: '2026-11-15', to: '2026-11-16' },
    ])
      await expect(service.search(actor, activitySearchInput.parse(value))).rejects.toMatchObject({
        code: 'SPECIAL_PERMISSION_HISTORY_UNAVAILABLE',
      });
    expect(dataReads).toBe(0);
    expect(warehouseCalls).toBe(0);
  });
  it('serves non-cacheable strict POST filtering and denies contact-bearing GET aliases or invented store scope', async () => {
    const meta = await app.inject('/api/v1/admin/special-permission-activity/capabilities');
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({ today: '2026-11-16', historyConfigured: false });
    const value = { from: '2026-11-16', to: '2026-11-16', search: 'customer.fixture@example.test' };
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/special-permission-activity/search',
      payload: value,
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.json<{ data: unknown[] }>().data).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/admin/special-permission-activity/search?search=customer.fixture@example.test',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/special-permission-activity/search',
          payload: { ...value, storeIds: ['1'] },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('binds no-date and historical requests to one warehouse snapshot and reduces source-oracle projections without MySQL fallback', async () => {
    const projections = z.array(activityProjection).parse(
      await db
        .get('writer')
        .select({
          id: sql<string>`cast(${activity.id} as char)`,
          actorExists: sql<boolean>`${PosUser.id} is not null`.mapWith(
            (value: unknown) => String(value) === '1',
          ),
          firstName: PosUser.first_name,
          lastName: PosUser.last_name,
          platform: activity.platform,
          comment: activity.comment,
          createdAt: activity.createdAt,
          recipient: activity.recipient,
        })
        .from(activity)
        .leftJoin(PosUser, eq(PosUser.id, activity.actorId))
        .orderBy(asc(activity.id)),
    );
    const cases = [
      { from: null, to: null, platforms: [], search: '', start: 0, length: 2, draw: 1 },
      {
        from: '2026-11-15',
        to: '2026-11-15',
        platforms: [],
        search: '',
        start: 0,
        length: 10,
        draw: 2,
      },
      {
        from: '2026-11-15',
        to: '2026-11-16',
        platforms: ['Tss Money'],
        search: 'café',
        start: 1000000,
        length: 2,
        draw: 3,
      },
      {
        from: null,
        to: null,
        platforms: [],
        search: 'nothing-fixture',
        start: 0,
        length: 10,
        draw: 4,
      },
    ];
    const expected = source(cases),
      calls: {
        statement: string;
        params: Record<string, unknown>;
        types: Record<string, string | string[]>;
        label: string;
      }[] = [];
    let index = 0,
      dataReads = 0;
    const service = specialPermissionHistoryService(
      config,
      {
        get(name) {
          if (name === 'data') dataReads++;
          return db.get(name);
        },
      },
      {
        BQ_SPECIAL_PERMISSION_ACTIVITY_VIEW: 'sample-project.pos.activity',
        BQ_SPECIAL_PERMISSION_ACTIVITY_MATCH_UDF: 'sample-project.pos.source_match',
      },
      {
        async queryReport(statement, params, types, label) {
          calls.push({ statement, params, types, label });
          const response = expected[index++]!;
          return [
            {
              total: response.recordsFiltered,
              actual_start: '0',
              data: response.data.map((row) =>
                projections.find((projection) => projection.id === row.id)!,
              ),
            },
          ];
        },
      },
      clock,
    );
    for (const [caseIndex, value] of cases.entries()) {
      const actual = await service.search(actor, activitySearchInput.parse(value));
      const { queryCount: _queryCount, ...response } = expected[caseIndex]!;
      expect(comparable(actual)).toEqual(response);
      expect(actual.reader).toBe('bigquery');
    }
    expect(dataReads).toBe(0);
    expect(calls).toHaveLength(cases.length);
    expect(calls[0]?.params).toMatchObject({ fromTime: null, toTime: null, start: 0, length: 2 });
    expect(calls[2]?.params).toMatchObject({
      fromTime: '2026-11-15 00:00:00',
      toTime: '2026-11-17 00:00:00',
      platforms: ['Tss Money'],
      pattern: '%café%',
    });
    expect(calls[2]?.statement).not.toContain('café');
    expect(calls[2]?.types).toMatchObject({
      fromTime: 'DATETIME',
      toTime: 'DATETIME',
      platforms: ['STRING'],
      pattern: 'STRING',
      start: 'INT64',
      length: 'INT64',
    });
    expect(calls.every((call) => call.label === 'special-permission-activity')).toBe(true);
  });
  it('fails closed on incomplete, reordered, duplicated, numeric-ID or wrong-count warehouse projections', async () => {
    const row = {
      id: '9007199254740993',
      actorExists: false,
      firstName: null,
      lastName: null,
      platform: 'barcode',
      comment: 'fixture',
      createdAt: '2026-11-15 00:00:00',
      recipient: null,
    };
    for (const response of [
      [],
      [{ total: '1', actual_start: '0', data: [] }],
      [{ total: '2', actual_start: '0', data: [row, row] }],
      [{ total: '2', actual_start: '0', data: [{ ...row, id: '9007199254740994' }, row] }],
      [{ total: '1', actual_start: '1', data: [row] }],
      [{ total: '1', actual_start: '0', data: [{ ...row, id: 9007199254740992 }] }],
      [{ total: '1', actual_start: '0', data: [{ ...row, actorExists: true }] }],
    ]) {
      const service = specialPermissionHistoryService(
        config,
        db,
        { BQ_SPECIAL_PERMISSION_ACTIVITY_VIEW: 'sample-project.pos.activity' },
        {
          async queryReport() {
            return response;
          },
        },
        clock,
      );
      await expect(service.search(actor, activitySearchInput.parse({}))).rejects.toMatchObject({
        code: 'SPECIAL_PERMISSION_HISTORY_DATA_INVALID',
      });
    }
    let calls = 0;
    const service = specialPermissionHistoryService(
      config,
      db,
      { BQ_SPECIAL_PERMISSION_ACTIVITY_VIEW: 'sample-project.pos.activity' },
      {
        async queryReport() {
          calls++;
          return [];
        },
      },
      clock,
    );
    await expect(
      service.search(actor, activitySearchInput.parse({ platforms: ['barcode'] })),
    ).rejects.toMatchObject({ code: 'SPECIAL_PERMISSION_HISTORY_UNAVAILABLE' });
    expect(calls).toBe(0);
  });
});
