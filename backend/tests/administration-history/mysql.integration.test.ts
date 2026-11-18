import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql, { type Connection } from 'mysql2/promise';
import Fastify, { type FastifyInstance } from 'fastify';
import { Temporal } from '@js-temporal/polyfill';
import { z, ZodError } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { PosUser, Store } from '../../src/db/legacy-schema.js';
import { AppError } from '../../src/domain/errors.js';
import type { Principal } from '../../src/domain/access.js';
import {
  legacyFixtureRecord,
  legacyFixtureTableSql,
} from '../../tools/administration/mysql-fixture.js';
import {
  registerAdministrationHistory,
  administrationHistoryService,
} from '../../src/modules/administration-history/index.js';
import {
  historyInput,
  historySourceContract,
  type AdministrationHistoryOptions,
} from '../../src/modules/administration-history/contracts.js';
import { administrationHistoryAuthActor } from '../../src/modules/administration-history/schema.js';
import { goldenSpawnResult } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';

const template = process.env.ADMINISTRATION_HISTORY_MYSQL_TEST_URL;
const clock = () => Temporal.Instant.from('2026-11-16T12:00:00Z');
const options: AdministrationHistoryOptions = {
  POS_ADMINISTRATION_HISTORY_MYSQL_CONTRACT: historySourceContract,
  POS_ADMINISTRATION_HISTORY_MYSQL_ACTOR: 'auth-user',
  BQ_ADMINISTRATION_HISTORY_VIEW: 'fixture-project.history.admin_log',
  BQ_ADMINISTRATION_HISTORY_MATCH_UDF: 'fixture-project.history.admin_match',
  BQ_ADMINISTRATION_HISTORY_CONTRACT: historySourceContract,
};
const groupId = '64f6d568-21d5-448c-87bc-e184fd4fcbdc',
  newGroupId = '721bb2a5-8ddb-4c25-a7b2-b169b84d70cf';
