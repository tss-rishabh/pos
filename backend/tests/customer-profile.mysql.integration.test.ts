import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../src/config.js';
import { createDatabases, type Databases } from '../src/db/pools.js';
import { existsSync, readFileSync } from 'node:fs';
import { migrationPaths, splitMigration } from '../src/db/migrations.js';
import { MUser, PosUser, Store, StoreCounter } from '../src/db/legacy-schema.js';
import type { Principal } from '../src/domain/access.js';
import { bindCheckInRedis, checkInService } from '../src/modules/administration/checkins.js';
import { memoryRedisPort } from '../src/redis/memory.js';

import { checkoutStateSchema } from '../src/modules/checkout/contracts.js';
import { checkoutSessions } from '../src/modules/checkout/schema.js';
import {
  customerProfileDate,
  customerProfileService,
} from '../src/modules/customer-insights/profile.js';
import { verifiedMysqlFixture } from '../tools/operational-reports/verified-mysql-fixture.js';
import { customerProfileAdjustmentService } from '../src/modules/customer-insights/adjustments.js';
import { customerProfileAdjustmentInput } from '../src/modules/customer-insights/contracts.js';
import { profileAdjustmentKey } from '../src/modules/customer-insights/adjustments.js';
import { memoryOrderRedis } from '../src/modules/fulfillment/order-redis.js';
import { customerBriefingService } from '../src/modules/customer-insights/briefing.js';
import { customerBriefing } from '../src/modules/customer-insights/briefing-contracts.js';
import { customerBenefitsService } from '../src/modules/customer-insights/benefits.js';
import { benefitCustomers } from '../src/modules/customer-insights/benefits-schema.js';
import { goldenStdout } from './golden/load.js';
// Check-ins are the legacy Redis keys; bind an in-process port for this file.
bindCheckInRedis(memoryRedisPort());

it('replays the actual pinned property and business-update methods without contact or wallet changes', () => {
  const result: unknown = JSON.parse(goldenStdout('core', 'customer-profile-mysql-integration'));
  expect(result).toEqual({
    sourceSha256: '23e3ff32bc197de469f072da53a86eb1ff1bccc669d6f060e8c7c4852ff2f9e0',
    propertyVectors: 6,
    businessVectors: 2,
  });
});

it('normalizes legacy empty/partial/invalid dates without changing valid leap-day dates', () => {
  expect([null, '', '0000-00-00', '2026-00-01', '2026-02-29'].map(customerProfileDate)).toEqual([
    null,
    null,
    null,
    null,
    null,
  ]);
  expect(customerProfileDate('2000-02-29')).toBe('2000-02-29');
});

it('validates editable fields, calendar dates and lengths while excluding identity and money fields', () => {
  const valid = {
    operationId: randomUUID(),
    expectedVersion: 1,
    expectedEtag: 'a'.repeat(64),
    changes: { birthday: '2000-02-29', gender: 'F', gstin: '27abcde1234f1z5' },
  };
  expect(customerProfileAdjustmentInput.parse(valid).changes.gstin).toBe('27ABCDE1234F1Z5');
  for (const changes of [
    {},
    { birthday: '0000-00-00' },
    { birthday: '2026-02-29' },
    { birthday: null },
    { gender: 'X' },
    { email: 'new@example.test' },
    { tssMoney: '10.00' },
    { gstin: 'x'.repeat(16) },
    { gstin: '12345678901234<' },
  ])
    expect(customerProfileAdjustmentInput.safeParse({ ...valid, changes }).success).toBe(false);
});

