import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { JOB_NAMES, JOB_QUEUES, type JobHandler, type JobName } from '../../src/jobs/contract.js';
import { memoryEphemeralStore } from '../../src/jobs/ephemeral.js';
import { jobModules, registerAllJobHandlers } from '../../src/jobs/handlers.js';
import { recordingJobProducer } from '../../src/jobs/module-runtime.js';
import { createJobHandlerRegistry } from '../../src/jobs/registry.js';
import type { JobRuntime } from '../../src/jobs/runtime.js';

const config = readConfig({
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  SESSION_SECRET: 'job-handler-mapping-test-secret-'.repeat(2),
});
function runtime(closers: (() => Promise<void>)[] = []): JobRuntime {
  return {
    config,
    db: createDatabases(config),
    ephemeral: memoryEphemeralStore(),
    jobs: recordingJobProducer(),
    log: () => {},
    onClose: (close) => closers.push(close),
  };
}

/** phase-c-legacy-jobs.md §4.7 ownership; every contract job name has exactly one owner. */
const owners: Record<string, readonly JobName[]> = {
  administration: [
    'core.tasks.parse_csv_product_store',
    'core.tasks.parse_csv_product_stock',
    'core.tasks.sync_ecom_inventory',
  ],
  'operational-reports': [
    'report.datatables.return_orders_datatable.do_return_export',
    'report.datatables.return_orders_datatable.do_order_export',
    'report.datatables.cash_balance_datatable.do_cash_balance_export',
    'report.datatables.sales_data.do_sales_export',
    'report.datatables.day_close_datatable.do_day_close_export',
    'report.datatables.hyperlocal_daily_datatable.do_hyperlocal_daily_export',
  ],
  'gift-card-batches': ['pos.gift_card_batches.generate'],
  checkout: ['core.tasks.send_sms'],
  'legacy-order-status': ['core.tasks.push_vinc_order_for_all'],
  fulfillment: [
    'order.tasks.auto_reject_timed_out_for_store',
    'order.views.advance_order_notification',
  ],
  'legacy-fulfillment': [
    'order.views.auto_hl_order_transfer',
    'order.views.auto_hl_order_to_online',
    'core.tasks.new_order_create_communication',
  ],
};

describe('job handler registration (src/jobs/handlers.ts)', () => {
  it('registers exactly one handler for every job name in contract.ts', async () => {
    const closers: (() => Promise<void>)[] = [],
      registry = createJobHandlerRegistry();
    registerAllJobHandlers(registry, runtime(closers));
    expect(registry.registered()).toEqual([...JOB_NAMES]);
    for (const name of JOB_NAMES) expect(registry.handler(name)).toBeTypeOf('function');
    await Promise.all(closers.map((close) => close()));
  });

  it('maps each module to the jobs it owns, with no job claimed twice', async () => {
    const closers: (() => Promise<void>)[] = [];
    expect(jobModules.map(([module]) => module).sort()).toEqual(Object.keys(owners).sort());
    for (const [module, register] of jobModules) {
      const names: JobName[] = [];
      register(
        {
          register(name: JobName, _handler: JobHandler) {
            names.push(name);
          },
        },
        runtime(closers),
      );
      expect(names.sort(), module).toEqual([...(owners[module] ?? [])].sort());
    }
    const all = Object.values(owners).flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...JOB_NAMES].sort());
    await Promise.all(closers.map((close) => close()));
  });

  it('keeps the dormant legacy queues store and report_queue in the contract', () => {
    // No legacy task is routed to these Celery queues (phase-c-legacy-jobs.md §4); the worker
    // still consumes them so a legacy producer during cut-over is not stranded.
    expect(JOB_QUEUES).toContain('store');
    expect(JOB_QUEUES).toContain('report_queue');
  });
});
