# Existing-order payment and recovery

Source `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a` renders **Mark payment** in `order/templates/order/{index,show}.html`. It submits `AjaxTransactionUploadView` (`order/views.py:3020`), with cash/received cash, terminal or other online method and external references. Uploaded payments expose status/cancel controls. This is distinct from the unused `ajax-payment-status` API; visible Revert buttons are commented.

`OrdersPage` now mounts the same `PaymentPanel` used during checkout. Its paid callback refreshes order detail/invoice and the list. A newly confirmed explicit cash action or terminal reconciliation can open the protected invoice preview/print flow; a restored paid GET or saved-request replay only refreshes data. It never calls `completeSale`, clears a draft or manufactures a local paid receipt. Protected order/store scope and exact current operator/counter check-in remain mandatory. Existing method14 pending orders require the ordinary stock/wallet/consent/refund/gift projection before another payment can start. Immutable offline cash and cancellation receipts independently forbid another collection even after mutable status repair.

## Resources and durable behavior

- `GET /api/v1/stores/:storeId/orders/:orderId/payment-context` returns exact scope, current active attempt/legacy reference, creation eligibility and a static blocker. No terminal credential, raw response, contact or private hash is returned.
- `POST .../legacy-payment-recoveries` accepts `{operationId,provider:'pine'|'paytm',legacyId}`. It records one exact original dispatch; it never invokes `gateway.start`. The unique `(provider,legacy_id)` and attempt UUID commit together in `payments/legacy-migration.sql`, preserving original actor/request correlation.
- Existing payment options, attempt GET/list/create, reconciliation and Pine cancellation resources handle both new attempts and adopted transactions.

Adoption binds original transaction ID, amount/cash/received split, provider reference and one active machine in the exact order counter. Pine requires its original store code/IMEI/Plutus reference; Paytm requires exact MID/TID. Store-wide fallback, ambiguous machines/dispatches, missing proof, an unaccounted completed event and changed source financial fields are refused. Raw legacy `api_response` is never selected. New private source fingerprints have explicit version1 and fixed fields; initial versionless Pine aliases/Paytm shapes remain verifiable through an explicit compatibility decoder. Arbitrary SELECT aliases cannot enter new hashes. Both formats refuse changed source amounts, terminal identity or status even after a failed/cancelled adoption. Queries bound history to100 attempts/200 relevant events; excessive history requires explicit reconciliation.

The browser saves one validated, bounded ID/tender-only intent before dispatch. It retains old ID-only references without inventing a missing body. Reload/unknown outcome performs GET-only recovery; an absent result exposes an explicit retry of the original UUID/body. Durable storage failure prevents dispatch. Terminal reconciliation never repeats a charge. Paid callbacks restored by a read remain available for local completion recovery in the checkout component; existing-order callbacks only refresh order data.

Pine uploaded/APPROVED is pending, not paid; status `TXN APPROVED` is paid. Forced cancellation needs actual matching provider APPROVED evidence. Timeout, missing reference, transaction-not-found/in-progress or mismatched evidence remains unresolved. Paytm status success requires exact MID/TID/transaction/minor amount; local `txn_cancelled`/`NIL` flags do not prove provider cancellation. No Paytm cancellation HTTP is fabricated. Reconcile a real terminal void/failure before another collection or order cancellation.

Payment check-in/current store authorization precedes order locks. Financial history uses locking current reads; a nonlocking preflight must not establish an older REPEATABLE READ snapshot before a competing payment commits. Different operation UUIDs and cancellation share the same locked order boundary.

## Checks and limits

Run pinned Node24 with local-only `CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test`:

```sh
npx -y node@24.22.3 node_modules/typescript/bin/tsc -p tools/checkout/order-payments.tsconfig.json
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/checkout/mysql.integration.test.ts
```

Native tests cover20 concurrent adoption replays, status-only settlement, local-only Paytm cancellation, machine ambiguity, source tampering, scope/proof/tender/completed-history fences,20 competing payment UUIDs and cancellation races. Frontend `tests/order-payments` mounts the actual OrdersPage in isolated Chromium: cash completion, absent start exact retry, lost committed legacy adoption, committed/absent cancellation recovery and conservation of unrelated IndexedDB drafts/completed-sales. It uses an ephemeral Vite port/cache with `ADMINISTRATION_BROWSER_TESTS=true`; strict config is `tests/order-payments/tsconfig.json`. Production scenarios are `e2e/checkout/order-payments.spec.ts`.

No real provider request or source database write occurred. Old orders without native ordinary proofs/consent cannot be silently backfilled or charged. External legacy writers, provider terminal certification and deployed compatibility contracts remain release gates. Printing/legal document qualification is owned by the separate invoice-document slice.

## Source print triggers

Pinned `order/templates/order/show.html:550` opens auto_print after the terminal status callback reports Approved; lines872/877 open it only for Cash/Online(Others) Delivered or Cash Delivered. `_exchange_js.html:29` opens the successful replacement child order invoice. The Returns page now uses a distinct exchange-operation invoice capability after a completed POST continuation/reconciliation, with no fabricated counter payment or checkout operation; a completed GET reload does not print again. The replacement distinguishes action from read origin instead of printing an already-paid result merely loaded from history. Optional print/document failure retains the confirmed payment and the unrelated local cart. Protected same-origin previews avoid new Electron windows; source/platform/physical-printer certification remains separate.

The actual OrdersPage browser fixture checks one print request after a new cash confirmation, zero additional preview after a paid reload, retained paid state after invoice failure, and benefit-cancellation review/receipt. It also mounts separately authorized additional online/SDD/Express invoice capabilities without inferring them from store paid flags.
