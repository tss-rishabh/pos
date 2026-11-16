import { describe, expect, it } from 'vitest';
import {
  queueReportExport,
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
  it('canonicalizes local timestamps and retains source/date-basis metadata for order exports',async()=>{
    const storage=fixtureStorage(),commands:string[]=[],value={...filters,kind:'order-transactions' as const,source:'online' as const,dateType:'return_date' as const,from:'2026-11-16T00:00',to:'2026-11-16T23:59:59'};
    await expect(queueReportExport('10',value,storage,async(command,input)=>{commands.push(command);expect(input).toMatchObject({source:'online',dateType:'return_date',from:'2026-11-16T00:00:00'});expect(input).not.toHaveProperty('search');throw new Error('Transport interrupted');})).rejects.toThrow();
    await queueReportExport('10',{...value,from:'2026-11-16T00:00:00'},storage,async command=>{commands.push(command);return result;});expect(commands[0]).toBe(commands[1]);expect(storage.entries.size).toBe(0);
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
