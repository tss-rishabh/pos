import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { testAuthRedis, testSessions } from '../helpers/auth-sessions.js';
import { seal } from '../../src/auth/crypto.js';
import { readConfig } from '../../src/config.js';
import { readStoreDefaultOperatorOptions } from '../../src/modules/administration/store-default-operators.js';
import { barcodeFixture } from '../../tools/administration/barcodes/fixture.js';

const template = process.env.STORE_DEFAULT_OPERATORS_MYSQL_URL;
const origin = 'http://127.0.0.1:4410';
const payload = {
  store_name: 'Synthetic configured store',
  short_name: 'Configured',
  location_code: 'NEW',
  type: 'STORE',
  category: 'IN_HOUSE',
  latitude: '19.0760',
  longitude: '72.8777',
  address: 'Synthetic store address',
  city_id: '1111',
  country_id: '99',
  phone: '9876543298',
};

it('distinguishes missing, explicitly empty and invalid source contact configuration', () => {
  expect(readStoreDefaultOperatorOptions({})).toEqual({});
  expect(readStoreDefaultOperatorOptions({ STOREDEFAULTUSER: '' })).toEqual({
    defaultStoreOperatorContactEmails: [],
  });
  expect(readStoreDefaultOperatorOptions({ STOREDEFAULTUSER: '  ' })).toEqual({
    defaultStoreOperatorContactEmails: [],
  });
  expect(() =>
    readStoreDefaultOperatorOptions({
      STOREDEFAULTUSER: 'recipient@example.test,,other@example.test',
    }),
  ).toThrow();
  for (const token of [' recipient@example.test', 'recipient@example.test '])
    expect(() => readStoreDefaultOperatorOptions({ STOREDEFAULTUSER: token })).toThrow();
  expect(
    readStoreDefaultOperatorOptions({
      STOREDEFAULTUSER: 'Recipient@example.test,other@example.test',
    }),
  ).toEqual({
    defaultStoreOperatorContactEmails: ['Recipient@example.test', 'other@example.test'],
  });
});

