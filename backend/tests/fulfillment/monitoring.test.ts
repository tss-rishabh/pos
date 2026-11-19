import { describe, expect, it } from 'vitest';
import { monitorCounts } from '../../src/modules/fulfillment/monitoring.js';
describe('all-store monitoring reader safety', () => {
  it('keeps source summed per-status distinct counts instead of deduplicating across shipped statuses', () =>
    expect(
      monitorCounts([
        { status: 'OUT_FOR_DELIVERY', count: 2 },
        { status: 'DELIVERED', count: 2 },
        { status: 'RTO', count: 1 },
      ]).shipped,
    ).toBe(5));
});
