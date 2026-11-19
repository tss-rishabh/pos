import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import { getTableName } from 'drizzle-orm';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { readConfig, type Config } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { splitMigration } from '../../src/db/migrations.js';
import {
  PosUser,
  Store,
  StoreCounter,
  StoreStorage,
  UserStore,
  SalesPerson,
  StoreSalesPerson,
  PosTutorial,
  POSFranchise,
  PosMachine,
  PosPaytmMachine,
  ReportExport,
} from '../../src/db/legacy-schema.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { administrationService } from '../../src/modules/administration/service.js';
import { documentationService } from '../../src/modules/administration/documentation.js';
import {
  administrationCollectionExport,
  collectionExportScope,
} from '../../src/modules/administration/collection-export.js';
import { administrationCollectionExportInputSchema } from '../../src/modules/administration/collection-export-contracts.js';
import { registerAdministrationStoreDetails } from '../../src/modules/administration/store-detail-routes.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';

const template = process.env.ADMINISTRATION_MYSQL_TEST_URL;
describe.skipIf(!template)('native administration collection workflows', () => {
  let conn: mysql.Connection,
    db: Databases,
    config: Config,
    schema: string,
    fixture: ReturnType<typeof verifiedMysqlFixture>;
  const tables = [
    PosUser,
    Store,
    StoreCounter,
    StoreStorage,
    UserStore,
    SalesPerson,
    StoreSalesPerson,
    PosTutorial,
    POSFranchise,
    PosMachine,
    PosPaytmMachine,
    ReportExport,
  ].map(getTableName);
  const actor: Principal = {
    id: '1',
    name: 'Synthetic administrator',
    email: 'fixture@example.test',
    role: 1,
    userType: 1,
    storeIds: [],
  };
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_administration_test' ||
      url.search ||
      url.hash
    )
      throw new Error('Explicit isolated localhost administration template required.');
    schema = 'pos_admin_collections_' + randomUUID().replaceAll('-', '').slice(0, 12);
    conn = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    await conn.query('CREATE DATABASE ' + mysql.escapeId(schema));
    await conn.changeUser({ database: schema });
    fixture = verifiedMysqlFixture(conn);
    await fixture.create(tables);
    for (const path of [
      'src/modules/administration/migration.sql',
      'src/modules/administration/media-migration.sql',
      'src/modules/operational-reports/migration.sql',
    ])
      for (const statement of splitMigration(readFileSync(path, 'utf8')))
        await conn.query(statement);
    url.pathname = '/' + schema;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'admin-collection-native-fixture-'.repeat(3),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
    });
    db = createDatabases(config);
  }, 20000);
  afterAll(async () => {
    await db?.close();
    if (conn) {
      await conn.query('DROP DATABASE ' + mysql.escapeId(schema));
      await conn.end();
    }
  });
  beforeEach(async () => {
    for (const table of [
      'pos_rewrite_documentation_assets',
      'pos_rewrite_documentation_revisions',
      'pos_rewrite_report_exports',
      ...tables,
    ])
      await conn.query('DELETE FROM ' + mysql.escapeId(table));
    await fixture.insert(getTableName(PosUser), {
      id: 1,
      username: 'admin-fixture',
      role: 1,
      user_type: 1,
      is_active: 1,
    });
    for (const [id, name] of [
      [1, 'Zulu'],
      [2, 'Alpha'],
      [3, 'Alpha'],
    ] as const)
      await fixture.insert(getTableName(Store), {
        id,
        store_name: name,
        type: 'STORE',
        category: 'IN_HOUSE',
        is_active: id === 3 ? 0 : 1,
      });
  });
  it('pages native collation ties in both directions and rejects changed filter/sort/actor cursors', async () => {
    const service = administrationService(config, db),
      page = {
        after: '0',
        limit: 1,
        search: '',
        active: 'all' as const,
        sort: 'name',
        direction: 'asc' as const,
      };
    const first = await service.stores(actor, page);
    expect(first.data.map((r) => String(r.id))).toEqual(['2']);
    const second = await service.stores(actor, { ...page, after: first.nextCursor! });
    expect(second.data.map((r) => String(r.id))).toEqual(['3']);
    const third = await service.stores(actor, { ...page, after: second.nextCursor! });
    expect(third.data.map((r) => String(r.id))).toEqual(['1']);
    expect(third.nextCursor).toBeNull();
    const reverse = await service.stores(actor, { ...page, direction: 'desc' });
    expect(reverse.data.map((r) => String(r.id))).toEqual(['1']);
    expect(
      (
        await service.stores(actor, { ...page, direction: 'desc', after: reverse.nextCursor! })
      ).data.map((r) => String(r.id)),
    ).toEqual(['3']);
    for (const changed of [{ sort: 'phone' }, { active: 'true' as const }, { search: 'Alpha' }])
      await expect(
        service.stores(actor, { ...page, ...changed, after: first.nextCursor! }),
      ).rejects.toMatchObject({ code: 'ADMINISTRATION_CURSOR_INVALID' });
    await expect(
      service.stores(actor, { ...page, sort: 'name desc; DROP TABLE stores' }),
    ).rejects.toMatchObject({ code: 'ADMINISTRATION_SORT_INVALID' });
  });
  it('preserves native Unicode sorting and current-only archived selection', async () => {
    await conn.query('UPDATE stores SET store_name=? WHERE id=2', ['Ångström']);
    await conn.query('UPDATE stores SET store_name=? WHERE id=3', ['Éclair']);
    const service = administrationService(config, db),
      page = {
        after: '0',
        limit: 1,
        search: '',
        active: 'all' as const,
        sort: 'name',
        direction: 'asc' as const,
      };
    const seen: string[] = [];
    let after = '0';
    do {
      const value = await service.stores(actor, { ...page, after });
      seen.push(...value.data.map((r) => String(r.id)));
      after = value.nextCursor ?? '';
    } while (after);
    expect(new Set(seen).size).toBe(3);
    const [reference] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT id FROM stores ORDER BY store_name ASC,id ASC',
    );
    expect(seen).toEqual(reference.map((row) => String(row.id)));
    expect(
      (await service.stores(actor, { ...page, active: 'false', limit: 500 })).data.map((r) =>
        String(r.id),
      ),
    ).toEqual(['3']);
  });
  it('builds all matching bounded CSV with exact selected columns, formula protection and current authority', async () => {
    await conn.query('UPDATE stores SET store_name=? WHERE id=2', ['=HYPERLINK("synthetic")']);
    const input = administrationCollectionExportInputSchema.parse({
      kind: 'administration-list',
      resource: 'stores',
      columns: ['name', 'id'],
      active: 'all',
      sort: 'id',
      direction: 'asc',
    });
    expect(collectionExportScope(actor, input).requiresGlobal).toBe(true);
    const artifact = await administrationCollectionExport(config, db)(actor, input);
    expect('bytes' in artifact).toBe(true);
    if (!('bytes' in artifact)) throw new Error('CSV expected');
    expect(artifact.rowCount).toBe(3);
    expect(artifact.bytes.toString('utf8')).toContain('"Name","ID"\r\n');
    expect(artifact.bytes.toString('utf8')).toContain("'=HYPERLINK");
    expect(artifact.bytes.toString('utf8')).toContain('""synthetic""');
    await conn.query('UPDATE pos_user SET role=5 WHERE id=1');
    await expect(administrationCollectionExport(config, db)(actor, input)).rejects.toMatchObject({
      code: 'ROLE_ACCESS_DENIED',
    });
  });
  it('refuses arbitrary columns/store scopes and enforces byte limits without partial files', async () => {
    for (const change of [
      { columns: ['password'] },
      { columns: ['id', 'id'] },
      { storeIds: ['1'] },
      { resource: 'counters', storeIds: [] },
    ])
      expect(
        administrationCollectionExportInputSchema.safeParse({
          kind: 'administration-list',
          resource: 'stores',
          columns: ['id'],
          ...change,
        }).success,
      ).toBe(false);
    const input = administrationCollectionExportInputSchema.parse({
      kind: 'administration-list',
      resource: 'stores',
      columns: ['name'],
    });
    await expect(
      administrationCollectionExport(config, db)(actor, input, {
        jobId: randomUUID(),
        signal: new AbortController().signal,
        maxBytes: 8,
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
  });
  it('sorts operators and salespeople by full native names and returns readable batched assignment names', async () => {
    for (const [id, last] of [
      [2, 'Zulu'],
      [3, 'Alpha'],
    ] as const) {
      await fixture.insert(getTableName(PosUser), {
        id,
        username: 'operator-' + id,
        first_name: 'Equal',
        last_name: last,
        role: 5,
        user_type: 1,
        is_active: 1,
      });
      await fixture.insert(getTableName(SalesPerson), {
        id,
        employee_id: 'employee-' + id,
        first_name: 'Equal',
        last_name: last,
        user_type: 1,
        is_active: 1,
      });
      await fixture.insert(getTableName(UserStore), { django_user_id: id, store_id: 1 });
      await fixture.insert(getTableName(StoreSalesPerson), {
        salesperson_id: id,
        store_id: 1,
        is_active: 1,
      });
    }
    const service = administrationService(config, db),
      page = {
        after: '0',
        limit: 1,
        search: 'Equal',
        active: 'true' as const,
        sort: 'name',
        direction: 'asc' as const,
      };
    const operators = await service.operators(actor, page);
    expect(operators.data[0]).toMatchObject({ id: 3n, storeIds: ['1'], storeNames: ['Zulu'] });
    expect(
      (await service.operators(actor, { ...page, after: operators.nextCursor! })).data[0]?.id,
    ).toBe(2n);
    const salespeople = await service.salespeople(actor, page);
    expect(salespeople.data[0]).toMatchObject({
      id: 3n,
      storeIds: ['1'],
      storeNames: ['Zulu'],
      activeStoreId: '1',
    });
    expect(
      (await service.salespeople(actor, { ...page, after: salespeople.nextCursor! })).data[0]?.id,
    ).toBe(2n);
    expect(
      JSON.stringify(operators, (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    ).not.toContain('password');
  });
  it.each(['counters', 'storage'] as const)(
    'paginates %s only inside the selected store and rechecks export assignment/category authority',
    async (resource) => {
      const table = resource === 'counters' ? StoreCounter : StoreStorage,
        name = resource === 'counters' ? 'counter_name' : 'storage_name';
      for (const [id, storeId, label] of [
        [1, 1, 'Zulu'],
        [2, 1, 'Alpha'],
        [3, 2, 'Outside'],
      ] as const)
        await fixture.insert(getTableName(table), {
          id,
          store_id: storeId,
          [name]: label,
          is_active: 1,
        });
      const service = administrationService(config, db),
        page = {
          after: '0',
          limit: 1,
          search: '',
          active: 'true' as const,
          sort: 'name',
          direction: 'asc' as const,
        };
      const read = (after: string) =>
        resource === 'counters'
          ? service.counters(actor, '1', { ...page, after })
          : service.storages(actor, '1', { ...page, after });
      const first = await read('0');
      expect(first.data.map((row) => String(row.id))).toEqual(['2']);
      expect((await read(first.nextCursor!)).data.map((row) => String(row.id))).toEqual(['1']);
      const input = administrationCollectionExportInputSchema.parse({
        kind: 'administration-list',
        resource,
        storeIds: ['1'],
        columns: ['id', 'name'],
      });
      const artifact = await administrationCollectionExport(config, db)(actor, input);
      expect(artifact.rowCount).toBe(2);
      await conn.query('UPDATE pos_user SET role=2,user_type=2 WHERE id=1');
      const franchise = { ...actor, role: 2 as const, userType: 2 as const, storeIds: ['1'] };
      await expect(
        administrationCollectionExport(config, db)(franchise, input),
      ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
      await conn.query("UPDATE stores SET category='FRANCHISE' WHERE id=1");
      await fixture.insert(getTableName(UserStore), { django_user_id: 1, store_id: 1 });
      expect((await administrationCollectionExport(config, db)(franchise, input)).rowCount).toBe(2);
      await conn.query('DELETE FROM user_stores WHERE django_user_id=1');
      await expect(
        administrationCollectionExport(config, db)(franchise, input),
      ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    },
  );
  it('keeps documentation priority paging backwards compatible while new sorts and archived export use real native rows', async () => {
    for (const [id, title, active] of [
      [1, 'Zulu', 1],
      [2, 'Alpha', 1],
      [3, 'Archived', 0],
    ] as const)
      await fixture.insert(getTableName(PosTutorial), {
        id,
        title,
        is_active: active,
        sort_value: id,
        created_by: 1,
        short_discription: 'Summary',
        discription: 'Safe',
        image_link: '[]',
        video_link: '[]',
        doc_link: '[]',
        cover_image: '[]',
      });
    const guides = documentationService(config, db),
      page = { after: '0', limit: 1, search: '', active: 'true' as const };
    const old = await guides.list(actor, page);
    expect(old.data[0]?.id).toBe('2');
    expect(old.nextCursor).toMatch(/^v1\./);
    expect((await guides.list(actor, { ...page, after: old.nextCursor! })).data[0]?.id).toBe('1');
    const first = await guides.list(actor, { ...page, sort: 'title', direction: 'asc' });
    expect(first.data[0]?.id).toBe('2');
    expect(first.nextCursor).toMatch(/^c1\./);
    expect(
      (
        await guides.list(actor, {
          ...page,
          sort: 'title',
          direction: 'asc',
          after: first.nextCursor!,
        })
      ).data[0]?.id,
    ).toBe('1');
    const input = administrationCollectionExportInputSchema.parse({
      kind: 'administration-list',
      resource: 'documentation',
      columns: ['title', 'uploader'],
      active: 'false',
    });
    expect((await administrationCollectionExport(config, db)(actor, input)).rowCount).toBe(1);
    await conn.query('UPDATE pos_user SET role=2 WHERE id=1');
    await expect(
      administrationCollectionExport(config, db)({ ...actor, role: 2 }, input),
    ).rejects.toMatchObject({ code: 'ROLE_ACCESS_DENIED' });
  });
  it('serves the selected native store detail and PNG QR, without requiring or changing check-in', async () => {
    const app = Fastify({ logger: false });
    app.decorateRequest('principal', null);
    app.addHook('preHandler', async (request) => {
      request.principal = actor;
    });
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof AppError ? error.status : 500)
        .send({ error: 'Synthetic fixture refusal' }),
    );
    registerAdministrationStoreDetails(app, db);
    try {
      const detail = await app.inject('/api/v1/admin/stores/2/detail');
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        id: '2',
        name: 'Alpha',
        publicUrl: 'https://thesouledstore.com/?store_id=2',
      });
      expect(detail.body).not.toMatch(/password|merchant_key|mfa_hash/);
      const qr = await app.inject('/api/v1/admin/stores/2/qr');
      expect(qr.statusCode).toBe(200);
      expect(qr.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(qr.headers['content-disposition']).toBe('attachment; filename="store-2-qr.png"');
      await conn.query('UPDATE pos_user SET is_active=0 WHERE id=1');
      expect((await app.inject('/api/v1/admin/stores/2/qr')).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
