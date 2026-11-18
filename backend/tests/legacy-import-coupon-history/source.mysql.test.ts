import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { installNativeHeadFixture } from '../native-head-metadata/fixture.js';
import { couponHistorySourceCapture } from '../../src/modules/legacy-order-imports/benefit-profile/history-source.js';
import { couponHistoryWriterDefinitions } from '../../src/modules/legacy-order-imports/benefit-profile/history-writers.js';
import {
  couponControlHeadHash,
  couponSourceCaptureContract,
  verifyCouponSourceCapture,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-publication.js';
import type { CouponHistoryScope } from '../../src/modules/legacy-order-imports/benefit-profile/history.js';
import { importFinancialFixture } from '../legacy-import-financial/fixture.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL,
  key = 'isolated-native-coupon-history-source-'.repeat(3);
describe.skipIf(!template)(
  'independent coupon source publisher on owned native MySQL fixture',
  () => {
    let f: Awaited<ReturnType<typeof importFinancialFixture>>,
      heads: Awaited<ReturnType<typeof installNativeHeadFixture>>,
      native: ReturnType<typeof verifiedMysqlFixture>,
      scope: CouponHistoryScope;
    const producer = () =>
      couponHistorySourceCapture(heads.sourceDb, {
        headMetadata: heads.headMetadata,
        contract: couponSourceCaptureContract,
        sourceKey: key,
        sourceTimeZone: 'Asia/Kolkata',
      });
    beforeAll(async () => {
      f = await importFinancialFixture(template!);
      native = verifiedMysqlFixture(f.connection, [
        'evidence/mysql-import-benefit-profile-schema.json',
        'evidence/mysql-customer-contact-schema.json',
        'evidence/mysql-global-benefits-schema.json',
      ]);
      await native.create(['coupons', 'order_coupon_log']);
      heads = await installNativeHeadFixture(f.connection, template!, {
        families: ['membership', 'coupon'],
      });
    }, 30000);
    afterAll(async () => {
      await heads?.cleanup();
      await f?.close();
    });
    beforeEach(async () => {
      await f.reset();
      await f.connection.query('DELETE FROM order_coupon_log');
      await f.connection.query('DELETE FROM coupons');
      await f.connection.query('DELETE FROM pos_rewrite_coupon_history_heads');
      await native.insert('coupons', {
        id: 222,
        voucher_code: 'SYNTHETIC_BIRTHDAY',
        voucher_type: '1',
        voucher_val: 10,
        voucher_valid_for: 1,
        platform: 'offline',
        no_times_allowed: 1000,
        unique_no_times_allowed: 10,
        coupon_lot_no: 'FixtureLot',
        start_date: '2020-01-01 00:00:00',
        end_date: '2035-01-01 00:00:00',
        is_deleted: 0,
        for_new_user: 0,
        user_specific: 0,
      });
      await native.insert('coupons', {
        id: 223,
        voucher_code: 'synthetic_birthday',
        voucher_type: '1',
        voucher_val: 10,
        voucher_valid_for: 1,
        platform: 'offline',
        no_times_allowed: 1000,
        unique_no_times_allowed: 11,
        coupon_lot_no: 'fixturelot ',
        start_date: '2020-01-01 00:00:00',
        end_date: '2035-01-01 00:00:00',
        is_deleted: 0,
        for_new_user: 0,
        user_specific: 0,
      });
      // Seed only this disposable fixture's known identities. The production
      // migration parser intentionally refuses the review-only legacy backfill.
      await f.connection
        .query(`INSERT IGNORE INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision)
      VALUES('controls','0',1),('coupon','222',0),('customer','77',0)`);
      const point = Temporal.Now.zonedDateTimeISO('Asia/Kolkata')
        .toPlainDateTime()
        .round({ smallestUnit: 'second', roundingMode: 'floor' });
      scope = {
        contract: 'pos-csv-coupon-history-v1',
        operationId: randomUUID(),
        requestHash: 'a'.repeat(64),
        planHash: 'b'.repeat(64),
        customerId: '77',
        couponId: '222',
        configurationHash: 'c'.repeat(64),
        asOf: point.toString({ smallestUnit: 'second' }).replace('T', ' '),
        sourceTimeZone: 'Asia/Kolkata',
      };
    });
    async function order(id: string, status: number | null, coupon = '222', date = scope.asOf) {
      await f.fixture.insert('orders', {
        id,
        user_id: '77',
        coupon_used: coupon,
        order_status: status,
        created_at: date,
        updated_at: date,
        payment_method: 14,
      });
    }
    async function log(id: string, coupon = '222', date = scope.asOf, status = 1) {
      await native.insert('order_coupon_log', {
        id,
        user_id: '77',
        order_id: '999999',
        coupon_id: coupon,
        status,
        created_at: date,
        updated_at: date,
      });
    }
    async function literalCounts() {
      const point = Temporal.PlainDateTime.from(scope.asOf.replace(' ', 'T')),
        queries: [string, unknown[]][] = [
          [
            'SELECT CAST(COUNT(1) AS CHAR) AS value FROM orders o WHERE o.order_status NOT IN (0,4,7,15,17,22,31,33) AND o.coupon_used=?',
            [scope.couponId],
          ],
          [
            'SELECT CAST(COUNT(id) AS CHAR) AS value FROM orders WHERE DATE(created_at)=? AND order_status NOT IN (0,17) AND user_id=? AND coupon_used=?',
            [point.toPlainDate().toString(), scope.customerId, scope.couponId],
          ],
          [
            'SELECT CAST(COUNT(id) AS CHAR) AS value FROM orders WHERE user_id=? AND order_status NOT IN (0,17)',
            [scope.customerId],
          ],
          [
            'SELECT CAST(COUNT(ocl.id) AS CHAR) AS value FROM order_coupon_log ocl JOIN orders o ON ocl.user_id=o.user_id AND ocl.coupon_id=o.coupon_used AND o.order_status NOT IN (0,17) WHERE MONTH(ocl.created_at)=? AND YEAR(ocl.created_at)=? AND ocl.user_id=? AND ocl.coupon_id=? AND ocl.status=1',
            [point.month, point.year, scope.customerId, scope.couponId],
          ],
        ];
      const counts: string[] = [];
      for (const [query, params] of queries) {
        const [rows] = await f.connection.query(query, params);
        counts.push(
          z
            .array(z.object({ value: z.string() }))
            .length(1)
            .parse(rows)[0]!.value,
        );
      }
      return {
        globalUsage: counts[0],
        birthdayTodayUsage: counts[1],
        customerOrderCount: counts[2],
        monthlyJoinedUsage: counts[3],
      };
    }
    it('captures explicitly proved zero counts without altering heads or financial records', async () => {
      const before = await f.connection.query(
          'SELECT * FROM pos_rewrite_coupon_history_heads ORDER BY kind,scope_id',
        ),
        result = await producer().capture(scope),
        after = await f.connection.query(
          'SELECT * FROM pos_rewrite_coupon_history_heads ORDER BY kind,scope_id',
        );
      expect(result.facts).toEqual({
        globalUsage: '0',
        birthdayTodayUsage: '0',
        customerOrderCount: '0',
        monthlyJoinedUsage: '0',
        lotCounts: [],
      });
      expect(after[0]).toEqual(before[0]);
      expect(verifyCouponSourceCapture(result, key)).toEqual(result);
    });
    it('preserves literal join multiplication and exact source code equality while lot equality uses native collation', async () => {
      await order('9007199254740993', 1);
      await order('9007199254740994', 4);
      await order('9007199254740995', 6);
      await log('101');
      await log('102');
      await log('103');
      await order('9007199254740996', 1, '223');
      await log('104', '223');
      const result = await producer().capture(scope);
      expect(result.facts).toMatchObject(await literalCounts());
      expect(result.facts.monthlyJoinedUsage).toBe('9');
      expect(result.facts.lotCounts).toEqual([
        {
          couponId: '222',
          sameCode: true,
          noTimesAllowed: '1000',
          uniqueNoTimesAllowed: '10',
          usedCount: '9',
        },
        {
          couponId: '223',
          sameCode: false,
          noTimesAllowed: '1000',
          uniqueNoTimesAllowed: '11',
          usedCount: '1',
        },
      ]);
    });
    it('matches DATE/MONTH source predicates for null/status exclusions, old and already-present future orders', async () => {
      const point = Temporal.PlainDateTime.from(scope.asOf.replace(' ', 'T'));
      for (const [index, status] of [0, 4, 7, 15, 17, 22, 31, 33, null, 1, 6].entries()) {
        if (status === null)
          await expect(order(String(5000 + index), status)).rejects.toMatchObject({
            code: 'ER_BAD_NULL_ERROR',
          });
        else await order(String(5000 + index), status);
      }
      await order(
        '6001',
        1,
        '222',
        point.add({ days: 1 }).toString({ smallestUnit: 'second' }).replace('T', ' '),
      );
      await order('6002', 1, '222', '2015-01-01 12:00:00');
      await log('101');
      await log(
        '102',
        '222',
        point
          .with({ day: 1 })
          .subtract({ months: 1 })
          .toString({ smallestUnit: 'second' })
          .replace('T', ' '),
      );
      await log('103', '222', scope.asOf, 0);
      const result = await producer().capture(scope);
      expect(result.facts).toMatchObject(await literalCounts());
      expect(result.facts.globalUsage).toBe('4');
      expect(result.facts.birthdayTodayUsage).toBe('8');
    });
    it('authenticates changed native heads and rolls every head mutation back with its writer transaction', async () => {
      await order('5001', 1);
      const first = await producer().capture(scope);
      await f.connection.beginTransaction();
      await f.connection.query('UPDATE orders SET order_status=0 WHERE id=5001');
      await f.connection.rollback();
      const rolledBack = await producer().capture(scope);
      expect(rolledBack.facts).toEqual(first.facts);
      expect(rolledBack.controlHeadHash).toBe(first.controlHeadHash);
      await f.connection.query('UPDATE orders SET order_status=0 WHERE id=5001');
      const changed = await producer().capture(scope);
      expect(changed.facts.globalUsage).toBe('0');
      expect(changed.controlHeadHash).not.toBe(first.controlHeadHash);
      expect(couponControlHeadHash(changed, key)).toBe(changed.controlHeadHash);
    });
    it('does no constructor I/O and refuses a missing participating-writer trigger before signing', async () => {
      const get = vi.spyOn(heads.sourceDb, 'get');
      producer();
      expect(get).not.toHaveBeenCalled();
      get.mockRestore();
      const row = couponHistoryWriterDefinitions[0]!;
      const [definition] = await f.connection.query('SHOW CREATE TRIGGER ' + row.name);
      const original = z
        .array(z.object({ 'SQL Original Statement': z.string() }))
        .length(1)
        .parse(definition)[0]!['SQL Original Statement'];
      await f.connection.query('DROP TRIGGER ' + row.name);
      try {
        await expect(producer().capture(scope)).rejects.toMatchObject({
          code: 'ORDER_IMPORT_COUPON_PUBLICATION_WRITERS_UNQUALIFIED',
        });
      } finally {
        await f.connection.query(original);
      }
    });
  },
);
