import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import type { Databases } from '../../src/db/pools.js';
import { readConfig } from '../../src/config.js';
import { financeFeedOptions, financeFeedService } from '../../src/modules/finance/feed.js';
describe('finance reconciliation warehouse routing', () => {
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
        DEMO_MODE: 'true',
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
