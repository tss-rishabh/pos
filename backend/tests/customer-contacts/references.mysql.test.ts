import { spawnSync } from 'node:child_process';
import { Temporal } from '@js-temporal/polyfill';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  carryCustomerEmailReferences,
  assertEmailNotRegistered,
  assertNoEmployeeContactChange,
} from '../../src/modules/customer-contacts/references.js';
import { customerContactFixture } from './mysql-fixture.js';

const template = process.env.CUSTOMER_CONTACT_MYSQL_TEST_URL;
const projections = {
  user_eav: 'entity,attribute,value,is_active,created_at,updated_at',
  user_email_membership_copy_logs:
    'user_id,old_email,new_email,shared_user_ids,exclusive_expiry,created_at',
  jp_customers: 'id,`user`,email,deleted_at',
  gift_vouchers: 'id,to_id',
  welcome_offer: 'id,email_id',
  bank_transfer_requests: 'id,email,status',
  refund_alternate_payment_details: 'id,email,status',
};
const tables = [
  'users',
  'orders',
  'gift_vouchers',
  'user_eav',
  'user_email_membership_copy_logs',
  'jp_customers',
  'welcome_offer',
  'bank_transfer_requests',
  'refund_alternate_payment_details',
  'refund_requests',
  'coupons',
  'coupons_users',
  'user_detail_logs',
];
describe.skipIf(!template)(
  'source-equivalent contact reference transactions on isolated physical MySQL',
  () => {
    let native: Awaited<ReturnType<typeof customerContactFixture>>;
    const oldEmail = '9876543210@temp.id',
      newEmail = 'customer.fixture@example.test',
      wallTime = '2026-11-16 15:30:00';
    const input = {
      customerId: '1',
      oldEmail,
      newEmail,
      wallTime,
      refundSuccess: 'SUCCESS' as const,
      refundFailed: 'FAILED' as const,
    };
    beforeAll(async () => {
      native = await customerContactFixture(template!, tables);
      await native.connection.query(
        'ALTER TABLE jp_customers ADD UNIQUE KEY uix_jp_customers_email(email)',
      );
      await native.connection.query(
        'ALTER TABLE refund_alternate_payment_details ADD UNIQUE KEY refund_request_id(refund_request_id)',
      );
    });
    beforeEach(async () => {
      for (const table of tables) await native.connection.query('TRUNCATE TABLE `' + table + '`');
      const { insert } = native.fixture;
      await insert('users', {
        id: '1',
        email: oldEmail,
        telephone: '9876543210',
        user_type: '2',
        status: 1,
        tss_money: 123.45,
      });
      await insert('users', {
        id: '2',
        email: 'other.fixture@example.test',
        telephone: '9876543211',
        user_type: '2',
        status: 1,
      });
      for (const row of [
        { id: '101', user_id: '1' },
        { id: '102', user_id: '2' },
      ])
        await insert('orders', row);
      for (const [attribute, value] of [
        ['EXCLUSIVE_NOTIFY', 'yes'],
        ['EXCLUSIVE_EXPIRY', '2030-01-01 00:00:00'],
        ['EXCLUSIVE_MEMBER', 'fixture-member'],
      ])
        await insert('user_eav', {
          entity: oldEmail,
          attribute: attribute!,
          value: value!,
          is_active: 1,
          created_at: '2020-01-01 00:00:00',
          updated_at: '2020-02-01 00:00:00',
        });
      for (const row of [
        {
          id: 200,
          user: 1,
          email: 'deleted.fixture@example.test',
          deleted_at: '2020-01-01 00:00:00',
        },
        { id: 201, user: 1, email: oldEmail, deleted_at: null },
        { id: 202, user: 1, email: 'second.fixture@example.test', deleted_at: null },
      ])
        await insert('jp_customers', row);
      await insert('gift_vouchers', { id: '9007199254740993', to_id: oldEmail });
      await insert('welcome_offer', { id: '301', user_id: '1', email_id: oldEmail });
      for (const row of [
        { id: '401', order_id: '101', status: 'PENDING' },
        { id: '402', order_id: '101', status: 'SUCCESS' },
        { id: '403', order_id: '101', status: 'FAILED' },
        { id: '404', order_id: '101', status: 'ERROR' },
        { id: '405', order_id: '102', status: 'PENDING' },
      ])
        await insert('bank_transfer_requests', { ...row, email: oldEmail });
      for (const row of [
        { id: '501', order_id: '101', user_id: '1', is_completed: 'FAILED' },
        { id: '502', order_id: '101', user_id: '1', is_completed: 'COMPLETED' },
        { id: '503', order_id: '102', user_id: '2', is_completed: 'FAILED' },
        { id: '504', order_id: '101', user_id: '1', is_completed: 'FAILED' },
      ])
        await insert('refund_requests', row);
      for (const row of [
        { id: '601', order_id: '101', refund_request_id: '501', status: 'PENDING' },
        { id: '602', order_id: '101', refund_request_id: '502', status: 'PENDING' },
        { id: '603', order_id: '102', refund_request_id: '503', status: 'PENDING' },
        { id: '604', order_id: '101', refund_request_id: '504', status: 'MAIL_SENT' },
      ])
        await insert('refund_alternate_payment_details', { ...row, email: oldEmail });
    });
    afterAll(async () => {
      await native?.close();
    });
    async function snapshot() {
      const output: Record<string, unknown> = {};
      for (const [table, projection] of Object.entries(projections)) {
        const order =
          table === 'user_eav'
            ? 'entity,attribute'
            : table === 'user_email_membership_copy_logs'
              ? 'user_id,old_email,new_email'
              : 'id';
        output[table] = (
          await native.connection.query(
            'SELECT ' + projection + ' FROM `' + table + '` ORDER BY ' + order,
          )
        )[0];
      }
      return JSON.parse(JSON.stringify(output)) as unknown;
    }
    function source(value = input) {
      const result = spawnSync(
        'uv',
        [
          'run',
          '--no-project',
          '--python',
          '3.10',
          '--with',
          'SQLAlchemy==1.4.53',
          '--with',
          'PyMySQL==1.1.0',
          '--with',
          'python-dateutil==2.8.2',
          'python',
          'tools/customer-contacts/source-reference-oracle.py',
        ],
        {
          input: JSON.stringify({ database: native.url, ...value }),
          encoding: 'utf8',
          timeout: 30000,
        },
      );
      if (result.status !== 0) throw new Error('Pinned contact oracle failed: ' + result.stdout);
      return z
        .object({
          sourceCommit: z.string(),
          tables: z.record(z.string(), z.unknown()),
          refundRemails: z.array(z.object({ orderId: z.string(), refundRequestId: z.string() })),
        })
        .parse(JSON.parse(result.stdout) as unknown);
    }
    it.each([false, true])(
      'matches pinned Python reference effects for sharedOldEmail=%s without changing balances',
      async (shared) => {
        if (shared)
          await native.connection.query('UPDATE users SET email=? WHERE id=2', [oldEmail]);
        const expected = source();
        const result = await native.db
          .get('writer')
          .transaction((tx) => carryCustomerEmailReferences(tx, input));
        expect(await snapshot()).toEqual(expected.tables);
        expect(result.refundRemails).toEqual(expected.refundRemails);
        expect(result.sharedOldEmail).toBe(shared);
        const [users] = await native.connection.query<import('mysql2').RowDataPacket[]>(
          'SELECT tss_money FROM users WHERE id=1',
        );
        expect(Number(users[0]?.tss_money)).toBe(123.45);
      },
      30000,
    );
    it('retains the source55-character welcome boundary and taken Juspay-address fallback', async () => {
      const long = 'long.'.repeat(10) + 'fixture@example.test';
      expect(long.length).toBeGreaterThan(55);
      await native.fixture.insert('jp_customers', { id: 203, user: 2, email: long });
      const value = { ...input, newEmail: long },
        expected = source(value);
      await native.db.get('writer').transaction((tx) => carryCustomerEmailReferences(tx, value));
      expect(await snapshot()).toEqual(expected.tables);
    }, 30000);
    it('preserves the source reference result after the proposed nonunique order/status refund index', async () => {
      const expected = source();
      await native.connection.query(
        'CREATE INDEX ix_contact_refund_order_status_request ON refund_alternate_payment_details(order_id,status,refund_request_id)',
      );
      try {
        const result = await native.db
          .get('writer')
          .transaction((tx) => carryCustomerEmailReferences(tx, input));
        expect(await snapshot()).toEqual(expected.tables);
        expect(result.refundRemails).toEqual(expected.refundRemails);
        const [plan] = await native.connection.query<import('mysql2').RowDataPacket[]>(
          'EXPLAIN SELECT id FROM refund_alternate_payment_details WHERE order_id=? AND status=?',
          ['101', 'PENDING'],
        );
        expect(
          plan.some((row) =>
            String(row.possible_keys).includes('ix_contact_refund_order_status_request'),
          ),
        ).toBe(true);
      } finally {
        await native.connection.query(
          'DROP INDEX ix_contact_refund_order_status_request ON refund_alternate_payment_details',
        );
      }
    });
    it('rejects registered email/member claims and active employee coupons on the current writer', async () => {
      await expect(
        native.db
          .get('writer')
          .transaction((tx) => assertEmailNotRegistered(tx, 'other.fixture@example.test')),
      ).rejects.toMatchObject({ code: 'CUSTOMER_CONTACT_ALREADY_REGISTERED' });
      await native.fixture.insert('user_eav', {
        entity: newEmail,
        attribute: 'EXCLUSIVE_NOTIFY',
        is_active: 0,
      });
      await expect(
        native.db.get('writer').transaction((tx) => assertEmailNotRegistered(tx, newEmail)),
      ).rejects.toMatchObject({ code: 'CUSTOMER_CONTACT_ALREADY_REGISTERED' });
      await native.fixture.insert('coupons', {
        id: 700,
        user_id: '1',
        is_employee_coupon: 1,
        is_deleted: 0,
        start_date: '2026-11-16 15:00:00',
        end_date: '2026-11-16 16:00:00',
      });
      await native.fixture.insert('coupons_users', { id: '701', c_id: '700', user_id: '1' });
      await expect(
        native.db
          .get('writer')
          .transaction((tx) =>
            assertNoEmployeeContactChange(tx, '1', Temporal.Instant.from('2026-11-16T10:00:00Z')),
          ),
      ).rejects.toMatchObject({ code: 'CUSTOMER_CONTACT_EMPLOYEE_EMAIL' });
      await native.db
        .get('writer')
        .transaction((tx) =>
          assertNoEmployeeContactChange(tx, '2', Temporal.Instant.from('2026-11-16T10:00:00Z')),
        );
    });
    it('rolls every reference and copy audit back if a downstream update fails', async () => {
      const before = await snapshot();
      await native.connection.query(
        "CREATE TRIGGER fixture_contact_refund_failure BEFORE UPDATE ON refund_alternate_payment_details FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic failure'",
      );
      try {
        await expect(
          native.db.get('writer').transaction((tx) => carryCustomerEmailReferences(tx, input)),
        ).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      } finally {
        await native.connection.query('DROP TRIGGER fixture_contact_refund_failure');
      }
    });
  },
);
