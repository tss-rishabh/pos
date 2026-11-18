import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { warehouseReportCount } from '../../src/modules/operational-reports/report-inputs.js';
import {
  returnedOrdersInputSchema,
  returnedOrdersOptions,
  returnedOrdersReportService,
} from '../../src/modules/operational-reports/returned-orders.js';
import {
  orderTransactionsInputSchema,
  orderTransactionsOptions,
  orderTransactionsReportService,
} from '../../src/modules/operational-reports/order-transactions.js';
import {
  hyperlocalDailyInputSchema,
  hyperlocalDailyOptions,
  hyperlocalDailyReportService,
} from '../../src/modules/operational-reports/hyperlocal-daily.js';
import { scheduledReportBuilder } from '../../src/modules/operational-reports/scheduled-data.js';
import { scheduledReportOptions } from '../../src/modules/operational-reports/scheduled-options.js';
import { scheduleInput } from '../../src/modules/operational-reports/scheduled-domain.js';
import { closeHistoryService } from '../../src/modules/finance/history.js';
import { ledgerOptions } from '../../src/modules/finance/ledger.js';

const config = readConfig({
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  SESSION_SECRET: 'fact-range-fixture-'.repeat(3),
});
const clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z');
const user: Principal = {
  id: '10',
  name: 'Fixture',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: ['1'],
};
const input = { from: '2026-11-16T00:00:00', to: '2026-11-16T23:59:59', storeIds: ['1'] };
function noMysql(): Databases {
  return {
    get() {
      throw new Error('Unbounded report facts reached MySQL');
    },
    close: async () => {},
  };
}

describe('actual report fact-cohort routing', () => {
  it.each(
    [
      [],
      [{}],
      [{ count: null }],
      [{ count: false }],
      [{ count: '-1' }],
      [{ count: '9007199254740992' }],
      [{ count: 1 }, { count: 1 }],
    ].map((rows) => ({ rows })),
  )('refuses missing/malformed SQL COUNT evidence: %j', ({ rows }) => {
    expect(() => warehouseReportCount(rows)).toThrowError(
      expect.objectContaining({ code: 'REPORT_VIEW_INVALID', status: 503 }),
    );
  });
  it('keeps an explicit zero and full-width safe counts distinct from missing rows', () => {
    expect(warehouseReportCount([{ count: '0' }])).toBe(0);
    expect(warehouseReportCount([{ count: String(Number.MAX_SAFE_INTEGER) }])).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
  it('does not coerce a null archived financial COUNT into a zero-result report', async () => {
    const service = closeHistoryService(
      config,
      noMysql(),
      ledgerOptions({
        BQ_FINANCE_DAY_CLOSES: 'fixture-project.finance.closes',
      }),
      {
        async queryReport() {
          return [{ count: null }];
        },
      },
      clock,
    );
    await expect(
      service.read(user, {
        from: '2026-11-15',
        to: '2026-11-15',
        attempts: 'latest',
        page: 1,
        pageSize: 25,
      }),
    ).rejects.toMatchObject({ code: 'REPORT_VIEW_INVALID' });
  });
  it('uses BQ even for today when return dates or pending expiry leave joined sale facts unbounded', async () => {
    const calls: string[] = [];
    const warehouse = {
      async queryReport(statement: string) {
        calls.push(statement);
        return statement.includes('COUNT(') ? [{ count: 0 }] : [];
      },
    };
    const returned = returnedOrdersReportService(
      config,
      noMysql(),
      returnedOrdersOptions({ BQ_RETURNED_ORDERS_VIEW: 'fixture-project.reports.returns' }),
      warehouse,
      clock,
    );
    expect(await returned.read(user, returnedOrdersInputSchema.parse(input))).toMatchObject({
      reader: 'bigquery',
      data: [],
      total: 0,
    });
    const orders = orderTransactionsReportService(
      config,
      noMysql(),
      orderTransactionsOptions({
        BQ_STORE_ORDER_SALES_VIEW: 'fixture-project.reports.sales',
        BQ_STORE_ORDER_RETURNS_VIEW: 'fixture-project.reports.returns',
      }),
      warehouse,
      clock,
    );
    expect(
      await orders.read(
        user,
        orderTransactionsInputSchema.parse({ ...input, dateType: 'return_date' }),
      ),
    ).toMatchObject({ reader: 'bigquery', data: [], total: 0 });
    const hyperlocal = hyperlocalDailyReportService(
      config,
      noMysql(),
      hyperlocalDailyOptions({ BQ_HYPERLOCAL_DAILY_VIEW: 'fixture-project.reports.hyperlocal' }),
      warehouse,
      clock,
    );
    expect(await hyperlocal.read(user, hyperlocalDailyInputSchema.parse(input))).toMatchObject({
      reader: 'bigquery',
      data: [],
      total: 0,
    });
    expect(calls.some((sql) => sql.includes('return_date>=@start'))).toBe(true);
    expect(calls.some((sql) => sql.includes('return_created_at>=@start'))).toBe(true);
    expect(calls.some((sql) => sql.includes('pending_expires_at>=@start'))).toBe(true);
  });
  it('never turns an absent count result or missing today-history configuration into an empty native report', async () => {
    const empty = {
      async queryReport() {
        return [];
      },
    };
    const service = returnedOrdersReportService(
      config,
      noMysql(),
      returnedOrdersOptions({ BQ_RETURNED_ORDERS_VIEW: 'fixture-project.reports.returns' }),
      empty,
      clock,
    );
    await expect(service.read(user, returnedOrdersInputSchema.parse(input))).rejects.toMatchObject({
      code: 'REPORT_VIEW_INVALID',
    });
    const missing = returnedOrdersReportService(
      config,
      noMysql(),
      returnedOrdersOptions({}),
      empty,
      clock,
    );
    await expect(missing.read(user, returnedOrdersInputSchema.parse(input))).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
  });
  it('routes today timing and the literal preceding-day summary cohort to warehouse', async () => {
    const calls: { sql: string; params: Record<string, unknown> }[] = [];
    const options = scheduledReportOptions({
      BQ_HYPERLOCAL_ORDER_LOGS_VIEW: 'fixture-project.reports.logs',
      BQ_HYPERLOCAL_ORDER_FACTS_VIEW: 'fixture-project.reports.orders',
    });
    const builder = scheduledReportBuilder(
      config,
      noMysql(),
      options,
      {
        async queryReport(sql: string, params: Record<string, unknown>) {
          calls.push({ sql, params });
          return [];
        },
      },
      undefined,
      clock,
      async () => ({ stores: [], slots: [] }),
    );
    await builder({
      ...scheduleInput.parse({ kind: 'hyperlocal-performance' }),
      date: '2026-11-16',
    });
    await builder({ ...scheduleInput.parse({ kind: 'hyperlocal-summary' }), date: '2026-11-16' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toContain('o.created_at');
    expect(calls[1]!.params).toMatchObject({
      from: '2026-11-16 00:00:00',
      windowStart: '2026-11-15 00:00:00',
      end: '2026-11-17 00:00:00',
    });
    expect(calls[1]!.sql).toContain('o.created_at>=@windowStart');
  });
});
