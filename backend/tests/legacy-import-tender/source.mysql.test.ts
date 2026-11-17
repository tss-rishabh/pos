import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { importFinancialFixture } from '../legacy-import-financial/fixture.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { readNativeCsvTenderFacts } from '../../src/modules/legacy-order-imports/tender-profile/native.js';
import {
  reviewOriginalCsvTender,
  sourceTenderUnitSequenceHash,
  tenderRowsSchema,
} from '../../src/modules/legacy-order-imports/tender-profile/domain.js';
import { Decimal } from 'decimal.js';

const sourceResult = z.looseObject({
  vector: z.string(),
  lineItems: z.boolean(),
  payment: z.string(),
  sourceTender: z.object({
    cash: z.number(),
    cashReceived: z.number(),
    manualOther: z.number(),
    rawTender: z.string(),
    date: z.string(),
    others: z.boolean(),
  }),
  sourceRows: tenderRowsSchema,
  order: z.looseObject({
    id: z.number(),
    payable: z.string(),
    fraction: z.string(),
    amount: z.string(),
    coupon_amount: z.string().nullable(),
    ref_flag: z.number(),
    order_status: z.number(),
    payment_status: z.number(),
    created_at: z.string(),
  }),
  counter: z.object({
    cash: z.string(),
    received: z.string(),
    online: z.string(),
    manual_other: z.string(),
    change_amount: z.string(),
  }),
  lines: z.array(
    z.looseObject({
      id: z.number(),
      prod_id: z.string(),
      qty: z.number(),
      status: z.string(),
      price: z.number(),
      disc: z.number(),
      gst: z.number(),
      pre_gst_amt: z.string(),
      final_payable: z.string(),
      amount_to_be_refunded: z.number(),
      fraction_value: z.number(),
    }),
  ),
  ledger: z.object({
    order_status: z.number(),
    payment_status: z.number(),
    pay_dict: z.record(z.string(), z.number()),
    created_at: z.string(),
  }),
  refundOriginal: z.looseObject({ coherent: z.boolean() }),
  refundApproved: z.looseObject({ coherent: z.boolean() }),
  dayClose: z.looseObject({
    order_count: z.number(),
    cash: z.number(),
    card_upi: z.number(),
    online_other: z.number(),
  }),
  cashLedger: z.object({
    liveSales: z.string(),
    hypotheticalClosedSales: z.string(),
    hypotheticalClosingBalance: z.string(),
  }),
  dsr: z.array(
    z.looseObject({
      order_count: z.number(),
      cash_total: z.number(),
      total_online: z.number(),
      revenue: z.union([z.string(), z.number().finite()]),
    }),
  ),
  confirmationBoundary: z.literal('seeded-source-post-confirmation'),
});

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)(
  'literal fractional CSV tender / native header / refund / report evidence',
  () => {
    let f: Awaited<ReturnType<typeof importFinancialFixture>>;
    let source: ReturnType<typeof verifiedMysqlFixture>;
    const tables = [
      'cities',
      'zones',
      'pricelist',
      'pricelist_meta',
      'has_categories',
      'has_addresses',
      'order_address_mapping',
      'flag_history',
      'order_cancel_message_mapping',
      'order_attributes',
      'payment_status',
      'exchange_order_log',
      'coupons',
      'return_orders',
    ];
    beforeAll(async () => {
      f = await importFinancialFixture(template!);
      source = verifiedMysqlFixture(f.connection, [
        'evidence/mysql-order-import-address-schema.json',
        'evidence/mysql-global-benefits-schema.json',
      ]);
      await source.create(tables);
    }, 30000);
    afterAll(async () => {
      await f?.close();
    });
    beforeEach(async () => {
      await f.reset();
      for (const table of tables) await f.connection.query('DELETE FROM `' + table + '`');
      await f.connection.query('ALTER TABLE orders AUTO_INCREMENT=20000001');
      await f.connection.query('ALTER TABLE has_products AUTO_INCREMENT=60000001');
      await source.insert('cities', { id: 10, city_name: 'Fixture city', state_id: 20 });
      await source.insert('zones', { id: 20, name: 'Fixture state' });
      await f.connection.query(
        "UPDATE stores SET city_id=10,store_name='Fixture store',address='Fixture address',alt_address='',phone='9000000000',pincode='400001' WHERE id=1",
      );
      await f.connection.query(
        "UPDATE users SET firstname='Fixture',lastname='Import',cashback=0,tss_money=0,tss_points=0 WHERE id=77",
      );
      await f.connection.query(
        'UPDATE products SET price=100,spl_price=0,cog=0,parent_prod_id=0 WHERE id=9007199254740993',
      );
      await f.fixture.insert('products', {
        id: '9007199254740994',
        prod_type: 1,
        parent_prod_id: 0,
        price: 100,
        spl_price: 0,
        cog: 0,
      });
      await source.insert('pricelist_meta', { id: 1, is_active: 1 });
      await source.insert('has_addresses', { id: 88, user_id: 77 });
      await source.insert('payment_status', { id: 4, payment_status: 'Paid' });
      await source.insert('coupons', {
        id: 222,
        voucher_type: 1,
        voucher_code: 'FIXTURE_BIRTHDAY',
        start_date: '2026-01-01 00:00:00',
        end_date: '2026-12-31 23:59:59',
        created_at: '2026-06-15 00:00:00',
        updated_at: '2026-06-15 00:00:00',
      });
    });
    function run(vector: string, lineItems = false, payment: 'cash' | 'Card' = 'cash') {
      const result: unknown = JSON.parse(
        execFileSync(
          resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
          [
            '-B',
            resolve('compatibility/upstream/legacy-order-imports/tender-profile/native_vector.py'),
          ],
          {
            input: JSON.stringify({ url: f.config.MYSQL_WRITER_URL, vector, lineItems, payment }),
            encoding: 'utf8',
            timeout: 20000,
            maxBuffer: 256000,
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
          },
        ),
      );
      const failure = z
        .object({ oracleError: z.record(z.string(), z.unknown()) })
        .safeParse(result);
      expect(failure.success ? failure.data.oracleError : null).toBeNull();
      return sourceResult.parse(result);
    }
    it('preserves original collected cash while header, refund and report residual remain different', () => {
      const result = run('fraction-two');
      expect(result.order).toMatchObject({
        payable: '50',
        fraction: '0.98',
        payment_status: 4,
        order_status: 3,
      });
      expect(result.counter).toEqual({
        cash: '50.98',
        received: '50.98',
        online: '0',
        manual_other: '0',
        change_amount: '0',
      });
      expect(
        result.lines.map((row) => ({
          quantity: row.qty,
          status: row.status,
          refundable: row.amount_to_be_refunded,
        })),
      ).toEqual([{ quantity: 2, status: 'PLACED', refundable: 50 }]);
      expect(result.ledger.pay_dict).toEqual({
        'cash payment': 50.98,
        'online payment': 0,
        'total amount on counter': 50.98,
      });
      expect(result.dayClose).toMatchObject({ order_count: 1, cash: 50.98, online_other: 0 });
      expect(result.dsr[0]?.total_online).toBeCloseTo(-0.98, 10);
      expect(result.refundApproved.coherent).toBe(true);
    }, 30000);
    const vectors = [
      { id: 'integer', payable: '100', fraction: '0', tender: 100, coupon: 0 },
      { id: 'fraction-two', payable: '50', fraction: '0.98', tender: 50.98, coupon: 0 },
      { id: 'float-drift', payable: '1', fraction: '0', tender: 0.9999999999999999, coupon: 0 },
      { id: 'mixed-drift', payable: '100', fraction: '0', tender: 100, coupon: 0 },
      { id: 'inclusive-gst', payable: '748', fraction: '0.5', tender: 748.5, coupon: 0 },
      { id: 'app-percent', payable: '95', fraction: '0', tender: 100, coupon: 0 },
      { id: 'birthday-percent', payable: '90', fraction: '0', tender: 100, coupon: 10 },
      { id: 'birthday-fraction', payable: '45', fraction: '0.89', tender: 50.98, coupon: 5.1 },
      { id: 'birthday-full', payable: '0', fraction: '0', tender: 100, coupon: 100 },
      { id: 'app-gst', payable: '285', fraction: '0.98', tender: 301.02000000000004, coupon: 0 },
    ];
    it.each(
      vectors.flatMap((vector) =>
        [false, true].flatMap((lineItems) =>
          (['cash', 'Card'] as const).map((payment) => ({ vector, lineItems, payment })),
        ),
      ),
    )(
      'executes $vector.id / lineItems=$lineItems / $payment without inventing change or report receipts',
      async ({ vector, lineItems, payment }) => {
        const result = run(vector.id, lineItems, payment),
          isCash = payment === 'cash';
        expect(result.order).toMatchObject({
          payable: vector.payable,
          fraction: vector.fraction,
          payment_status: 4,
          order_status: 3,
          created_at: '2026-06-15 12:00:00',
        });
        expect(Number(result.order.coupon_amount ?? 0)).toBe(vector.coupon);
        expect(result.order.ref_flag).toBe(0);
        expect(result.lines.every((row) => row.status === 'PLACED')).toBe(true);
        expect(result.counter.change_amount).toBe('0');
        expect(Number(result.counter.cash)).toBe(isCash ? vector.tender : 0);
        expect(Number(result.counter.received)).toBe(isCash ? vector.tender : 0);
        expect(Number(result.counter.manual_other)).toBe(isCash ? 0 : vector.tender);
        expect(result.ledger).toMatchObject({
          order_status: 3,
          payment_status: 4,
          created_at: '2026-06-15 12:00:00',
        });
        expect(result.ledger.pay_dict['total amount on counter']).toBe(vector.tender);
        expect(result.dayClose).toMatchObject({
          order_count: 1,
          cash: isCash ? vector.tender : 0,
          online_other: isCash ? 0 : vector.tender,
        });
        const currencyCash = new Decimal(isCash ? String(vector.tender) : '0').toFixed(2);
        expect(result.cashLedger).toEqual({
          liveSales: currencyCash,
          hypotheticalClosedSales: currencyCash,
          hypotheticalClosingBalance: currencyCash,
        });
        expect(result.dsr).toHaveLength(1);
        expect(result.dsr[0]!.total_online).toBeCloseTo(
          Number(vector.payable) - (isCash ? vector.tender : 0),
          10,
        );
        expect(result.refundApproved.coherent).toBe(true);
        expect(
          result.lines.reduce((total, row) => total + row.amount_to_be_refunded, 0),
        ).toBeCloseTo(Number(vector.payable), 3);
        const native = await f.db
          .get('writer')
          .transaction((tx) => readNativeCsvTenderFacts(tx, String(result.order.id)));
        const declared = result.sourceRows
          .reduce(
            (sum, row) => sum.plus(new Decimal(row.unitPrice).mul(row.quantity)),
            new Decimal(0),
          )
          .toFixed(2);
        const candidate = reviewOriginalCsvTender({
          operationId: '4c3fadfb-29ce-480b-b9f4-5129a36c5b91',
          planHash: 'a'.repeat(64),
          sourceUnitSequenceHash: sourceTenderUnitSequenceHash(result.sourceRows),
          rows: result.sourceRows,
          declaredTender: declared,
          originalSourceTenderRaw: result.sourceTender.rawTender,
          mode: isCash ? 'cash' : 'manual-other',
          native,
        });
        expect(candidate.financiallyExecutable).toBe(false);
        expect(candidate.providerAction).toBe('none');
        expect(candidate.cashOutAction).toBe('none');
        expect(candidate.change).toBe('0.00');
        expect(candidate.amounts.sourcePayable).toBe(Number(vector.payable).toFixed(2));
        expect(candidate.candidateDsr.cash).toBe(isCash ? declared : '0.00');
        expect(candidate.candidateDsr.online).toBe(isCash ? '0.00' : declared);
        expect(
          new Decimal(candidate.sourceDsr.onlineResidual)
            .plus(candidate.amounts.unexplainedDifference)
            .toFixed(2),
        ).toBe(candidate.candidateDsr.online);
        expect(
          new Decimal(candidate.candidateDsr.cash)
            .plus(candidate.candidateDsr.online)
            .minus(candidate.amounts.sourcePayable)
            .toFixed(2),
        ).toBe(candidate.amounts.unexplainedDifference);
        expect(candidate.orderHeaderAction).toBe('preserve');
        expect(candidate.refundAllocationAction).toBe('preserve');
      },
      30000,
    );
  },
);
