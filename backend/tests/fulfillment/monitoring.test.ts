import { describe, expect, it } from 'vitest';
import { monitorCounts } from '../../src/modules/fulfillment/monitoring.js';
import {
  maskName,
  monitoringSelection,
  namesVisible,
  hlaStoreIdsKey,
} from '../../src/modules/fulfillment/monitoring.js';
import { memoryOrderRedis } from '../../src/modules/fulfillment/order-redis.js';
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

describe('S24 names and the legacy hla_store_ids session selection', () => {
  it('masks like Helpers.mask_name and shows names only for own, checked-in or role 1', () => {
    expect(maskName('Fixture')).toBe('F*****e');
    expect(maskName('Al')).toBe('***');
    expect(maskName('Zoë Ann')).toBe('Z*****n');
    const viewer = { role: 4, storeIds: ['1'], checkedInStore: '3' };
    expect(['1', '2', '3'].map((id) => namesVisible(viewer, id))).toEqual([true, false, true]);
    expect(namesVisible({ ...viewer, role: 1 }, '2')).toBe(true);
  });
  it('keeps the selection per session until the session ends', async () => {
    const redis = memoryOrderRedis(),
      selection = monitoringSelection(redis);
    expect(await selection.read('s1')).toEqual([]);
    await selection.save('s1', Date.now() + 60_000, ['2', '2', '5']);
    expect(await selection.read('s1')).toEqual(['2', '5']);
    expect(await selection.read('s2')).toEqual([]);
    await selection.save('s3', Date.now() - 1, ['9']);
    expect(redis.snapshot().has(hlaStoreIdsKey('s3'))).toBe(false);
    await redis.set(hlaStoreIdsKey('s4'), 'not json');
    expect(await selection.read('s4')).toEqual([]);
  });
});
