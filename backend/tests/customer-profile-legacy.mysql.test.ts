import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../src/config.js';
import { createDatabases, type Databases } from '../src/db/pools.js';
import type { Principal } from '../src/domain/access.js';
import { bindCheckInRedis, checkInService } from '../src/modules/administration/checkins.js';
import { checkoutStateSchema } from '../src/modules/checkout/contracts.js';
import { checkoutSessionStore } from '../src/modules/checkout/session-store.js';
import { configuredStateStore } from '../src/modules/checkout/state-store.js';
import { customerProfileService } from '../src/modules/customer-insights/profile.js';
import { customerProfileAdjustmentService } from '../src/modules/customer-insights/adjustments.js';
import { customerProfileChanges } from '../src/modules/customer-insights/contracts.js';
import { memoryOrderRedis } from '../src/modules/fulfillment/order-redis.js';
import { verifiedMysqlFixture } from '../tools/operational-reports/verified-mysql-fixture.js';
import { memoryRedisPort } from './helpers/memory-redis.js';
import { goldenStdout } from './golden/load.js';
import { fixturePlaceholders } from './golden/fixture-placeholders.js';

// Check-ins are the legacy Redis keys; bind an in-process port for this file.
bindCheckInRedis(memoryRedisPort());

/**
 * Pinned AjaxUserUpdateView and AjaxUpdateEndUserDataView (users/views.py:667-693,1050-1075 at
 * 78d5b63) dispatched through real Django over this native fixture, replayed from
 * tests/golden/customer-profile/native-workflow.json (captured with the d7cfa66
 * tools/customer-profile/native-workflow-source.py oracle; the capture runner appends the
 * resulting users row as MySQL text). The browser half of that workflow is not captured.
 */
