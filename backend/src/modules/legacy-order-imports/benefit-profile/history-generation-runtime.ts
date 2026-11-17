import type { CsvCouponHistoryPort } from './history.js';
import { couponHistoryScopeSchema } from './history.js';
import { couponHistoryWitnessSchema } from './bridge.js';
import { couponWarehouseKeys } from './history-warehouse-contracts.js';
import {
  generationScopeFor,
  bindGenerationHistory,
  generationError,
} from './history-generation-contracts.js';
import { generationReadRunner, type GenerationDependencies } from './history-generation-read.js';
import {
  generationOptionsSchema,
  requireGenerationOptions,
  readGenerationOptions,
  type GenerationOptions,
} from './history-generation-options.js';
export interface GenerationAuthority {
  sourceKey: string;
  publicationKey: string;
  historyKey: string;
}
/** BQ-only runtime. No native source/qualifier/publisher module is imported. */
export function couponGenerationHistory(
  supplied: GenerationOptions,
  authority: GenerationAuthority,
  dependencies: GenerationDependencies = {},
): CsvCouponHistoryPort {
  const parsed = generationOptionsSchema.safeParse(supplied);
  if (!parsed.success) throw generationError('CONFIGURATION', 503);
  couponWarehouseKeys(authority.sourceKey, authority.publicationKey, authority.historyKey);
  const options = Object.freeze(parsed.data),
    keys = Object.freeze({ ...authority }),
    runner = generationReadRunner(options, keys, dependencies);
  return {
    async read(input, request) {
      requireGenerationOptions(options, 'read');
      const scope = couponHistoryScopeSchema.safeParse(input),
        witness = couponHistoryWitnessSchema.safeParse(request?.witness);
      if (!scope.success || !witness.success || !(request?.signal instanceof AbortSignal))
        throw generationError('WITNESS', 503);
      const result = await runner.read(
        generationScopeFor(scope.data),
        witness.data,
        request.signal,
      );
      request.signal.throwIfAborted();
      return bindGenerationHistory(
        result,
        scope.data,
        witness.data,
        keys,
        options.comparisonFingerprint!,
        runner.clock(),
      );
    },
  };
}
/** Pure opt-in factory for Root preparation injection. No selector means no
 * reader, never a native/empty-history substitute. */
export function couponHistoryRuntime(
  env: NodeJS.ProcessEnv,
  authority: GenerationAuthority | undefined,
  dependencies: GenerationDependencies = {},
): CsvCouponHistoryPort | undefined {
  const options = readGenerationOptions(env);
  if (!options.contract) return undefined;
  if (!authority) throw generationError('KEY_REQUIRED', 503);
  return couponGenerationHistory(options, authority, dependencies);
}
