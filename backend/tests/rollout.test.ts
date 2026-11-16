import { it, expect } from 'vitest';
import { parseStoreRollout, storeRolloutEnabled } from '../src/domain/rollout.js';
it('uses exact ALL semantics and preserves source numeric/category selection', async () => {
  expect(parseStoreRollout(' all ')).toEqual({ all: true, ids: [], categories: [] });
  expect(parseStoreRollout('ALL, COCO,001,1,FOFO,unknown')).toEqual({
    all: false,
    ids: [1n],
    categories: ['IN_HOUSE', 'FRANCHISE'],
  });
  const unavailable = () => {
    throw new Error('No metadata query expected.');
  };
  expect(await storeRolloutEnabled(unavailable, 'unknown', 1, '0')).toBe(true);
  expect(await storeRolloutEnabled(unavailable, 'ALL', 5, '0')).toBe(true);
  expect(await storeRolloutEnabled(unavailable, '001', 5, '1')).toBe(true);
  expect(await storeRolloutEnabled(unavailable, 'ALL,unknown', 5, '1')).toBe(false);
});
