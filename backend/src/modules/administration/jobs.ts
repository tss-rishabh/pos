import type { JobModuleRegistration } from '../../jobs/runtime.js';

/**
 * Administration jobs: core.tasks.parse_csv_product_store (C1), core.tasks.parse_csv_product_stock
 * (C2) and core.tasks.sync_ecom_inventory (C10). Implemented by the administration workstream.
 */
export const registerJobHandlers: JobModuleRegistration = () => {};
