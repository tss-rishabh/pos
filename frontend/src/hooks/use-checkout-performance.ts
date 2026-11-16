import { useEffect } from 'react';
import { z } from 'zod';
import { captureOperatorScope } from '../api/client';
import { performanceReadyEvent } from '../offline/performance/contracts';
import { syncPreparedPerformance } from '../offline/performance/sync';

const identifier = z.string().regex(/^[1-9]\d{0,19}$/);
const runnerScope = z
  .object({ ownerId: identifier, storeId: identifier, counterId: identifier })
  .strict();
export type CheckoutPerformanceScope = z.infer<typeof runnerScope>;
type PerformanceSync = (scope: CheckoutPerformanceScope, signal: AbortSignal) => Promise<void>;
interface RunnerOptions {
  signal: AbortSignal;
  events?: EventTarget;
  sync?: PerformanceSync;
}

// Effect restarts/StrictMode must also wait for an aborted previous pass to drain.
let performanceFlight: Promise<void> = Promise.resolve();
const defaultSync: PerformanceSync = (scope, signal) =>
  syncPreparedPerformance(scope.ownerId, scope.storeId, scope.counterId, { signal });

/** Optional metadata only; this scheduler has no order/payment or UI callbacks. */
export function startCheckoutPerformanceRunner(
  raw: CheckoutPerformanceScope,
  options: RunnerOptions,
) {
  const scope = Object.freeze(runnerScope.parse(raw));
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const events = options.events ?? window;
  const sync = options.sync ?? defaultSync;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | null = null;
  let requested = false,
    stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    events.removeEventListener(performanceReadyEvent, flush);
    signal.removeEventListener('abort', stop);
    controller.abort();
  }
  function flush() {
    if (stopped || signal.aborted) return;
    if (pending) {
      requested = true;
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const execute = async () => {
      if (stopped || signal.aborted) return;
      try {
        await sync(scope, signal);
      } catch {
        /* Keep queued metadata; financial work and its UI remain independent. */
      }
    };
    const pass = performanceFlight.then(execute, execute);
    performanceFlight = pass;
    pending = pass;
    void pass.finally(() => {
      pending = null;
      if (stopped || signal.aborted) return;
      if (requested) {
        requested = false;
        flush();
      } else timer = setTimeout(flush, 5000);
    });
  }
  if (signal.aborted) stop();
  else {
    signal.addEventListener('abort', stop, { once: true });
    events.addEventListener(performanceReadyEvent, flush);
    flush();
  }
  return { flush, stop };
}

export function useCheckoutPerformance(
  ownerId: string,
  storeId: string,
  counterId: string,
  online: boolean,
): void {
  useEffect(() => {
    if (!online || !ownerId || !storeId || !counterId) return;
    try {
      const runner = startCheckoutPerformanceRunner(
        { ownerId, storeId, counterId },
        {
          signal: captureOperatorScope(ownerId),
        },
      );
      return runner.stop;
    } catch {
      /* A stale workspace cannot start background work for another actor. */
    }
  }, [ownerId, storeId, counterId, online]);
}
