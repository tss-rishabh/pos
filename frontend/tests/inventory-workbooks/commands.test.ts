import { afterEach, describe, expect, it, vi } from 'vitest';
import { setRequestOperator } from '../../src/api/client';
import {
  queueReportExport,
  type ReportExportFilters,
} from '../../src/pages/operational-reports/export-commands';
const filters: ReportExportFilters = {
  kind: 'current-inventory-workbook',
  from: '2000-01-01',
  to: '2000-01-02',
  storeIds: ['2', '1'],
  attempts: 'all',
  search: 'private unused filter',
  label: 'Fixture workbook',
};
const result = {
  id: 'fixture-job',
  origin: 'current' as const,
  kind: filters.kind,
  reportName: 'Fixture workbook',
  from: null,
  to: null,
  status: 'QUEUED' as const,
  message: 'Waiting.',
  requestedBy: '10',
  requestedAt: null,
  completedAt: null,
  format: 'XLSX',
  byteCount: null,
  rowCount: null,
  canDownload: false,
};
function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) || null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  setRequestOperator(null);
});
describe('ordered current inventory requests', () => {
  it('retains exact ordered workbook commands on unknown replies without inventing dates or persisting labels/search', async () => {
    const local = storage(),
      calls: { id: string; input: unknown }[] = [];
    await expect(
      queueReportExport('10', filters, local, async (id, input) => {
        calls.push({ id, input });
        throw new Error('Fixture unknown.');
      }),
    ).rejects.toThrow();
    expect(JSON.stringify([...local.data])).not.toContain('Fixture workbook');
    expect(JSON.stringify([...local.data])).not.toContain(filters.search);
    await queueReportExport('10', filters, local, async (id, input) => {
      calls.push({ id, input });
      return result;
    });
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]?.input).toEqual({
      kind: 'current-inventory-workbook',
      storeIds: ['2', '1'],
      label: 'Fixture workbook',
    });
    expect(local.data.size).toBe(0);
  });
  it('treats a different workbook sheet order as a different immutable command', async () => {
    const local = storage(),
      ids: string[] = [];
    for (const stores of [
      ['2', '1'],
      ['1', '2'],
    ])
      await expect(
        queueReportExport('10', { ...filters, storeIds: stores }, local, async (id) => {
          ids.push(id);
          throw new Error('Fixture unknown.');
        }),
      ).rejects.toThrow();
    expect(ids[0]).not.toBe(ids[1]);
    expect(local.data.size).toBe(2);
  });
  it('does not dispatch or persist an old owner continuation even when the same identity signs in again after hashing', async () => {
    setRequestOperator('10');
    const local = storage(),
      fetch = vi.spyOn(globalThis, 'fetch');
    let release: (value: ArrayBuffer) => void = () => undefined;
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          release = resolve;
        }),
    );
    const operation = queueReportExport('10', filters, local);
    setRequestOperator('11');
    setRequestOperator('10');
    release(new ArrayBuffer(32));
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
    expect(local.data.size).toBe(0);
  });
});
