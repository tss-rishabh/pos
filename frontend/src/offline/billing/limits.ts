/** Offline billing window and clock-tamper guard (Phase D2 item 5b).
 *
 * The window starts at the device's last successful server contact while the
 * queue was empty. While the app runs, each step adds the larger of the
 * monotonic and the wall-clock delta: the monotonic clock stops during system
 * sleep on some platforms, so sleep never pauses the window, and a forward
 * wall-clock jump can only shorten it. The main process also steps the window
 * on power resume. Elapsed time is persisted every minute. Across restarts the
 * wall-clock gap is added (the window keeps running while the app is closed).
 * If the wall clock moves backwards, or a restart observes a wall clock
 * inconsistent with the persisted elapsed time, the window is treated as
 * expired. */
export interface OfflineLimits {
  maxMinutes: number;
  maxOrders: number;
}
/** Used until the device first receives the backend's OFFLINE_BILLING_MAX_*
 * environment values (GET /api/v1/offline-billing/settings). */
export const DEFAULT_LIMITS: Readonly<OfflineLimits> = Object.freeze({
  maxMinutes: 120,
  maxOrders: 10,
});
/** NTP slews and suspend/resume jitter stay below this; larger backwards
 * movement is treated as tampering. */
export const BACKWARD_TOLERANCE_MS = 120_000;

export interface WindowState {
  startedAtWallMs: number;
  elapsedMs: number;
  lastWallMs: number;
  tampered: boolean;
}
export interface ClockReading {
  wallMs: number;
  /** Process-local monotonic milliseconds (performance.now()). */
  monoMs: number;
}
/** In-memory monotonic anchor; null for the first reading after a restart. */
export interface ClockSession {
  lastMonoMs: number;
}

export function resetWindow(wallMs: number): WindowState {
  return { startedAtWallMs: wallMs, elapsedMs: 0, lastWallMs: wallMs, tampered: false };
}

export function advanceWindow(
  state: WindowState,
  reading: ClockReading,
  session: ClockSession | null,
): { state: WindowState; session: ClockSession } {
  const next: WindowState = { ...state };
  const nextSession: ClockSession = { lastMonoMs: reading.monoMs };
  if (!Number.isFinite(reading.wallMs) || !Number.isFinite(reading.monoMs))
    return { state: { ...next, tampered: true }, session: nextSession };
  if (session === null) {
    const gap = reading.wallMs - state.lastWallMs;
    if (gap < -BACKWARD_TOLERANCE_MS) next.tampered = true;
    else next.elapsedMs += Math.max(0, gap);
    // The wall clock must account for at least the persisted elapsed time.
    if (reading.wallMs - state.startedAtWallMs + BACKWARD_TOLERANCE_MS < next.elapsedMs)
      next.tampered = true;
  } else {
    const monotonic = Math.max(0, reading.monoMs - session.lastMonoMs),
      wall = reading.wallMs - state.lastWallMs;
    if (wall + BACKWARD_TOLERANCE_MS < monotonic) next.tampered = true;
    // Sleep pauses the monotonic clock (macOS) but not the wall clock: count the larger.
    next.elapsedMs += Math.max(monotonic, wall);
  }
  next.lastWallMs = Math.max(state.lastWallMs, reading.wallMs);
  return { state: next, session: nextSession };
}

export type LimitBlock = 'NEVER_CONNECTED' | 'CLOCK_INCONSISTENT' | 'TIME_LIMIT' | 'ORDER_LIMIT';
export interface LimitEvaluation {
  allowed: boolean;
  reason: LimitBlock | null;
  minutesUsed: number;
  ordersUsed: number;
  maxMinutes: number;
  maxOrders: number;
  message: string;
}

export function evaluateLimits(
  limits: OfflineLimits,
  window: WindowState | null,
  unsyncedOrders: number,
): LimitEvaluation {
  const minutesUsed = window
      ? Math.min(limits.maxMinutes, Math.floor(window.elapsedMs / 60000))
      : 0,
    usage = `${minutesUsed} of ${limits.maxMinutes} minutes and ${unsyncedOrders} of ${limits.maxOrders} orders used.`;
  const result = (reason: LimitBlock | null, message: string): LimitEvaluation => ({
    allowed: reason === null,
    reason,
    minutesUsed,
    ordersUsed: unsyncedOrders,
    maxMinutes: limits.maxMinutes,
    maxOrders: limits.maxOrders,
    message,
  });
  if (!window)
    return result(
      'NEVER_CONNECTED',
      'Connect this device to the store service once before billing offline.',
    );
  if (window.tampered)
    return result(
      'CLOCK_INCONSISTENT',
      'Offline billing is paused because the device clock changed. Reconnect and sync to continue. Reprint and sync remain available.',
    );
  if (window.elapsedMs >= limits.maxMinutes * 60000)
    return result(
      'TIME_LIMIT',
      `Offline time limit reached: ${usage} Reconnect and sync before billing again. Reprint and sync remain available.`,
    );
  if (unsyncedOrders >= limits.maxOrders)
    return result(
      'ORDER_LIMIT',
      `Offline order limit reached: ${usage} Reconnect and sync before billing again. Reprint and sync remain available.`,
    );
  return result(null, `Offline billing available: ${usage}`);
}
