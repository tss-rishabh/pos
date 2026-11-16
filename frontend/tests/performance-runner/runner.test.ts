import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startCheckoutPerformanceRunner,
  type CheckoutPerformanceScope,
} from '../../src/hooks/use-checkout-performance';
import { performanceReadyEvent } from '../../src/offline/performance/contracts';

const scope: CheckoutPerformanceScope = { ownerId: '1', storeId: '1', counterId: '1' };
const drain = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
describe('optional paid performance background runner', () => {
  const runners: ReturnType<typeof startCheckoutPerformanceRunner>[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    for (const runner of runners.splice(0)) runner.stop();
    await drain();
    vi.useRealTimers();
  });
  it('coalesces paid-ready events, never overlaps a pass and polls after completion', async () => {
    const events = new EventTarget(),
      releases: (() => void)[] = [];
    let active = 0,
      maxActive = 0,
      calls = 0;
    const runner = startCheckoutPerformanceRunner(scope, {
      events,
      signal: new AbortController().signal,
      async sync(captured, signal) {
        expect(captured).toEqual(scope);
        expect(signal.aborted).toBe(false);
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        active--;
      },
    });
    runners.push(runner);
    await drain();
    for (let index = 0; index < 20; index++) events.dispatchEvent(new Event(performanceReadyEvent));
    await vi.advanceTimersByTimeAsync(15000);
    expect(calls).toBe(1);
    releases.shift()!();
    await drain();
    expect(calls).toBe(2);
    releases.shift()!();
    await drain();
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(3);
    releases.shift()!();
    await drain();
    expect(maxActive).toBe(1);
  });
  it('aborts an old scope, drains it before a new runner and ignores its future events', async () => {
    const events = new EventTarget(),
      controller = new AbortController();
    let release: (() => void) | undefined, captured: AbortSignal | undefined;
    const calls: string[] = [];
    const first = startCheckoutPerformanceRunner(scope, {
      events,
      signal: controller.signal,
      async sync(owner, signal) {
        calls.push(owner.ownerId);
        captured = signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    runners.push(first);
    await drain();
    controller.abort();
    expect(captured?.aborted).toBe(true);
    const second = startCheckoutPerformanceRunner(
      { ...scope, ownerId: '2' },
      {
        events,
        signal: new AbortController().signal,
        async sync(owner) {
          calls.push(owner.ownerId);
        },
      },
    );
    runners.push(second);
    await drain();
    expect(calls).toEqual(['1']);
    release!();
    await drain();
    expect(calls).toEqual(['1', '2']);
    events.dispatchEvent(new Event(performanceReadyEvent));
    await drain();
    expect(calls).toEqual(['1', '2', '2']);
  });
  it('retains scheduling after optional metadata errors and stops all work on cleanup', async () => {
    const events = new EventTarget();
    let calls = 0;
    const runner = startCheckoutPerformanceRunner(scope, {
      events,
      signal: new AbortController().signal,
      async sync() {
        calls++;
        throw new Error('Synthetic optional metadata failure');
      },
    });
    runners.push(runner);
    await drain();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
    runner.stop();
    events.dispatchEvent(new Event(performanceReadyEvent));
    await vi.advanceTimersByTimeAsync(15000);
    expect(calls).toBe(2);
  });
  it('does no work for an already cancelled operator scope', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const runner = startCheckoutPerformanceRunner(scope, {
      events: new EventTarget(),
      signal: controller.signal,
      async sync() {
        calls++;
      },
    });
    runners.push(runner);
    await drain();
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls).toBe(0);
  });
});
