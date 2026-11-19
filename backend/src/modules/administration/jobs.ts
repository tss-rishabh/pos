import type { JobModuleRegistration } from '../../jobs/runtime.js';
import { configuredStockProjection } from '../../db/stock-projection/options.js';
import {
  ecommerceInventoryJob,
  httpFullEcommerceSync,
  mysqlStockSyncerBk,
} from './ecommerce-sync/index.js';
import { inventoryImportJobs } from './import-job.js';
import { createCsvUploadStorage } from './import-storage.js';
import { readPrivateS3Options } from './private-s3-client.js';
import { createProductSyncAdapter, productSynchronizer } from './product-sync.js';
import { executeStockProcedure } from './stock-procedure.js';
import { readAdministrationWorkerOptions } from './worker-options.js';

/**
 * Administration jobs: core.tasks.parse_csv_product_store (C1), core.tasks.parse_csv_product_stock
 * (C2) and core.tasks.sync_ecom_inventory (C10), all on queue `core`.
 */
export const registerJobHandlers: JobModuleRegistration = (registry, runtime) => {
  const { config, db, ephemeral, log } = runtime;
  const syncOptions = readAdministrationWorkerOptions();
  const productSync = productSynchronizer(
    createProductSyncAdapter(config, syncOptions, fetch, { requireReplaySafe: false }),
    log,
  );
  const imports = inventoryImportJobs({
    config,
    db,
    ephemeral,
    storage: createCsvUploadStorage(config, readPrivateS3Options()),
    // Source `GenericHelper.sync_pos_inventory` calls `tss.pos_stock_syncer`; the selected
    // transaction-scoped projection replaces it when configured.
    stockProcedure: configuredStockProjection(config) ?? executeStockProcedure,
    productSync,
    log,
  });
  registry.register('core.tasks.parse_csv_product_store', imports.productStore);
  registry.register('core.tasks.parse_csv_product_stock', imports.productStock);
  registry.register(
    'core.tasks.sync_ecom_inventory',
    ecommerceInventoryJob({
      db,
      syncerBk: mysqlStockSyncerBk(db),
      fullSync: httpFullEcommerceSync(syncOptions.MAIN_API_V2_URL),
      log,
    }),
  );
};
