import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { installNativeHeadFixture } from '../native-head-metadata/fixture.js';
import { couponHistorySourceCapture } from '../../src/modules/legacy-order-imports/benefit-profile/history-source.js';
import { couponWarehouseSourceControls } from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-source.js';
import { couponHistoryWriterDefinitions } from '../../src/modules/legacy-order-imports/benefit-profile/history-writers.js';
import {
  couponComparisonFingerprint,
  couponComparisonSchema,
  verifyCouponWarehouseControls,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-contracts.js';
import type { CouponHistoryScope } from '../../src/modules/legacy-order-imports/benefit-profile/history.js';
import { importFinancialFixture } from '../legacy-import-financial/fixture.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { literalCouponFacts } from './warehouse-fixtures.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL,
  key = 'native-coupon-controls-fixture-key-'.repeat(3);
describe.skipIf(!template)('qualification-only native coupon control projection', () => {
  let f: Awaited<ReturnType<typeof importFinancialFixture>>,
    heads: Awaited<ReturnType<typeof installNativeHeadFixture>>,
    comparison: ReturnType<typeof couponComparisonSchema.parse>,
    native: ReturnType<typeof verifiedMysqlFixture>,
    scope: CouponHistoryScope;
  const capture = () =>
    couponHistorySourceCapture(heads.sourceDb, {
      headMetadata: heads.headMetadata,
      contract: 'pos-csv-coupon-source-capture-v1',
      sourceKey: key,
      sourceTimeZone: 'Asia/Kolkata',
    }).capture(scope);
  const controls = (maxControls = 10000) =>
    couponWarehouseSourceControls(
      heads.sourceDb,
      { sourceKey: key, comparisonFingerprint: couponComparisonFingerprint(comparison) },
      { maxControls, headMetadata: heads.headMetadata },
    );
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
    const [raw] = await f.connection.query(
      "SELECT c.COLUMN_NAME AS `column`,c.DATA_TYPE AS dataType,c.CHARACTER_SET_NAME AS characterSet,c.COLLATION_NAME AS collation,k.PAD_ATTRIBUTE AS padAttribute FROM information_schema.COLUMNS c JOIN information_schema.COLLATIONS k ON k.COLLATION_NAME=c.COLLATION_NAME WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME='coupons' AND c.COLUMN_NAME IN('coupon_lot_no','voucher_code')",
    );
    const columns = z.array(z.record(z.string(), z.unknown())).parse(raw);
    comparison = couponComparisonSchema.parse({
      contract: 'pos-native-coupon-comparisons-v1',
      lot: columns.find((row) => row.column === 'coupon_lot_no'),
      code: columns.find((row) => row.column === 'voucher_code'),
      lotComparison: 'native-column-equality-and-nonempty',
      codeComparison: 'python-decoded-exact-utf8',
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
    for (const [id, code, lot] of [
      [222, 'SYNTHETIC_BIRTHDAY', 'FixtureLot'],
      [223, 'synthetic_birthday', 'fixturelot '],
      [224, 'SYNTHETIC_BIRTHDAY ', 'FixtureLot'],
    ] as const)
      await native.insert('coupons', {
        id,
        voucher_code: code,
        voucher_type: '1',
        voucher_val: 10,
        voucher_valid_for: 1,
        platform: 'offline',
        no_times_allowed: 1000,
        unique_no_times_allowed: 10,
        coupon_lot_no: lot,
        start_date: '2020-01-01 00:00:00',
        end_date: '2035-01-01 00:00:00',
        is_deleted: 0,
        for_new_user: 0,
        user_specific: 0,
      });
    await f.connection.query(
      "INSERT IGNORE INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision) VALUES('controls','0',1),('coupon','222',0),('customer','77',0)",
    );
    scope = {
      contract: 'pos-csv-coupon-history-v1',
      operationId: randomUUID(),
      requestHash: 'a'.repeat(64),
      planHash: 'b'.repeat(64),
      customerId: '77',
      couponId: '222',
      configurationHash: 'c'.repeat(64),
      asOf: Temporal.Now.zonedDateTimeISO('Asia/Kolkata')
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' })
        .replace('T', ' '),
      sourceTimeZone: 'Asia/Kolkata',
    };
  });
  async function order(id: string, couponId: string, date = scope.asOf, status = 1, userId = '77') {
    await f.fixture.insert('orders', {
      id,
      user_id: userId,
      coupon_used: couponId,
      order_status: status,
      created_at: date,
      updated_at: date,
      payment_method: 14,
    });
  }
  async function log(id: string, couponId: string, date = scope.asOf) {
    await native.insert('order_coupon_log', {
      id,
      user_id: '77',
      order_id: '999999',
      coupon_id: couponId,
      status: 1,
      created_at: date,
      updated_at: date,
    });
  }
  it('authenticates native case/PAD SPACE lot flags, exact decoded code inequality, zero and orphan controls without raw coupon strings', async () => {
    await order('5001', '222');
    await order('5002', '0');
    await log('101', '223');
    await log('102', '224');
    await log('103', '999');
    const source = await capture(),
      result = await controls().capture(source);
    expect(result.rows).toEqual([
      {
        couponId: '0',
        present: false,
        lotMatches: false,
        sameCode: false,
        noTimesAllowed: null,
        uniqueNoTimesAllowed: null,
      },
      {
        couponId: '222',
        present: true,
        lotMatches: true,
        sameCode: true,
        noTimesAllowed: '1000',
        uniqueNoTimesAllowed: '10',
      },
      {
        couponId: '223',
        present: true,
        lotMatches: true,
        sameCode: false,
        noTimesAllowed: '1000',
        uniqueNoTimesAllowed: '10',
      },
      {
        couponId: '224',
        present: true,
        lotMatches: true,
        sameCode: false,
        noTimesAllowed: '1000',
        uniqueNoTimesAllowed: '10',
      },
      {
        couponId: '999',
        present: false,
        lotMatches: false,
        sameCode: false,
        noTimesAllowed: null,
        uniqueNoTimesAllowed: null,
      },
    ]);
    expect(result.manifest.comparison).toEqual(comparison);
    expect(
      verifyCouponWarehouseControls(
        result.manifest,
        source,
        result.rows,
        key,
        couponComparisonFingerprint(comparison),
      ).rows,
    ).toEqual(result.rows);
    expect(JSON.stringify(result)).not.toMatch(
      /SYNTHETIC_BIRTHDAY|synthetic_birthday|FixtureLot|fixturelot/,
    );
  });
  it('primitive projections independently reproduce literal native five-query facts including unrelated global usage and multiplicative logs', async () => {
    const point = Temporal.PlainDateTime.from(scope.asOf.replace(' ', 'T')),
      future = point.add({ years: 2 }).toString({ smallestUnit: 'second' }).replace('T', ' ');
    await order('5001', '222');
    await order('5002', '222', scope.asOf, 4);
    await order('5003', '222', '2010-01-01 00:00:00', 6);
    await order('5004', '223', future);
    await order('5005', '222', future, 1, '88');
    await log('101', '222');
    await log('102', '222');
    await log('103', '222');
    await log('104', '223', future);
    const source = await capture(),
      projected = await controls().capture(source);
    const facts = literalCouponFacts(
      scope,
      [
        { orderId: '5001', userId: '77', couponId: '222', status: 1, createdAt: scope.asOf },
        { orderId: '5002', userId: '77', couponId: '222', status: 4, createdAt: scope.asOf },
        {
          orderId: '5003',
          userId: '77',
          couponId: '222',
          status: 6,
          createdAt: '2010-01-01 00:00:00',
        },
        { orderId: '5004', userId: '77', couponId: '223', status: 1, createdAt: future },
        { orderId: '5005', userId: '88', couponId: '222', status: 1, createdAt: future },
      ],
      ['101', '102', '103', '104'].map((logId, index) => ({
        logId,
        userId: '77',
        couponId: index === 3 ? '223' : '222',
        status: 1,
        createdAt: index === 3 ? future : scope.asOf,
      })),
      projected.rows,
    );
    expect(facts).toEqual(source.facts);
    expect(facts.monthlyJoinedUsage).toBe('9');
    expect(facts.globalUsage).toBe('3');
    expect(facts.lotCounts[1]!.usedCount).toBe('1');
  });
  it('refuses changed heads between source capture and control publication, including a rolled-back writer producing no false change', async () => {
    await order('5001', '222');
    const source = await capture();
    await f.connection.beginTransaction();
    await f.connection.query('UPDATE orders SET order_status=0 WHERE id=5001');
    await f.connection.rollback();
    await expect(controls().capture(source)).resolves.toBeDefined();
    await f.connection.query('UPDATE orders SET order_status=0 WHERE id=5001');
    await expect(controls().capture(source)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_COUPON_PUBLICATION_CONTROLS_SOURCE_CHANGED',
    });
  });
  it('refuses an unqualified native collation fingerprint and an incomplete bounded control set', async () => {
    await order('5001', '222');
    await log('101', '223');
    const source = await capture();
    await expect(
      couponWarehouseSourceControls(
        heads.sourceDb,
        {
          sourceKey: key,
          comparisonFingerprint: '0'.repeat(64),
        },
        { headMetadata: heads.headMetadata },
      ).capture(source),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_COUPON_PUBLICATION_COMPARISON_UNQUALIFIED' });
    await expect(controls(1).capture(source)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_COUPON_PUBLICATION_CONTROLS_TOO_LARGE',
    });
  });
  it('checks actual participating writer bodies before signing, with no constructor reads or row writes', async () => {
    const get = vi.spyOn(heads.sourceDb, 'get');
    controls();
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
    const source = await capture(),
      row = couponHistoryWriterDefinitions[0]!;
    const [definition] = await f.connection.query('SHOW CREATE TRIGGER ' + row.name);
    const original = z
      .array(z.object({ 'SQL Original Statement': z.string() }))
      .length(1)
      .parse(definition)[0]!['SQL Original Statement'];
    await f.connection.query('DROP TRIGGER ' + row.name);
    try {
      await expect(controls().capture(source)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_COUPON_PUBLICATION_WRITERS_UNQUALIFIED',
      });
    } finally {
      await f.connection.query(original);
    }
  });
});
