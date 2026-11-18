import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { JobHandler, JobName } from '../../src/jobs/contract.js';
import { memoryEphemeralStore } from '../../src/jobs/ephemeral.js';
import { recordingJobProducer } from '../../src/jobs/module-runtime.js';
import { registerJobHandlers } from '../../src/modules/operational-reports/jobs.js';
import {
  exportInputSchema,
  legacyExports,
  legacyTimePeriod,
  normalizedExportInput,
} from '../../src/modules/operational-reports/export-domain.js';
import {
  exportInputFromJobArgs,
  exportJobArgs,
} from '../../src/modules/operational-reports/export-service.js';

describe('report export jobs E1-E6', () => {
  it('registers one handler per legacy Celery task name', () => {
    const registered = new Map<JobName, JobHandler>(),
      db: Databases = {
        get() {
          throw new Error('No database access while registering.');
        },
        close: async () => {},
      };
    registerJobHandlers(
      { register: (name, handler) => void registered.set(name, handler) },
      {
        config: readConfig({
          NODE_ENV: 'test',
          DEMO_MODE: 'true',
          SESSION_SECRET: 'export-jobs-fixture-'.repeat(3),
        }),
        db,
        ephemeral: memoryEphemeralStore(),
        jobs: recordingJobProducer(),
        log: () => {},
      },
    );
    expect([...registered.keys()].sort()).toEqual([
      'report.datatables.cash_balance_datatable.do_cash_balance_export',
      'report.datatables.day_close_datatable.do_day_close_export',
      'report.datatables.hyperlocal_daily_datatable.do_hyperlocal_daily_export',
      'report.datatables.return_orders_datatable.do_order_export',
      'report.datatables.return_orders_datatable.do_return_export',
      'report.datatables.sales_data.do_sales_export',
    ]);
    expect(
      Object.values(legacyExports).map((spec) => [
        spec.reportType,
        spec.completedStatus,
        spec.failureBranch,
      ]),
    ).toEqual([
      ['RETURN', 'COMPLETED', false],
      ['ORDER', 'COMPLETED', false],
      ['CASH_BALANCE', 'Completed', true],
      ['RETURN', 'COMPLETED', false],
      ['DAY_CLOSE', 'Completed', true],
      ['HYPERLOCAL_DAILY', 'COMPLETED', true],
    ]);
  });
  it('round-trips filters through scalar job args and formats legacy time periods', () => {
    const input = normalizedExportInput({
        kind: 'order-transactions',
        from: '2026-11-16T09:05',
        to: '2026-11-16T21:00',
        storeIds: ['12', '3', '12'],
        source: 'online',
        dateType: 'return_date',
        label: 'Orders',
      }),
      args = exportJobArgs('7', input);
    expect(args).toEqual({
      user_id: '7',
      report_name: 'Orders',
      report_message: '',
      date_from: '2026-11-16T09:05:00',
      date_to: '2026-11-16T21:00:00',
      store_ids: ['3', '12'],
      date_type: 'return_date',
      order_source: 'online_orders',
    });
    expect(exportInputFromJobArgs('order-transactions', args)).toEqual({
      userId: '7',
      input: { ...input, note: '' },
    });
    expect(legacyTimePeriod(input)).toBe('2026-11-16 09:05:00 - 2026-11-16 21:00:00');
    expect(
      legacyTimePeriod(
        normalizedExportInput({ kind: 'cash-balance', from: '2026-11-01', to: '2026-11-16' }),
      ),
    ).toBe('2026-11-01 - 2026-11-16');
    expect(() => exportInputFromJobArgs('returned-orders', { ...args, extra: 'x' })).toThrow();
  });
  it('no longer accepts the four rewrite-only export kinds or server-side column variants', () => {
    for (const kind of [
      'current-inventory-workbook',
      'salesperson-performance',
      'cashier-performance',
      'hyperlocal-acceptance',
      'administration-list',
    ])
      expect(
        exportInputSchema.safeParse({ kind, from: '2026-11-01', to: '2026-11-02' }).success,
      ).toBe(false);
    expect(
      exportInputSchema.safeParse({
        kind: 'returned-orders',
        from: '2026-11-01T00:00',
        to: '2026-11-02T00:00',
        columns: ['order_id'],
      }).success,
    ).toBe(false);
  });
});
