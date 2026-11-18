import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import {
  clearOrderCopyOrigin,
  markOrderCopyOrigin,
  orderCopyRequiresOnlineReview,
} from '../../src/pages/order-copy/marker';
let entries: Map<string, string>;
const checkout = '11111111-1111-4111-8111-111111111111',
  command = '22222222-2222-4222-8222-222222222222';
beforeEach(() => {
  entries = new Map();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
it('retains a separate owner-scoped online-review fence until an independently confirmed completion clears it', () => {
  expect(orderCopyRequiresOnlineReview('44', '1', checkout)).toBe(false);
  markOrderCopyOrigin('44', '1', checkout, command);
  expect(orderCopyRequiresOnlineReview('44', '1', checkout)).toBe(true);
  expect(orderCopyRequiresOnlineReview('99', '1', checkout)).toBe(false);
  clearOrderCopyOrigin('44', '1', checkout);
  expect(orderCopyRequiresOnlineReview('44', '1', checkout)).toBe(false);
});
it('fails closed on corrupt or unavailable marker storage', () => {
  markOrderCopyOrigin('44', '1', checkout, command);
  for (const key of entries.keys()) entries.set(key, 'invalid-json');
  expect(orderCopyRequiresOnlineReview('44', '1', checkout)).toBe(true);
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('fixture unavailable');
    },
  });
  expect(orderCopyRequiresOnlineReview('44', '1', checkout)).toBe(true);
  expect(() => clearOrderCopyOrigin('44', '1', checkout)).not.toThrow();
});
