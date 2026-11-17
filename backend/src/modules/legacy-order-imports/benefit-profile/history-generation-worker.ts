import { generationError } from './history-generation-contracts.js';
import { generationPositiveId } from './history-generation-control.js';
import type { GenerationJournal } from './history-generation-journal.js';
import type { couponGenerationPublisher } from './history-generation-publisher.js';
export interface GenerationWorkerOptions {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  deadlineMs: number;
}
/** Background-only driver. Construction never schedules work. Distinct processes
 * cooperate through the journal's atomic send claims; lost replies only read the
 * original warehouse job. A cursor prevents one unknown job starving later work. */
export function couponGenerationWorker(
  publisher: ReturnType<typeof couponGenerationPublisher>,
  journal: GenerationJournal,
  supplied: Partial<GenerationWorkerOptions> = {},
) {
  const options = {
    enabled: false,
    intervalMs: 5000,
    batchSize: 10,
    deadlineMs: 20000,
    ...supplied,
  };
  if (
    typeof options.enabled !== 'boolean' ||
    ![options.intervalMs, options.batchSize, options.deadlineMs].every(Number.isSafeInteger) ||
    options.intervalMs < 1000 ||
    options.intervalMs > 60000 ||
    options.batchSize < 1 ||
    options.batchSize > 100 ||
    options.deadlineMs < 100 ||
    options.deadlineMs > 40000
  )
    throw generationError('CONFIGURATION', 503);
  let cursor: { updatedAt: number; id: string } | undefined,
    active: Promise<{ attempted: number; advanced: number; unavailable: number }> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    controller: AbortController | undefined,
    stopping = false,
    started = false;
  const runOnce = (external?: AbortSignal) => {
    if (active) return active;
    if (stopping) return Promise.resolve({ attempted: 0, advanced: 0, unavailable: 0 });
    controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(options.deadlineMs),
      ...(external ? [external] : []),
    ]);
    active = (async () => {
      await Promise.resolve();
      const result = { attempted: 0, advanced: 0, unavailable: 0 };
      try {
        if (signal.aborted) return result;
        const page = await journal.pending(options.batchSize, cursor);
        cursor = page.next ?? undefined;
        for (const id of page.ids) {
          if (signal.aborted) break;
          result.attempted++;
          try {
            const before = await publisher.read(id),
              after = await publisher.advance(id, signal);
            if (after.version !== before.version) result.advanced++;
          } catch {
            result.unavailable++;
          }
        }
        // No automatic start/restart from a missing read: advance always retains the
        // original phase and exact job ID. Empty pages wrap the next bounded sweep.
        return result;
      } finally {
        active = undefined;
        controller = undefined;
      }
    })();
    return active;
  };
  async function tick() {
    try {
      await runOnce();
    } catch {
      /* Root may report the static worker-unavailable event. */
    }
    if (!stopping) timer = setTimeout(() => void tick(), options.intervalMs);
  }
  return {
    runOnce,
    /** Trusted scheduler input only; never a runtime history fallback. Caller
     * supplies the already-authorized upcoming import customers before dispatch. */
    async prepareCustomers(customerIds: readonly string[], signal: AbortSignal) {
      if (
        customerIds.length > 100 ||
        new Set(customerIds).size !== customerIds.length ||
        customerIds.some((id) => !generationPositiveId.safeParse(id).success)
      )
        throw generationError('SCOPE');
      let prepared = 0,
        unavailable = 0;
      for (const customerId of customerIds) {
        if (signal.aborted) break;
        try {
          await publisher.prepareCustomer(customerId, signal);
          prepared++;
        } catch {
          unavailable++;
        }
      }
      return { prepared, unavailable };
    },
    start() {
      if (!options.enabled || started || stopping) return;
      started = true;
      void tick();
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      await active;
    },
  };
}
export function readGenerationWorkerOptions(
  env: NodeJS.ProcessEnv = process.env,
): GenerationWorkerOptions {
  const enabled = env.CSV_COUPON_GENERATION_WORKER_ENABLED;
  if (enabled && enabled !== 'true' && enabled !== 'false')
    throw generationError('CONFIGURATION', 503);
  const options = {
    enabled: enabled === 'true',
    intervalMs: Number(env.CSV_COUPON_GENERATION_WORKER_INTERVAL_MS || 5000),
    batchSize: Number(env.CSV_COUPON_GENERATION_WORKER_BATCH_SIZE || 10),
    deadlineMs: Number(env.CSV_COUPON_GENERATION_WORKER_DEADLINE_MS || 20000),
  };
  if (
    ![options.intervalMs, options.batchSize, options.deadlineMs].every(Number.isSafeInteger) ||
    options.intervalMs < 1000 ||
    options.intervalMs > 60000 ||
    options.batchSize < 1 ||
    options.batchSize > 100 ||
    options.deadlineMs < 100 ||
    options.deadlineMs > 40000
  )
    throw generationError('CONFIGURATION', 503);
  return options;
}
