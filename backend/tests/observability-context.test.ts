import { describe, expect, it } from 'vitest';
import { currentRequestTrace, withRequestTrace } from '../src/observability/context.js';

describe('durable job request correlation', () => {
  it('keeps concurrent initiating operators isolated and restores the caller context', async () => {
    const first = {
        requestId: 'request-first',
        userId: '1',
        module: 'administration',
        resource: 'historical-order-import',
      },
      second = { ...first, requestId: 'request-second', userId: '2' };
    const results = await Promise.all(
      [first, second].map((trace) =>
        withRequestTrace(trace, async () => {
          await Promise.resolve();
          return currentRequestTrace();
        }),
      ),
    );
    expect(results).toEqual([first, second]);
    expect(currentRequestTrace()).toBeNull();
  });
  it('copies only allowed identifiers and prevents later caller mutation from changing a job trace', async () => {
    const trace = {
      requestId: 'original-request',
      userId: '1',
      module: 'administration',
      resource: 'historical-order-import',
      payload: 'private-test-sentinel',
    };
    const pending = withRequestTrace(trace, async () => {
      await Promise.resolve();
      return currentRequestTrace();
    });
    trace.requestId = 'changed-request';
    expect(await pending).toEqual({
      requestId: 'original-request',
      userId: '1',
      module: 'administration',
      resource: 'historical-order-import',
    });
    expect(currentRequestTrace()).toBeNull();
  });
});
