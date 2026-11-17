# Fast cash checkout

This is a bounded fast-cash orchestration slice, not certification of every original fast-checkout form field or deployed provider. It uses the existing checkout submission and cash payment resources. No extra financial endpoint, order reprice, fabricated receipt or automatic retry is introduced.

## Source evidence

The source is `backend-pos-web` at `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`: `order/views.py` (`AjaxFastCheckoutView`) and `order/templates/order/create_order.html` (`fast_checkout_button_press`, `CashProceedButtonFast`). `tools/checkout/fast_cash_oracle.py` extracts and executes the literal Python `complete_transaction` method without importing Django, network clients or persistent models. The default command only verifies the checked-in vectors; regeneration requires explicit `--write`.

The seventeen synthetic vectors cover default zero/blank received cash, exact cash, change, decimal payables, helper rejection and the original zero-total failure. They preserve source cash/default behavior. The new zero-total branch uses the existing independently verified prepaid checkout evidence and accepts no cash. This is an explicit correction approved during implementation; it does not manufacture a cash attempt for a zero-total order.

The source positive-cash form requires a master salesperson and a resolved product assignment. The review now exposes master/per-product controls using the existing versioned checkout mutation. The primary-reader picker is `GET /api/v1/stores/:storeId/salespeople?purpose=checkout&active=true&after=0&limit=100`; the administration owner enforces a current active assignment to that store and returns only IDs/names. The writer mutation rechecks the assignment. IDs above `2147483647` are rejected because legacy order salesperson columns are signed INT even though the directory uses BIGINT. Per-product choices must reference this checkout. A master assignment supplies the default for unoverridden lines, matching the source assignment fallback.

## Durable behavior

`frontend/src/offline/fast-cash/commands.ts` freezes the original reviewed draft/version, server checkout/version, canonical quote digest, exact payable/received amount and original order/payment operation IDs before dispatch. IndexedDB V7 has one active intent per original operator/store/counter. The command contains no customer contact data, cart payload, OTP, token, free-text message or salesperson name.

The first explicit action saves the source-format editable cash message on the server, then can submit the order and complete its exact cash payment. Each financial stage is claimed and checkpointed before a POST. A lost response, reload, another tab or timer performs GET-only reconciliation. A further explicit action first checks the original server result and can retry only the original immutable intent/UUID when the result remains absent. An unresolved server operation cannot be replaced or redispatched. Positive cash completion requires the exact original paid cash-attempt evidence; prepaid completion requires the original checkout-operation evidence. Existing production projection, refund-allocation, customer-freshness and gift-card gates still apply.

`GET/PUT /api/v1/stores/:storeId/checkout-sessions/:checkoutId/settlement-note` is owner-scoped and explicitly traced. PUT uses the existing version/idempotency lease, requires a positive final quote and binds the message to its exact payable/received cash with an HMAC. General checkout and payment DTOs return only the hash/amount metadata; only the protected note read returns its text. The browser command retains only the hash. Payment accepts only the checkout ID/hash, locks and checks the original writer checkout and amounts, then copies its private message into the attempt before settlement. The same paid transaction writes `OrderStore.message` and the cash/status/ledger changes. Replay uses the frozen attempt text. The verified physical column is `VARCHAR(255) latin1_swedish_ci`; unsupported characters and overlong/blank text are rejected before financial work instead of lossy conversion. Ordinary payments with no explicit note retain the existing `Complete` default. Clear/detach removes the private draft note.

The local session, current role/type/store scope, captured actor, expiry and logout tombstone are rechecked before claim and publication. A stale observer cannot overwrite a newer fenced claim. After server payment is proved, the existing `completeSale` transaction conserves concurrently edited local lines under a new draft UUID. Only a matching durable local completion retires the active intent pointer; the original command/receipt remains. An old completion callback cannot erase a new intent.

`FastCashCheckout` is mounted in `CheckoutReview`. A pending fast intent disables the normal payment path until its identity/outcome is reconciled, and its first IndexedDB read completes before the ordinary payment panel can mount. Existing customer profile editor, insight, approval and clear/recovery controls are preserved. Paid invoices use the protected same-origin preview and print dialog instead of a new browser window, which also works with the Electron navigation policy.

## Checks

Use the pinned Node 24 LTS toolchain:

```sh
cd backend
node node_modules/typescript/bin/tsc -p tools/checkout/fast-cash.tsconfig.json
node node_modules/vitest/vitest.mjs run tests/checkout/fast-cash-source.test.ts tests/checkout/service.test.ts
cd ../frontend
node node_modules/typescript/bin/tsc -p tests/fast-cash/tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run tests/fast-cash.test.ts
npm run build
node node_modules/@playwright/test/cli.js test e2e/checkout/fast-cash.spec.ts
```

The real IndexedDB tests cover twenty simultaneous preparations across two database handles, durable pre-dispatch state, lost committed/uncommitted order/payment replies, restart, GET-only recovery, exact explicit retry, zero prepaid, actor/role changes, invalid money/scope/snapshot/note binding, local storage failures, stale read fencing, newer-cart conservation and old-callback/new-intent isolation. Isolated MySQL checks reject wrong note/hash/checkout/amount before an attempt exists, serialize twenty cash starts into one note/ledger, round-trip supported Latin text, roll back a late SQL failure and repair from the original frozen attempt after cart text changes. The production Chromium fixture covers normal cash with master/product selection, edited message and protected print invocation; a lost note response before any financial intent; lost order plus newer local quantity; lost committed payment recovery; and prepaid without a cash attempt. All gateway/provider outcomes are controlled fixtures; these checks never create a live order or charge/send anything.

## Current coverage and remaining boundaries

Current timing coverage and the remaining source/acceptance boundaries are separated below:

- Source `performance_json`/`overall_performance_time` capture and independently receipted postpaid persistence are implemented; see [checkout-performance.md](checkout-performance.md). Optional timing failure never changes a confirmed financial result.
- Protected automatic invoice preview/print invocation follows a newly proved completion. A restored paid read does not replay printing; the ordinary manual preview/print action remains available. Physical macOS/Windows printer output and legal/provider qualification still require the separate invoice/desktop acceptance evidence.
- The CSV `custom_created_at`/backdated helper and `parse_csv_offline_order_punchin` job remain inventoried dormant source functionality: the web enqueue and upload/download views are commented out, and no URL mounts them. Active fast cash has no manual-date field. Pending cash-on-counter whole-order cancellation is implemented separately; its stock/provider/projection and benefit/provenance rollout gates remain in `pending-order-cancellation.md`. Recorded paid cash correction is a distinct bounded workflow in `payment-reversals.md`.

No sibling source repository was edited or compatibility patch deployed. The broader [checkout release gaps](checkout.md) remain in force.
