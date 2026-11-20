import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { orderSearchInput } from '../../src/modules/order-history/search/contracts.js';
import { sourceExcerpt } from '../golden/source-excerpts.js';

/**
 * Exact original handler (backend-pos-web 78d5b63, order/templates/order/index.html), captured
 * verbatim in tests/golden/order-search/he-submit-handler.json; the small carrier supplies only
 * form-control values.
 */
const submitHandler = sourceExcerpt('order-search', 'he-submit-handler', 'submitHandler');
function originalRejects(stores: string[], type = 'HE', ids = '') {
  let callback: ((event: { preventDefault(): void }) => unknown) | undefined,
    rejected = false;
  const document = {};
  const dollar = Object.assign(
    (selector: unknown) =>
      selector === document
        ? {
            on: (_event: string, _selector: string, handler: typeof callback) => {
              callback = handler;
            },
          }
        : {
            val: () =>
              selector === '.s_stores'
                ? stores
                : selector === 'input[name="order_type"]:checked'
                  ? type
                  : selector === '.order_id'
                    ? ids
                    : '',
          },
    {
      alert: (_message: string) => {
        rejected = true;
      },
    },
  );
  runInNewContext(submitHandler, { $: dollar, document }, { timeout: 1000 });
  if (!callback) throw new Error('Original submit handler did not register.');
  callback({
    preventDefault: () => {
      rejected = true;
    },
  });
  return rejected;
}
describe('reachable Express single-store form constraint', () => {
  it.each([[], ['1', '2'], ['1']].map((stores) => ({ stores })))(
    'matches actual original submit decision for stores $stores',
    ({ stores }) => {
      for (const ids of ['', '101']) {
        const rejected = originalRejects(stores, 'HE', ids);
        expect(rejected).toBe(stores.length !== 1);
        expect(
          orderSearchInput.safeParse({
            orderType: 'HE',
            storeIds: stores,
            orderIds: ids ? [ids] : [],
          }).success,
        ).toBe(!rejected);
      }
    },
  );
  it('retains queue and other-type semantics while hardening direct non-queue HE requests', () => {
    for (const stores of [[], ['1', '2'], ['1']]) {
      for (const queue of [{ inQueue: true }, { notPacked: true }])
        expect(
          orderSearchInput.safeParse({ orderType: 'HE', storeIds: stores, ...queue }).success,
        ).toBe(true);
      for (const type of ['ST', 'N', 'HL'] as const) {
        expect(originalRejects(stores, type)).toBe(false);
        expect(orderSearchInput.safeParse({ orderType: type, storeIds: stores }).success).toBe(
          true,
        );
      }
    }
  });
});
