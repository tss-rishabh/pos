import { describe, expect, it } from 'vitest';
import {
  queueReportExport,
  queueAdministrationCollectionExport,
  type ReportExportFilters,
} from '../../src/pages/operational-reports/export-commands';
const filters: ReportExportFilters = {
    kind: 'day-close-history',
    from: '2026-11-16',
    to: '2026-11-16',
    storeIds: ['1', '2'],
    attempts: 'all',
    search: 'private customer remark',
  },
  result = {
    id: 'fixture-job',
    origin: 'current' as const,
    kind: 'day-close-history',
    reportName: 'Day-close history',
    from: '2026-11-16',
    to: '2026-11-16',
    status: 'QUEUED' as const,
    message: 'Waiting to prepare the report.',
    requestedBy: '10',
    requestedAt: '2026-11-16T12:00:00Z',
    completedAt: null,
    format: 'CSV',
    byteCount: null,
    rowCount: null,
    canDownload: false,
  };
function fixtureStorage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) || null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}
describe('report export request recovery', () => {
  it('uses the same durable journal for date-free current collection exports without storing filters', async () => {
    const storage = fixtureStorage(),
      commands: string[] = [],
      collection = {
        resource: 'operators' as const,
        storeIds: [],
        search: 'private fixture email',
        active: 'all' as const,
        sort: 'name',
        direction: 'asc' as const,
        columns: ['name', 'role'],
      };
    await expect(
      queueAdministrationCollectionExport('10', collection, storage, async (command, input) => {
        commands.push(command);
        expect(input).toEqual({ kind: 'administration-list', ...collection });
        expect(input).not.toHaveProperty('from');
        expect(input).not.toHaveProperty('to');
        throw new Error('Lost reply');
      }),
    ).rejects.toThrow();
    expect(JSON.stringify([...storage.entries])).not.toContain(collection.search);
    await queueAdministrationCollectionExport('10', collection, storage, async (command) => {
      commands.push(command);
      return result;
    });
    expect(commands[0]).toBe(commands[1]);
    expect(storage.entries.size).toBe(0);
  });
  it('retains exact sorted visible-column command retries, with a separate digest for changed columns', async () => {
    const storage = fixtureStorage(),
      commands: string[] = [],
      value: ReportExportFilters = {
        ...filters,
        kind: 'salesperson-performance',
        from: '2026-11-16T00:00',
        to: '2026-11-16T23:59',
        sort: 'rating',
        direction: 'asc',
        columns: ['salesperson_name', 'rating'],
      };
    const fail = async (command: string, input: unknown) => {
      commands.push(command);
      expect(input).toEqual({
        kind: value.kind,
        from: '2026-11-16T00:00:00',
        to: '2026-11-16T23:59:00',
        storeIds: ['1', '2'],
        sort: 'rating',
        direction: 'asc',
        columns: value.columns,
      });
      throw new Error('Lost response');
    };
    await expect(queueReportExport('10', value, storage, fail)).rejects.toThrow();
    await expect(queueReportExport('10', value, storage, fail)).rejects.toThrow();
    expect(commands[0]).toBe(commands[1]);
    await queueReportExport('10', { ...value, columns: ['rating'] }, storage, async (command) => {
      expect(command).not.toBe(commands[0]);
      return result;
    });
    expect(storage.entries.size).toBe(1);
    expect(JSON.stringify([...storage.entries])).not.toContain(value.search);
    expect(JSON.stringify([...storage.entries])).not.toContain('salesperson_name');
  });
  it('canonicalizes local timestamps and retains source/date-basis metadata for order exports', async () => {
    const storage = fixtureStorage(),
      commands: string[] = [],
      value = {
        ...filters,
        kind: 'order-transactions' as const,
        source: 'online' as const,
        dateType: 'return_date' as const,
        from: '2026-11-16T00:00',
        to: '2026-11-16T23:59:59',
      };
    await expect(
      queueReportExport('10', value, storage, async (command, input) => {
        commands.push(command);
        expect(input).toMatchObject({
          source: 'online',
          dateType: 'return_date',
          from: '2026-11-16T00:00:00',
        });
        expect(input).not.toHaveProperty('search');
        throw new Error('Transport interrupted');
      }),
    ).rejects.toThrow();
    await queueReportExport(
      '10',
      { ...value, from: '2026-11-16T00:00:00' },
      storage,
      async (command) => {
        commands.push(command);
        return result;
      },
    );
    expect(commands[0]).toBe(commands[1]);
    expect(storage.entries.size).toBe(0);
  });
  it('preserves a command across transport failures and canonicalizes store selections without storing search text', async () => {
    const storage = fixtureStorage(),
      commands: string[] = [];
    await expect(
      queueReportExport('10', filters, storage, async (command) => {
        commands.push(command);
        throw new Error('Transport interrupted');
      }),
    ).rejects.toThrow('Transport interrupted');
    expect(JSON.stringify([...storage.entries])).not.toContain(filters.search);
    await queueReportExport(
      '10',
      { ...filters, storeIds: ['2', '1', '1'] },
      storage,
      async (command, input) => {
        commands.push(command);
        expect(input).toMatchObject({ storeIds: ['1', '2'], search: filters.search });
        return result;
      },
    );
    expect(commands[0]).toBe(commands[1]);
    expect(storage.entries.size).toBe(0);
  });
  it('isolates operator retries and omits history-only filters from cash balance exports', async () => {
    const storage = fixtureStorage(),
      commands: string[] = [];
    for (const owner of ['10', '11'])
      await expect(
        queueReportExport(
          owner,
          { ...filters, kind: 'cash-balance' },
          storage,
          async (command, input) => {
            commands.push(command);
            expect(input).not.toHaveProperty('search');
            expect(input).not.toHaveProperty('attempts');
            throw new Error('Transport interrupted');
          },
        ),
      ).rejects.toThrow();
    expect(commands[0]).not.toBe(commands[1]);
    expect(storage.entries.size).toBe(2);
    expect(JSON.stringify([...storage.entries])).not.toContain(filters.search);
  });
});
