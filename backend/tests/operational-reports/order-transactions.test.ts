import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import {
  orderTransactionsReportService,
  orderTransactionsInputSchema,
  orderTransactionsOptions,
} from '../../src/modules/operational-reports/order-transactions.js';
import { sourceOrderLine } from './fixtures/order-report.js';
const config = readConfig({
    NODE_ENV: 'test',
    MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
    SESSION_SECRET: 'order-transaction-fixture-'.repeat(3),
  }),
  user: Principal = {
    id: '10',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 4,
    userType: 1,
    storeIds: ['123'],
  },
  clock = () => Temporal.Instant.from('2026-11-17T08:00:00Z'),
  input = orderTransactionsInputSchema.parse({
    from: '2026-11-16T00:00:00',
    to: '2026-11-16T23:59:59',
    storeIds: ['123'],
    source: 'online',
    dateType: 'return_date',
  }),
  options = orderTransactionsOptions({
    BQ_STORE_ORDER_SALES_VIEW: 'fixture-project.reports.store_sales',
    BQ_STORE_ORDER_RETURNS_VIEW: 'fixture-project.reports.store_returns',
    BQ_ONLINE_ORDER_SALES_VIEW: 'fixture-project.reports.online_sales',
    BQ_ONLINE_ORDER_RETURNS_VIEW: 'fixture-project.reports.online_returns',
  });
describe('combined transaction warehouse contracts', () => {
  it('routes old orders/returns to explicit views and binds source-specific dates/scope', async () => {
    let reads = 0;
    const calls: {
        statement: string;
        params: Record<string, unknown>;
        resource: string | undefined;
      }[] = [],
      db: Databases = {
        get() {
          reads++;
          throw new Error('Unexpected historical MySQL read');
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
          return statement.includes(' AS count') ? [{ count: 1 }] : [sourceOrderLine()];
        },
      },
      service = orderTransactionsReportService(config, db, options, warehouse, clock),
      result = await service.read(user, input);
    expect(result.reader).toBe('bigquery');
    expect(result.total).toBe(1);
    expect(reads).toBe(0);
    expect(calls.every((call) => call.resource === 'order-transactions')).toBe(true);
    expect(calls[1]?.params).toMatchObject({
      stores: ['123'],
      start: '2026-11-16 00:00:00',
      end: '2026-11-16 23:59:59',
    });
    expect(calls[1]?.statement.includes('online_sales')).toBe(true);
    expect(calls[1]?.statement.includes('online_returns')).toBe(true);
    expect(calls[1]?.statement.includes('return_created_at>=@start')).toBe(true);
    expect(calls[1]?.statement.includes('123')).toBe(false);
    expect(calls[1]?.statement.startsWith('SELECT')).toBe(true);
    expect((await service.read(user, { ...input, storeIds: [] })).total).toBe(0);
    await expect(service.read(user, { ...input, storeIds: ['999'] })).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    expect(calls).toHaveLength(2);
  });
  it('bounds full exports before fetching lines and sanitizes view/transport failures', async () => {
    let calls = 0;
    const db: Databases = {
        get() {
          throw new Error('Unexpected MySQL read');
        },
        close: async () => {},
      },
      large = orderTransactionsReportService(
        config,
        db,
        options,
        {
          async queryReport() {
            calls++;
            return [{ count: 70001 }];
          },
        },
        clock,
      );
    await expect(large.read(user, input, true)).rejects.toMatchObject({ code: 'REPORT_TOO_LARGE' });
    expect(calls).toBe(1);
    const missing = orderTransactionsReportService(
      config,
      db,
      orderTransactionsOptions({}),
      undefined,
      clock,
    );
    await expect(missing.read(user, input)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    const failed = orderTransactionsReportService(
      config,
      db,
      options,
      {
        async queryReport() {
          throw new Error('secret query values');
        },
      },
      clock,
    );
    await expect(failed.read(user, input)).rejects.toMatchObject({
      code: 'REPORT_QUERY_FAILED',
      message: 'The order transaction report could not be prepared.',
    });
    expect(() =>
      orderTransactionsInputSchema.parse({ ...input, source: 'online;DROP TABLE orders' }),
    ).toThrow();
  });
});
