import { describe, expect, it } from 'vitest';
import {
  BACKWARD_TOLERANCE_MS,
  DEFAULT_LIMITS,
  advanceWindow,
  evaluateLimits,
  resetWindow,
} from '../../src/offline/billing/limits';

const minute = 60_000;

describe('offline limit defaults', () => {
  it('uses 120 minutes / 10 orders until the backend environment values arrive', () => {
    expect(DEFAULT_LIMITS).toEqual({ maxMinutes: 120, maxOrders: 10 });
  });
});

describe('offline billing window', () => {
  const start = Date.UTC(2026, 10, 19, 10, 0, 0);
  it('requires one server contact before billing offline', () => {
    expect(evaluateLimits(DEFAULT_LIMITS, null, 0)).toMatchObject({
      allowed: false,
      reason: 'NEVER_CONNECTED',
    });
  });
  it('blocks the 11th order and reports usage', () => {
    const window = resetWindow(start);
    expect(evaluateLimits(DEFAULT_LIMITS, window, 9).allowed).toBe(true);
    const blocked = evaluateLimits(DEFAULT_LIMITS, window, 10);
    expect(blocked).toMatchObject({ allowed: false, reason: 'ORDER_LIMIT', ordersUsed: 10 });
    expect(blocked.message).toContain('10 of 10 orders');
  });
  it('blocks at minute 120 using monotonic elapsed time', () => {
    let state = resetWindow(start);
    let session = { lastMonoMs: 1_000 };
    let step = advanceWindow(
      state,
      { wallMs: start + 119 * minute, monoMs: 1_000 + 119 * minute },
      session,
    );
    state = step.state;
    session = step.session;
    expect(evaluateLimits(DEFAULT_LIMITS, state, 0).allowed).toBe(true);
    step = advanceWindow(
      state,
      { wallMs: start + 120 * minute, monoMs: 1_000 + 120 * minute },
      session,
    );
    const result = evaluateLimits(DEFAULT_LIMITS, step.state, 0);
    expect(result).toMatchObject({ allowed: false, reason: 'TIME_LIMIT', minutesUsed: 120 });
  });
  it('applies whichever limit is hit first with configured values', () => {
    const limits = { maxMinutes: 5, maxOrders: 3 };
    const state = advanceWindow(
      resetWindow(start),
      { wallMs: start + 5 * minute, monoMs: 5 * minute },
      { lastMonoMs: 0 },
    ).state;
    expect(evaluateLimits(limits, state, 1).reason).toBe('TIME_LIMIT');
    expect(evaluateLimits(limits, resetWindow(start), 3).reason).toBe('ORDER_LIMIT');
  });
  it('ignores a forward wall-clock jump while running (monotonic time counts)', () => {
    const step = advanceWindow(
      resetWindow(start),
      { wallMs: start + 10 * 3600_000, monoMs: 10 * minute },
      { lastMonoMs: 0 },
    );
    expect(step.state.elapsedMs).toBe(10 * minute);
    expect(step.state.tampered).toBe(false);
  });
});

describe('clock-tamper guard', () => {
  const start = Date.UTC(2026, 10, 19, 10, 0, 0);
  it('expires the window when the wall clock goes backwards while running', () => {
    const step = advanceWindow(
      resetWindow(start),
      { wallMs: start - 30 * minute, monoMs: 5 * minute },
      { lastMonoMs: 0 },
    );
    expect(step.state.tampered).toBe(true);
    expect(evaluateLimits(DEFAULT_LIMITS, step.state, 0).reason).toBe('CLOCK_INCONSISTENT');
  });
  it('tolerates small NTP adjustments', () => {
    const step = advanceWindow(
      resetWindow(start),
      { wallMs: start + 5 * minute - BACKWARD_TOLERANCE_MS + 1_000, monoMs: 5 * minute },
      { lastMonoMs: 0 },
    );
    expect(step.state.tampered).toBe(false);
  });
  it('counts the time the app was closed after a restart', () => {
    const persisted = {
      ...resetWindow(start),
      elapsedMs: 30 * minute,
      lastWallMs: start + 30 * minute,
    };
    const step = advanceWindow(persisted, { wallMs: start + 90 * minute, monoMs: 12 }, null);
    expect(step.state.elapsedMs).toBe(90 * minute);
    expect(step.state.tampered).toBe(false);
    expect(step.session).toEqual({ lastMonoMs: 12 });
  });
  it('expires the window when the app restarts with an earlier wall clock', () => {
    const persisted = {
      ...resetWindow(start),
      elapsedMs: 30 * minute,
      lastWallMs: start + 30 * minute,
    };
    const step = advanceWindow(persisted, { wallMs: start + 10 * minute, monoMs: 5 }, null);
    expect(step.state.tampered).toBe(true);
  });
  it('expires the window when a restart sees less wall time than persisted elapsed time', () => {
    const persisted = {
      ...resetWindow(start),
      elapsedMs: 60 * minute,
      lastWallMs: start + 20 * minute,
    };
    const step = advanceWindow(persisted, { wallMs: start + 21 * minute, monoMs: 5 }, null);
    expect(step.state.tampered).toBe(true);
  });
  it('keeps the window expired once tampering was observed', () => {
    const tampered = { ...resetWindow(start), tampered: true };
    const step = advanceWindow(
      tampered,
      { wallMs: start + minute, monoMs: minute },
      { lastMonoMs: 0 },
    );
    expect(step.state.tampered).toBe(true);
    expect(resetWindow(start + 2 * minute).tampered).toBe(false);
  });
});
