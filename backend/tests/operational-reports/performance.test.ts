import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import {
  cashierInputSchema,
  salespersonInputSchema,
  staffPerformanceService,
  performanceOptions,
} from '../../src/modules/operational-reports/performance.js';
const config = readConfig({
    NODE_ENV: 'test',
    MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
    SESSION_SECRET: 'staff-performance-fixture-'.repeat(3),
  }),
  user: Principal = {
    id: '10',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 1,
    userType: 1,
    storeIds: [],
  },
  clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z');
describe('staff performance warehouse contracts', () => {
  it('binds historical scope and report-specific dates without a MySQL history fallback', async () => {
    let mysqlReads = 0;
    const calls: {
        statement: string;
        params: Record<string, unknown>;
        resource: string | undefined;
      }[] = [],
      db: Databases = {
        get() {
          mysqlReads++;
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
          return [];
        },
      },
      service = staffPerformanceService(
        config,
        db,
        performanceOptions({
          BQ_SALESPERSON_PERFORMANCE_VIEW: 'fixture-project.reports.salespeople',
          BQ_CASHIER_PERFORMANCE_VIEW: 'fixture-project.reports.cashiers',
        }),
        warehouse,
        clock,
      ),
      input = { from: '2026-11-15T00:00:00', to: '2026-11-15T23:59:59', storeIds: ['123'] };
    expect((await service.salespeople(user, salespersonInputSchema.parse(input))).reader).toBe(
      'bigquery',
    );
    expect((await service.cashiers(user, cashierInputSchema.parse(input))).reader).toBe('bigquery');
    expect(mysqlReads).toBe(0);
    expect(calls.map((call) => call.resource)).toEqual([
      'salesperson-performance',
      'cashier-performance',
    ]);
    expect(calls[0]?.statement).toContain('line_created_at>=@start');
    expect(calls[1]?.statement).toContain('order_created_at>=@start');
    expect(calls.every((call) => !call.statement.includes('123'))).toBe(true);
    expect(calls[0]?.params.stores).toEqual(['123']);
    await expect(
      service.cashiers({ ...user, role: 4 }, cashierInputSchema.parse(input)),
    ).rejects.toMatchObject({ code: 'ROLE_ACCESS_DENIED' });
    await expect(
      service.salespeople(
        { ...user, userType: 2, storeIds: [] },
        salespersonInputSchema.parse(input),
      ),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    expect(calls).toHaveLength(2);
  });
  it('fails missing history configuration and invalid sort values safely', async () => {
    let reads = 0;
    const db: Databases = {
        get() {
          reads++;
          throw new Error('Unexpected MySQL history read');
        },
        close: async () => {},
      },
      service = staffPerformanceService(config, db, performanceOptions({}), undefined, clock),
      input = salespersonInputSchema.parse({
        from: '2026-11-15T00:00:00',
        to: '2026-11-15T23:59:59',
      });
    await expect(service.salespeople(user, input)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(reads).toBe(0);
    expect(() =>
      salespersonInputSchema.parse({ ...input, sort: 'total_sales; DROP TABLE orders' }),
    ).toThrow();
  });
});
