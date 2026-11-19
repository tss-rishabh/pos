import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  benefitOracleResult,
  type BenefitOracleCase,
} from '../../tools/checkout/benefit-oracle.js';
import { goldenStdout } from '../golden/load.js';

/** Replays tools/checkout/benefit_oracle.py output captured from the pinned source. */
function benefitOracle(
  cases: readonly BenefitOracleCase[],
  profile: 'legacy' | 'proposed-wallet-v1' = 'legacy',
) {
  if (!cases.length || cases.length > 1000) throw new Error('Bounded benefit cases required.');
  return benefitOracleResult.parse(
    JSON.parse(
      goldenStdout(
        'checkout',
        'global-benefit-source-mysql-integration',
        JSON.stringify({ cases, profile }),
      ),
    ) as unknown,
  );
}
import { planWalletAdjustment } from '../../src/modules/checkout/benefit-adjustments/policy.js';

const integration = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!integration)(
  'literal global-benefit SQL against verified strict-mode metadata',
  () => {
    let connection: mysql.Connection,
      schema = '';
    const userId = '9007199254740993',
      tables = [
        'users',
        'reward_point_history',
        'tss_money_history',
        'tss_point_history',
        'coupons',
        'gift_vouchers',
        'gift_voucher_history',
      ];
    async function rows(query: string) {
      const values = (await connection.query<mysql.RowDataPacket[]>(query))[0];
      for (const row of values) if (typeof row.count === 'string') row.count = Number(row.count);
      return values;
    }
    async function execute(queries: readonly string[]) {
      for (const query of queries) {
        if (/\btss\s*\./i.test(query))
          throw new Error('Source fixture refuses hardcoded database qualifiers.');
        await connection.query(query);
      }
    }
    const originalCase = (overrides: Partial<BenefitOracleCase> = {}): BenefitOracleCase => ({
      asset: 'money',
      amount: '25.50',
      platform: 'ORDER_REFUND',
      reason: 'Compensation',
      orderId: '9007199254740994',
      productId: '9007199254740995',
      balances: { money: 100, points: 100, cashback: 7 },
      ...overrides,
    });
    beforeAll(async () => {
      const url = new URL(integration!);
      if (
        url.protocol !== 'mysql:' ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.pathname !== '/pos_rewrite_checkout_test' ||
        url.search ||
        url.hash
      )
        throw new Error('Benefit checks refuse nonisolated database URLs.');
      connection = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
      schema = `pos_rewrite_checkout_test_benefit_${process.pid}_${randomUUID().slice(0, 8)}`;
      await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
      await connection.changeUser({ database: schema });
      await verifiedMysqlFixture(connection).create(tables);
      await connection.query(
        "SET SESSION sql_mode='STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
      );
    });
    beforeEach(async () => {
      for (const table of tables) await connection.query(`TRUNCATE TABLE ${mysql.escapeId(table)}`);
      await verifiedMysqlFixture(connection).insert('users', {
        id: userId,
        firstname: 'Fixture',
        lastname: 'Customer',
        email: 'fixture@example.test',
        tss_money: 100,
        tss_points: 100,
        cashback: 7,
      });
    });
    afterAll(async () => {
      if (connection) {
        if (/^pos_rewrite_checkout_test_benefit_\d+_[a-f0-9-]{8}$/.test(schema))
          await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
        await connection.end();
      }
    });

    it('proves the original Money action overwrites separate cashback on an enum-compatible path', async () => {
      const source = benefitOracle([originalCase()]).cases[0]!;
      await execute(source.queries);
      expect(
        (
          await rows(
            `SELECT CAST(tss_money AS DOUBLE) money,CAST(cashback AS DOUBLE) cashback FROM users WHERE id=${userId}`,
          )
        )[0],
      ).toMatchObject({ money: 125.5, cashback: 125.5 });
      expect((await rows('SELECT COUNT(*) count FROM reward_point_history'))[0]?.count).toBe(1);
    });

    it('proves wrong-ledger ENUM failure and the proposed proper-ledger credit preserves cashback', async () => {
      const source = benefitOracle([originalCase({ platform: 'ORDER_MONEY' })]).cases[0]!;
      await expect(execute(source.queries)).rejects.toMatchObject({ errno: 1265 });
      expect((await rows('SELECT COUNT(*) count FROM tss_money_history'))[0]?.count).toBe(0);
      const candidate = benefitOracle(
        [originalCase({ platform: 'ORDER_MONEY' })],
        'proposed-wallet-v1',
      ).cases[0]!;
      await execute(candidate.queries);
      expect(
        (
          await rows(
            `SELECT CAST(tss_money AS DOUBLE) money,CAST(cashback AS DOUBLE) cashback FROM users WHERE id=${userId}`,
          )
        )[0],
      ).toMatchObject({ money: 125.5, cashback: 7 });
      expect((await rows('SELECT COUNT(*) count FROM reward_point_history'))[0]?.count).toBe(0);
      expect(
        (await rows('SELECT order_id,product_id,platform,comment FROM tss_money_history'))[0],
      ).toMatchObject({
        order_id: '9007199254740994',
        product_id: '9007199254740995',
        platform: 'ORDER_MONEY',
        comment: 'Compensation',
      });
    });

    it('proves original Points binding fails strict BIGINT and the proposed fields retain exact references', async () => {
      const value = originalCase({ asset: 'points' });
      await expect(execute(benefitOracle([value]).cases[0]!.queries)).rejects.toMatchObject({
        errno: 1366,
      });
      expect((await rows('SELECT COUNT(*) count FROM tss_point_history'))[0]?.count).toBe(0);
      await execute(benefitOracle([value], 'proposed-wallet-v1').cases[0]!.queries);
      expect(
        (
          await rows('SELECT order_id,prod_id,platform,comment,added_amt FROM tss_point_history')
        )[0],
      ).toMatchObject({
        order_id: '9007199254740994',
        prod_id: '9007199254740995',
        platform: 'ORDER_REFUND',
        comment: 'Compensation',
        added_amt: 25.5,
      });
      expect(
        (
          await rows(
            `SELECT CAST(tss_points AS DOUBLE) points,CAST(cashback AS DOUBLE) cashback FROM users WHERE id=${userId}`,
          )
        )[0],
      ).toMatchObject({ points: 125.5, cashback: 7 });
    });

    it('does not silently map unsupported Points platform or empty explicit earning expiry', async () => {
      await expect(
        execute(
          benefitOracle(
            [originalCase({ asset: 'points', platform: 'DONATION_POINTS' })],
            'proposed-wallet-v1',
          ).cases[0]!.queries,
        ),
      ).rejects.toMatchObject({ errno: 1265 });
      await expect(
        execute(
          benefitOracle([originalCase({ expiry: '' })], 'proposed-wallet-v1').cases[0]!.queries,
        ),
      ).rejects.toMatchObject({ errno: 1292 });
      expect((await rows('SELECT COUNT(*) count FROM tss_point_history'))[0]?.count).toBe(0);
      expect((await rows('SELECT COUNT(*) count FROM tss_money_history'))[0]?.count).toBe(0);
    });

    it('proves global voucher omission and GV_ADD ENUM failures without inventing validity/defaults', async () => {
      const source = benefitOracle([originalCase({ asset: 'voucher', amount: '100' })]).cases[0]!;
      // The first literal INSERT fails before the source's hardcoded tss.coupons lookup.
      await expect(execute([source.queries[0]!])).rejects.toMatchObject({ errno: 1364 });
      await expect(
        connection.query("INSERT INTO gift_voucher_history(user_id,platform) VALUES(?, 'GV_ADD')", [
          userId,
        ]),
      ).rejects.toMatchObject({ errno: 1265 });
      expect((await rows('SELECT COUNT(*) count FROM coupons'))[0]?.count).toBe(0);
      expect((await rows('SELECT COUNT(*) count FROM gift_vouchers'))[0]?.count).toBe(0);
    });

    it('preserves source DOUBLE FIFO writes and native FLOAT balance on a coherent debit', async () => {
      const histories = [
        {
          id: '9007199254740996',
          added_amt: 0.145,
          used_amt: 0.005,
          created_at: '2026-01-01 00:00:00',
        },
        { id: '9007199254740997', added_amt: 200, used_amt: 0, created_at: '2026-01-02 00:00:00' },
      ];
      for (const history of histories)
        await connection.query(
          'INSERT INTO tss_money_history(id,user_id,added_amt,used_amt,created_at,is_expired) VALUES(?,?,?,?,?,0)',
          [history.id, userId, history.added_amt, history.used_amt, history.created_at],
        );
      const value = originalCase({ operation: 0, amount: '10.21', histories });
      await execute(benefitOracle([value], 'proposed-wallet-v1').cases[0]!.queries);
      const planned = planWalletAdjustment(
        {
          asset: 'money',
          direction: 'subtract',
          amount: '10.21',
          platform: 'ORDER_REFUND',
          reason: 'Compensation',
          orderId: '9007199254740994',
          productId: '9007199254740995',
          expiry: '2026-12-31',
        },
        { money: 100, points: 100, cashback: 7 },
        histories.map((history) => ({
          id: history.id,
          addedAmount: history.added_amt,
          usedAmount: history.used_amt,
          isExpired: false,
          createdAt: history.created_at,
        })),
      );
      expect(
        (
          await rows(
            `SELECT CAST(tss_money AS DOUBLE) money,CAST(cashback AS DOUBLE) cashback FROM users WHERE id=${userId}`,
          )
        )[0],
      ).toMatchObject({ money: planned.storedAfter, cashback: 7 });
      for (const row of planned.consumed)
        expect(
          (await rows(`SELECT used_amt FROM tss_money_history WHERE id=${row.historyId}`))[0]
            ?.used_amt,
        ).toBe(row.usedAmount);
    });
  },
);
