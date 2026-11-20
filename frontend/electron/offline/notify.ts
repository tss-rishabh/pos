export interface NotifierTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Coalesce status-change pushes. A sync or heartbeat calls `changed()` several times within a
 * few milliseconds (probe result, syncing on, each uploaded sale, syncing off); every push makes
 * each renderer consumer read `offline:status` again. The first call schedules one push after
 * `delayMs`; further calls before it fires are absorbed, so a burst produces a single push that
 * still reflects the final state.
 */
export function coalescedNotifier(
  send: () => void,
  delayMs: number,
  timers: NotifierTimers = {
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  },
) {
  let pending: unknown = null;
  return {
    notify() {
      if (pending !== null) return;
      pending = timers.setTimeout(() => {
        pending = null;
        send();
      }, delayMs);
    },
    cancel() {
      if (pending === null) return;
      timers.clearTimeout(pending);
      pending = null;
    },
  };
}
