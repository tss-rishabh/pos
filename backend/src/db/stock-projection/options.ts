import { z } from 'zod';
import type { Config } from '../../config.js';
import { projectionContract } from './domain.js';
import { availableStockProjection, availableSystemStockProjection } from './service.js';

export const systemStockProjectionContract = 'pos-system-stock-projection-70b801-v1';

/** Explicit selection of a source-pinned implementation; this never enables the old CALL. */
export function configuredStockProjection(
  config: Pick<Config, 'BUSINESS_TIMEZONE'>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const options = z
    .object({
      POS_STOCK_PROJECTION_CONTRACT: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.literal(projectionContract).optional(),
      ),
    })
    .parse(environment);
  return options.POS_STOCK_PROJECTION_CONTRACT
    ? availableStockProjection(config.BUSINESS_TIMEZONE)
    : undefined;
}

/** System actor0 is never inferred from an HTTP body or the ordinary contract. */
export function configuredSystemStockProjection(
  config: Pick<Config, 'BUSINESS_TIMEZONE'>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const options = z
    .object({
      POS_SYSTEM_STOCK_PROJECTION_CONTRACT: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.literal(systemStockProjectionContract).optional(),
      ),
    })
    .parse(environment);
  return configuredStockProjection(config, environment) &&
    options.POS_SYSTEM_STOCK_PROJECTION_CONTRACT
    ? availableSystemStockProjection(config.BUSINESS_TIMEZONE)
    : undefined;
}
