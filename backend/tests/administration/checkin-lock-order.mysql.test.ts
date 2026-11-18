import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, getTableName, sql } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { splitMigration } from '../../src/db/migrations.js';
import { PosUser, Store, StoreCounter, UserStore } from '../../src/db/legacy-schema.js';
import { operatorAuthEpochs } from '../helpers/retired-auth.js';
import type { Principal } from '../../src/domain/access.js';
import {
  checkInService,
  type AdministrationTransaction,
} from '../../src/modules/administration/checkins.js';
import { assertCurrentStoreAccess } from '../../src/modules/administration/authorization.js';
import { administrationService } from '../../src/modules/administration/service.js';
import { operatorCheckIns } from '../../src/modules/administration/schema.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

const template = process.env.ADMINISTRATION_MYSQL_TEST_URL;
const operator = (id = '1'): Principal => ({
  id,
  role: id === '1' ? 1 : 2,
  userType: 1,
  storeIds: ['1', '2'],
  name: 'Fixture',
  email: 'fixture@example.test',
});
function sqlTime(value: number) {
  return new Date(value).toISOString().slice(0, 23).replace('T', ' ');
}
function latch() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

describe.skipIf(!template)('native check-in authority lock ordering', () => {
  let connection: mysql.Connection,
    db: Databases,
    schema: string,
    fixture: ReturnType<typeof verifiedMysqlFixture>,
    checks: ReturnType<typeof checkInService>,
    administration: ReturnType<typeof administrationService>;
  const sourceTables = [PosUser, Store, StoreCounter, UserStore].map(getTableName);
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_administration_test' ||
      url.search ||
      url.hash
    )
      throw new Error('Explicit isolated localhost administration schema template required.');
    schema = 'pos_rewrite_checkin_locks_' + randomUUID().replaceAll('-', '').slice(0, 12);
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
    await fixture.create(sourceTables);
    for (const path of ['src/modules/administration/migration.sql'])
      for (const statement of splitMigration(readFileSync(path, 'utf8')))
        await connection.query(statement);
    await connection.query(
      'CREATE TABLE fixture_authorized_effects (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB',
    );
    url.pathname = '/' + schema;
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'isolated-checkin-native-authority-'.repeat(3),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      MYSQL_POOL_SIZE: '6',
    });
    db = createDatabases(config);
    checks = checkInService(db, config);
    administration = administrationService(config, db);
  }, 15000);
  afterAll(async () => {
    await connection?.rollback();
    await db?.close();
    if (connection) {
      await connection.rollback();
      await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
      await connection.end();
    }
  });
  afterEach(async () => {
    await connection?.rollback();
  });
  beforeEach(async () => {
    for (const table of [
      'fixture_authorized_effects',
      'pos_rewrite_operator_checkins',
      'pos_rewrite_operator_auth_epochs',
      ...sourceTables,
    ])
      await connection.query('DELETE FROM ' + mysql.escapeId(table));
    for (const id of ['1', '2']) {
      await fixture.insert(getTableName(PosUser), {
        id,
        username: 'fixture-' + id,
        [PosUser.role.name]: id === '1' ? 1 : 2,
        [PosUser.user_type.name]: 1,
        [PosUser.is_active.name]: 1,
      });
      await fixture.insert(getTableName(Store), {
        id,
        [Store.type.name]: 'STORE',
        [Store.category.name]: 'IN_HOUSE',
        [Store.is_active.name]: 1,
      });
      await db.get('writer').insert(operatorAuthEpochs).values({ userId: id, epoch: 0n });
      for (const storeId of ['1', '2'])
        await fixture.insert(getTableName(UserStore), {
          [UserStore.django_user_id.name]: id,
          [UserStore.store_id.name]: storeId,
        });
    }
    for (const [id, store] of [
      ['2', '1'],
      ['3', '1'],
      ['4', '2'],
    ])
      await fixture.insert(getTableName(StoreCounter), {
        id: id!,
        [StoreCounter.store.name]: store!,
        [StoreCounter.is_active.name]: 1,
      });
    await db
      .get('writer')
      .insert(operatorCheckIns)
      .values(
        ['1', '2'].map((id) => ({
          operatorId: id,
          storeId: 1n,
          counterId: 2n,
          checkedInAt: sqlTime(Date.now()),
          expiresAt: sqlTime(Date.now() + 3600000),
        })),
      );
  });
  async function task(work: (tx: AdministrationTransaction) => Promise<void>) {
    let identify!: (id: string) => void, failed!: (reason: unknown) => void;
    const identity = new Promise<string>((resolve, reject) => {
      identify = resolve;
      failed = reject;
    });
    const finished = db.get('writer').transaction(async (tx) => {
      const [rows] = await tx.execute(sql`SELECT CAST(CONNECTION_ID() AS CHAR) AS id`);
      identify(z.array(z.object({ id: z.string().regex(/^[1-9]\d*$/) })).parse(rows)[0]!.id);
      await work(tx);
    });
    void finished.catch(failed);
    return { id: await identity, finished };
  }
  async function waiting(id: string | null, table: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [rows] = await connection.query(
        `SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
        JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
        JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID
        WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME=? AND (? IS NULL OR t.PROCESSLIST_ID=?)`,
        [schema, table, id, id],
      );
      if (
        BigInt(z.array(z.object({ n: z.union([z.string(), z.number()]) })).parse(rows)[0]!.n) > 0n
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('The expected native authority lock wait was not observed.');
  }
  async function effect(tx: AdministrationTransaction, id = 1) {
    await tx.execute(sql`INSERT INTO fixture_authorized_effects(id) VALUES(${id})`);
  }
  async function noEffects() {
    const [rows] = await connection.query('SELECT COUNT(*) AS n FROM fixture_authorized_effects');
    expect(rows).toEqual([{ n: '0' }]);
  }
  it.each(['demotion', 'archive'] as const)(
    'store status rejects a cached administrator after current-actor %s wins the lock',
    async (change) => {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM pos_user WHERE id=1 FOR UPDATE');
      const status = administration.setStoreStatus(operator(), '1', false);
      // Attach a handler immediately; the native outcome is asserted after commit.
      void status.catch(() => {});
      try {
        await waiting(null, getTableName(PosUser));
        await connection.query(
          change === 'demotion'
            ? 'UPDATE pos_user SET role=5 WHERE id=1'
            : 'UPDATE pos_user SET is_active=0 WHERE id=1',
        );
        await connection.query(
          "UPDATE pos_rewrite_operator_auth_epochs SET epoch=epoch+1 WHERE operator_id='1'",
        );
        await connection.commit();
        await expect(status).rejects.toMatchObject({
          code: change === 'demotion' ? 'ROLE_ACCESS_DENIED' : 'AUTH_REQUIRED',
        });
        const [rows] = await connection.query('SELECT is_active FROM stores WHERE id=1');
        expect(rows).toEqual([{ is_active: 1 }]);
      } finally {
        await connection.rollback();
        await Promise.allSettled([status]);
      }
    },
  );
  it('store status holds current-actor authority before Store and lets a later revocation wait for commit', async () => {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM stores WHERE id=1 FOR UPDATE');
    const status = administration.setStoreStatus(operator(), '1', false);
    void status.catch(() => {});
    let revoke: Awaited<ReturnType<typeof task>> | undefined;
    try {
      await waiting(null, getTableName(Store));
      revoke = await task(async (tx) => {
        await tx.update(PosUser).set({ is_active: false }).where(eq(PosUser.id, 1n));
        await tx
          .update(operatorAuthEpochs)
          .set({ epoch: sql`${operatorAuthEpochs.epoch}+1` })
          .where(eq(operatorAuthEpochs.userId, '1'));
      });
      await waiting(revoke.id, getTableName(PosUser));
      await connection.commit();
      await expect(status).resolves.toMatchObject({ message: 'The Store has been deleted' });
      await revoke.finished;
      const [rows] = await connection.query('SELECT is_active FROM stores WHERE id=1');
      expect(rows).toEqual([{ is_active: 0 }]);
    } finally {
      await connection.rollback();
      await Promise.allSettled([status, ...(revoke ? [revoke.finished] : [])]);
    }
  });
  it('store status preserves archive/reactivation and refuses an active duplicate name', async () => {
    await connection.query("UPDATE stores SET store_name='Fixture first' WHERE id=1");
    await connection.query("UPDATE stores SET store_name='Fixture second' WHERE id=2");
    await expect(administration.setStoreStatus(operator(), '1', false)).resolves.toMatchObject({
      message: 'The Store has been deleted',
    });
    await connection.query("UPDATE stores SET store_name='Fixture first' WHERE id=2");
    await expect(administration.setStoreStatus(operator(), '1', true)).rejects.toMatchObject({
      code: 'STORE_ALREADY_EXISTS',
    });
    const [archived] = await connection.query('SELECT is_active FROM stores WHERE id=1');
    expect(archived).toEqual([{ is_active: 0 }]);
    await connection.query("UPDATE stores SET store_name='Fixture second' WHERE id=2");
    await expect(administration.setStoreStatus(operator(), '1', true)).resolves.toMatchObject({
      message: 'The Store has been activated',
    });
    const [restored] = await connection.query('SELECT is_active FROM stores WHERE id=1');
    expect(restored).toEqual([{ is_active: 1 }]);
  });
  it('waits for actor archive before taking check-in and rechecks the current actor even after an earlier RR snapshot', async () => {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM pos_user WHERE id=1 FOR UPDATE');
    const work = await task(async (tx) => {
      await tx.select({ id: PosUser.id }).from(PosUser).where(eq(PosUser.id, 1n));
      await checks.assertCheckIn('1', '1', '2', tx);
      await effect(tx);
    });
    try {
      await waiting(work.id, getTableName(PosUser));
      await connection.query(
        "SELECT operator_id FROM pos_rewrite_operator_checkins WHERE operator_id='1' FOR UPDATE",
      );
      await connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
      await connection.commit();
      await expect(work.finished).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      await noEffects();
    } finally {
      await connection.rollback();
      await Promise.allSettled([work.finished]);
    }
  });
  it('takes Store before check-in so a concurrent Store archive can finish without a lock cycle', async () => {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM stores WHERE id=1 FOR UPDATE');
    const work = await task(async (tx) => {
      await checks.assertCheckIn('1', '1', '2', tx);
      await effect(tx);
    });
    try {
      await waiting(work.id, getTableName(Store));
      await connection.query(
        "SELECT operator_id FROM pos_rewrite_operator_checkins WHERE operator_id='1' FOR UPDATE",
      );
      await connection.query('UPDATE stores SET is_active=0 WHERE id=1');
      await connection.commit();
      await expect(work.finished).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
      await noEffects();
    } finally {
      await connection.rollback();
      await Promise.allSettled([work.finished]);
    }
  });
  it('locks an explicit counter before check-in and refuses a counter archived while it waited', async () => {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM store_counters WHERE id=2 FOR UPDATE');
    const work = await task(async (tx) => {
      await checks.assertCheckIn('1', '1', '2', tx);
      await effect(tx);
    });
    try {
      await waiting(work.id, getTableName(StoreCounter));
      await connection.query(
        "SELECT operator_id FROM pos_rewrite_operator_checkins WHERE operator_id='1' FOR UPDATE",
      );
      await connection.query('UPDATE store_counters SET is_active=0 WHERE id=2');
      await connection.commit();
      await expect(work.finished).rejects.toMatchObject({ code: 'COUNTER_UNAVAILABLE' });
      await noEffects();
    } finally {
      await connection.rollback();
      await Promise.allSettled([work.finished]);
    }
  });
  it.each([undefined, '2'])(
    'matches source actor→epoch→Store→counter→check-in without a cycle (counter=%s)',
    async (counter) => {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM pos_user WHERE id=1 FOR SHARE');
      await connection.query(
        "SELECT epoch FROM pos_rewrite_operator_auth_epochs WHERE operator_id='1' FOR SHARE",
      );
      await connection.query('SELECT id FROM stores WHERE id=1 FOR UPDATE');
      await connection.query('SELECT id FROM store_counters WHERE id=2 FOR SHARE');
      const work = await task(async (tx) => {
        await checks.assertCheckIn('1', '1', counter, tx);
        await effect(tx);
      });
      try {
        await waiting(work.id, getTableName(Store));
        await connection.query(
          "SELECT operator_id FROM pos_rewrite_operator_checkins WHERE operator_id='1' FOR UPDATE",
        );
        await connection.commit();
        await expect(work.finished).resolves.toBeUndefined();
      } finally {
        await connection.rollback();
        await Promise.allSettled([work.finished]);
      }
    },
  );
  it('does not read an assignment lock before Store for role2', async () => {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM stores WHERE id=1 FOR UPDATE');
    const work = await task((tx) => assertCurrentStoreAccess(tx, '2', '1'));
    try {
      await waiting(work.id, getTableName(Store));
      await connection.query(
        'SELECT id FROM user_stores WHERE django_user_id=2 AND store_id=1 FOR UPDATE',
      );
      await connection.commit();
      await expect(work.finished).resolves.toBeUndefined();
    } finally {
      await connection.rollback();
      await Promise.allSettled([work.finished]);
    }
  });
  it('two financial actors take their final Store lock before check-ins and complete without upgrades or retries', async () => {
    const entered = latch(),
      proceed = latch(),
      first = await task(async (tx) => {
        await assertCurrentStoreAccess(tx, '1', '1');
        entered.release();
        await proceed.ready;
        await tx
          .select()
          .from(operatorCheckIns)
          .where(eq(operatorCheckIns.operatorId, '2'))
          .for('update');
        await checks.assertCheckIn('1', '1', '2', tx);
        await tx.select({ id: Store.id }).from(Store).where(eq(Store.id, 1n)).for('update');
        await effect(tx, 1);
      });
    await Promise.race([entered.ready, first.finished]);
    const second = await task(async (tx) => {
      await assertCurrentStoreAccess(tx, '2', '1');
      await checks.assertCheckIn('2', '1', '2', tx);
      await tx.select({ id: Store.id }).from(Store).where(eq(Store.id, 1n)).for('update');
      await effect(tx, 2);
    });
    try {
      await waiting(second.id, getTableName(Store));
      proceed.release();
      await expect(Promise.all([first.finished, second.finished])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      const [rows] = await connection.query(
        'SELECT id FROM fixture_authorized_effects ORDER BY id',
      );
      expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    } finally {
      proceed.release();
      await Promise.allSettled([first.finished, second.finished]);
    }
  });
  it('true shared authority readers can proceed together without taking an exclusive Store lock', async () => {
    const entered = latch(),
      proceed = latch(),
      first = await task(async (tx) => {
        await assertCurrentStoreAccess(tx, '1', '1', undefined, 'share');
        entered.release();
        await proceed.ready;
      });
    await Promise.race([entered.ready, first.finished]);
    const second = await task(async (tx) => {
      await assertCurrentStoreAccess(tx, '2', '1', undefined, 'share');
      await proceed.ready;
    });
    try {
      let shared = false;
      for (let attempt = 0; attempt < 200 && !shared; attempt++) {
        const [rows] = await connection.query(
          `SELECT COUNT(*) AS n FROM performance_schema.data_locks l
          JOIN performance_schema.threads t ON t.THREAD_ID=l.THREAD_ID
          WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME=? AND l.LOCK_TYPE='RECORD'
           AND l.LOCK_STATUS='GRANTED' AND l.LOCK_MODE LIKE 'S%' AND t.PROCESSLIST_ID=?`,
          [schema, getTableName(Store), second.id],
        );
        shared =
          BigInt(z.array(z.object({ n: z.union([z.string(), z.number()]) })).parse(rows)[0]!.n) >
          0n;
        if (!shared) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(shared).toBe(true);
      proceed.release();
      await expect(Promise.all([first.finished, second.finished])).resolves.toEqual([
        undefined,
        undefined,
      ]);
    } finally {
      proceed.release();
      await Promise.allSettled([first.finished, second.finished]);
    }
  });
  it.each([false, true])(
    'validates the current optional counter after a Store wait (archived=%s)',
    async (archived) => {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM stores WHERE id=1 FOR UPDATE');
      const work = await task(async (tx) => {
        await checks.assertCheckIn('1', '1', undefined, tx);
        await effect(tx);
      });
      try {
        await waiting(work.id, getTableName(Store));
        await connection.query(
          "UPDATE pos_rewrite_operator_checkins SET counter_id=3 WHERE operator_id='1'",
        );
        if (archived) await connection.query('UPDATE store_counters SET is_active=0 WHERE id=3');
        await connection.commit();
        if (archived) {
          await expect(work.finished).rejects.toMatchObject({ code: 'COUNTER_UNAVAILABLE' });
          await noEffects();
        } else await expect(work.finished).resolves.toBeUndefined();
      } finally {
        await connection.rollback();
        await Promise.allSettled([work.finished]);
      }
    },
  );
  it('does not authorize an optional-counter check-in that moved stores during its Store wait', async () => {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM stores WHERE id=1 FOR UPDATE');
    const work = await task(async (tx) => {
      await checks.assertCheckIn('1', '1', undefined, tx);
      await effect(tx);
    });
    try {
      await waiting(work.id, getTableName(Store));
      await connection.query(
        "UPDATE pos_rewrite_operator_checkins SET store_id=2,counter_id=4 WHERE operator_id='1'",
      );
      await connection.commit();
      await expect(work.finished).rejects.toMatchObject({ code: 'CHECK_IN_REQUIRED' });
      await noEffects();
    } finally {
      await connection.rollback();
      await Promise.allSettled([work.finished]);
    }
  });
  it('current presentation treats an unlocked hint as insufficient after a check-in move', async () => {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM stores WHERE id=1 FOR UPDATE');
    const work = checks.current(operator());
    void work.catch(() => undefined);
    try {
      await waiting(null, getTableName(Store));
      await connection.query(
        "UPDATE pos_rewrite_operator_checkins SET store_id=2,counter_id=4 WHERE operator_id='1'",
      );
      await connection.commit();
      await expect(work).resolves.toBeNull();
    } finally {
      await connection.rollback();
      await Promise.allSettled([work]);
    }
  });
  it.each(['actor', 'store', 'counter'] as const)(
    'current presentation rechecks a %s archive under its shared lock prefix',
    async (resource) => {
      await connection.beginTransaction();
      const table =
          resource === 'actor'
            ? getTableName(PosUser)
            : resource === 'store'
              ? getTableName(Store)
              : getTableName(StoreCounter),
        id = resource === 'counter' ? 2 : 1;
      await connection.query('SELECT id FROM ' + mysql.escapeId(table) + ' WHERE id=? FOR UPDATE', [
        id,
      ]);
      const work = checks.current(operator());
      void work.catch(() => undefined);
      try {
        await waiting(null, table);
        await connection.query(
          "SELECT operator_id FROM pos_rewrite_operator_checkins WHERE operator_id='1' FOR UPDATE",
        );
        await connection.query('UPDATE ' + mysql.escapeId(table) + ' SET is_active=0 WHERE id=?', [
          id,
        ]);
        await connection.commit();
        await expect(work).resolves.toBeNull();
      } finally {
        await connection.rollback();
        await Promise.allSettled([work]);
      }
    },
  );
  it('preserves franchise category/assignment, expiry, counter-null and current role gates', async () => {
    await db.get('writer').update(PosUser).set({ user_type: 2 }).where(eq(PosUser.id, 2n));
    await expect(checks.assertCheckIn('2', '1', '2')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await db.get('writer').update(Store).set({ category: 'FRANCHISE' }).where(eq(Store.id, 1n));
    await expect(checks.assertCheckIn('2', '1', '2')).resolves.toBeUndefined();
    await db
      .get('writer')
      .delete(UserStore)
      .where(and(eq(UserStore.django_user_id, 2n), eq(UserStore.store_id, 1n)));
    await expect(checks.assertCheckIn('2', '1', '2')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await checks.clear(operator('2'));
    await expect(checks.assertCheckIn('2', '1', '2')).rejects.toMatchObject({
      code: 'CHECK_IN_REQUIRED',
    });
    await db
      .get('writer')
      .update(operatorCheckIns)
      .set({ counterId: null })
      .where(eq(operatorCheckIns.operatorId, '1'));
    await expect(checks.assertCheckIn('1', '1')).resolves.toBeUndefined();
    await expect(checks.assertCheckIn('1', '1', '2')).rejects.toMatchObject({
      code: 'CHECK_IN_REQUIRED',
    });
    await db
      .get('writer')
      .update(operatorCheckIns)
      .set({ expiresAt: sqlTime(Date.now() - 1) })
      .where(eq(operatorCheckIns.operatorId, '1'));
    await expect(checks.assertCheckIn('1', '1')).rejects.toMatchObject({
      code: 'CHECK_IN_REQUIRED',
    });
    await db
      .get('writer')
      .update(StoreCounter)
      .set({ is_active: false })
      .where(eq(StoreCounter.id, 2n));
    await expect(checks.assertCheckIn('1', '1', '2')).rejects.toMatchObject({
      code: 'CHECK_IN_REQUIRED',
    });
    await db.get('writer').update(PosUser).set({ role: 4 }).where(eq(PosUser.id, 2n));
    await expect(
      db.get('writer').transaction((tx) => assertCurrentStoreAccess(tx, '2', '1', [1, 2, 3])),
    ).rejects.toMatchObject({ code: 'ROLE_ACCESS_DENIED' });
  });
  it('keeps normal set/current/clear and a permitted shared current presentation working', async () => {
    const user = operator();
    await checks.set(user, '2', '4');
    expect(await checks.current(user)).toMatchObject({ storeId: '2', counterId: '4' });
    await checks.clear(user);
    expect(await checks.current(user)).toBeNull();
  });
});
