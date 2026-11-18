import { executePosSourceOracle } from '../../tools/operational-reports/source-python.js';
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import {
  flashSalesReportService,
  flashSalesInputSchema,
  flashSalesOptions,
  prepareFlashSales,
  flashSalesCsv,
  type FlashSalesSourceRow,
  type FlashRefundRow,
} from '../../src/modules/operational-reports/flash-sales.js';
const sample = (overrides: Partial<FlashSalesSourceRow> = {}): FlashSalesSourceRow => ({
  StoreName: 'Fixture store',
  date: '2026-11-16',
  total_number_of_bills: 2,
  total_order_qty: 4,
  total_tss_money: 12.345,
  total_tss_points: 2.675,
  total_coupon: 1.005,
  total_gift_voucher: 3,
  total_pg_disc: 0,
  total_cash: 100.5,
  total_paytm_card_amount: 10,
  total_paytm_upi_amount: 20,
  total_online_other: 30,
  total_online: 40,
  district_transation_amt: 5,
  credit_pincode_amt: 7,
  ...overrides,
});
describe('source flash-sales reducer and warehouse bindings', () => {
  it('matches actual Python rounding/refund buckets and the 22-column source export manifest', () => {
    const cases: { sales: FlashSalesSourceRow[]; refunds: FlashRefundRow[] }[] = [];
    for (let index = 0; index < 40; index++)
      cases.push({
        sales: [
          sample({
            total_cash: [100.5, 101.5, -2.5, 0, 0.001][index % 5]!,
            total_tss_money: index % 3 ? 2.675 : null,
            StoreName: index % 4 ? 'Fixture store' : null,
          }),
        ],
        refunds: [
          'CASH',
          'TSS_POINTS',
          'TSS_MONEY',
          'OG_AS_TSS_MONEY',
          'GIFT_CARD_AS_TSS_MONEY',
          'BANK',
          'UPI',
        ].map((mode, ordinal) => ({
          StoreName: index % 4 ? 'Fixture store' : null,
          date: '2026-11-16',
          refunded_mode: mode,
          total_refunded_amt: (index - 20) / 3 + ordinal * 0.005,
        })),
      });
    const expected = JSON.parse(
      executePosSourceOracle(['tools/operational-reports/flash-sales-oracle.py'], {
        input: JSON.stringify({ cases }),
        encoding: 'utf8',
      }),
    ) as unknown;
    expect(cases.map((value) => prepareFlashSales(value.sales, value.refunds))).toEqual(expected);
    const csv = flashSalesCsv(prepareFlashSales([sample()], [])),
      headers = csv.split('\r\n')[0]?.split(',');
    expect(headers).toHaveLength(22);
    expect(headers?.[14]).toBe('"district_transation_amt"');
    expect(csv.split('\r\n')[1]?.split(',')[14]).toBe('""');
  });
  it('routes historical relations to explicit views and preserves separate interactive/export join behavior', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'flash-report-fixture-'.repeat(3),
      }),
      user: Principal = {
        id: '10',
        name: 'Fixture',
        email: 'fixture@example.test',
        role: 4,
        userType: 1,
        storeIds: ['1'],
      },
      calls: { statement: string; params: Record<string, unknown>; resource?: string }[] = [],
      db: Databases = {
        get() {
          throw new Error('Historical MySQL forbidden');
        },
        close: async () => {},
      },
      options = flashSalesOptions(
        Object.fromEntries(
          [
            'ORDERS',
            'ORDER_STORES',
            'LINES',
            'STORES',
            'PAYTM_TRANSACTIONS',
            'RETURN_ORDERS',
            'REFUND_LOGS',
            'AUTOMATED_REFUNDS',
          ].map((value) => [
            `BQ_FLASH_SALES_${value}_VIEW`,
            `fixture-project.reports.${value.toLowerCase()}`,
          ]),
        ),
      ),
      service = flashSalesReportService(
        config,
        db,
        options,
        {
          async queryReport(
            statement: string,
            params: Record<string, unknown>,
            _types: Record<string, string | string[]>,
            resource?: string,
          ) {
            calls.push({ statement, params, resource });
            return statement.includes('cash_summary AS') ? [sample()] : [];
          },
        },
        () => Temporal.Instant.from('2026-11-17T08:00:00Z'),
      ),
      input = flashSalesInputSchema.parse({
        from: '2026-11-16',
        to: '2026-11-16',
        storeIds: ['1'],
      });
    expect((await service.read(user, input)).reader).toBe('bigquery');
    await service.read(user, input, true);
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.resource === 'flash-sales')).toBe(true);
    expect(calls[0]?.params).toMatchObject({
      stores: ['1'],
      start: '2026-11-16 00:00:00',
      end: '2026-11-16 23:59:59',
    });
    expect(calls[0]?.statement).toContain('fixture-project.reports.orders');
    expect(calls[0]?.statement).toContain(
      'LEFT JOIN `fixture-project.reports.paytm_transactions` cppt',
    );
    expect(calls[2]?.statement).not.toContain(' cppt');
    expect(calls[0]?.statement).toContain('IN UNNEST(@stores)');
    expect(calls[1]?.statement).not.toContain('@rownum');
    await expect(service.read(user, { ...input, storeIds: ['2'] })).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    expect((await service.read(user, { ...input, storeIds: [] })).total).toBe(0);
    await expect(
      flashSalesReportService(config, db, flashSalesOptions({}), undefined, () =>
        Temporal.Instant.from('2026-11-17T08:00:00Z'),
      ).read(user, input),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });
});