describe.skipIf(!template)('actual App native-cookie store default identities', () => {
  let native: Awaited<ReturnType<typeof barcodeFixture>>;
  let app: FastifyInstance | undefined;
  let cookie: string;
  let archivedCookie: string;
  let config: ReturnType<typeof readConfig>;
  const sessions = () => testSessions(config, native.db);
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.port === '54777' ||
      url.pathname !== '/pos_rewrite_store_defaults_test'
    )
      throw new Error('EXPLICIT_OWNED_STORE_DEFAULT_FIXTURE_REQUIRED');
    native = await barcodeFixture(template!);
    await native.fixture.create(['user_stores', 'pos_franchise', 'tss_settings', 'store_counters']);
    config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'false',
      WEB_ORIGIN: origin,
      SESSION_SECRET: 'synthetic-store-default-identity-'.repeat(3),
      MYSQL_WRITER_URL: native.url,
      MYSQL_PRIMARY_READER_URL: native.url,
      MYSQL_DATA_READER_URL: native.url,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    });
  });
  beforeEach(async () => {
    for (const table of [
      'user_stores',
      'store_counters',
      'stores',
      'pos_franchise',
      'tss_settings',
      'pos_user',
    ])
      await native.admin.query('DELETE FROM `' + table + '`');
    for (const [id, contact] of [
      ['1', 'actor-contact@example.test'],
      ['2', 'first-contact@example.test'],
      ['3', 'archived-contact@example.test'],
      ['30', 'later-contact@example.test'],
    ] as const)
      await native.seed('pos_user', {
        id,
        username: `synthetic-default-${id}`,
        email: `login-${id}@example.test`,
        contact_email: contact,
        role: id === '1' ? 1 : 5,
        user_type: 1,
        is_active: 1,
      });
    await native.seed('tss_settings', { id: 1, platform: 'STORE_LOCATION_CODE', value: '["NEW"]' });
    const createCookie = async (id: string) =>
      'pos_session=' + seal({ id, ...(await sessions().create(id)) }, config.SESSION_SECRET);
    cookie = await createCookie('1');
    archivedCookie = await createCookie('3');
    await native.admin.query('UPDATE pos_user SET is_active=0 WHERE id=3');
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await native?.close();
  });
  async function application(raw: string | undefined) {
    vi.stubEnv('STOREDEFAULTUSER', raw);
    app = await buildApp(config, { logger: false, authRedis: testAuthRedis });
    await app.ready();
    return app;
  }
  async function create() {
    return app!.inject({
      method: 'POST',
      url: '/api/v1/admin/stores',
      headers: { cookie, origin, 'x-operator-id': '1' },
      payload,
    });
  }
  async function counts() {
    const [rows] = await native.admin.query<RowDataPacket[]>(
      'SELECT (SELECT COUNT(*) FROM stores) AS stores,(SELECT COUNT(*) FROM store_counters) AS counters,(SELECT COUNT(*) FROM user_stores) AS assignments,(SELECT COUNT(*) FROM pos_franchise) AS franchises',
    );
    const row = rows[0];
    return {
      stores: Number(row?.stores),
      counters: Number(row?.counters),
      assignments: Number(row?.assignments),
      franchises: Number(row?.franchises),
    };
  }
  it('resolves configured contact_email recipients through real registration, retaining archived assignments without granting archived access', async () => {
    await application('first-contact@example.test,archived-contact@example.test');
    const response = await create();
    expect(response.statusCode).toBe(201);
    const id = response.json<{ id: string }>().id;
    const [stored] = await native.admin.execute<RowDataPacket[]>(
      'SELECT slack_group_url FROM stores WHERE id=?',
      [id],
    );
    expect(stored[0]?.slack_group_url).toBe('');
    const [assigned] = await native.admin.execute<RowDataPacket[]>(
      'SELECT CAST(django_user_id AS CHAR) AS id FROM user_stores WHERE store_id=? ORDER BY django_user_id',
      [id],
    );
    expect(assigned.map((row) => row.id)).toEqual(['2', '3']);
    expect(await counts()).toMatchObject({ stores: 1, counters: 1, assignments: 2, franchises: 0 });
    const denied = await app!.inject({
      method: 'GET',
      url: '/api/v1/stores',
      headers: { cookie: archivedCookie, 'x-operator-id': '3' },
    });
    expect(denied.statusCode).toBe(401);
  });
  it('honors explicit empty configuration through actual App creation', async () => {
    await application('');
    expect((await create()).statusCode).toBe(201);
    expect(await counts()).toMatchObject({ stores: 1, counters: 1, assignments: 0, franchises: 0 });
  });
  it('keeps missing configuration unavailable without preventing startup or creating partial rows', async () => {
    await application(undefined);
    const response = await create();
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(await counts()).toMatchObject({ stores: 0, counters: 0, assignments: 0, franchises: 0 });
  });
  it('resolves current identities at the write, skipping source-missing/deleted recipients rather than caching startup IDs', async () => {
    await application('first-contact@example.test,missing-contact@example.test');
    await native.admin.query('DELETE FROM pos_user WHERE id=2');
    await native.admin.query(
      "UPDATE pos_user SET contact_email='first-contact@example.test' WHERE id=30",
    );
    expect((await create()).statusCode).toBe(201);
    const [assigned] = await native.admin.query<RowDataPacket[]>(
      'SELECT CAST(django_user_id AS CHAR) AS id FROM user_stores',
    );
    expect(assigned.map((row) => row.id)).toEqual(['30']);
  });
  it('retains current actor archive denial before all creation side effects', async () => {
    await application('first-contact@example.test');
    await native.admin.query('UPDATE pos_user SET is_active=0 WHERE id=1');
    expect((await create()).statusCode).toBe(401);
    expect(await counts()).toMatchObject({ stores: 0, counters: 0, assignments: 0, franchises: 0 });
  });
  it('atomically refuses ambiguous legacy identities under their native collation', async () => {
    await application('first-contact@example.test');
    // Explicit corruption/fault injection on this disposable fixture only.
    // Normal physical-schema cases above retain the captured unique index.
    await native.admin.query('ALTER TABLE pos_user DROP INDEX contact_email');
    try {
      await native.admin.query(
        "UPDATE pos_user SET contact_email='FIRST-CONTACT@example.test' WHERE id=30",
      );
      const response = await create();
      expect(response.statusCode).toBe(503);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        'STORE_DEFAULT_OPERATORS_AMBIGUOUS',
      );
      expect(await counts()).toMatchObject({
        stores: 0,
        counters: 0,
        assignments: 0,
        franchises: 0,
      });
    } finally {
      await native.admin.query(
        "UPDATE pos_user SET contact_email='later-contact@example.test' WHERE id=30",
      );
      await native.admin.query('CREATE UNIQUE INDEX contact_email ON pos_user(contact_email)');
    }
  });
});
