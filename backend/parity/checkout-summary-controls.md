# Checkout summary and complementary-item controls

This completes the bounded `ad6f1a1` handoff implementation against backend `e9c6558`. It is implementation coverage and focused integration verification, not whole-template or native end-to-end parity admission.

## Source bindings

Pinned POS source: `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.

| Reachable source control/display                                                                                                                                                                         | Mounted rewrite and API binding                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `order/templates/order/create_order.html:450–535`: cart total, membership/non-coupon savings, Store Discount (PG), Points, coupon, gift voucher, Money, GST, total before rounding, rounding and payable | `CheckoutReview` mounts `CartQuoteSummary`; the existing checkout GET/mutation responses expose sanitized actual `quote.meta.items` and backend `quoteDisplay`. The official upstream payable is displayed independently.                                                                                                                                                                                        |
| Template `:538–545`: cashback only when `discount_eligibility == True`, with configured credit message; `order/views.py:1540/:1634` supplies eligibility/message                                         | The same operator/store/checkout/customer/version-bound `GET /api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-benefits` used by `CustomerBenefitsCard` gates cashback. Unknown/error/mismatched eligibility cannot promise an amount. `quoteDisplay.cashbackCreditMessage` preserves configured text, including explicit empty text.                                                               |
| Template `:156–174/:1601`: regular and complimentary item names/details, quantity/prices; complimentary quantity is readonly but Remove is active                                                        | `CheckoutCartLines` renders actual provider ordinary/complementary rows, safe string IDs and parent/SKU detail links. It does not invent stock, prices, quantities or local draft entries. Physical gift cards retain their separate `GiftCardItems` controls.                                                                                                                                                   |
| Template `:2583`: Remove posts AjaxCart `opr=delete` for selected product ID                                                                                                                             | Complimentary Remove calls the existing `PUT /api/v1/stores/:storeId/checkout-sessions/:checkoutId/line-items/:productId` with quantity zero through `CheckoutReview.act/mutate`, retaining operation UUID/version/recovery. Backend `service.changeLine` dispatches `deleteCartPayload` for zero even when the SKU exists only in complementary products; `cartMutation` clears quote and returns phase `open`. |

The source's derived `total_savings - coupon_discount` and `total + rounding_off` come from the same quote through backend `quoteDisplay`; the browser does not calculate totals. Formatting preserves supplied decimal strings without Number conversion, summation or rounding. Missing or invalid fields remain explicitly unavailable rather than becoming zero. The existing official payable and payment calculations are unchanged.

The display labels a non-current quote and hides cached customer eligibility while a mutation, offline condition, actor/draft mismatch, or incomplete import prevents current review. The existing checkout confirmation/version/authority guards remain in force. Complementary removal does not rewrite the initial draft manifest, repeat order creation, or change financial policy.

## Validation

Node 24, caller-owned mitigated dependencies, no live database/provider writes:

```sh
cd frontend
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p tests/checkout-actions/tsconfig.json
node node_modules/eslint/bin/eslint.js src/pages/checkout/CartQuoteSummary.tsx src/pages/checkout/CheckoutCartLines.tsx src/pages/checkout/quote-summary.ts src/pages/checkout/CheckoutReview.tsx src/pages/checkout/client.ts tests/checkout-actions
CHECKOUT_ACTIONS_BROWSER_TESTS=true node node_modules/vitest/vitest.mjs run tests/checkout-actions
node node_modules/vite/bin/vite.js build
```

Executed results: main and focused strict checks, changed-file lint and production build pass. Four unit cases cover exact decimal formatting, missing/duplicate calculation rows, current quote identity, and high-ID/provider-line parsing. Seven controlled Chromium cases cover normal/missing/stale summaries, eligible/ineligible/mismatched-customer cashback, configured messaging, detail links and the exact complementary removal command plus quote invalidation. All 11 cases pass.

The browser harness mounts the production components with synthetic quote state, controlled benefit HTTP responses and a recording checkout mutation callback. It verifies presentation and action binding; it does **not** certify native financial effects, Django rendering, full application authentication, provider behavior, or the full create-order template. Original source/runtime receipts remain unchanged. The full checkout action inventory and joined source/native/App admission are separate work.