const integration = process.env.CUSTOMER_PROFILE_MYSQL_TEST_URL;
const dispatched = z.object({
  status: z.number(),
  body: z.unknown(),
  location: z.string().nullable(),
  exceptionType: z.string().nullable(),
  nativeUpdates: z.number(),
  nativeRows: z.array(z.record(z.string(), z.string().nullable())).length(1),
});
type Row = Record<string, string | null>;
describe.skipIf(!integration)('pinned customer profile updates on native MySQL', () => {
  let connection: mysql.Connection, db: Databases, url: string, baseline: Row;
  let config: ReturnType<typeof readConfig>;
  let profiles: ReturnType<typeof customerProfileService>;
  let adjustments: ReturnType<typeof customerProfileAdjustmentService>;
  const redis = memoryOrderRedis();
  const schema = 'pos_rewrite_profile_workflow_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const checkoutId = randomUUID();
  const user: Principal = {
    id: '7',
    role: 4,
    userType: 1,
    name: 'Fixture operator',
    email: 'operator@example.test',
    storeIds: ['1'],
  };
  const scope = { storeId: '1', checkoutId };
  // 2026-11-17 11:30:20 Asia/Kolkata; the capture froze datetime.now() at the same wall time.
  const now = Date.parse('2026-11-17T06:00:20Z');
  function source(target: string, form: Record<string, string>, authenticated = true) {
    return dispatched.parse(
      JSON.parse(
        goldenStdout(
          'customer-profile',
          'native-workflow',
          JSON.stringify({
            url,
            now: '2026-11-17T11:30:20',
            action: 'dispatch',
            target,
            serialized: new URLSearchParams(form).toString(),
            authenticated,
            snapshot: { table: 'users', column: 'id', values: ['777'] },
          }),
          undefined,
          fixturePlaceholders(url),
        ),
      ) as unknown,
    );
  }
  /** Every users column as MySQL text, as the capture runner reads it. */
  async function row(): Promise<Row> {
    const [columns] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ' +
        "AND TABLE_NAME='users' ORDER BY ORDINAL_POSITION",
      [schema],
    );
    const names = columns.map((value) => String(value.name));
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT ${names.map((name) => `CAST(${mysql.escapeId(name)} AS CHAR) AS ${mysql.escapeId(name)}`).join(',')} FROM users WHERE id=777`,
    );
    return Object.fromEntries(
      names.map((name) => [name, (rows[0]![name] as string | null) ?? null]),
    );
  }
  async function restore() {
    const { id: _id, ...values } = baseline;
    await connection.query('UPDATE users SET ? WHERE id=777', [values]);
  }
  async function rewrite(changes: Record<string, string>) {
    await restore();
    await redis.del([...redis.snapshot().keys()]);
    await checkoutSessionStore(configuredStateStore(config)).write(
      checkoutStateSchema.parse({
        id: checkoutId,
        operatorId: '7',
        operatorCustomerId: '700',
        storeId: '1',
        counterId: '2',
        tabId: 1,
        customerId: '777',
        verifiedCustomerUntil: null,
        version: 1,
        phase: 'open',
        cart: { products: { items: [] } },
        quote: null,
        orderId: null,
        paymentConfirmation: null,
        salespersonId: null,
        lineSalespersons: {},
        giftCards: {},
        busyOperationId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const current = await profiles.read(user, scope);
    await adjustments.apply(user, scope, {
      operationId: randomUUID(),
      expectedVersion: 1,
      expectedEtag: current.etag,
      changes,
    });
    return row();
  }
  beforeAll(async () => {
    const base = new URL(integration!);
    if (
      base.protocol !== 'mysql:' ||
      base.hostname !== '127.0.0.1' ||
      base.pathname !== '/pos_rewrite_customer_profile_test' ||
      base.search ||
      base.hash
    )
      throw new Error('Use only the explicit isolated local customer-profile fixture.');
    connection = await mysql.createConnection({
      host: base.hostname,
      port: Number(base.port || 3306),
      user: decodeURIComponent(base.username),
      password: decodeURIComponent(base.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(connection);
    await fixture.create([
      'users',
      'pos_user',
      'stores',
      'store_counters',
      'user_stores',
      'user_eav',
      'gift_vouchers',
      'user_addons',
    ]);
    await fixture.insert('pos_user', {
      id: 7,
      role: 4,
      user_type: 1,
      username: 'fixture-operator',
      is_active: 1,
      is_staff: 1,
    });
    await fixture.insert('stores', { id: 1, type: 'STORE', is_active: 1 });
    await fixture.insert('store_counters', { id: 2, store_id: 1, is_active: 1 });
    await fixture.insert('user_stores', { django_user_id: 7, store_id: 1 });
    await fixture.insert('users', {
      id: 777,
      firstname: '<Fixture>',
      lastname: 'Guest',
      email: 'guest@example.test',
      telephone: '9876543210',
      gender: 'F',
      birthdate: '2000-02-29',
      anniversary: '2020-01-01',
      customer_type: 'B2B',
      gstin: '27ABCDE1234F1Z5',
      tss_money: 100.129,
      tss_points: 0.99,
      status: 1,
      is_block: 0,
      is_disabled: 0,
      user_platform: 'BACK_OFFICE_USER',
      created_at: '2020-01-01 10:00:00',
      updated_at: '2020-01-01 10:00:00',
    });
    baseline = await row();
    base.pathname = '/' + schema;
    url = base.href;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'customer-profile-legacy-key-'.repeat(3),
      MYSQL_WRITER_URL: url,
      MYSQL_PRIMARY_READER_URL: url,
      MYSQL_DATA_READER_URL: url,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
    });
    db = createDatabases(config);
    profiles = customerProfileService(config, db);
    adjustments = customerProfileAdjustmentService(config, db, redis, () => now);
    await checkInService(db, config).set(user, '1', '2');
  }, 30_000);
  beforeEach(restore);
  afterAll(async () => {
    await db?.close();
    if (connection) {
      await connection.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });
  it.each([
    [
      { customer_type: 'B2C', gstin: '' },
      { customerType: 'B2C', gstin: '' },
    ],
    [
      { customer_type: 'B2B', gstin: '29ABCDE1234F1Z5' },
      { customerType: 'B2B', gstin: '29ABCDE1234F1Z5' },
    ],
  ])('update-user %j writes the same users row as the rewrite', async (form, changes) => {
    const legacy = source('/users/update-user', {
      user_id: '777',
      name: 'ignored',
      email: 'ignored@example.test',
      telephone: '0000000000',
      ...form,
    });
    expect(legacy).toMatchObject({
      status: 200,
      body: { status: 200, message: 'User updated successfully+++.' },
      nativeUpdates: 1,
    });
    expect(await rewrite(changes)).toEqual(legacy.nativeRows[0]);
  });
  it.each([
    ['birthday', '2004-02-29', { birthday: '2004-02-29' }],
    ['anniversary', '2022-12-01', { anniversary: '2022-12-01' }],
    ['gender', 'M', { gender: 'M' }],
  ])(
    'ajax-update-user-data %s full-model save matches the rewrite row, including updated_at',
    async (property, value, changes) => {
      const legacy = source('/users/ajax-update-user-data/', {
        user_id: '777',
        user_property: property,
        property_value: value,
      });
      expect(legacy).toMatchObject({
        status: 200,
        body: { status: 200, message: 'User details updated' },
        nativeUpdates: 1,
      });
      expect(await rewrite(changes)).toEqual(legacy.nativeRows[0]);
    },
  );
  it('records the source 200-status validation bodies; the rewrite refuses the same inputs', () => {
    for (const [form, message] of [
      [{}, 'User ID not in payload'],
      [{ user_id: '777' }, 'Property not in payload'],
      [{ user_id: '777', user_property: 'email', property_value: 'x' }, 'Invalid property choice'],
      [{ user_id: '777', user_property: 'gender' }, 'Property not in payload'],
      [{ user_id: '999', user_property: 'gender', property_value: 'M' }, 'User not found'],
    ] as const) {
      const legacy = source('/users/ajax-update-user-data/', form);
      expect(legacy, message).toMatchObject({
        status: 200,
        body: { status: 400, message },
        nativeUpdates: 0,
      });
      expect(legacy.nativeRows[0], message).toEqual(baseline);
    }
    expect(customerProfileChanges.safeParse({}).success).toBe(false);
    expect(customerProfileChanges.safeParse({ email: 'x' }).success).toBe(false);
  });
  it('documents the source unauthenticated profile write and SQL interpolation the rewrite refuses', async () => {
    // users/views.py:1050 lists View before LoginRequiredMixin, so the login check never runs.
    const open = source(
      '/users/ajax-update-user-data/',
      { user_id: '777', user_property: 'gender', property_value: 'O' },
      false,
    );
    expect(open).toMatchObject({ status: 200, body: { status: 200 }, nativeUpdates: 1 });
    expect(open.nativeRows[0]!.gender).toBe('O');
    await restore();
    const guarded = source('/users/update-user', { user_id: '777', customer_type: 'B2C' }, false);
    expect(guarded).toMatchObject({ status: 302, nativeUpdates: 0 });
    expect(guarded.location).toMatch(/^\/accounts\/login\/\?next=/);
    // users/views.py:684 formats request values into the UPDATE; a quote breaks the statement.
    const injected = source('/users/update-user', {
      user_id: '777',
      customer_type: 'B2B',
      gstin: '29ABC"DE1234F1Z',
    });
    // The UPDATE is attempted (counted) and fails; legacy returns the raw MySQL error text.
    expect(injected).toMatchObject({ status: 200, body: { status: 500 }, nativeUpdates: 1 });
    expect(z.object({ message: z.string() }).parse(injected.body).message).toMatch(
      /^Something went wrong: \(1064, /,
    );
    expect(injected.nativeRows[0]).toEqual(baseline);
    expect(customerProfileChanges.safeParse({ gstin: '29ABC"DE1234F1Z' }).success).toBe(false);
  });
});
