import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { counterDigest, counterError } from './contracts.js';
import { screeningCounterPublisher, type ScreeningCounterWarehouse } from './publisher.js';
import {
  readScreeningCounterWarehouseOptions,
  screeningCounterWarehouse,
  type ScreeningCounterWarehouseOptions,
} from './warehouse.js';
export const counterPublisherContract = 'pos-screening-counter-publisher-v1';
export interface ScreeningCounterPublisherOptions {
  contract?: typeof counterPublisherContract;
  sourceKey?: string;
  publicationKey?: string;
  warehouse: ScreeningCounterWarehouseOptions;
}
export function readScreeningCounterPublisherOptions(
  env: NodeJS.ProcessEnv = process.env,
): ScreeningCounterPublisherOptions {
  const selected = env.POS_SCREENING_COUNTER_PUBLISHER_CONTRACT;
  if (selected && selected !== counterPublisherContract)
    throw counterError('PUBLISHER_CONFIGURATION');
  return {
    ...(selected === counterPublisherContract ? { contract: counterPublisherContract } : {}),
    sourceKey: env.POS_SCREENING_COUNTER_SOURCE_CAPTURE_KEY,
    publicationKey: env.POS_SCREENING_COUNTER_PUBLICATION_KEY,
    warehouse: readScreeningCounterWarehouseOptions(env),
  };
}
/** Explicit independent publisher installation only. No app/startup sweep or
 * selected checkout ever initializes a missing counter on demand. */
export function configuredScreeningCounterPublisher(
  config: Config,
  db: Databases,
  options: ScreeningCounterPublisherOptions,
  warehouse?: ScreeningCounterWarehouse,
) {
  if (options.contract !== counterPublisherContract) return undefined;
  if (
    config.DEMO_MODE ||
    !config.MYSQL_WRITER_URL ||
    !options.sourceKey ||
    !options.publicationKey ||
    options.sourceKey === options.publicationKey
  )
    throw counterError('PUBLISHER_CONFIGURATION');
  counterDigest(options.sourceKey, 'capture', null);
  counterDigest(options.publicationKey, 'publication', null);
  return screeningCounterPublisher(
    db,
    { sourceKey: options.sourceKey, publicationKey: options.publicationKey },
    warehouse ?? screeningCounterWarehouse(config, options.warehouse),
  );
}
