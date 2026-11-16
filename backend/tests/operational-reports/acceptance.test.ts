import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import {
  acceptanceInputSchema,
  acceptanceOptions,
  acceptanceReportService,
} from '../../src/modules/operational-reports/acceptance.js';
const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'acceptance-report-fixture-'.repeat(3),
  }),
  user: Principal = {
    id: '10',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 1,
    userType: 1,
    storeIds: [],
  };
describe('hyperlocal acceptance report boundary', () => {
  it('routes history only to the declared warehouse view with bound scope and sort allowlist', async () => {
    let mysqlCalls = 0;
    const calls: {
        statement: string;
        params: Record<string, unknown>;
        resource: string | undefined;
      }[] = [],
      db: Databases = {
        get() {
          mysqlCalls++;
          throw new Error('Unexpected MySQL report read');
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
          return statement.includes('COUNT(*)') ? [{ count: 0 }] : [];
        },
      },
      service = acceptanceReportService(
        config,
        db,
        acceptanceOptions({ BQ_HYPERLOCAL_ACCEPTANCE_VIEW: 'fixture-project.reports.acceptance' }),
        warehouse,
        () => Temporal.Instant.from('2026-11-16T08:00:00Z'),
      );
    const input = acceptanceInputSchema.parse({
        from: '2026-11-15T00:00:00',
        to: '2026-11-15T23:59:59',
        storeIds: ['123'],
        sort: 'time_taken',
        direction: 'asc',
      }),
      result = await service.read(user, input);
    expect(result.reader).toBe('bigquery');
    expect(mysqlCalls).toBe(0);
    expect(calls[1]).toMatchObject({
      params: { stores: ['123'], start: '2026-11-15 00:00:00', end: '2026-11-15 23:59:59' },
      resource: 'hyperlocal-acceptance',
    });
    expect(calls[1]?.statement).toContain('ORDER BY time_taken asc,log_id ASC');
    expect(calls[1]?.statement).not.toContain('123');
    expect(() =>
      acceptanceInputSchema.parse({ ...input, sort: 'created_at;DROP TABLE orders' }),
    ).toThrow();
    await expect(service.read({ ...user, role: 4 }, input)).rejects.toMatchObject({
      code: 'ROLE_ACCESS_DENIED',
    });
    expect(calls).toHaveLength(2);
    expect(
      (await service.read({ ...user, userType: 2, storeIds: ['123'] }, { ...input, storeIds: [] }))
        .total,
    ).toBe(0);
    await expect(
      service.read({ ...user, userType: 2, storeIds: ['123'] }, { ...input, storeIds: ['999'] }),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    expect(calls).toHaveLength(2);
  });
  it('fails absent history mappings without a MySQL fallback', async () => {
    let reads = 0;
    const db: Databases = {
        get() {
          reads++;
          throw new Error('Unexpected MySQL report read');
        },
        close: async () => {},
      },
      service = acceptanceReportService(config, db, acceptanceOptions({}), undefined, () =>
        Temporal.Instant.from('2026-11-16T08:00:00Z'),
      );
    await expect(
      service.read(
        user,
        acceptanceInputSchema.parse({ from: '2026-11-15T00:00:00', to: '2026-11-15T23:59:59' }),
      ),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(reads).toBe(0);
  });
});
