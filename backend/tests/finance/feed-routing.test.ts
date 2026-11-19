import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import type { Databases } from '../../src/db/pools.js';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { SQL } from 'drizzle-orm';
import { readConfig } from '../../src/config.js';
import { financeFeedOptions, financeFeedService } from '../../src/modules/finance/feed.js';
describe('finance reconciliation warehouse routing', () => {
  it('combines today DATA sales with older-sale BQ returns without changing tax/refund totals', async () => {
    const cfg = readConfig({
      NODE_ENV: 'test',
      MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
      SESSION_SECRET: 'feed-split-fixture-'.repeat(3),
    });
    const base = {
      id: '1001',
      transaction_date: '2026-11-16',
      LocationCode: 'FIXTURE',
      PaymentMode: 'Cash',
      PayAmount: 236,
      PaymentStatus: 'Paid',
      OrderAmount: 236,
      order_ref_no: 'fixture',
      counter_name: 'Counter',
      TaxRate: 18,
      LineItemSubTotalWoTax: 100,
      PayAmountRefunded: null,
      PayAmountRefundedMode: null,
    };
    const sale = {
      ...base,
      CASH: '236',
      PaytmCardUpi: null,
      PinelabCardUpi: null,
      OnlineOther: null,
      DistrictAmount: null,
      TssMoneyUsed: 0,
      CreditPincodeAmount: null,
      VoucherAmountUsed: 0,
      CouponAmountUsed: 0,
      TssPointsUsed: 0,
      PgDisc: 0,
    };
    const native: string[] = [],
      warehouse: string[] = [];
    const db = {
      get(role: string) {
        expect(role).toBe('data');
        return {
          async execute(query: SQL) {
            native.push(new MySqlDialect().sqlToQuery(query).sql);
            return [
              [sale, { ...sale, PayAmountRefunded: 23.6, PayAmountRefundedMode: 'cash' }],
              [],
            ];
          },
        };
      },
      close: async () => {},
    } as unknown as Databases;
    let unavailable = false;
    const service = financeFeedService(
      cfg,
      db,
      financeFeedOptions({
        BQ_FINANCE_RECONCILIATION_RETURNS: 'fixture-project.finance.returns',
      }),
      {
        async queryReport(statement, params) {
          warehouse.push(statement);
          expect(params).toEqual({ start: '2026-11-16', end: '2026-11-17' });
          if (unavailable) throw new Error('Fixture warehouse unavailable');
          return [
            {
              ...base,
              id: '999',
              PayAmountRefunded: 59,
              PayAmountRefundedMode: 'tss_money',
              LineItemSubTotalWoTax: 50,
            },
          ];
        },
      },
      () => Temporal.Instant.from('2026-11-16T08:00:00Z'),
    );
    const result = await service.orders({
      from: '2026-11-16',
      to: '2026-11-16',
      page: 1,
      pageSize: 100,
    });
    expect(result.pagination.total_records).toBe(2);
    expect(result.data).toEqual([
      expect.objectContaining({
        order_id: '1001',
        transaction_type: 'SALE',
        taxable_value: 200,
        gst_amount: 36,
        refund_amount: 23.6,
        cash_refunded: 23.6,
        cash_amount: '236',
      }),
      expect.objectContaining({
        order_id: '999',
        transaction_type: 'RETURN',
        taxable_value: 50,
        gst_amount: 9,
        refund_amount: 59,
        tss_money_refunded: 59,
        cash_refunded: 0,
      }),
    ]);
    expect(native).toHaveLength(1);
    expect(warehouse).toHaveLength(1);
    expect(warehouse[0]).toContain('`fixture-project.finance.returns`');
    unavailable = true;
    await expect(
      service.orders({ from: '2026-11-16', to: '2026-11-16', page: 1, pageSize: 100 }),
    ).rejects.toThrow('Fixture warehouse unavailable');
    expect(native).toHaveLength(2);
    expect(warehouse).toHaveLength(2);
  });
  it('uses bound historical view queries with zero MySQL fallback and fails when mappings are absent', async () => {
    let mysqlCalls = 0;
    const db: Databases = {
      get: () => {
        mysqlCalls++;
        throw new Error('Unexpected MySQL report read');
      },
      close: async () => {},
    };
    const cfg = readConfig({
        NODE_ENV: 'test',
        MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
        SESSION_SECRET: 'feed-routing-fixture-'.repeat(3),
      }),
      clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z');
    const calls: { statement: string; params: Record<string, unknown>; resource?: string }[] = [],
      warehouse = {
        queryReport: async (
          statement: string,
          params: Record<string, unknown>,
          _types: Record<string, string | string[]>,
          resource?: string,
        ) => {
          calls.push({ statement, params, resource });
          return [];
        },
      };
    const options = financeFeedOptions({
        BQ_FINANCE_RECONCILIATION_SALES: 'fixture-project.finance.sales',
        BQ_FINANCE_RECONCILIATION_RETURNS: 'fixture-project.finance.returns',
      }),
      service = financeFeedService(cfg, db, options, warehouse, clock);
    expect(
      await service.orders({ from: '2026-11-15', to: '2026-11-15', page: 1, pageSize: 100 }),
    ).toMatchObject({ success: true, data: [], pagination: { total_records: 0 } });
    expect(mysqlCalls).toBe(0);
    expect(calls).toHaveLength(2);
    expect(
      calls.every(
        (call) =>
          call.resource === 'finance-reconciliation' && !call.statement.includes('2026-11-15'),
      ),
    ).toBe(true);
    expect(calls[0]?.params.start).toBe('2026-11-15');
    await expect(
      financeFeedService(cfg, db, financeFeedOptions({}), warehouse, clock).orders({
        from: '2026-11-15',
        to: '2026-11-15',
        page: 1,
        pageSize: 100,
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(mysqlCalls).toBe(0);
  });
});