const integration = process.env.CUSTOMER_PROFILE_MYSQL_TEST_URL;
describe.skipIf(!integration)(
  'customer profile with native current-authority and primary-reader scope',
  () => {
    let connection: mysql.Connection;
    let db: Databases;
    let config: ReturnType<typeof readConfig>;
    let service: ReturnType<typeof customerProfileService>;
    let adjustments: ReturnType<typeof customerProfileAdjustmentService>;
    let fixture: ReturnType<typeof verifiedMysqlFixture>;
    const redis = memoryOrderRedis();
    const schema =
      'pos_rewrite_customer_profile_test_' + randomUUID().replaceAll('-', '').slice(0, 12);
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
    const state = () =>
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
        phase: 'quoted',
        cart: { products: { items: [] } },
        quote: null,
        orderId: null,
        orderSubmissionOperationId: null,
        paymentConfirmation: null,
        salespersonId: null,
        lineSalespersons: {},
        giftCards: {},
        busyOperationId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    beforeAll(async () => {
      const base = new URL(integration!);
      if (
        base.protocol !== 'mysql:' ||
        !['127.0.0.1', 'localhost'].includes(base.hostname) ||
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
      fixture = verifiedMysqlFixture(connection, ['evidence/mysql-customer-benefit-schema.json']);
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
        anniversary: null,
        customer_type: 'B2B',
        gstin: '27ABCDE1234F1Z5',
        status: 1,
        is_block: 0,
      });
      // Workstreams delete their module migration files ahead of the registry clean-up.
      for (const path of migrationPaths.filter((value) => existsSync(value)))
        for (const statement of splitMigration(readFileSync(path, 'utf8')))
          await connection.query(statement);
      base.pathname = '/' + schema;
      config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'false',
        SESSION_SECRET: 'customer-profile-isolated-test-key-'.repeat(2),
        MYSQL_WRITER_URL: base.href,
        MYSQL_PRIMARY_READER_URL: base.href,
        MYSQL_DATA_READER_URL: base.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      });
      db = createDatabases(config);
      service = customerProfileService(config, db);
      adjustments = customerProfileAdjustmentService(config, db, redis);
    }, 30_000);
    beforeEach(async () => {
      await connection.query('DELETE FROM user_eav');
      await connection.query('DELETE FROM gift_vouchers');
      await connection.query('DELETE FROM user_addons');
      await db
        .get('writer')
        .update(benefitCustomers)
        .set({ disabled: 0 })
        .where(eq(benefitCustomers.id, 777n));
      await db.get('writer').update(Store).set({ is_active: true }).where(eq(Store.id, 1n));
      await db
        .get('writer')
        .update(StoreCounter)
        .set({ is_active: true })
        .where(eq(StoreCounter.id, 2n));
      await db
        .get('writer')
        .update(PosUser)
        .set({ is_active: true, role: 4, user_type: 1 })
        .where(eq(PosUser.id, 7n));
      await db
        .get('writer')
        .update(MUser)
        .set({
          status: 1,
          is_block: 0,
          lastname: 'Guest',
          email: 'guest@example.test',
          telephone: '9876543210',
          birthdate: '2000-02-29',
          anniversary: '2020-01-01',
          gender: 'F',
          customer_type: 'B2B',
          gstin: '27ABCDE1234F1Z5',
          tss_money: 100.129,
          tss_points: 0.99,
          user_platform: 'BACK_OFFICE_USER',
        })
        .where(eq(MUser.id, 777n));
      await db.get('writer').delete(checkoutSessions).where(eq(checkoutSessions.id, checkoutId));
      await redis.del([...redis.snapshot().keys()]);
      await db
        .get('writer')
        .insert(checkoutSessions)
        .values({ id: checkoutId, operatorId: '7', storeId: '1', version: 1, state: state() });
      await checkInService(db, config).set(user, '1', '2');
    });
    afterAll(async () => {
      await db?.close();
      if (connection) {
        await connection.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
        await connection.end();
      }
    });
    it('returns the exact attached current customer fields and no wallet/authentication secrets', async () => {
      const result = await service.read(user, scope);
      expect(result.customerId).toBe('777');
      expect(result.profile).toEqual({
        firstName: '<Fixture>',
        lastName: 'Guest',
        email: 'guest@example.test',
        telephone: '9876543210',
        gender: 'F',
        birthday: '2000-02-29',
        anniversary: '2020-01-01',
        customerType: 'B2B',
        gstin: '27ABCDE1234F1Z5',
      });
      expect(result.etag).toMatch(/^[a-f0-9]{64}$/);
      expect(result.editable).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/password|mfa_hash|tss_money|tss_points/);
      await db.get('writer').update(MUser).set({ lastname: 'Changed' }).where(eq(MUser.id, 777n));
      expect((await service.read(user, scope)).etag).not.toBe(result.etag);
    });
    it('does not accept a guessed checkout belonging to another operator or store', async () => {
      await expect(service.read({ ...user, id: '8' }, scope)).rejects.toMatchObject({
        code: 'CUSTOMER_PROFILE_NOT_FOUND',
      });
      await expect(service.read(user, { ...scope, storeId: '2' })).rejects.toMatchObject({
        code: 'STORE_ACCESS_DENIED',
      });
    });
    it('rechecks current operator and franchise authority rather than trusting the principal', async () => {
      await db.get('writer').update(PosUser).set({ is_active: false }).where(eq(PosUser.id, 7n));
      await expect(service.read(user, scope)).rejects.toMatchObject({ status: 401 });
      await db
        .get('writer')
        .update(PosUser)
        .set({ is_active: true, role: 1, user_type: 2 })
        .where(eq(PosUser.id, 7n));
      await expect(service.read(user, scope)).rejects.toMatchObject({ status: 403 });
    });
    it('rejects archived stores and inactive counters even when a prior check-in exists', async () => {
      await db.get('writer').update(Store).set({ is_active: false }).where(eq(Store.id, 1n));
      await expect(service.read(user, scope)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
      await db.get('writer').update(Store).set({ is_active: true }).where(eq(Store.id, 1n));
      await db
        .get('writer')
        .update(StoreCounter)
        .set({ is_active: false })
        .where(eq(StoreCounter.id, 2n));
      await expect(service.read(user, scope)).rejects.toMatchObject({
        code: 'COUNTER_UNAVAILABLE',
      });
    });
    it('rejects inactive customers and changed checkouts before returning private profile data', async () => {
      await db.get('writer').update(MUser).set({ is_block: 1 }).where(eq(MUser.id, 777n));
      await expect(service.read(user, scope)).rejects.toMatchObject({
        code: 'CUSTOMER_PROFILE_NOT_FOUND',
      });
      await db.get('writer').update(MUser).set({ is_block: 2 }).where(eq(MUser.id, 777n));
      await expect(service.read(user, scope)).rejects.toMatchObject({
        code: 'CUSTOMER_PROFILE_NOT_FOUND',
      });
      await db.get('writer').update(MUser).set({ is_block: 0 }).where(eq(MUser.id, 777n));
      const changed = { ...state(), storeId: '2' };
      await db
        .get('writer')
        .update(checkoutSessions)
        .set({ state: changed })
        .where(and(eq(checkoutSessions.id, checkoutId), eq(checkoutSessions.operatorId, user.id)));
      await expect(service.read(user, scope)).rejects.toMatchObject({
        code: 'CUSTOMER_PROFILE_NOT_FOUND',
      });
    });
    async function intent(changes = { gender: 'M' }) {
      const current = await service.read(user, scope);
      return {
        operationId: randomUUID(),
        expectedVersion: current.checkoutVersion,
        expectedEtag: current.etag,
        changes,
      };
    }
    it('commits only the chosen profile fields, clears the old quote and stores no PII values in its proof', async () => {
      const [before] = await db.get('writer').select().from(MUser).where(eq(MUser.id, 777n));
      const current = await service.read(user, scope);
      const input = {
        operationId: randomUUID(),
        expectedVersion: 1,
        expectedEtag: current.etag,
        changes: {
          birthday: '2004-02-29',
          anniversary: '2022-12-01',
          gender: 'M',
          customerType: 'B2C',
          gstin: '',
        },
      };
      const result = await adjustments.apply(user, scope, input);
      expect(result.adjustment.fields).toEqual([
        'birthday',
        'anniversary',
        'gender',
        'customerType',
        'gstin',
      ]);
      expect(result.profile).toMatchObject({
        customerId: '777',
        checkoutVersion: 2,
        profile: {
          birthday: '2004-02-29',
          anniversary: '2022-12-01',
          gender: 'M',
          customerType: 'B2C',
          gstin: null,
        },
      });
      expect(result.adjustment.etag).toBe(result.profile.etag);
      const [saved] = await db
        .get('writer')
        .select()
        .from(checkoutSessions)
        .where(eq(checkoutSessions.id, checkoutId));
      expect(saved?.state).toMatchObject({
        version: 2,
        phase: 'open',
        quote: null,
        customerId: '777',
      });
      const [after] = await db.get('writer').select().from(MUser).where(eq(MUser.id, 777n));
      for (const field of [
        'firstname',
        'lastname',
        'email',
        'telephone',
        'tss_money',
        'cashback',
        'tss_points',
        'password',
        'status',
        'is_block',
      ] as const)
        expect(after?.[field]).toEqual(before?.[field]);
      const [proof] = [...redis.snapshot().values()].map(
        (value) => JSON.parse(value) as { requestHash: string },
      );
      expect(proof?.requestHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(proof)).not.toMatch(
        /example\.test|9876543210|2004-02-29|2022-12-01|ABCDE/,
      );
    });
    it('replays20 identical concurrent commands once and rejects same UUID with a different intent', async () => {
      const input = await intent();
      // The replay receipt is written to Redis after the MySQL commit (schema freeze), so a
      // retry racing that commit sees the moved checkout version instead of the receipt.
      const settled = await Promise.allSettled(
        Array.from({ length: 20 }, () => adjustments.apply(user, scope, input)),
      );
      const results = settled.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(
        settled
          .filter((result) => result.status === 'rejected')
          .every((result) =>
            ['CUSTOMER_PROFILE_VERSION_CHANGED', 'CUSTOMER_PROFILE_CHANGED'].includes(
              (result.reason as { code?: string }).code ?? '',
            ),
          ),
      ).toBe(true);
      expect(new Set(results.map((result) => result.adjustment.etag)).size).toBe(1);
      expect(results.every((result) => result.adjustment.checkoutVersion === 2)).toBe(true);
      expect(redis.snapshot().size).toBe(1);
      expect(await adjustments.read(user, scope, input.operationId)).toEqual(results[0]);
      await expect(
        adjustments.apply(user, scope, { ...input, changes: { gender: 'O' } }),
      ).rejects.toMatchObject({
        code: 'CUSTOMER_PROFILE_OPERATION_REUSED',
      });
    }, 20_000);
    it('rejects competing versions and stale primary-reader profiles without overwriting the writer', async () => {
      const input = await intent();
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          adjustments.apply(user, scope, { ...input, operationId: randomUUID() }),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(4);
      const next = await intent();
      await db
        .get('writer')
        .update(MUser)
        .set({ lastname: 'Concurrent external update' })
        .where(eq(MUser.id, 777n));
      await expect(adjustments.apply(user, scope, next)).rejects.toMatchObject({
        code: 'CUSTOMER_PROFILE_CHANGED',
      });
      const [customer] = await db
        .get('writer')
        .select({ gender: MUser.gender, name: MUser.lastname })
        .from(MUser)
        .where(eq(MUser.id, 777n));
      expect(customer).toEqual({ gender: 'M', name: 'Concurrent external update' });
    });
    it('rechecks editable state and current authority, including archived operators, stores and blocked customers', async () => {
      const input = await intent();
      for (const phase of ['uncertain', 'order-created', 'submitted'] as const) {
        await db
          .get('writer')
          .update(checkoutSessions)
          .set({ state: { ...state(), phase } })
          .where(eq(checkoutSessions.id, checkoutId));
        await expect(adjustments.apply(user, scope, input)).rejects.toMatchObject({
          code: 'CUSTOMER_PROFILE_NOT_EDITABLE',
        });
      }
      await db
        .get('writer')
        .update(checkoutSessions)
        .set({ state: { ...state(), busyOperationId: randomUUID() } })
        .where(eq(checkoutSessions.id, checkoutId));
      await expect(adjustments.apply(user, scope, input)).rejects.toMatchObject({
        code: 'CUSTOMER_PROFILE_NOT_EDITABLE',
      });
      await db
        .get('writer')
        .update(checkoutSessions)
        .set({ state: state() })
        .where(eq(checkoutSessions.id, checkoutId));
      await db.get('writer').update(PosUser).set({ is_active: false }).where(eq(PosUser.id, 7n));
      await expect(adjustments.apply(user, scope, input)).rejects.toMatchObject({ status: 401 });
      await db.get('writer').update(PosUser).set({ is_active: true }).where(eq(PosUser.id, 7n));
      await db.get('writer').update(Store).set({ is_active: false }).where(eq(Store.id, 1n));
      await expect(adjustments.apply(user, scope, input)).rejects.toMatchObject({
        code: 'STORE_UNAVAILABLE',
      });
      await db.get('writer').update(Store).set({ is_active: true }).where(eq(Store.id, 1n));
      await db.get('writer').update(MUser).set({ is_block: 2 }).where(eq(MUser.id, 777n));
      await expect(adjustments.apply(user, scope, input)).rejects.toMatchObject({
        code: 'CUSTOMER_PROFILE_NOT_FOUND',
      });
      expect(redis.snapshot().size).toBe(0);
    });
    it('requires a valid B2B GSTIN; legacy has no upstream customer-context gate', async () => {
      const input = await intent();
      await expect(
        adjustments.apply(user, scope, { ...input, changes: { gstin: '' } }),
      ).rejects.toMatchObject({ code: 'CUSTOMER_PROFILE_GSTIN_REQUIRED' });
      expect((await customerProfileService(config, db).read(user, scope)).editable).toBe(true);
      expect(redis.snapshot().size).toBe(0);
    });
    it('rolls back customer fields and receipt when the late checkout write fails, then retries the same intent', async () => {
      const input = await intent();
      await connection.query(
        "CREATE TRIGGER fixture_profile_late_failure BEFORE UPDATE ON pos_rewrite_checkout_sessions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture rollback'",
      );
      try {
        await expect(adjustments.apply(user, scope, input)).rejects.toThrow();
        const [customer] = await db
          .get('writer')
          .select({ gender: MUser.gender })
          .from(MUser)
          .where(eq(MUser.id, 777n));
        expect(customer?.gender).toBe('F');
        expect(redis.snapshot().size).toBe(0);
      } finally {
        await connection.query('DROP TRIGGER fixture_profile_late_failure');
      }
      expect((await adjustments.apply(user, scope, input)).adjustment.checkoutVersion).toBe(2);
    });
    it('does not expose another actor command and refuses corrupted saved proof', async () => {
      const input = await intent();
      await adjustments.apply(user, scope, input);
      await expect(
        adjustments.read({ ...user, id: '8' }, scope, input.operationId),
      ).rejects.toMatchObject({ code: 'CUSTOMER_PROFILE_NOT_FOUND' });
      const key = profileAdjustmentKey(input.operationId);
      await redis.set(
        key,
        JSON.stringify({
          ...JSON.parse(redis.snapshot().get(key)!),
          receipt: { operationId: 'invalid' },
        }),
      );
      await expect(adjustments.read(user, scope, input.operationId)).rejects.toMatchObject({
        code: 'CUSTOMER_PROFILE_PROOF_INVALID',
      });
    });
    it('binds the private briefing to the writer-authorized customer while accepting a different service ID', async () => {
      const calls: { id: string; email: string; telephone: string; storeId: string }[] = [];
      const insights = customerBriefingService(config, db, {
        read: async (identity, storeId) => {
          calls.push({ ...identity, storeId });
          return customerBriefing.parse({
            user_id: 'different-service-id',
            customer: { name: 'Fixture briefing', is_exclusive: true },
          });
        },
      });
      const result = await insights.read(user, scope);
      expect(calls).toEqual([
        { id: '777', email: 'guest@example.test', telephone: '9876543210', storeId: '1' },
      ]);
      expect(result).toMatchObject({
        customerId: '777',
        checkoutVersion: 1,
        briefing: { user_id: 'different-service-id', customer: { name: 'Fixture briefing' } },
      });
      const [checkout] = await db
        .get('writer')
        .select()
        .from(checkoutSessions)
        .where(eq(checkoutSessions.id, checkoutId));
      expect(checkout?.version).toBe(1);
    });
    it('releases SQL locks during a briefing request and rejects contact changes before publishing', async () => {
      let ready = () => {},
        release = () => {};
      const entered = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const insights = customerBriefingService(config, db, {
        read: async () => {
          ready();
          await held;
          return customerBriefing.parse({});
        },
      });
      const pending = insights.read(user, scope);
      const observed = expect(pending).rejects.toMatchObject({
        code: 'CUSTOMER_INSIGHTS_CONTEXT_CHANGED',
      });
      await entered;
      try {
        await connection.query('SET SESSION innodb_lock_wait_timeout=1');
        await connection.query("UPDATE users SET telephone='9000000000' WHERE id=777");
      } finally {
        release();
      }
      await observed;
    });
    it('rechecks archived operator authority after the briefing network request', async () => {
      let ready = () => {},
        release = () => {};
      const entered = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const insights = customerBriefingService(config, db, {
        read: async () => {
          ready();
          await held;
          return customerBriefing.parse({});
        },
      });
      const pending = insights.read(user, scope);
      const observed = expect(pending).rejects.toMatchObject({ status: 401 });
      await entered;
      try {
        await connection.query('UPDATE pos_user SET is_active=0 WHERE id=7');
      } finally {
        release();
      }
      await observed;
    });
    it('rejects a changed checkout version instead of publishing recommendations for an older sale', async () => {
      const insights = customerBriefingService(config, db, {
        read: async () => {
          await db
            .get('writer')
            .update(checkoutSessions)
            .set({ version: 2, state: { ...state(), version: 2 } })
            .where(eq(checkoutSessions.id, checkoutId));
          return customerBriefing.parse({});
        },
      });
      await expect(insights.read(user, scope)).rejects.toMatchObject({
        code: 'CUSTOMER_INSIGHTS_CONTEXT_CHANGED',
      });
    });
    it('reads current membership, app status, source-rounded wallets and active vouchers without changing sale or balances', async () => {
      await fixture.insert('user_eav', {
        entity: 'GUEST@example.test',
        attribute: 'EXCLUSIVE_EXPIRY',
        value: '2000-01-01T00:00:00',
        is_active: 1,
      });
      await fixture.insert('user_addons', { user_id: 777, is_app_user: 2 });
      await fixture.insert('gift_vouchers', {
        id: 10,
        to_id: 'GUEST@example.test',
        status: 1,
        end_date: '2020-01-01',
      });
      await fixture.insert('gift_vouchers', { id: 11, to_id: 'guest@example.test', status: 1 });
      await fixture.insert('gift_vouchers', { id: 12, to_id: 'guest@example.test', status: 0 });
      const benefits = customerBenefitsService(config, db, { active: async () => true });
      expect(await benefits.read(user, scope)).toMatchObject({
        customerId: '777',
        checkoutVersion: 1,
        membership: { active: true, expiry: '2000-01-01T00:00:00', message: '' },
        wallet: { money: '100.12', points: '0.00' },
        app: { isAppUser: true, discountEligible: true },
        activeGiftVoucherCount: '2',
      });
      const [stored] = await db
        .get('writer')
        .select({ money: MUser.tss_money })
        .from(MUser)
        .where(eq(MUser.id, 777n));
      expect(stored?.money).toBeCloseTo(100.129, 3);
      const [checkout] = await db
        .get('writer')
        .select({ version: checkoutSessions.version })
        .from(checkoutSessions)
        .where(eq(checkoutSessions.id, checkoutId));
      expect(checkout?.version).toBe(1);
    });
    it('uses the same native email collation as the separate source membership and voucher queries', async () => {
      await db
        .get('writer')
        .update(MUser)
        .set({ email: 'Güest@example.test', user_platform: 'STORE_FRONT_USER' })
        .where(eq(MUser.id, 777n));
      await fixture.insert('user_eav', {
        entity: 'GUEST@example.test',
        attribute: 'EXCLUSIVE_EXPIRY',
        value: '2060-01-01 00:00:00',
        is_active: 0,
      });
      await fixture.insert('gift_vouchers', { id: 10, to_id: 'GUEST@example.test', status: 1 });
      const [raw] = await connection.query(
        'SELECT CAST(COUNT(*) AS CHAR) AS count FROM gift_vouchers WHERE to_id = ? AND status=1',
        ['Güest@example.test'],
      );
      const expected = z.array(z.object({ count: z.string() })).parse(raw)[0]!;
      const [nativeMembership] = await connection.query(
        "SELECT value,is_active FROM user_eav WHERE entity=? AND attribute='EXCLUSIVE_EXPIRY' LIMIT 1",
        ['Güest@example.test'],
      );
      // latin1_swedish_ci distinguishes this spelling; a Unicode column-to-
      // column join would change the source's parameter comparison semantics.
      expect(z.array(z.unknown()).parse(nativeMembership)).toEqual([]);
      const result = await customerBenefitsService(config, db, { active: async () => true }).read(
        user,
        scope,
      );
      expect(result.activeGiftVoucherCount).toBe(expected.count);
      expect(result.app.discountEligible).toBe(false);
      expect(result.membership).toEqual({
        active: false,
        expiry: null,
        message: '',
      });
    });
    it('releases writer locks across the campaign lookup and rejects a contact change before publication', async () => {
      let entered = () => {},
        release = () => {};
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const benefits = customerBenefitsService(config, db, {
        active: async () => {
          entered();
          await held;
          return true;
        },
      });
      const pending = benefits.read(user, scope);
      const observed = expect(pending).rejects.toMatchObject({
        code: 'CUSTOMER_BENEFITS_CONTEXT_CHANGED',
      });
      await ready;
      try {
        await connection.query('SET SESSION innodb_lock_wait_timeout=1');
        await connection.query("UPDATE users SET email='changed@example.test' WHERE id=777");
      } finally {
        release();
      }
      await observed;
    });
    it('rechecks disabled customer and archived operator authority without showing stale benefits', async () => {
      await db
        .get('writer')
        .update(benefitCustomers)
        .set({ disabled: 1 })
        .where(eq(benefitCustomers.id, 777n));
      await expect(
        customerBenefitsService(config, db, { active: async () => true }).read(user, scope),
      ).rejects.toMatchObject({ code: 'CUSTOMER_PROFILE_NOT_FOUND' });
      await db
        .get('writer')
        .update(benefitCustomers)
        .set({ disabled: 0 })
        .where(eq(benefitCustomers.id, 777n));
      const benefits = customerBenefitsService(config, db, {
        active: async () => {
          await connection.query('UPDATE pos_user SET is_active=0 WHERE id=7');
          return true;
        },
      });
      await expect(benefits.read(user, scope)).rejects.toMatchObject({ status: 401 });
    });
  },
);
