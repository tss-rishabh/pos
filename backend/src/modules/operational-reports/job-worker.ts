import { randomUUID } from 'node:crypto';
/** Bounded lifecycle shared by durable report workers. Side effects remain in their ledgers. */
export function boundedJobWorker<T>(
  runOne: () => Promise<T | null>,
  intervalMs: number,
  batchSize: number,
  onResult: (result: T, runId: string) => void,
  onError: (runId: string) => void,
) {
  let timer: ReturnType<typeof setInterval> | undefined,
    active: Promise<void> | undefined,
    stopping = false;
  const runOnce = () => {
    if (stopping || active) return active || Promise.resolve();
    active = (async () => {
      const runId = randomUUID();
      try {
        for (let count = 0; count < batchSize && !stopping; count++) {
          const result = await runOne();
          if (!result) break;
          onResult(result, runId);
        }
      } catch {
        onError(runId);
      }
    })().finally(() => {
      active = undefined;
    });
    return active;
  };
  return {
    runOnce,
    start() {
      if (timer || stopping) return;
      timer = setInterval(() => void runOnce(), intervalMs);
      timer.unref();
      void runOnce();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      await active;
    },
  };
}
