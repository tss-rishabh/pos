import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Databases } from '../../src/db/pools.js';
import { installNativeHeadFixture } from '../native-head-metadata/fixture.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  giftCardIssuanceContract,
  giftCardIssuanceHashSql,
} from '../../src/modules/checkout/gift-card-issuance.js';
import { checkoutHeaderHashSql } from '../../src/modules/checkout/projection.js';
import {
  applyCancellationBenefits,
  lockCancellationBenefits,
} from '../../src/modules/checkout/cancellations/benefits.js';
import {
  captureCancellationMembership,
  sealCancellationMembership,
} from '../../src/modules/checkout/cancellations/membership.js';
import { cancellationMembershipRows } from '../../src/modules/checkout/cancellations/benefit-schema.js';
import {
  cancellationBenefitPolicy,
  type CancellationBenefitProfile,
  type CancellationBenefitScope,
} from '../../src/modules/checkout/cancellations/benefit-contracts.js';
import { goldenStdout } from '../golden/load.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
const profile: CancellationBenefitProfile = {
  policy: cancellationBenefitPolicy,
  walletWriterContract: 'pos-wallet-user-lock-v1',
  voucherWriterContract: 'pos-voucher-user-lock-v1',
};
const secret = 'isolated-cancellation-benefit-secret-'.repeat(3);
const membershipProfile: CancellationBenefitProfile = {
  ...profile,
  membershipWriterContract: 'pos-cancellation-membership-provenance-v2',
  membershipCacheContract: 'pos-membership-fresh-reader-v1',
  membershipProofKey: 'isolated-separate-membership-key-'.repeat(3),
};
const now = '2026-11-17 12:00:00';
describe.skipIf(!template)(
  'locked pending cancellation benefits on verified physical MySQL',
  () => {
    let connection: Connection,
      db: Databases,
      schemaName: string,
      fixture: ReturnType<typeof verifiedMysqlFixture>;
    let heads: Awaited<ReturnType<typeof installNativeHeadFixture>>;
    let previousEnvironment: Record<string, string | undefined> = {};
    let next = 8000;
    beforeAll(async () => {
      const url = new URL(template!);
      if (
        url.protocol !== 'mysql:' ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.pathname !== '/pos_rewrite_checkout_test'
      )
        throw new Error('Explicit isolated localhost template required.');
      schemaName = `pos_rewrite_checkout_test_cancel_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
      connection = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
      await connection.query(`CREATE DATABASE ${mysql.escapeId(schemaName)}`);
      await connection.changeUser({ database: schemaName });
      fixture = verifiedMysqlFixture(connection, [
        'evidence/mysql-pending-cancellation-benefits-schema.json',
        'evidence/mysql-global-benefits-schema.json',
      ]);
      await fixture.create([
        'users',
        'orders',
        'has_products',
        'amount_to_be_refunded_log',
        'order_tss_money',
        'order_tss_point',
        'tss_money_history',
        'tss_point_history',
        'gift_vouchers',
        'gift_voucher_history',
        'gift_card_collection',
        'user_eav',
      ]);
      await connection.query(
        readFileSync(
          'compatibility/upstream/pending-cancellation/voucher-history-index.sql',
          'utf8',
        ),
      );
      for (const statement of readFileSync(
        'src/modules/checkout/migrations/0015_gift_card_issuance.sql',
        'utf8',
      )
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((value) => value.trim()))
        await connection.query(statement);
      for (const statement of readFileSync(
        'src/modules/checkout/cancellations/benefit-migration.sql',
        'utf8',
      )
        .split(';')
        .filter((value) => value.trim()))
        await connection.query(statement);
      await connection.query(
        readFileSync(
          'src/modules/checkout/cancellations/membership-producer-migration.sql',
          'utf8',
        ),
      );
      await connection.query('CREATE INDEX fixture_users_email ON users(email)');
      heads = await installNativeHeadFixture(connection, template!, {
        families: ['membershipRevision'],
      });
      previousEnvironment = Object.fromEntries(
        Object.keys(heads.environment).map((key) => [key, process.env[key]]),
      );
      Object.assign(process.env, heads.environment);
      for (const table of [
        'pos_rewrite_cancellation_membership_provenance',
        'gift_vouchers',
        'gift_voucher_history',
        'gift_card_collection',
        'pos_rewrite_gift_card_issuances',
        'order_tss_money',
        'order_tss_point',
        'tss_money_history',
        'tss_point_history',
        'amount_to_be_refunded_log',
      ])
        await connection.query(
          'GRANT INSERT, UPDATE, DELETE ON ' +
            mysql.escapeId(schemaName) +
            '.' +
            mysql.escapeId(table) +
            ' TO ' +
            mysql.escape(heads.names.app) +
            "@'%'",
        );
      db = heads.appDb;
    }, 30_000);
    afterAll(async () => {
      await db?.close();
      await heads?.close();
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (connection) {
        await connection.query(`DROP DATABASE ${mysql.escapeId(schemaName)}`);
        await connection.end();
      }
    });
    async function order(
      money = 0,
      points = 0,
      voucher = 0,
      voucherId = 0,
    ): Promise<CancellationBenefitScope> {
      const id = String(++next),
        customerId = id,
        lineId = String(BigInt(id) + 9007199254740993n);
      await fixture.insert('users', {
        id: customerId,
        email: `cash-${id}@example.test`,
        status: 1,
        is_block: 0,
        is_disabled: 0,
        tss_money: 10,
        tss_points: 20,
        cashback: 77,
      });
      await fixture.insert('orders', {
        id,
        user_id: customerId,
        payment_method: 14,
        order_status: 1,
        payment_status: 1,
        tss_money_used: money,
        tss_points_used: points,
        voucher_used: voucherId,
        voucher_amt_used: voucher,
        pay_amt: 100,
      });
      await fixture.insert('has_products', {
        id: lineId,
        order_id: id,
        prod_id: 10,
        qty: 1,
        status: 'PLACED',
        cashback_refunded: 0,
      });
      await fixture.insert('amount_to_be_refunded_log', {
        order_id: id,
        has_product_id: lineId,
        prod_id: 10,
        tss_money_used: money,
        tss_point_used: points,
        gift_voucher_amount: voucher,
        is_refunded: 0,
        refunded_amt: 0,
      });
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT ${checkoutHeaderHashSql} AS hash FROM orders WHERE id=?`,
        [id],
      );
      return {
        orderId: id,
        customerId,
        voucherId: String(voucherId),
        headerHash: String(rows[0]!.hash),
        money,
        points,
        voucher,
        lines: [{ lineId, productId: '10', money, points, voucher }],
        membership: false,
        timestamp: now,
      };
    }
    async function earning(
      scope: CancellationBenefitScope,
      asset: 'money' | 'points',
      used: number,
      expiry = '2027-01-01 00:00:00',
      returned: number | null = 0,
    ) {
      const history = asset === 'money' ? 'tss_money_history' : 'tss_point_history',
        allocations = asset === 'money' ? 'order_tss_money' : 'order_tss_point';
      const [result] = await connection.execute<mysql.ResultSetHeader>(
        `INSERT INTO ${mysql.escapeId(history)} (user_id,added_amt,used_amt,platform,expiry,is_expired,is_bulk_upload,created_at,updated_at) VALUES (?,?,?,'MISC_COMPENSATION',?,0,0,?,?)`,
        [scope.customerId, used, used, expiry, now, now],
      );
      await fixture.insert(allocations, {
        order_id: scope.orderId,
        [asset === 'money' ? 'tss_money_id' : 'tss_point_id']: result.insertId,
        used_amount: used,
        [asset === 'money' ? 'tss_money_return' : 'tss_point_return']: returned,
      });
      return result.insertId;
    }
    const execute = (scope: CancellationBenefitScope, selectedProfile = profile) =>
      db.get('writer').transaction(async (tx) => {
        const plan = await lockCancellationBenefits(tx, scope, selectedProfile, secret);
        await applyCancellationBenefits(tx, plan);
        return plan.summary;
      });
    async function balance(customerId: string) {
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT CAST(tss_money AS CHAR) AS money,CAST(tss_points AS CHAR) AS points,CAST(cashback AS CHAR) AS cashback FROM users WHERE id=?',
        [customerId],
      );
      return rows[0]!;
    }
    it('restores split original expiries and both correct ledgers while preserving Cashback', async () => {
      const scope = await order(25, 30);
      await earning(scope, 'money', 10, '2027-01-01 00:00:00');
      await earning(scope, 'money', 15, '2028-01-01 00:00:00');
      await earning(scope, 'points', 30, '2029-01-01 00:00:00');
      expect(await execute(scope)).toMatchObject({
        moneyCredited: '25',
        pointsCredited: '30',
        moneyExpired: '0',
      });
      expect(await balance(scope.customerId)).toMatchObject({
        money: '35',
        points: '50',
        cashback: '77',
      });
      const [history] = await connection.query<RowDataPacket[]>(
        'SELECT added_amt,expiry,has_product_id,platform FROM tss_money_history WHERE order_id=? ORDER BY id',
        [scope.orderId],
      );
      expect(history).toHaveLength(2);
      expect(history.map((row) => row.expiry)).toEqual([
        '2027-01-01 00:00:00',
        '2028-01-01 00:00:00',
      ]);
      expect(
        history.every(
          (row) =>
            String(row.has_product_id) === scope.lines[0]!.lineId &&
            row.platform === 'ORDER_CANCELLED',
        ),
      ).toBe(true);
    });
    it('consumes an expired allocation once, keeps it unspendable and refuses an incomplete replay', async () => {
      const scope = await order(25);
      await earning(scope, 'money', 10, '2020-01-01 00:00:00');
      await earning(scope, 'money', 15);
      expect(await execute(scope)).toMatchObject({ moneyCredited: '15', moneyExpired: '10' });
      expect((await balance(scope.customerId)).money).toBe('25');
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT added_amt,amt_before_update,amt_after_update,is_expired FROM tss_money_history WHERE order_id=? AND platform='TSS_MONEY_EXPIRED'",
        [scope.orderId],
      );
      expect(rows[0]).toMatchObject({
        added_amt: -10,
        amt_before_update: 10,
        amt_after_update: 10,
        is_expired: 1,
      });
      await expect(execute(scope)).rejects.toMatchObject({
        code: 'CANCELLATION_EARNING_TRACE_INCOMPLETE',
      });
      expect((await balance(scope.customerId)).money).toBe('25');
    });
    it('rejects NULL, orphan, insufficient and wrong-customer mappings before money mutations', async () => {
      for (const flaw of ['null', 'orphan', 'short', 'foreign'] as const) {
        const scope = await order(20);
        const id = await earning(
          scope,
          'money',
          flaw === 'short' ? 10 : 20,
          '2027-01-01 00:00:00',
          flaw === 'null' ? null : 0,
        );
        if (flaw === 'orphan')
          await connection.execute('DELETE FROM tss_money_history WHERE id=?', [id]);
        if (flaw === 'foreign')
          await connection.execute('UPDATE tss_money_history SET user_id=999999 WHERE id=?', [id]);
        await expect(execute(scope)).rejects.toMatchObject({
          code: 'CANCELLATION_EARNING_TRACE_INCOMPLETE',
        });
        expect((await balance(scope.customerId)).money).toBe('10');
      }
    });
    it('rejects an unbound line allocation even when the forged requested total balances', async () => {
      const scope = await order(20);
      await earning(scope, 'money', 20);
      await expect(
        execute({ ...scope, lines: [{ ...scope.lines[0]!, lineId: '2' }] }),
      ).rejects.toMatchObject({ code: 'CANCELLATION_BENEFIT_TOTAL_MISMATCH' });
      expect((await balance(scope.customerId)).money).toBe('10');
    });
    it('rolls every wallet history, returned mapping and balance back on a late failure', async () => {
      const scope = await order(25, 30);
      await earning(scope, 'money', 25);
      await earning(scope, 'points', 30);
      await expect(
        db.get('writer').transaction(async (tx) => {
          const plan = await lockCancellationBenefits(tx, scope, profile, secret);
          await applyCancellationBenefits(tx, plan);
          throw new Error('controlled late rollback');
        }),
      ).rejects.toThrow('controlled late rollback');
      expect(await balance(scope.customerId)).toMatchObject({
        money: '10',
        points: '20',
        cashback: '77',
      });
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT tss_money_return AS returned FROM order_tss_money WHERE order_id=?',
        [scope.orderId],
      );
      expect(rows[0]?.returned).toBe(0);
      expect((await execute(scope)).moneyCredited).toBe('25');
    });
    it('serializes competing benefit restorations under the same locked original order', async () => {
      const scope = await order(25);
      await earning(scope, 'money', 25);
      const result = await Promise.allSettled(Array.from({ length: 20 }, () => execute(scope)));
      expect(result.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
      expect((await balance(scope.customerId)).money).toBe('35');
    });
    it('cannot apply a plan from another transaction or apply the same plan twice', async () => {
      const scope = await order(25);
      await earning(scope, 'money', 25);
      const plan = await db
        .get('writer')
        .transaction((tx) => lockCancellationBenefits(tx, scope, profile, secret));
      await expect(
        db.get('writer').transaction((tx) => applyCancellationBenefits(tx, plan)),
      ).rejects.toMatchObject({ code: 'CANCELLATION_BENEFIT_PLAN_CHANGED' });
      await expect(
        db.get('writer').transaction(async (tx) => {
          const current = await lockCancellationBenefits(tx, scope, profile, secret);
          await applyCancellationBenefits(tx, current);
          await applyCancellationBenefits(tx, current);
        }),
      ).rejects.toMatchObject({ code: 'CANCELLATION_BENEFIT_PLAN_CHANGED' });
      expect((await balance(scope.customerId)).money).toBe('10');
    });
    it('retains blocked, expired and disabled card state while crediting only its proved original debit', async () => {
      for (const condition of ['blocked', 'expired', 'disabled', 'active'] as const) {
        const voucherId = ++next;
        await fixture.insert('gift_card_collection', {
          id: voucherId,
          size: 1,
          is_block: condition === 'blocked' ? 1 : 0,
          is_completed: 1,
          is_printed: 1,
        });
        await fixture.insert('gift_vouchers', {
          id: voucherId,
          gv_type: 'GIFT_CARD',
          from_id: 777,
          order_id: 9000,
          gift_card_srno: voucherId,
          collection_no: voucherId,
          voucher_value: 30,
          voucher_initial_value: 100,
          status: condition === 'disabled' ? 0 : 1,
          start_date: '2020-01-01 00:00:00',
          end_date: condition === 'expired' ? '2020-02-01 00:00:00' : '2027-01-01 00:00:00',
        });
        await connection.execute(
          `INSERT INTO pos_rewrite_gift_card_issuances(voucher_id,order_id,collection_id,serial,input_hash,contract_version,activated_at) SELECT id,order_id,collection_no,gift_card_srno,${giftCardIssuanceHashSql},?,? FROM gift_vouchers WHERE id=?`,
          [giftCardIssuanceContract, now, voucherId],
        );
        const scope = await order(0, 0, 20, voucherId);
        await fixture.insert('gift_voucher_history', {
          user_id: scope.customerId,
          order_id: scope.orderId,
          gv_id: voucherId,
          added_amt: -20,
          amt_before_update: 50,
          amt_after_update: 30,
          platform: 'ORDER_PLACED',
        });
        expect(await execute(scope)).toMatchObject({
          voucherCredited: '20',
          voucherAvailable: condition === 'active',
        });
        const [rows] = await connection.query<RowDataPacket[]>(
          'SELECT voucher_value,status,end_date FROM gift_vouchers WHERE id=?',
          [voucherId],
        );
        expect(rows[0]).toMatchObject({
          voucher_value: 50,
          status: condition === 'disabled' ? 0 : 1,
          end_date: condition === 'expired' ? '2020-02-01 00:00:00' : '2027-01-01 00:00:00',
        });
        const [history] = await connection.query<RowDataPacket[]>(
          "SELECT added_amt FROM gift_voucher_history WHERE order_id=? AND platform='ORDER_CANCELLED'",
          [scope.orderId],
        );
        expect(history[0]?.added_amt).toBe(20);
        await expect(execute(scope)).rejects.toMatchObject({
          code: 'CANCELLATION_VOUCHER_DEBIT_UNCONFIRMED',
        });
      }
    });
    it('refuses an unindexed voucher ledger and proves the additive index preserves the exact response', async () => {
      const voucherId = ++next;
      await fixture.insert('gift_vouchers', {
        id: voucherId,
        gv_type: 'GIFT_VOUCHER',
        voucher_value: 30,
        voucher_initial_value: 100,
        status: 1,
      });
      const scope = await order(0, 0, 20, voucherId);
      await fixture.insert('gift_voucher_history', {
        user_id: scope.customerId,
        order_id: scope.orderId,
        gv_id: voucherId,
        added_amt: -20,
        amt_before_update: 50,
        amt_after_update: 30,
        platform: 'ORDER_PLACED',
      });
      await connection.query('DROP INDEX ix_pos_gv_history_order_voucher ON gift_voucher_history');
      const query =
          'SELECT id,added_amt,amt_before_update,amt_after_update,platform FROM gift_voucher_history WHERE order_id=? AND gv_id=? ORDER BY id LIMIT 1001',
        params = [scope.orderId, voucherId];
      const [before] = await connection.query<RowDataPacket[]>(query, params);
      try {
        await expect(execute(scope)).rejects.toMatchObject({
          code: 'CANCELLATION_VOUCHER_INDEX_UNVERIFIED',
        });
      } finally {
        await connection.query(
          readFileSync(
            'compatibility/upstream/pending-cancellation/voucher-history-index.sql',
            'utf8',
          ),
        );
      }
      const [after] = await connection.query<RowDataPacket[]>(query, params);
      expect(after).toEqual(before);
      const [plan] = await connection.query<RowDataPacket[]>('EXPLAIN ' + query, params);
      expect(plan[0]?.possible_keys).toContain('ix_pos_gv_history_order_voucher');
      expect((await execute(scope)).voucherCredited).toBe('20');
    });
    it('does not manufacture a legacy gift-card funding proof from a debit or a disabled balance', async () => {
      const voucherId = ++next;
      await fixture.insert('gift_card_collection', {
        id: voucherId,
        size: 1,
        is_block: 0,
        is_completed: 1,
        is_printed: 1,
      });
      await fixture.insert('gift_vouchers', {
        id: voucherId,
        gv_type: 'GIFT_CARD',
        collection_no: voucherId,
        voucher_value: 0,
        voucher_initial_value: 100,
        status: 0,
        start_date: '2020-01-01 00:00:00',
        end_date: '2027-01-01 00:00:00',
      });
      const scope = await order(0, 0, 20, voucherId);
      await fixture.insert('gift_voucher_history', {
        user_id: scope.customerId,
        order_id: scope.orderId,
        gv_id: voucherId,
        added_amt: -20,
        amt_before_update: 20,
        amt_after_update: 0,
        platform: 'ORDER_PLACED',
      });
      await expect(execute(scope)).rejects.toMatchObject({
        code: 'CANCELLATION_GIFT_CARD_FUNDING_UNCONFIRMED',
      });
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT voucher_value,status FROM gift_vouchers WHERE id=?',
        [voucherId],
      );
      expect(rows[0]).toMatchObject({ voucher_value: 0, status: 0 });
    });
    it('rejects missing, changed and duplicate original voucher debits', async () => {
      for (const kind of ['missing', 'changed', 'duplicate'] as const) {
        const voucherId = ++next;
        await fixture.insert('gift_vouchers', {
          id: voucherId,
          gv_type: 'GIFT_VOUCHER',
          voucher_value: 30,
          voucher_initial_value: 100,
          status: 1,
        });
        const scope = await order(0, 0, 20, voucherId);
        if (kind !== 'missing')
          await fixture.insert('gift_voucher_history', {
            user_id: scope.customerId,
            order_id: scope.orderId,
            gv_id: voucherId,
            added_amt: kind === 'changed' ? -19 : -20,
            amt_before_update: 50,
            amt_after_update: 30,
            platform: 'ORDER_PLACED',
          });
        if (kind === 'duplicate')
          await fixture.insert('gift_voucher_history', {
            user_id: scope.customerId,
            order_id: scope.orderId,
            gv_id: voucherId,
            added_amt: -20,
            amt_before_update: 50,
            amt_after_update: 30,
            platform: 'ORDER_PLACED',
          });
        await expect(execute(scope)).rejects.toMatchObject({
          code: 'CANCELLATION_VOUCHER_DEBIT_UNCONFIRMED',
        });
        const [rows] = await connection.query<RowDataPacket[]>(
          'SELECT voucher_value FROM gift_vouchers WHERE id=?',
          [voucherId],
        );
        expect(rows[0]?.voucher_value).toBe(30);
      }
    });
    const sourceMembershipRow = z
      .object({
        attribute: z.enum(['EXCLUSIVE_MEMBER', 'EXCLUSIVE_EXPIRY']),
        value: z.union([z.string(), z.number()]),
        is_active: z.number().int(),
        created_at: z.string(),
        updated_at: z.string(),
      })
      .strict();
    const membershipVectors = z
      .object({
        sourceCommit: z.literal('2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'),
        sourceHashes: z.record(z.string(), z.string()),
        cases: z.array(
          z.object({
            name: z.string(),
            before: z.array(sourceMembershipRow),
            staged: z.array(sourceMembershipRow),
            originalCancelled: z.array(sourceMembershipRow),
            commits: z.number().int(),
          }),
        ),
      })
      .parse(JSON.parse(goldenStdout('checkout', 'cancellation-benefits-mysql')) as unknown);
    async function stagedMember(name: string) {
      const vector = membershipVectors.cases.find((row) => row.name === name)!;
      const scope = { ...(await order()), membership: true },
        entity = `cash-${scope.customerId}@example.test`;
      for (const row of vector.before)
        await fixture.insert('user_eav', {
          entity,
          attribute: row.attribute,
          value: String(row.value),
          is_active: row.is_active,
          created_at: row.created_at,
          updated_at: row.updated_at,
        });
      await db.get('writer').transaction(async (tx) => {
        const token = await captureCancellationMembership(
          tx,
          scope,
          membershipProfile,
          crypto.randomUUID(),
          ['10'],
        );
        for (const row of vector.staged) {
          const values = {
            entity,
            attribute: row.attribute,
            value: String(row.value),
            active: row.is_active,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
          await tx
            .insert(cancellationMembershipRows)
            .values(values)
            .onDuplicateKeyUpdate({ set: values });
        }
        await sealCancellationMembership(tx, token);
      });
      return { scope, entity, vector };
    }
    it('restores only each source-proved membership change and retains an upgraded prior entitlement', async () => {
      for (const name of ['new-pending', 'new-activated', 'upgrade-existing']) {
        const { scope, entity, vector } = await stagedMember(name);
        expect((await execute(scope, membershipProfile)).membership).toBe(
          name === 'upgrade-existing' ? 'prior-entitlement-restored' : 'deactivated',
        );
        const [rows] = await connection.query<RowDataPacket[]>(
          'SELECT attribute,value,is_active,created_at,updated_at FROM user_eav WHERE entity=? ORDER BY attribute',
          [entity],
        );
        expect(rows).toEqual(
          vector.before
            .map((row) => ({ ...row, value: String(row.value) }))
            .sort((a, b) => a.attribute.localeCompare(b.attribute)),
        );
        if (name === 'upgrade-existing')
          expect(
            vector.originalCancelled.find((row) => row.attribute === 'EXCLUSIVE_MEMBER'),
          ).toMatchObject({ value: 3, is_active: 0 });
      }
    });
    it('refuses newer membership ownership even if an old state is later restored', async () => {
      const { scope, entity } = await stagedMember('upgrade-existing');
      await connection.execute(
        "UPDATE user_eav SET value='5',updated_at='2026-11-17 12:01:00' WHERE entity=? AND attribute='EXCLUSIVE_MEMBER'",
        [entity],
      );
      await expect(execute(scope, membershipProfile)).rejects.toMatchObject({
        code: 'CANCELLATION_MEMBERSHIP_RESTORATION_UNVERIFIED',
      });
      await connection.execute(
        'UPDATE pos_rewrite_membership_versions SET revision=revision+1 WHERE customer_id=?',
        [scope.customerId],
      );
      await connection.execute(
        "UPDATE user_eav SET value='6',updated_at='2025-01-01 00:00:00' WHERE entity=? AND attribute='EXCLUSIVE_MEMBER'",
        [entity],
      );
      await expect(execute(scope, membershipProfile)).rejects.toMatchObject({
        code: 'CANCELLATION_MEMBERSHIP_RESTORATION_UNVERIFIED',
      });
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT value,is_active FROM user_eav WHERE entity=? AND attribute=\'EXCLUSIVE_MEMBER\'",
        [entity],
      );
      expect(rows[0]).toMatchObject({ value: '6', is_active: 1 });
    });
    it('rejects missing, changed and unsealed membership proof and duplicate current email ownership', async () => {
      const raw = { ...(await order()), membership: true };
      await expect(execute(raw, membershipProfile)).rejects.toMatchObject({
        code: 'CANCELLATION_MEMBERSHIP_RESTORATION_UNVERIFIED',
      });
      const { scope, entity } = await stagedMember('new-activated');
      await connection.execute(
        "UPDATE pos_rewrite_cancellation_membership_provenance SET proof_hash=REPEAT('a',64) WHERE order_id=?",
        [scope.orderId],
      );
      await expect(execute(scope, membershipProfile)).rejects.toMatchObject({
        code: 'CANCELLATION_MEMBERSHIP_RESTORATION_UNVERIFIED',
      });
      const other = await stagedMember('new-activated');
      await fixture.insert('users', { id: ++next, email: other.entity.toUpperCase(), status: 1 });
      await expect(execute(other.scope, membershipProfile)).rejects.toMatchObject({
        code: 'CANCELLATION_MEMBERSHIP_RESTORATION_UNVERIFIED',
      });
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT is_active FROM user_eav WHERE entity=?',
        [entity],
      );
      expect(rows.every((row) => row.is_active === 1)).toBe(true);
    });
    it('rolls entitlement restoration and its monotonic revision back with a later financial failure', async () => {
      const { scope, entity } = await stagedMember('upgrade-existing');
      await expect(
        db.get('writer').transaction(async (tx) => {
          const plan = await lockCancellationBenefits(tx, scope, membershipProfile, secret);
          await applyCancellationBenefits(tx, plan);
          await tx.execute(
            sql`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='controlled membership rollback'`,
          );
        }),
      ).rejects.toThrow();
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT value,is_active FROM user_eav WHERE entity=? AND attribute='EXCLUSIVE_MEMBER'",
        [entity],
      );
      expect(rows[0]).toMatchObject({ value: '6', is_active: 1 });
      expect((await execute(scope, membershipProfile)).membership).toBe(
        'prior-entitlement-restored',
      );
    });
  },
);
