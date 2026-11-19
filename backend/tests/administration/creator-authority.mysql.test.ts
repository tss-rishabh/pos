import { readFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { splitMigration } from '../../src/db/migrations.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { operatorCreator } from '../../src/modules/administration/operator-create.js';
import { administrationService } from '../../src/modules/administration/service.js';
import { operatorCreateInput } from '../../src/modules/administration/contracts.js';
import { storeFormInput } from '../../src/modules/administration/store-form.js';
import { barcodeFixture } from '../../tools/administration/barcodes/fixture.js';

const database = process.env.ADMINISTRATION_CREATOR_MYSQL_URL;
const actor: Principal = {
  id: '1',
  name: 'Synthetic creator',
  email: 'creator@example.test',
  role: 1,
  userType: 1,
  storeIds: [],
};
const operatorInput = () =>
  operatorCreateInput.parse({
    firstName: 'Synthetic',
    lastName: 'Operator',
    email: 'new-operator@example.test',
    phone: '9876543299',
    contactEmail: 'new-otp@example.test',
    role: 1,
    userType: 1,
    otpMethod: 2,
    password: 'Riv3r!Cobalt-Forest#89',
    confirmPassword: 'Riv3r!Cobalt-Forest#89',
  });
const store = () =>
  storeFormInput.parse({
    store_name: 'Synthetic new store',
    short_name: 'Synthetic',
    location_code: 'NEW',
    type: 'STORE',
    category: 'IN_HOUSE',
    latitude: '19.0760',
    longitude: '72.8777',
    address: 'Synthetic address',
    city_id: '1111',
    country_id: '0',
    phone: '9876543298',
  });
const countedTables = [
  'pos_user',
  'users',
  'stores',
  'store_counters',
  'user_stores',
  'pos_franchise',
] as const;

describe.skipIf(!database)('writer-current creator authority on owned native MySQL', () => {
  let native: Awaited<ReturnType<typeof barcodeFixture>>;
  let barrier: Connection;
  beforeAll(async () => {
    const url = new URL(database!);
    if (
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.port === '54777' ||
      url.pathname !== '/pos_rewrite_creator_authority_test'
    )
      throw new Error('EXPLICIT_OWNED_CREATOR_DATABASE_REQUIRED');
    native = await barcodeFixture(database!);
    await native.fixture.create([
      'users',
      'store_counters',
      'user_stores',
      'pos_franchise',
      'tss_settings',
    ]);
    for (const statement of splitMigration(
      readFileSync('src/modules/administration/migration.sql', 'utf8'),
    ))
      await native.admin.query(statement);
    const fixtureUrl = new URL(native.url);
    barrier = await mysql.createConnection({
      host: fixtureUrl.hostname,
      port: Number(fixtureUrl.port),
      user: decodeURIComponent(fixtureUrl.username),
      password: decodeURIComponent(fixtureUrl.password),
      database: fixtureUrl.pathname.slice(1),
    });
    // Missing lock instrumentation is a failed prerequisite, never a skipped race assertion.
    await native.admin.query('SELECT COUNT(*) FROM performance_schema.data_lock_waits');
  });
  afterAll(async () => {
    await barrier?.rollback();
    await barrier?.end();
    await native?.close();
  });
  beforeEach(async () => {
    for (const table of countedTables)
      await native.admin.query('DELETE FROM ' + mysql.escapeId(table));
    await native.admin.query('DELETE FROM tss_settings');
    await native.seed('pos_user', {
      id: '1',
      username: 'synthetic-creator',
      email: actor.email,
      contact_email: 'creator-otp@example.test',
      phone: '9876543201',
      is_active: 1,
      role: 1,
      user_type: 1,
    });
    await native.seed('tss_settings', { id: 1, platform: 'STORE_LOCATION_CODE', value: '["NEW"]' });
  });
  async function counts() {
    return Object.fromEntries(
      await Promise.all(
        countedTables.map(async (table) => {
          const [rows] = await native.admin.query<RowDataPacket[]>(
            'SELECT COUNT(*) AS n FROM ' + mysql.escapeId(table),
          );
          return [table, Number(rows[0]?.n)];
        }),
      ),
    );
  }
  async function assertUnchanged(before: Awaited<ReturnType<typeof counts>>) {
    expect(await counts()).toEqual(before);
  }
  async function atRegistry(
    resource: 'operators' | 'stores',
    create: () => Promise<unknown>,
    revoke: string,
    expectedCode: string,
  ) {
    const before = await counts();
    await barrier.beginTransaction();
    await barrier.execute(
      'SELECT resource FROM pos_rewrite_administration_registries WHERE resource=? FOR UPDATE',
      [resource],
    );
    // The real creator must complete its real password hash (operators), start
    // its real transaction and block on our exact owned registry row.
    const pending = create().then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );
    try {
      const deadline = Date.now() + 5000;
      let observed = false;
      while (Date.now() < deadline) {
        const [rows] = await native.admin.execute<RowDataPacket[]>(
          'SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID AND l.ENGINE=w.ENGINE WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME=?',
          [new URL(native.url).pathname.slice(1), 'pos_rewrite_administration_registries'],
        );
        if (Number(rows[0]?.n) === 1) {
          observed = true;
          break;
        }
        await pause(10);
      }
      expect(observed, 'Actual creator registry lock wait must be observed').toBe(true);
      // All mutation statements are fixed test code, never request-derived SQL.
      await barrier.query(revoke);
      await barrier.commit();
      const result = await pending;
      expect(result.error).toBeInstanceOf(AppError);
      expect(result.error).toMatchObject({ code: expectedCode });
      await assertUnchanged(before);
    } finally {
      await barrier.rollback();
      await pending;
    }
  }
  for (const [name, revoke, code, targetRole] of [
    ['demotion', 'UPDATE pos_user SET role=5 WHERE id=1', 'ROLE_ACCESS_DENIED', 1],
    ['OPM tier change', 'UPDATE pos_user SET role=3 WHERE id=1', 'OPERATOR_ROLE_DENIED', 2],
    ['archive', 'UPDATE pos_user SET is_active=0 WHERE id=1', 'AUTH_REQUIRED', 1],
    [
      'organization change',
      'UPDATE pos_user SET user_type=2 WHERE id=1',
      'OPERATOR_SCOPE_DENIED',
      1,
    ],
  ] as const) {
    it(`rejects operator creation after ${name} at real hash/transaction admission without identity or mirror writes`, async () => {
      const input = { ...operatorInput(), role: targetRole };
      await atRegistry(
        'operators',
        () => operatorCreator(native.config, native.db)(actor, input),
        revoke,
        code,
      );
    });
  }
  it('rejects store creation after a current organization change without store, franchise, counter or assignment writes', async () => {
    const service = administrationService(native.config, native.db, {
      defaultStoreOperatorIds: ['1'],
    });
    await atRegistry(
      'stores',
      () => service.createStore(actor, store()),
      'UPDATE pos_user SET user_type=2 WHERE id=1',
      'STORE_ACCESS_DENIED',
    );
  });
  for (const role of [1, 3] as const) {
    it(`rejects current franchise role ${role} creating an in-house store before all side effects`, async () => {
      await native.admin.execute('UPDATE pos_user SET role=?,user_type=2 WHERE id=1', [role]);
      const before = await counts();
      await expect(
        administrationService(native.config, native.db, {
          defaultStoreOperatorIds: ['1'],
        }).createStore({ ...actor, role, userType: 2 }, store()),
      ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
      await assertUnchanged(before);
    });
  }
  for (const [role, userType, targetRole] of [
    [1, 1, 1],
    [2, 1, 2],
    [3, 1, 4],
    [3, 2, 5],
  ] as const) {
    it(`preserves current operator create capability for role ${role}, organization ${userType}`, async () => {
      await native.admin.execute('UPDATE pos_user SET role=?,user_type=? WHERE id=1', [
        role,
        userType,
      ]);
      const input = { ...operatorInput(), role: targetRole, userType };
      const result = await operatorCreator(native.config, native.db)(
        { ...actor, role, userType },
        input,
      );
      expect(result.id).toMatch(/^\d+$/);
      expect(await counts()).toMatchObject({
        pos_user: 2,
        users: 1,
        stores: 0,
        store_counters: 0,
        user_stores: 0,
        pos_franchise: 0,
      });
      const [rows] = await native.admin.execute<RowDataPacket[]>(
        'SELECT password,plain_password FROM users WHERE pos_admin_id=?',
        [result.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ password: '', plain_password: '' });
    });
  }
  for (const [role, userType] of [
    [1, 1],
    [3, 1],
    [1, 2],
    [3, 2],
  ] as const) {
    it(`preserves legitimate store create capability for role ${role}, organization ${userType}`, async () => {
      await native.admin.execute('UPDATE pos_user SET role=?,user_type=? WHERE id=1', [
        role,
        userType,
      ]);
      const input =
        userType === 2
          ? {
              ...store(),
              category: 'FRANCHISE' as const,
              franchise: { name: 'Synthetic franchise', description: '', cin: '' },
            }
          : store();
      const result = await administrationService(native.config, native.db, {
        defaultStoreOperatorIds: ['1'],
      }).createStore({ ...actor, role, userType }, input);
      expect(result.id).toMatch(/^\d+$/);
      expect(await counts()).toMatchObject({
        pos_user: 1,
        users: 0,
        stores: 1,
        store_counters: 1,
        user_stores: 1,
        pos_franchise: userType === 2 ? 1 : 0,
      });
    });
  }
});
