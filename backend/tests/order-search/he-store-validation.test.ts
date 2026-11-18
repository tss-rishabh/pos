import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { orderSearchInput } from '../../src/modules/order-history/search/contracts.js';

const pin = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a';
/** Exact original handler; the small carrier supplies only form-control values. */
function originalRejects(stores: string[], type = 'HE', ids = '') {
  const source = execFileSync(
    'git',
    [
      '-C',
      process.env.ORDER_SEARCH_SOURCE_ROOT ?? resolve(process.cwd(), '../../backend-pos-web'),
      'show',
      pin + ':order/templates/order/index.html',
    ],
    { encoding: 'utf8' },
  );
  const start = source.indexOf("$(document).on('submit', '.filter-class'");
  const end = source.indexOf('\n    {% with request.path as path %}', start);
  if (start < 0 || end < 0) throw new Error('Pinned original form handler changed.');
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
  runInNewContext(source.slice(start, end), { $: dollar, document }, { timeout: 1000 });
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
