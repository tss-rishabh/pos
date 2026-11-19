import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import {
  returnedOrdersReportService,
  returnedOrdersInputSchema,
  returnedOrdersOptions,
  returnedOrdersCsv,
} from '../../src/modules/operational-reports/returned-orders.js';
import { reportCsvCell } from '../../src/modules/operational-reports/export-domain.js';
const config = readConfig({
    NODE_ENV: 'test',
    MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
    SESSION_SECRET: 'returned-report-fixture-'.repeat(3),
  }),
  user: Principal = {
    id: '10',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 4,
    userType: 1,
    storeIds: ['1'],
  },
  clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z');
describe('returned-order report boundaries', () => {
  it('escapes formula cells after control/format prefixes while preserving signed money', () => {
    expect(reportCsvCell('\u0000=SUM(A1:A2)')).toBe('"\'\u0000=SUM(A1:A2)"');
    expect(reportCsvCell('\u202e+1+1')).toBe('"\'\u202e+1+1"');
    expect(reportCsvCell('-5.00')).toBe('"-5.00"');
  });
  it('uses a declared historical view and binds private search/store values without MySQL fallback', async () => {
    let reads = 0;
    const calls: {
        statement: string;
        params: Record<string, unknown>;
        resource: string | undefined;
      }[] = [],
      db: Databases = {
        get() {
          reads++;
          throw new Error('Unexpected MySQL history read');
        },
        close: async () => {},
      },
      warehouse = {
        async queryReport(
          statement: string,
          params: Record<string, unknown>,
          _types: Record<string, string | string[]>,
          resource?: string,
        ) {
          calls.push({ statement, params, resource });
          return statement.includes('COUNT(DISTINCT')
            ? [{ count: 1 }]
            : [
                {
                  id: '123',
                  return_id: '456',
                  store_name: 'Fixture',
                  order_id: '1',
                  prod_id: '2',
                  qty: 1,
                  pay_amount_refunded: 25,
                  pay_amount_refunded_mode: 'TSS_MONEY',
                  reason: 'Fit',
                  sub_reason: null,
                  comment: '=SUM(A1:A2)',
                  order_date: '2026-11-14 10:00:00',
                  created_at: '2026-11-15 10:00:00',
                  original_order_id: null,
                },
              ];
        },
      },
      service = returnedOrdersReportService(
        config,
        db,
        returnedOrdersOptions({
          BQ_RETURNED_ORDERS_VIEW: 'fixture-project.reports.returned_orders',
        }),
        warehouse,
        clock,
      ),
      input = returnedOrdersInputSchema.parse({
        from: '2026-11-15T00:00:00',
        to: '2026-11-15T23:59:59',
        storeIds: ['1'],
        search: "private ' quote",
      }),
      report = await service.read(user, input);
    expect(report.reader).toBe('bigquery');
    expect(reads).toBe(0);
    expect(calls[1]).toMatchObject({
      params: { search: input.search, stores: ['1'] },
      resource: 'returned-orders',
    });
    expect(calls.every((call) => !call.statement.includes(input.search))).toBe(true);
    expect(returnedOrdersCsv(report.data)).toContain("'=SUM(A1:A2)");
    await expect(service.read(user, { ...input, storeIds: ['2'] })).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await expect(
      service.read({ ...user, role: 1, userType: 2 }, { ...input, storeIds: ['2'] }),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    expect((await service.read(user, { ...input, storeIds: [] })).total).toBe(0);
    expect(calls).toHaveLength(2);
  });
  it('rejects missing historical configuration and unsafe sorting before report reads', async () => {
    let reads = 0;
    const db: Databases = {
        get() {
          reads++;
          throw new Error('Unexpected MySQL read');
        },
        close: async () => {},
      },
      service = returnedOrdersReportService(
        config,
        db,
        returnedOrdersOptions({}),
        undefined,
        clock,
      ),
      input = returnedOrdersInputSchema.parse({
        from: '2026-11-15T00:00:00',
        to: '2026-11-15T23:59:59',
        storeIds: ['1'],
      });
    await expect(service.read(user, input)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(reads).toBe(0);
    expect(() =>
      returnedOrdersInputSchema.parse({ ...input, sort: 'created_at;DROP TABLE orders' }),
    ).toThrow();
  });
});
