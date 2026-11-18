import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Principal } from '../../src/domain/access.js';
import {
  exportHistoryBounds,
  exportHistoryInputSchema,
  exportHistoryOptions,
  exportHistoryReader,
} from '../../src/modules/operational-reports/export-history.js';
const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'export-history-fixture-'.repeat(3),
  }),
  user: Principal = {
    id: '10',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 4,
    userType: 1,
    storeIds: ['1'],
  },
  clock = () => Temporal.Instant.from('2026-11-17T12:00:00Z'),
  input = exportHistoryInputSchema.parse({
    period: 'archive',
    from: '2026-11-01',
    to: '2026-11-17',
    search: "private ' note",
  });
function row(id: string = randomUUID()) {
  return {
    id,
    kind: 'cash-balance',
    reportName: 'Fixture report',
    note: 'Fixture note',
    from: '2026-11-01',
    to: '2026-11-02',
    status: 'COMPLETED',
    requestedBy: '10',
    requestedAt: '2026-11-15 12:00:00',
    completedAt: '2026-11-15 12:01:00',
    format: 'CSV',
    byteCount: 120,
    rowCount: 2,
    period: null,
    storage_key: 'secret object location',
    error_message: 'secret raw query details',
  };
}
describe('archived export metadata contract', () => {
  it('retains exact legacy period values and500-row named bindings without exposing raw errors', async () => {
    for (const period of [null, '', '11/01/2026 - 11/02/2026']) {
      const calls: { statement: string; params: Record<string, unknown> }[] = [],
        reader = exportHistoryReader(
          config,
          exportHistoryOptions({
            BQ_LEGACY_REPORT_EXPORTS_VIEW: 'fixture-project.reports.legacy_exports',
          }),
          {
            async queryReport(statement, params) {
              calls.push({ statement, params });
              return statement.includes('COUNT(*)')
                ? [{ count: 1200 }]
                : [{ ...row('9007199254740993'), period, note: 'secret original source error' }];
            },
          },
          clock,
        ),
        result = await reader.list(user, {
          ...input,
          origin: 'legacy',
          page: 3,
          pageSize: 500,
          sort: 'period',
          direction: 'asc',
        });
      expect(result.data[0]).toMatchObject({ id: '9007199254740993', period, note: null });
      expect(calls[1]?.statement).toContain('time_period AS period');
      expect(calls[1]?.statement).toContain('ORDER BY time_period asc');
      expect(calls[1]?.params).toMatchObject({
        limit: 500,
        offset: 1000,
        owner: user.id,
        allOwners: false,
      });
      expect(JSON.stringify(result)).not.toContain('secret');
    }
    expect(() => exportHistoryInputSchema.parse({ ...input, pageSize: 501 })).toThrow();
  });
  it('refuses an omitted or malformed legacy period rather than fabricate a source value', async () => {
    for (const candidate of [
      { ...row('42'), period: undefined },
      { ...row('42'), period: 42 },
    ]) {
      const reader = exportHistoryReader(
        config,
        exportHistoryOptions({
          BQ_LEGACY_REPORT_EXPORTS_VIEW: 'fixture-project.reports.legacy_exports',
        }),
        {
          async queryReport(statement) {
            return statement.includes('COUNT(*)') ? [{ count: 1 }] : [candidate];
          },
        },
        clock,
      );
      await expect(reader.list(user, { ...input, origin: 'legacy' })).rejects.toMatchObject({
        code: 'EXPORT_HISTORY_VIEW_INVALID',
      });
    }
  });
  it('keeps franchise superadmins scoped to their own exports and rejects a mismatched warehouse owner', async () => {
    const franchise = { ...user, role: 1 as const, userType: 2 as const },
      calls: Record<string, unknown>[] = [];
    const reader = exportHistoryReader(
      config,
      exportHistoryOptions({ BQ_REPORT_EXPORTS_VIEW: 'fixture-project.reports.export_history' }),
      {
        async queryReport(statement, params) {
          calls.push(params);
          return statement.includes('COUNT(*)')
            ? [{ count: 1 }]
            : [{ ...row(), requestedBy: '99' }];
        },
      },
      clock,
    );
    await expect(reader.list(franchise, input)).rejects.toMatchObject({
      code: 'EXPORT_HISTORY_VIEW_INVALID',
    });
    expect(
      calls.every((params) => params.allOwners === false && params.owner === franchise.id),
    ).toBe(true);
  });
  it('binds ownership, private search, cutoff and paging and excludes storage/error payloads', async () => {
    const calls: {
        statement: string;
        params: Record<string, unknown>;
        resource: string | undefined;
      }[] = [],
      reader = exportHistoryReader(
        config,
        exportHistoryOptions({ BQ_REPORT_EXPORTS_VIEW: 'fixture-project.reports.export_history' }),
        {
          async queryReport(statement, params, _types, resource) {
            calls.push({ statement, params, resource });
            return statement.includes('COUNT(*)') ? [{ count: 1 }] : [row()];
          },
        },
        clock,
      ),
      result = await reader.list(user, input);
    expect(result.total).toBe(1);
    expect(result.data[0]).toMatchObject({
      origin: 'current',
      canDownload: false,
      requestedAt: '2026-11-15T12:00:00Z',
      message: 'Report file is ready.',
    });
    expect(JSON.stringify(result).includes('secret')).toBe(false);
    expect(calls[0]?.params).toMatchObject({
      owner: '10',
      allOwners: false,
      search: input.search,
      cutoff: '2026-11-16 12:00:00.000',
    });
    expect(
      calls.every(
        (call) =>
          call.resource === 'report-export-history' && !call.statement.includes(input.search),
      ),
    ).toBe(true);
    expect(calls[1]?.params).toMatchObject({ limit: 25, offset: 0 });
  });
  it('uses business-local legacy timestamps and suppresses legacy note/error text', async () => {
    const reader = exportHistoryReader(
        config,
        exportHistoryOptions({
          BQ_LEGACY_REPORT_EXPORTS_VIEW: 'fixture-project.reports.legacy_exports',
        }),
        {
          async queryReport(statement) {
            return statement.includes('COUNT(*)')
              ? [{ count: 1 }]
              : [{ ...row('42'), note: 'secret legacy error' }];
          },
        },
        clock,
      ),
      result = await reader.list({ ...user, role: 1 }, { ...input, origin: 'legacy' });
    expect(result.data[0]).toMatchObject({ requestedAt: '2026-11-15T06:30:00Z', note: null });
    expect(JSON.stringify(result).includes('secret')).toBe(false);
  });
  it('rejects absent mappings/invalid identities without fallback and bounds archive windows', async () => {
    let calls = 0;
    const reader = exportHistoryReader(
      config,
      exportHistoryOptions({}),
      {
        async queryReport() {
          calls++;
          throw new Error('Unexpected warehouse call');
        },
      },
      clock,
    );
    await expect(reader.list(user, input)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(
      (await reader.list(user, { ...input, from: '2026-11-17', to: '2026-11-17' })).total,
    ).toBe(0);
    expect(calls).toBe(0);
    expect(() => exportHistoryBounds(config, { ...input, from: '2020-01-01' }, clock())).toThrow();
    const invalid = exportHistoryReader(
      config,
      exportHistoryOptions({ BQ_REPORT_EXPORTS_VIEW: 'fixture-project.reports.export_history' }),
      {
        async queryReport(statement) {
          return statement.includes('COUNT(*)') ? [{ count: 1 }] : [row('invalid identity')];
        },
      },
      clock,
    );
    await expect(invalid.list(user, input)).rejects.toMatchObject({
      code: 'EXPORT_HISTORY_VIEW_INVALID',
    });
  });
});
