import { useSyncExternalStore } from 'react';
import {
  desktopOfflineBridge,
  offlineBillingClient,
  OfflineBillingClientError,
  type OfflineBillingClient,
} from './bridge';
import type { OfflineStatus } from './contracts';

export interface OfflineStatusSnapshot {
  /** The last status read; kept when a later read fails. */
  status: OfflineStatus | null;
  /** The last read's failure, cleared by the next successful read. */
  error: string | null;
}
type StatusClient = Pick<OfflineBillingClient, 'call' | 'onStatusChanged'>;
interface Timers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** One poll for every consumer; pushes from the main process cover state changes in between. */
export const OFFLINE_STATUS_POLL_MS = 15000;
const EMPTY: OfflineStatusSnapshot = Object.freeze({ status: null, error: null });

/**
 * One desktop offline-billing status shared by every consumer (header chips, the counter's
 * auto-switch and the offline billing page). While anything subscribes it holds a single push
 * subscription and a single poll; reads that overlap are merged into one call plus at most one
 * follow-up, so a burst of pushes never queues a call per consumer or per push.
 */
export function offlineStatusStore(
  client: StatusClient,
  pollMs = OFFLINE_STATUS_POLL_MS,
  timers: Timers = {
    setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
    clearInterval: (handle) =>
      globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
  },
) {
  let snapshot = EMPTY;
  const listeners = new Set<() => void>();
  let reading: Promise<void> | null = null,
    readAgain = false,
    stopPushes: (() => void) | null = null,
    poll: unknown = null;
  function publish(next: OfflineStatusSnapshot) {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }
  async function readLoop() {
    do {
      readAgain = false;
      try {
        publish({ status: await client.call('offline:status', {}), error: null });
      } catch (error) {
        publish({
          status: snapshot.status,
          error:
            error instanceof OfflineBillingClientError || error instanceof Error
              ? error.message
              : 'Offline billing could not complete this request.',
        });
      }
    } while (readAgain && listeners.size > 0);
  }
  /** Read the status now; a read already in flight is followed by exactly one more. */
  function refresh(): Promise<void> {
    if (reading) {
      readAgain = true;
      return reading;
    }
    reading = readLoop().finally(() => {
      reading = null;
    });
    return reading;
  }
  function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
      stopPushes = client.onStatusChanged(() => void refresh());
      poll = timers.setInterval(() => void refresh(), pollMs);
      void refresh();
    }
    return () => {
      if (!listeners.delete(listener) || listeners.size > 0) return;
      stopPushes?.();
      stopPushes = null;
      timers.clearInterval(poll);
      poll = null;
    };
  }
  return { subscribe, getSnapshot: () => snapshot, refresh };
}
export type OfflineStatusStore = ReturnType<typeof offlineStatusStore>;

let shared: OfflineStatusStore | null | undefined;
/** The process-wide store on desktop; null in web browsers (no offline billing bridge). */
export function sharedOfflineStatusStore(): OfflineStatusStore | null {
  if (shared === undefined) {
    const bridge = desktopOfflineBridge();
    shared = bridge ? offlineStatusStore(offlineBillingClient(bridge)) : null;
  }
  return shared;
}

const noSubscription = () => () => undefined;
const emptySnapshot = () => EMPTY;
const noRefresh = () => Promise.resolve();

/** The shared desktop offline-billing status; always empty in web browsers. */
export function useOfflineStatus(): OfflineStatusSnapshot & { refresh: () => Promise<void> } {
  const store = sharedOfflineStatusStore();
  const snapshot = useSyncExternalStore(
    store ? store.subscribe : noSubscription,
    store ? store.getSnapshot : emptySnapshot,
  );
  return { ...snapshot, refresh: store ? store.refresh : noRefresh };
}
