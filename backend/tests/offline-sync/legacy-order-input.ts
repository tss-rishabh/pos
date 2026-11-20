/**
 * Oracle input for tests/golden/offline-sync/legacy-order.json. The capture fed exactly
 * `JSON.stringify(legacyOrderInput)` to the legacy oracle; any change here needs a recapture from
 * the pinned source (tests/golden/INVENTORY.md, "V2").
 *
 * The cart is the one the rewrite test's fake API-v2 serves (product 10, quantity 1, 499), at
 * store 1, counter 3, salesperson 5, operator 44 whose storefront user (MUser) is 777, as in
 * tests/checkout/fixtures.ts. `tab_id` is a per-sale identifier: the legacy case uses a fixed
 * value and the test substitutes it.
 */
export const legacyTabId = 424242;
export const legacyOrderReply = { order: 7001, method: 'coc', isValid: true, name: 'Fixture' };
export const legacyCart = {
  products: { items: [{ prod_id: 10, quantity: 1, prod_type: 1, price: 499 }] },
  giftvouchers: { items: [] as unknown[] },
  meta: { items: [{ name: 'calculations', total: 499 }] },
};
const post = {
  user_id: 0,
  store_id: 1,
  counter_id: 3,
  tab_id: legacyTabId,
  auth_token: 'fixture-token',
  end_user: 0,
  nps_feedback_switch: 'false',
  total_payable: '499.00',
  performance_json: '{}',
  overall_performance_time: '',
};
export const legacyOrderInput = {
  cases: [
    {
      name: 'walk-in cart with a master salesperson',
      post,
      posAdminId: 44,
      adminCustomerId: 777,
      store_id: 1,
      redis: { [`1_${legacyTabId}`]: '5' },
      cart: legacyCart,
      apiReply: legacyOrderReply,
    },
  ],
  comment: { orderId: 7001, orderStatus: 1, comment: '<comment text>', userId: 44 },
};
