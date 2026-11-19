import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setRequestOperator } from '../../src/api/client';
import {
  exportInputSchema,
  queueReportExport,
  reportExportInput,
  type ReportExportFilters,
} from '../../src/pages/operational-reports/export-commands';

const queued =
  'Close history is being exported to CSV. The file will be available in the Export tab shortly. Click here to open the Export tab.';
const dayClose: ReportExportFilters = {
  kind: 'day-close-history',
  from: '2026-11-16',
  to: '2026-11-16',
  storeIds: ['2', '1', '2'],
  attempts: 'latest',
  label: '  Weekly close  ',
  note: '',
};
function stubFetch(body: unknown, status = 200) {
  const fetch = vi.fn(
    async (_path: string, _options: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
describe('legacy report export requests (E1-E6)', () => {
  beforeEach(() => setRequestOperator('10'));
  afterEach(() => {
    setRequestOperator(null);
    vi.unstubAllGlobals();
  });
  it('posts only { input } with the operator header and returns the legacy message', async () => {
    const fetch = stubFetch({ message: queued });
    await expect(queueReportExport('10', dayClose)).resolves.toEqual({ message: queued });
    expect(fetch).toHaveBeenCalledOnce();
    const [path, options] = fetch.mock.calls[0]!;
    expect(path).toBe('/api/v1/report-exports');
    expect(options.method).toBe('POST');
    expect(new Headers(options.headers).get('X-Operator-ID')).toBe('10');
    expect(JSON.parse(String(options.body))).toEqual({
      input: {
        kind: 'day-close-history',
        from: '2026-11-16',
        to: '2026-11-16',
        storeIds: ['2', '1'],
        label: 'Weekly close',
        attempts: 'latest',
      },
    });
  });
  it('carries each kind only the filters its legacy task receives', () => {
    const range = { from: '2026-11-16T00:00', to: '2026-11-16T23:59:59', storeIds: ['1'] };
    expect(
      reportExportInput({
        ...range,
        kind: 'order-transactions',
        source: 'online',
        dateType: 'return_date',
        attempts: 'all',
        note: 'For audit',
      }),
    ).toEqual({
      ...range,
      kind: 'order-transactions',
      source: 'online',
      dateType: 'return_date',
      note: 'For audit',
    });
    expect(reportExportInput({ ...range, kind: 'order-transactions' })).toMatchObject({
      source: 'store',
      dateType: 'order_date',
    });
    for (const kind of ['returned-orders', 'hyperlocal-daily'] as const)
      expect(reportExportInput({ ...range, kind, source: 'online', attempts: 'latest' })).toEqual({
        ...range,
        kind,
      });
    for (const kind of ['cash-balance', 'flash-sales'] as const)
      expect(
        reportExportInput({ kind, from: '2026-11-01', to: '2026-11-02', storeIds: [] }),
      ).toEqual({ kind, from: '2026-11-01', to: '2026-11-02', storeIds: [] });
    expect(
      reportExportInput({
        kind: 'day-close-history',
        from: '2026-11-01',
        to: '2026-11-02',
        storeIds: [],
      }),
    ).toMatchObject({ attempts: 'all' });
  });
  it('rejects removed kinds, server column variants and malformed dates before sending', async () => {
    const fetch = stubFetch({ message: queued });
    for (const kind of [
      'salesperson-performance',
      'cashier-performance',
      'hyperlocal-acceptance',
      'current-inventory-workbook',
      'administration-list',
    ])
      expect(
        exportInputSchema.safeParse({ kind, from: '2026-11-16', to: '2026-11-16', storeIds: [] })
          .success,
      ).toBe(false);
    for (const extra of [
      { search: 'x' },
      { sort: 'id' },
      { direction: 'asc' },
      { columns: ['id'] },
    ])
      expect(
        exportInputSchema.safeParse({
          kind: 'returned-orders',
          from: '2026-11-16T00:00:00',
          to: '2026-11-16T23:59:59',
          storeIds: ['1'],
          ...extra,
        }).success,
      ).toBe(false);
    await expect(
      queueReportExport('10', { ...dayClose, kind: 'returned-orders' }),
    ).rejects.toThrow();
    await expect(
      queueReportExport('10', { ...dayClose, label: 'x'.repeat(256) }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('surfaces API refusals and refuses a changed operator without a request', async () => {
    stubFetch({ error: { code: 'VALIDATION_ERROR', message: 'Select a valid range.' } }, 400);
    await expect(queueReportExport('10', dayClose)).rejects.toBeInstanceOf(ApiError);
    const fetch = stubFetch({ message: queued });
    await expect(queueReportExport('11', dayClose)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
