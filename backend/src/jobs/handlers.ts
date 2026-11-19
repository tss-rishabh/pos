import type { JobHandlerRegistry } from './contract.js';
import type { JobLogger, JobModuleRegistration, JobRuntime } from './runtime.js';
import { registerJobHandlers as administration } from '../modules/administration/jobs.js';
import { registerJobHandlers as operationalReports } from '../modules/operational-reports/jobs.js';
import { registerJobHandlers as giftCardBatches } from '../modules/gift-card-batches/jobs.js';
import { registerJobHandlers as registerCheckoutJobs } from '../modules/checkout/order-sms.js';
import { registerJobHandlers as registerFulfillmentJobs } from '../modules/fulfillment/index.js';
import { nodeOrderRedis } from '../modules/fulfillment/order-redis.js';
import { notificationBus } from '../modules/fulfillment/notification-bus.js';
import {
  legacyFulfillmentDependencies,
  registerJobHandlers as registerLegacyFulfillmentJobs,
} from '../modules/legacy-fulfillment/index.js';
import { registerJobHandlers as registerLegacyOrderStatusJobs } from '../modules/legacy-order-status/jobs.js';
import { createProductSyncAdapter } from '../modules/administration/product-sync.js';
import { readAdministrationWorkerOptions } from '../modules/administration/worker-options.js';
import { tracedFetch } from '../observability/context.js';

type LogEvent = Parameters<JobLogger>[1];
/** Keeps only scalar event fields: job logs carry ids and codes, never objects. */
function scalarEvent(event: object): LogEvent {
  const fields: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(event))
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
      fields[key] = value;
  return fields;
}

/** W4 checkout: `core.tasks.send_sms` (order SMS through API-v2 `omnichannel-sms`). */
const checkout: JobModuleRegistration = (registry, { config }) =>
  registerCheckoutJobs(registry, { config });

/** W5 legacy-order-status: `core.tasks.push_vinc_order_for_all` (C12). */
const legacyOrderStatus: JobModuleRegistration = (registry, { config, db }) =>
  registerLegacyOrderStatusJobs(registry, { config, db });

/**
 * W5 fulfillment: `order.tasks.auto_reject_timed_out_for_store` (O1) and
 * `order.views.advance_order_notification` (O5), on the legacy `redis_instance` keys.
 */
const fulfillment: JobModuleRegistration = (registry, runtime) => {
  const redis = nodeOrderRedis(runtime.config),
    bus = notificationBus(runtime.config);
  runtime.onClose?.(async () => {
    await bus.close();
    await redis.close();
  });
  registerFulfillmentJobs(registry, {
    config: runtime.config,
    db: runtime.db,
    redis,
    bus,
    log: (level, event, message) => runtime.log(level, scalarEvent(event), message),
  });
};

/**
 * W5 legacy-fulfillment: `order.views.auto_hl_order_transfer` (O2),
 * `order.views.auto_hl_order_to_online` (O3) and `core.tasks.new_order_create_communication`
 * (C9). O3 enqueues C9 through the worker's producer. Product sync after commit is the legacy
 * single unretried `Helpers.sync_pos_product` POST, as in the API process.
 */
const legacyFulfillment: JobModuleRegistration = (registry, runtime) => {
  const { config, db } = runtime,
    redis = nodeOrderRedis(config),
    syncProducts = createProductSyncAdapter(config, readAdministrationWorkerOptions(), tracedFetch, {
      requireReplaySafe: false,
    });
  const deps = legacyFulfillmentDependencies(config, db, {
    jobs: runtime.jobs,
    redis,
    ...(syncProducts ? { syncProducts } : {}),
    logger: { info: (event, message) => runtime.log('info', scalarEvent(event), message) },
  });
  runtime.onClose?.(async () => {
    await deps.close();
    await redis.close();
  });
  registerLegacyFulfillmentJobs(registry, deps);
};

/**
 * The single list of modules whose `registerJobHandlers` the worker loads. Every name in
 * `contract.ts` JOB_NAMES has exactly one handler (tests/jobs/handlers.test.ts). The legacy
 * queues `store` and `report_queue` are dormant: no legacy task is routed to them.
 *
 * Job ownership (phase-c-legacy-jobs.md §4.7):
 * - administration: core.tasks.parse_csv_product_store, core.tasks.parse_csv_product_stock,
 *   core.tasks.sync_ecom_inventory
 * - operational-reports: report.datatables.* exports E1-E6
 * - gift-card-batches: pos.gift_card_batches.generate
 * - checkout (W4): core.tasks.send_sms
 * - legacy-order-status (W5): core.tasks.push_vinc_order_for_all
 * - fulfillment (W5): order.tasks.auto_reject_timed_out_for_store,
 *   order.views.advance_order_notification
 * - legacy-fulfillment (W5): order.views.auto_hl_order_transfer,
 *   order.views.auto_hl_order_to_online, core.tasks.new_order_create_communication
 */
export const jobModules: readonly (readonly [string, JobModuleRegistration])[] = [
  ['administration', administration],
  ['operational-reports', operationalReports],
  ['gift-card-batches', giftCardBatches],
  ['checkout', checkout],
  ['legacy-order-status', legacyOrderStatus],
  ['fulfillment', fulfillment],
  ['legacy-fulfillment', legacyFulfillment],
];

export function registerAllJobHandlers(registry: JobHandlerRegistry, runtime: JobRuntime) {
  for (const [, register] of jobModules) register(registry, runtime);
}
