import { generationError } from './history-generation-contracts.js';
import type { GenerationDemands } from './history-generation-demands.js';
import type { couponGenerationPublisher } from './history-generation-publisher.js';
/** Readonly capture may be retried only before the atomic generation/demand bind.
 * After bind, the separate publisher worker owns original once-only job recovery. */
export function couponGenerationDemandWorker(
  demands: GenerationDemands,
  publisher: ReturnType<typeof couponGenerationPublisher>,
  newWorkEnabled: () => boolean,
) {
  let active: Promise<{ claimed: number; prepared: number; unavailable: number }> | undefined;
  return {
    drain(signal: AbortSignal, limit = 2) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw generationError('DEMAND');
      if (active) return active;
      active = (async () => {
        await Promise.resolve();
        const result = { claimed: 0, prepared: 0, unavailable: 0 };
        try {
          if (!newWorkEnabled() || signal.aborted) return result;
          const ids = await demands.pending(limit);
          for (const id of ids) {
            if (!newWorkEnabled() || signal.aborted) break;
            const claim = await demands.claim(id);
            if (!claim) continue;
            result.claimed++;
            try {
              await publisher.prepareCustomer(claim.scope.customerId, signal, (tx, generation) =>
                demands.bind(tx, claim, generation),
              );
              result.prepared++;
            } catch {
              result.unavailable++;
              if (!signal.aborted) await demands.defer(claim);
            }
          }
          return result;
        } finally {
          active = undefined;
        }
      })();
      return active;
    },
  };
}
