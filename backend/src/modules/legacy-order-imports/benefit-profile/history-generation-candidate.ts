import { couponHistoryWitnessSchema } from './bridge.js';
import { couponWarehouseKeys } from './history-warehouse-contracts.js';
import {
  verifyGenerationCapture,
  sealGenerationPublication,
  generationError,
  type GenerationCapture,
  type GenerationFacts,
} from './history-generation-contracts.js';
import { generationReadRunner, type GenerationDependencies } from './history-generation-read.js';
import {
  generationOptionsSchema,
  requireGenerationOptions,
  type GenerationOptions,
} from './history-generation-options.js';
import type { GenerationAuthority } from './history-generation-runtime.js';
export interface GenerationCandidatePort {
  read(capture: GenerationCapture, signal: AbortSignal): Promise<GenerationFacts>;
}
export function couponGenerationCandidate(
  supplied: GenerationOptions,
  authority: { sourceKey: string },
  dependencies: GenerationDependencies = {},
): GenerationCandidatePort {
  const parsed = generationOptionsSchema.safeParse(supplied);
  if (!parsed.success) throw generationError('CONFIGURATION', 503);
  couponWarehouseKeys(authority.sourceKey);
  const options = Object.freeze(parsed.data),
    runner = generationReadRunner(options, authority, dependencies);
  return {
    async read(input, signal) {
      requireGenerationOptions(options, 'candidate');
      const c = verifyGenerationCapture(
          input,
          authority.sourceKey,
          runner.clock(),
          options.maxLagMs,
        ),
        w = couponHistoryWitnessSchema.parse({
          writersContract: c.writersContract,
          writersDefinitionHash: c.writersDefinitionHash,
          serverUuid: c.serverUuid,
          sourceSchema: c.sourceSchema,
          heads: c.heads,
        });
      const result = await runner.read(c.scope, w, signal, c);
      if (result.capture.signature !== c.signature) throw generationError('INCOMPLETE');
      return result;
    },
  };
}
export async function qualifyGenerationPublication(
  capture: GenerationCapture,
  reader: GenerationCandidatePort,
  authority: GenerationAuthority,
  comparisonFingerprint: string,
  options: { signal: AbortSignal; clock?: () => number },
) {
  const clock = options.clock ?? Date.now;
  verifyGenerationCapture(capture, authority.sourceKey, clock());
  const actual = await reader.read(capture, options.signal);
  options.signal.throwIfAborted();
  return sealGenerationPublication(actual, authority, comparisonFingerprint, clock());
}
