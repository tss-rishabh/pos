import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { administrationServiceCore, type AdministrationOptions } from './service-core.js';
import { storeAdministration } from './service-stores.js';
import { counterAdministration } from './service-counters.js';
import { salespersonAdministration } from './service-salespeople.js';
import { operatorAdministration } from './service-operators.js';

export { insertBatches } from './service-core.js';
export type { AdminPage, AdministrationOptions, StoreImagePreparation } from './service-core.js';

export function administrationService(
  config: Config,
  db: Databases,
  options: AdministrationOptions = {},
) {
  const core = administrationServiceCore(config, db, options);
  return {
    ...storeAdministration(core),
    ...counterAdministration(core),
    ...salespersonAdministration(core),
    ...operatorAdministration(core),
  };
}
export type AdministrationService = ReturnType<typeof administrationService>;
