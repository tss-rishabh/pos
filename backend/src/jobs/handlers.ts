import type { JobHandlerRegistry } from './contract.js';
import type { JobModuleRegistration, JobRuntime } from './runtime.js';
import { registerJobHandlers as administration } from '../modules/administration/jobs.js';
import { registerJobHandlers as operationalReports } from '../modules/operational-reports/jobs.js';
import { registerJobHandlers as giftCardBatches } from '../modules/gift-card-batches/jobs.js';

/**
 * The single list of modules whose `registerJobHandlers` the worker loads
 * (`src/modules/<module>/jobs.ts`). The primary agent extends it at merge time.
 *
 * Job ownership (phase-c-legacy-jobs.md §4.7):
 * - administration: core.tasks.parse_csv_product_store, core.tasks.parse_csv_product_stock,
 *   core.tasks.sync_ecom_inventory
 * - operational-reports: report.datatables.* exports E1-E6
 * - gift-card-batches: pos.gift_card_batches.generate
 */
export const jobModules: readonly (readonly [string, JobModuleRegistration])[] = [
  ['administration', administration],
  ['operational-reports', operationalReports],
  ['gift-card-batches', giftCardBatches],
  // PLACEHOLDER W4 (checkout): core.tasks.send_sms, core.tasks.push_vinc_order_for_all.
  //   ['checkout', (await import('../modules/checkout/jobs.js')).registerJobHandlers],
  // PLACEHOLDER W5 (legacy-fulfillment): order.views.auto_hl_order_transfer,
  //   order.views.auto_hl_order_to_online, order.views.advance_order_notification,
  //   core.tasks.new_order_create_communication.
  //   ['legacy-fulfillment', ...],
  // PLACEHOLDER W5 (legacy-order-status): order.tasks.auto_reject_timed_out_for_store
  //   (if it lands there rather than in fulfillment).
  //   ['legacy-order-status', ...],
  // PLACEHOLDER W5 (order-history): no job in §4.7 today; keep the slot for its exports.
  //   ['order-history', ...],
];

export function registerAllJobHandlers(registry: JobHandlerRegistry, runtime: JobRuntime) {
  for (const [, register] of jobModules) register(registry, runtime);
}
