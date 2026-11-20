import { describe, expect, it, vi } from 'vitest';
import { OfflineBillingClientError } from '../../src/offline/billing/bridge';
import type { OfflineStatus } from '../../src/offline/billing/contracts';
import { offlineStatusStore } from '../../src/offline/billing/status-store';

const status = (online: boolean) => ({ online }) as unknown as OfflineStatus;

function fakeClient() {
  const pushes = new Set<() => void>();
  const pending: ((value: OfflineStatus) => void)[] = [];
  const failures: Error[] = [];
  const call = vi.fn(
    () =>
      new Promise<OfflineStatus>((resolve, reject) => {
        const failure = failures.shift();
        if (failure) reject(failure);
        else pending.push(resolve);
      }),
  );
  return {
    client: {
      call: call as never,
      onStatusChanged(listener: () => void) {
        pushes.add(listener);
        return () => pushes.delete(listener);
      },
    },
    call,
    pushes,
    failures,
    answer(online: boolean) {
      pending.shift()?.(status(online));
    },
  };
}
const fakeTimers = () => {
  const intervals = new Map<number, () => void>();
  let next = 1;
  return {
    intervals,
    timers: {
      setInterval: (callback: () => void) => {
        intervals.set(next, callback);
        return next++;
      },
      clearInterval: (handle: unknown) => void intervals.delete(handle as number),
    },
  };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('shared desktop offline status', () => {
  it('serves every consumer from one subscription, one poll and one read', async () => {
    const fake = fakeClient(),
      { intervals, timers } = fakeTimers();
    const store = offlineStatusStore(fake.client, 15000, timers);
    const consumers = [vi.fn(), vi.fn(), vi.fn()];
    const stops = consumers.map((consumer) => store.subscribe(consumer));
    expect(fake.pushes.size).toBe(1);
    expect(intervals.size).toBe(1);
    expect(fake.call).toHaveBeenCalledTimes(1);
    fake.answer(true);
    await settle();
    expect(store.getSnapshot()).toEqual({ status: status(true), error: null });
    for (const consumer of consumers) expect(consumer).toHaveBeenCalledTimes(1);
    stops.forEach((stop) => stop());
    expect(fake.pushes.size).toBe(0);
    expect(intervals.size).toBe(0);
  });

  it('merges a burst of pushes into the read in flight plus one follow-up', async () => {
    const fake = fakeClient(),
      { timers } = fakeTimers();
    const store = offlineStatusStore(fake.client, 15000, timers);
    store.subscribe(vi.fn());
    for (let index = 0; index < 5; index++) for (const push of fake.pushes) push();
    expect(fake.call).toHaveBeenCalledTimes(1);
    fake.answer(true);
    await settle();
    expect(fake.call).toHaveBeenCalledTimes(2);
    fake.answer(false);
    await settle();
    expect(fake.call).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().status).toEqual(status(false));
  });

  it('keeps the last status when a read fails and reports the failure', async () => {
    const fake = fakeClient(),
      { timers } = fakeTimers();
    const store = offlineStatusStore(fake.client, 15000, timers);
    store.subscribe(vi.fn());
    fake.answer(true);
    await settle();
    fake.failures.push(new OfflineBillingClientError('INVALID_REPLY', 'Invalid reply.'));
    await store.refresh();
    expect(store.getSnapshot()).toEqual({ status: status(true), error: 'Invalid reply.' });
  });
});