const sourceRow = z.object({
  id: z.string(),
  actorId: z.string(),
  actor: z.string(),
  actionTimeLabel: z.string(),
  action: z.string(),
  actionFlag: z.number(),
});
const sourcePage = z.object({
  total: z.string(),
  page: z.string(),
  pages: z.string(),
  data: z.array(sourceRow),
});
describe.skipIf(!template)('inherited model history against isolated MySQL', () => {
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
  let dailyReads = 0;
  const dailyInput = (extra: Record<string, unknown> = {}) =>
    historyInput.parse({
      model: 'operator',
      objectId: '9007199254740993',
      from: '2026-11-16',
      to: '2026-11-16',
      ...extra,
    });
  const tracked = () => ({
    ...db,
    get(name: Parameters<Databases['get']>[0]) {
      if (name === 'data') dailyReads++;
      return db.get(name);
    },
  });
  const source = (cases: unknown[], actorTable = 'auth_user') => {
    const run = goldenSpawnResult(
      'administration-history',
      'mysql-integration',
      JSON.stringify({ database: databaseUrl, actorTable, cases }),
      undefined,
      fixturePlaceholders(databaseUrl),
    );
    const value: unknown = JSON.parse(run.stdout);
    if (run.status !== 0)
      throw new Error(
        'Isolated Django history oracle failed: ' +
          z.object({ kind: z.string() }).parse(value).kind,
      );
    return z.object({ djangoVersion: z.literal('4.2.5'), cases: z.array(sourcePage) }).parse(value)
      .cases;
  };
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_administration_history_test'
    )
      throw new Error('Use the explicitly isolated local administration-history schema template.');
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
    schemaName = `pos_rewrite_administration_history_test_${process.pid}_${randomUUID().slice(0, 8)}`;
    await connection.query(
      `CREATE DATABASE ${mysql.escapeId(schemaName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
    );
    await connection.changeUser({ database: schemaName });
    await connection.query(legacyFixtureTableSql(PosUser));
    await connection.query(legacyFixtureTableSql(Store));
    await connection.query(legacyFixtureTableSql(administrationHistoryAuthActor));
    await connection.query(
      "ALTER TABLE auth_user ADD COLUMN password VARCHAR(128) NOT NULL DEFAULT 'fixture-not-a-password', ADD COLUMN last_login DATETIME(6) NULL",
    );
    await connection.query(
      'CREATE TABLE django_content_type (id INT NOT NULL PRIMARY KEY,app_label VARCHAR(100) NOT NULL,model VARCHAR(100) NOT NULL,UNIQUE KEY content_identity(app_label,model)) CHARACTER SET latin1 COLLATE latin1_swedish_ci ENGINE=InnoDB',
    );
    await connection.query(
      'CREATE TABLE django_admin_log (id INT NOT NULL PRIMARY KEY AUTO_INCREMENT,action_time DATETIME(6) NOT NULL,object_id LONGTEXT NULL,object_repr VARCHAR(200) NOT NULL,action_flag SMALLINT UNSIGNED NOT NULL,change_message LONGTEXT NOT NULL,content_type_id INT NULL,user_id INT NOT NULL,INDEX content_type_id(content_type_id),INDEX user_id(user_id),FOREIGN KEY(content_type_id) REFERENCES django_content_type(id),FOREIGN KEY(user_id) REFERENCES auth_user(id)) CHARACTER SET latin1 COLLATE latin1_swedish_ci ENGINE=InnoDB',
    );
    await connection.query(
      'CREATE TABLE pos_rewrite_administration_registries (resource VARCHAR(32) PRIMARY KEY) ENGINE=InnoDB',
    );
    for (const statement of readFileSync('src/modules/administration/access-migration.sql', 'utf8')
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean))
      await connection.query(statement);
    url.pathname = '/' + schemaName;
    databaseUrl = url.href;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'isolated-admin-history-secret-'.repeat(2),
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
    registerAdministrationHistory(app, config, db, options, undefined, clock);
    await app.ready();
  });
  beforeEach(async () => {
    for (const table of [
      'django_admin_log',
      'django_content_type',
      'auth_user',
      'pos_rewrite_administration_direct_permissions',
      'pos_rewrite_administration_memberships',
      'pos_rewrite_administration_group_permissions',
      'pos_rewrite_administration_groups',
      'pos_rewrite_administration_access_reconciliation',
      'pos_user',
      'stores',
    ])
      await connection.query('DELETE FROM ' + mysql.escapeId(table));
    dailyReads = 0;
    actor = {
      id: '1',
      name: 'Fixture administrator',
      email: 'fixture@example.test',
      role: 1,
      userType: 1,
      storeIds: [],
    };
    for (const [id, username, first, last] of [
      ['1', 'current-pos-admin', 'Current', 'POS'],
      ['7', 'pos-same-id', 'Wrong', 'Actor'],
      ['9007199254740993', 'exact-object', 'Target', 'Operator'],
    ] as const) {
      const row = legacyFixtureRecord(PosUser, {
          id,
          username,
          first_name: first,
          last_name: last,
          role: 1,
          user_type: 1,
          is_active: true,
          is_staff: true,
          is_superuser: id === '1',
        }),
        names = Object.keys(row);
      await connection.execute(
        `INSERT INTO pos_user (${names.map(mysql.escapeId).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
        names.map((name) => row[name]),
      );
    }
    const store = legacyFixtureRecord(Store, {
        id: '1',
        store_name: 'Archived fixture store',
        is_active: false,
      }),
      names = Object.keys(store);
    await connection.execute(
      `INSERT INTO stores (${names.map(mysql.escapeId).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      names.map((name) => store[name]),
    );
    await connection.query(
      "INSERT INTO auth_user(id,username,first_name,last_name) VALUES(1,'auth-admin','Historical','Auth'),(7,'source-author','  Saved','Actor  ')",
    );
    await connection.query(
      "INSERT INTO django_content_type VALUES(1,'users','posuser'),(2,'stores','store'),(3,'auth','group'),(4,'other','store')",
    );
    await connection.execute(
      "INSERT INTO pos_rewrite_administration_access_reconciliation(id,verified,source_fingerprint,snapshot_hash,operator_id,counts,completed_at) VALUES('legacy',1,?,?,'1','{}',NOW(3))",
      ['a'.repeat(64), 'b'.repeat(64)],
    );
    await connection.execute(
      'INSERT INTO pos_rewrite_administration_groups(id,name,revision,legacy_id,updated_at) VALUES(?,?,1,48,NOW(3)),(?,?,1,NULL,NOW(3))',
      [groupId, 'Imported source group', newGroupId, 'New rewrite group'],
    );
    const rows: unknown[][] = [];
    for (let index = 1; index <= 205; index++)
      rows.push([
        index,
        `2026-11-16 10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.123456`,
        '9007199254740993',
        'Target fixture',
        2,
        JSON.stringify([{ changed: { fields: [index === 1 ? 'email' : 'role'] } }]),
        1,
        index % 2 ? 7 : 1,
      ]);
    rows.push(
      [
        206,
        '2026-11-15 23:59:59.999999',
        '9007199254740993',
        'Old fixture',
        1,
        '[{"added":{}}]',
        1,
        7,
      ],
      [
        207,
        '2026-11-17 00:00:00.000000',
        '9007199254740993',
        'Future fixture',
        3,
        'Plain future',
        1,
        7,
      ],
      [
        208,
        '2026-11-16 00:00:00.000000',
        '1 ',
        'Archived fixture store',
        2,
        '[{"changed":{"fields":["store name"]}}]',
        2,
        7,
      ],
      [209, '2026-11-16 12:00:00.000000', '48', 'Imported group', 1, '[{"added":{}}]', 3, 1],
      [210, '2026-11-16 12:00:00.000000', '01', 'No leading-zero match', 1, 'Ignored', 2, 1],
      [211, '2026-11-16 12:00:00.000000', '1', 'Wrong content type', 1, 'Ignored', 4, 1],
    );
    await connection.query(
      'INSERT INTO django_admin_log(id,action_time,object_id,object_repr,action_flag,change_message,content_type_id,user_id) VALUES ?',
      [rows],
    );
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (connection) {
      await connection.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schemaName)}`);
      await connection.end();
    }
  });

  it('matches actual Django joined history and fixed pagination, preserving exact object IDs and microsecond boundaries', async () => {
    const cases = ['1', '2', '3', '0', '-1', '999999999999999999999999', 'bad', '+2', '٢'].map(
      (page) => ({
        page,
        appLabel: 'users',
        model: 'posuser',
        objectId: '9007199254740993',
        from: '2026-11-16 00:00:00',
        to: '2026-11-17 00:00:00',
      }),
    );
    const expected = source(cases),
      service = administrationHistoryService(config, tracked(), options, undefined, clock);
    for (const [index, input] of cases.entries()) {
      const result = await service.search(actor, dailyInput({ page: input.page }));
      expect({
        total: result.total,
        page: result.page,
        pages: result.pages,
        data: result.data.map(({ id, actorId, actor, actionTimeLabel, action, actionFlag }) => ({
          id,
          actorId,
          actor,
          actionTimeLabel,
          action,
          actionFlag,
        })),
      }).toEqual(expected[index]);
      expect(result.data.length).toBe(result.count);
    }
    expect(dailyReads).toBe(cases.length);
  });
  it('uses the explicitly bound auth actor and current names rather than an overlapping PosUser ID', async () => {
    const service = administrationHistoryService(config, db, options, undefined, clock);
    let result = await service.search(actor, dailyInput());
    expect(result.data[0]!.actor).toBe('source-author (Saved Actor)');
    expect(JSON.stringify(result.data)).not.toContain('Wrong Actor');
    await connection.query(
      "UPDATE auth_user SET username='renamed-source-author',first_name='',last_name='' WHERE id=7",
    );
    result = await service.search(actor, dailyInput());
    expect(result.data[0]!.actor).toBe('renamed-source-author');
  });
  it('preserves source object text equality and permits an existing archived store under its current model grant', async () => {
    const service = administrationHistoryService(config, db, options, undefined, clock),
      result = await service.search(actor, dailyInput({ model: 'store', objectId: '1' }));
    expect(result.total).toBe('1');
    expect(result.resource.label).toBe('Archived fixture store');
    expect(result.data[0]!.id).toBe('208');
    const expected = source([
      {
        appLabel: 'stores',
        model: 'store',
        objectId: '1',
        from: '2026-11-16 00:00:00',
        to: '2026-11-17 00:00:00',
      },
    ])[0]!;
    expect(result.data.map((row) => row.id)).toEqual(expected.data.map((row) => row.id));
  });
  it('maps imported group history by the verified legacy key and returns no fabricated history for new rewrite groups', async () => {
    const service = administrationHistoryService(config, tracked(), options, undefined, clock);
    expect(
      (await service.search(actor, dailyInput({ model: 'group', objectId: groupId }))).data[0]!.id,
    ).toBe('209');
    const fresh = await service.search(
      actor,
      historyInput.parse({ model: 'group', objectId: newGroupId }),
    );
    expect(fresh.reader).toBe('none');
    expect(fresh.total).toBe('0');
    expect(fresh.notice).toContain('no legacy Django history');
    expect(dailyReads).toBe(1);
  });
  it('checks writer-current staff/type/role/activity/reconciliation and view-or-change grants before accessing a reader', async () => {
    const service = administrationHistoryService(config, tracked(), options, undefined, clock);
    for (const mutation of [
      'UPDATE pos_user SET is_staff=0 WHERE id=1',
      'UPDATE pos_user SET user_type=2 WHERE id=1',
      'UPDATE pos_user SET role=2 WHERE id=1',
      'UPDATE pos_user SET is_active=0 WHERE id=1',
    ]) {
      await connection.query(mutation);
      await expect(service.search(actor, dailyInput())).rejects.toBeInstanceOf(AppError);
      await connection.query(
        'UPDATE pos_user SET is_staff=1,user_type=1,role=1,is_active=1 WHERE id=1',
      );
    }
    await connection.query(
      'UPDATE pos_rewrite_administration_access_reconciliation SET verified=0',
    );
    await expect(service.search(actor, dailyInput())).rejects.toMatchObject({
      code: 'ADMIN_ACCESS_RECONCILIATION_REQUIRED',
    });
    await connection.query(
      'UPDATE pos_rewrite_administration_access_reconciliation SET verified=1',
    );
    await connection.query('UPDATE pos_user SET is_superuser=0 WHERE id=1');
    await expect(service.search(actor, dailyInput())).rejects.toMatchObject({ status: 403 });
    expect(dailyReads).toBe(0);
    for (const key of ['users.view_posuser', 'users.change_posuser']) {
      await connection.execute(
        'INSERT INTO pos_rewrite_administration_direct_permissions(operator_id,permission_key) VALUES(1,?)',
        [key],
      );
      expect((await service.search(actor, dailyInput())).total).toBe('205');
      await connection.query('DELETE FROM pos_rewrite_administration_direct_permissions');
    }
    expect((await service.capabilities(actor)).models).toEqual([]);
  });
  it('requires the target to exist and the explicit actor/physical source binding before daily reads', async () => {
    const service = administrationHistoryService(config, tracked(), {}, undefined, clock);
    await expect(service.search(actor, dailyInput({ objectId: '999' }))).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.search(actor, dailyInput())).rejects.toMatchObject({
      code: 'ADMINISTRATION_HISTORY_SOURCE_UNVERIFIED',
    });
    expect(dailyReads).toBe(0);
    await expect(
      administrationHistoryService(
        config,
        tracked(),
        { ...options, POS_ADMINISTRATION_HISTORY_MYSQL_ACTOR: 'pos-user' },
        undefined,
        clock,
      ).search(actor, dailyInput()),
    ).rejects.toMatchObject({ code: 'ADMINISTRATION_HISTORY_SOURCE_UNVERIFIED' });
    expect(dailyReads).toBe(1);
  });
  it('routes all/older/mixed history only to bound BigQuery and validates its envelope, ordering and source formatting', async () => {
    const calls: { statement: string; parameters: Record<string, unknown> }[] = [];
    const projection = {
      id: '17',
      actionTime: '2026-11-15 10:00:00.123456',
      actorId: '7',
      actorUsername: 'source-author',
      actorFirstName: '  Saved',
      actorLastName: 'Actor  ',
      actionFlag: 2,
      changeMessage: '[{"changed":{"fields":["email","role"]}}]',
    };
    const service = administrationHistoryService(
      config,
      tracked(),
      options,
      {
        async queryReport(statement, parameters) {
          calls.push({ statement, parameters });
          return [{ total: '1', page: '1', pages: '1', data: [projection] }];
        },
      },
      clock,
    );
    for (const dates of [
      { from: null, to: null },
      { from: '2026-11-15', to: '2026-11-15' },
      { from: '2026-11-15', to: '2026-11-16' },
    ]) {
      const result = await service.search(
        actor,
        dailyInput({
          ...dates,
          page: '99999999999999999999999999999999999999999999999999999999999999999999999999999999',
        }),
      );
      expect(result.reader).toBe('bigquery');
      expect(result.data[0]!.action).toBe('Changed email and role.');
      expect(result.data[0]!.actor).toBe('source-author (Saved Actor)');
    }
    expect(dailyReads).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.parameters.objectId).toBe('9007199254740993');
    expect(calls[0]!.parameters.requestedPage).toBe('18446744073709551615');
    expect(calls[0]!.statement).toContain('`fixture-project.history.admin_match`');
    expect(calls[0]!.statement).not.toContain('9007199254740993');
    await expect(
      administrationHistoryService(config, tracked(), {}, undefined, clock).search(
        actor,
        historyInput.parse({ model: 'operator', objectId: '1' }),
      ),
    ).rejects.toMatchObject({ code: 'ADMINISTRATION_HISTORY_SOURCE_UNVERIFIED' });
    for (const bad of [
      { total: '2', page: '1', pages: '1', data: [projection] },
      { total: '1', page: '0', pages: '1', data: [projection] },
      { total: '1', page: '1', pages: '1', data: [{ ...projection, actorUsername: null }] },
      { total: '2', page: '1', pages: '1', data: [projection, projection] },
    ])
      await expect(
        administrationHistoryService(
          config,
          tracked(),
          options,
          { queryReport: async () => [bad] },
          clock,
        ).search(actor, historyInput.parse({ model: 'operator', objectId: '1' })),
      ).rejects.toMatchObject({ code: 'ADMINISTRATION_HISTORY_DATA_INVALID' });
    expect(dailyReads).toBe(0);
  });
  it('rejects a revoked grant after warehouse I/O without historical MySQL fallback', async () => {
    const service = administrationHistoryService(
      config,
      tracked(),
      options,
      {
        async queryReport() {
          await connection.query('UPDATE pos_user SET is_staff=0 WHERE id=1');
          return [{ total: '0', page: '1', pages: '1', data: [] }];
        },
      },
      clock,
    );
    await expect(
      service.search(actor, historyInput.parse({ model: 'operator', objectId: '1' })),
    ).rejects.toMatchObject({ status: 403 });
    expect(dailyReads).toBe(0);
  });
  it('exposes traced read-only strict body routes with private cache headers and no query-string search', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/model-history/search',
      payload: dailyInput({ model: 'store', objectId: '1' }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/admin/model-history/search?objectId=1' }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/model-history/search?search=private',
          payload: dailyInput(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/model-history/search',
          payload: { ...dailyInput(), search: 'private' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/v1/admin/model-history/1' })).statusCode,
    ).toBe(404);
  });
});
