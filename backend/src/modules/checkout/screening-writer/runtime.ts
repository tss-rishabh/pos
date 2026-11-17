import { publicScreeningCoordinator } from './coordinator.js';
import { configuredPublicBenefitPreparation } from './benefit-preparation-options.js';

/** Shared HTTP/worker installation. Construction performs no source or warehouse
 * calls. Invalid selected preparation retains a denying port so immutable
 * recovery remains available while new financial work stays paused. */
export function configuredPublicScreeningCoordinator(
  config: Parameters<typeof publicScreeningCoordinator>[0],
  db: Parameters<typeof publicScreeningCoordinator>[1],
  environment: Parameters<typeof publicScreeningCoordinator>[2],
  options: NonNullable<Parameters<typeof publicScreeningCoordinator>[3]> = {},
  variables: NodeJS.ProcessEnv = process.env,
) {
  return publicScreeningCoordinator(config, db, environment, {
    ...options,
    prepareBenefits:
      options.prepareBenefits ??
      configuredPublicBenefitPreparation(environment, options, config.DEMO_MODE ? {} : variables, {
        clock: options.clock,
        fetcher: options.fetcher,
      }),
  });
}
