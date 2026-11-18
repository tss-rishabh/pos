import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { normalizedExportInput } from '../../src/modules/operational-reports/export-domain.js';
import { reportScreenColumns } from '../../src/modules/operational-reports/export-presentation.js';
import { screenReportCsv } from '../../src/modules/operational-reports/screen-report-csv.js';
import { reportExportBuilder } from '../../src/modules/operational-reports/export-service.js';
import {
  performanceOptions,
  staffPerformanceService,
} from '../../src/modules/operational-reports/performance.js';
import {
  acceptanceOptions,
  acceptanceReportService,
} from '../../src/modules/operational-reports/acceptance.js';

const dates = { from: '2026-11-15T00:00:00', to: '2026-11-15T23:59:59', storeIds: ['1'] },
  config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'column-export-fixture-'.repeat(3),
  }),
  manager: Principal = {
    id: '10',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 1,
    userType: 1,
    storeIds: ['1'],
  },
  clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z'),
  db: Databases = {
    get() {
      throw new Error('Unexpected native fact query');
    },
    close: async () => {},
  };

describe('source report column export contract', () => {
  it('uses the pinned source performance/acceptance headings and active CSV/visibility controls', () => {
    for (const [kind, file] of [
      ['salesperson-performance', 'performance_report/salesperson_performance.html'],
      ['cashier-performance', 'performance_report/cashier_performance.html'],
      ['hyperlocal-acceptance', 'orders/hyperlocal_order_accept_report.html'],
    ] as const) {
      const html = readFileSync(
        new URL('../../../../backend-pos-web/report/templates/' + file, import.meta.url),
        'utf8',
      );
      const head = html.split('<thead>')[1]!.split('</thead>')[0]!,
        labels = [...head.matchAll(/<th[^>]*>(.*?)<\/th>/gs)].map((match) => match[1]!.trim());
      expect(reportScreenColumns[kind].map(([, label]) => label)).toEqual(labels);
      expect(html).toContain("extend: 'csv'");
      expect(html).toContain("columns: ':visible'");
      expect(html).toContain("'colvis'");
      expect(html).toContain('"searching": false');
    }
  });
  it('retains old unmarked bytes and rejects unknown/duplicate/empty columns and sort injection', () => {
    const old = { kind: 'returned-orders', ...dates, search: '' };
    expect(normalizedExportInput(old)).toEqual(old);
    expect(JSON.stringify(normalizedExportInput(old))).not.toMatch(/columns|direction|sort/);
    for (const columns of [[], ['rating', 'rating'], ['email'], ['rating;DROP TABLE orders']])
      expect(() =>
        normalizedExportInput({ kind: 'salesperson-performance', ...dates, columns }),
      ).toThrow();
    expect(() =>
      normalizedExportInput({ kind: 'cashier-performance', ...dates, sort: 'email' }),
    ).toThrow();
    expect(() =>
      normalizedExportInput({ kind: 'hyperlocal-acceptance', ...dates, search: 'private' }),
    ).toThrow();
  });
  it('exports literal visible cells in source column order with CSV formula protection', () => {
    const csv = screenReportCsv(
      'salesperson-performance',
      [{ store_name: 'hidden', salesperson_name: '\u200b=1+1', total_sales: '-5.00', rating: 10 }],
      ['total_sales', 'salesperson_name'],
    );
    expect(csv).toBe('\uFEFF"Salesperson Name","Total Sales"\r\n"\'\u200b=1+1","-5.00"');
    expect(csv).not.toContain('hidden');
    expect(() => screenReportCsv('salesperson-performance', [], ['email'])).toThrow();
    expect(() =>
      screenReportCsv(
        'salesperson-performance',
        [{ salesperson_name: '😀'.repeat(20) }],
        ['salesperson_name'],
        60,
      ),
    ).toThrow(expect.objectContaining({ code: 'EXPORT_TOO_LARGE' }));
  });
  it('keeps transaction full exports distinct from a strict visible-column fixed-order export', () => {
    const old = normalizedExportInput({ kind: 'order-transactions', ...dates });
    expect(old).not.toHaveProperty('columns');
    expect(old).not.toHaveProperty('sort');
    expect(
      normalizedExportInput({
        kind: 'order-transactions',
        ...dates,
        columns: ['order_id', 'invoice_no'],
        sort: 'transaction_date',
        direction: 'desc',
      }),
    ).toMatchObject({
      columns: ['order_id', 'invoice_no'],
      sort: 'transaction_date',
      direction: 'desc',
    });
    expect(() =>
      normalizedExportInput({ kind: 'order-transactions', ...dates, columns: ['password'] }),
    ).toThrow();
    expect(() =>
      normalizedExportInput({
        kind: 'order-transactions',
        ...dates,
        sort: 'transaction_date',
        direction: 'asc',
      }),
    ).toThrow();
  });
  it('builds every matching salesperson after global scoring, not only the displayed page', async () => {
    const rows = Array.from({ length: 61 }, (_, i) => ({
        employeeId: String(i + 1),
        storeName: 'Fixture',
        salespersonName: `Staff ${i}`,
        totalSales: 610 - i * 10,
      })),
      calls: string[] = [],
      performance = staffPerformanceService(
        config,
        db,
        performanceOptions({
          BQ_SALESPERSON_PERFORMANCE_VIEW: 'fixture-project.reports.salespeople',
        }),
        {
          async queryReport(statement) {
            calls.push(statement);
            return rows;
          },
        },
        clock,
      ),
      builder = reportExportBuilder(config, db, { performance }),
      result = await builder(
        manager,
        normalizedExportInput({
          kind: 'salesperson-performance',
          ...dates,
          sort: 'total_sales',
          direction: 'desc',
          columns: ['salesperson_name', 'rating'],
        }),
      );
    if (!('bytes' in result)) throw new Error('Expected CSV');
    expect(result.rowCount).toBe(61);
    expect(result.bytes.toString().split('\r\n')).toHaveLength(62);
    expect(result.bytes.toString()).toContain('"Staff 60","0.2"');
    expect(calls[0]).toContain('ORDER BY totalSales desc');
    expect(calls[0]).toContain('LIMIT 70001');
    await expect(
      builder(
        { ...manager, role: 4 },
        normalizedExportInput({ kind: 'salesperson-performance', ...dates }),
      ),
    ).rejects.toMatchObject({ code: 'ROLE_ACCESS_DENIED' });
  });
  it('keeps cashier global scores and sorts while returning all matching cashiers', async () => {
    const performance = staffPerformanceService(
        config,
        db,
        performanceOptions({ BQ_CASHIER_PERFORMANCE_VIEW: 'fixture-project.reports.cashiers' }),
        {
          async queryReport() {
            return Array.from({ length: 61 }, (_, i) => ({
              orderId: String(i + 1),
              cashierId: String(i + 1),
              cashierName: `Cashier ${String(i).padStart(2, '0')}`,
              performanceJson: JSON.stringify({ overall_performance_time: String(1000 + i) }),
              quantity: 1,
            }));
          },
        },
        clock,
      ),
      builder = reportExportBuilder(config, db, { performance }),
      result = await builder(
        manager,
        normalizedExportInput({
          kind: 'cashier-performance',
          ...dates,
          sort: 'cashier_name',
          direction: 'desc',
          columns: ['cashier_name', 'score'],
        }),
      );
    if (!('bytes' in result)) throw new Error('Expected CSV');
    expect(result.rowCount).toBe(61);
    const lines = result.bytes.toString().split('\r\n');
    expect(lines[1]).toContain('Cashier 60');
    expect(lines[61]).toContain('Cashier 00');
  });
  it('requests a bounded whole acceptance result and refuses count overflow before row/dimension reads', async () => {
    const calls: { statement: string; params: Record<string, unknown> }[] = [],
      acceptance = acceptanceReportService(
        config,
        db,
        acceptanceOptions({ BQ_HYPERLOCAL_ACCEPTANCE_VIEW: 'fixture-project.reports.acceptance' }),
        {
          async queryReport(statement, params) {
            calls.push({ statement, params });
            return [{ count: 70001 }];
          },
        },
        clock,
      ),
      builder = reportExportBuilder(config, db, { acceptance });
    await expect(
      builder(
        manager,
        normalizedExportInput({
          kind: 'hyperlocal-acceptance',
          ...dates,
          sort: 'order_id',
          direction: 'asc',
          columns: ['order_id'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    expect(calls).toHaveLength(1);
  });
});
