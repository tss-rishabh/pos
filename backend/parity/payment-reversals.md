# Recorded payment correction

Source: `backend-pos-web` revision `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`, `order/views.py:687–775` (`AjaxPaymentStatusView.post`). The literal method executes in `tools/payment-reversals/source_oracle.py`, without Django, database, provider or source-repository writes. Five cases establish its actual behavior, including unsafe cases; this is not a claim that the unsafe source is preserved.

The source `pay_type=1` action records cash/online amounts, sets caller-selected order/payment/line statuses, appends a delivery comment and sends Kinesis/engagement jobs. The existing `PaymentPanel`/payment-attempt endpoints already supply the supported current mark-payment workflow. The retained `pay_type=0` API resets order/payment to `1/1`, changes every line to `PLACED`, replaces caller-supplied tender fields, deletes delivered comments and writes a log saying counter cash was returned. It neither confirms a provider refund nor reverses stock, wallet or membership. It also accepts already-returned lines and arbitrary amounts. The rewrite does not expose those arbitrary resets.

## Executable supported correction

An authorized current manager (roles 1–3) at the original store/counter can correct a proved, complete ordinary COC14 cash receipt. Current role, organization assignment, active check-in and counter are checked in the writer transaction; franchise role1 has no global-store bypass. The order must have native ordinary projection/consent/refund proofs, a unique current paid cash attempt matching the exact transaction/amount/cash-received mapping, no provider/split/prepaid/offline/imported settlement, and no unaccounted failed-attempt cash. It refuses partial/returned/refunded lines, shipping/OFD/delivery/return physical flags, NULL physical fulfillment flags, shipping dates/references, issued vouchers/cards and in-flight/uncertain/rejected downstream effects. Existing source `DELIVERED` line status alone means counter completion, not proof that goods were handed over. The manager separately attests that goods have never been handed over and remain at this counter.

The manager attests the **net payable cash**, after original change, has actually been returned. For an original ₹100 sale paid with ₹150, the correction is ₹100, not ₹150. A unique cash-return receipt reference is retained. This is an auditable counter cash-out attestation, not provider refund evidence. Physical cash cannot be transacted atomically with SQL; a rejected/unknown local intent must remain available for manager reconciliation. It must never instruct the operator to return cash again.

One writer transaction appends a versioned HMAC-bound correction receipt, original cash-in/cash-out movements and close-impact receipts, changes source order/payment to `1/1`, zeros current tender fields and changes the proved whole line set to `PLACED`. It appends comments/transaction audit; all original delivered comments and the original paid attempt JSON remain unchanged. No stock, wallet, voucher balance, membership, price, tax or refund rows are changed. Pending first-paid Kinesis/engagement notifications are retained as `superseded`; pending order SMS remains behind its existing writer-paid delivery guard. Only the latest close version for each affected date is marked stale, preserving every frozen figure and earlier reason/history.

The payment reader derives `status:'reversed',reversalId` only after checking the immutable compensation, original payment hash, managed-order proof and both exact money movements. `storedPaymentAttemptSchema` refuses derived status in stored payment JSON. Old paid get/list/start replay/reconcile/cancel cannot emit a paid result after correction. Current paid reads also match the exact active transaction and tender mapping, including when an older reader is deployed without the compensation adapter.

Re-payment is cash-only and uses a new attempt UUID/transaction reference. It reuses the already committed projection; it never calls order creation/confirmation, stock, wallet, membership activation or benefit restoration. A new incoming cash movement commits with the new paid state. Twenty identical contenders produce one incoming receipt. First-paid Kinesis/engagement jobs already confirmed delivered are never re-created; genuinely pending jobs superseded during correction can be published once by the later paid receipt. Unknown or rejected earlier delivery requires reconciliation. No source or payment provider is called by the correction itself.

## Original correction resources and frontend integration

The physical-return workflow below is superseded by the completed prepare/arm/attest/manager-queue protocol in [cash-return-intents.md](cash-return-intents.md). Existing receipt fields/HMACs remain readable; every new financial correction requires its exact durable intent or retained original claim. The three original resources now sit within fifteen traced correction/intent/claim resources. The old device-only retry description is historical evidence, not the current UI contract.

`registerPaymentReversals(app,config,db,options)` exports three traced resources:

- `GET /api/v1/stores/:storeId/orders/:orderId/payment-reversals`: current eligibility, opaque snapshot and latest receipt.
- `POST` at that path: strict original-payment/counter/snapshot binding, immutable UUID, cash-return UUID, exact returned amount, reason enum and both physical attestations.
- `GET .../payment-reversals/:reversalId`: original receipt recovery; no redispatch.

`PaymentReversalPanel({user,storeId,orderId,online,onCorrected?})` is exported from `frontend/src/pages/payment-reversals`. Mount for an explicit existing-order manager action. Its optional callback refreshes order/payment/invoice detail only, never archives/completes a cart or treats the correction as a paid receipt. It saves the original non-PII intent before dispatch; storage failure means no send. Lost outcomes and reload use GET only. A genuinely absent original receipt offers a separately explicit retry with the exact saved input/UUID. Saved receipt is checked against actor/store/order/counter/payment/reference/amount/reason. Confirmed correction survives a failed optional detail refresh. Actor/store transitions cannot publish stale outcomes; offline commands are disabled.

The narrow existing `PaymentPanel` change accepts a validated `reversed` view, never calls its paid callback for that view, and permits a new payment choice. Existing-order payment recovery remains separate from local cart completion.

## Required root wiring and release gates

1. Register `src/modules/checkout/payment-reversals/migration.sql` after payments/returns/delivery context, ordinary projection/consent/gift issuance, offline cash and cancellation migrations. It creates four rewrite-only tables and adds an order/kind/status index to the rewrite payment outbox. No legacy DDL, procedure or live migration was executed.
2. Supply a stable dedicated `POS_PAYMENT_CORRECTION_PROOF_KEY_V1` (at least 32 bytes) as the new module's `hashSecret` and to `paymentCorrectionEvidence(key)`/financial readers. This versioned financial proof key must be retained independently of login/session/customer-JWT rotations; do not substitute a rotating session key. Never log it. Changing the v1 key invalidates historical financial verification; a future key/profile rotation must retain the old verifier/key.
3. Pass that `paymentCorrectionEvidence(key)` through `registerCheckout(...,{paymentCorrections})` (the narrow registrar seam is included). Once corrections exist, keep the reader adapter installed even when new correction writes are disabled. Existing payment gateway hash credentials remain unchanged.
4. Register the new routes with the exact existing ordinary projection/refund configuration. Blank/default settings disable writes. Only select `POS_PAYMENT_REVERSAL_CONTRACT=pos-payment-correction-v1` and `POS_PAYMENT_CORRECTION_FINANCE_CONTRACT=pos-payment-correction-cash-ledger-v1` after the financial integration below is implemented and verified. An environment literal alone does not certify it.
5. The concrete current/history composition is now implemented and tested as described in `parity/payment-correction-finance.md`. `paymentCorrectionCashProjection(executor,{storeIds,from,to},proofKey)` runs in the **same consistent snapshot** as ordinary finance data. Add `cashAdjustment` to source cash collection, `cashOut` to cash refund/outflow, and `orderCountAdjustment` to logical order count. Ledger running cash adds `cashAdjustment-cashOut`. DSR must expose payment-only counter movements without fabricating product returns, changing quantities/revenue or silently losing collected cash. Current financial authority is writer-based. Historical BigQuery publication must include the rewrite managed-order/movement/correction proofs and consistent source tender rows; no historical MySQL fallback or missing-ledger zero fallback is permitted. The controlled adapters are executable; actual immutable warehouse publication/source-barrier qualification remains required. Keep the finance contract unselected until that production acceptance is complete.

The delta reader removes the current source `OrderStore` cash baseline exactly once and replaces it with all immutable incoming cash on their actual payment dates. It emits cash-out on the actual correction date and retains one logical order on the original source order date. After an original ₹100 payment, ₹100 returned tomorrow, and ₹100 re-paid the next day, physical cash is +100/−100/+100 on those three dates; the order counts once. A later correction, archive, source status change or original manager logout cannot erase committed movements. Missing/inconsistent hashes, source ownership, cash pairs or truncated groups fail reconciliation. The bounded reader allows up to 1,000 managed orders/10,000 movements per request; callers must use bounded store/day partitions, never publish partial results.

## Explicit remaining reconciliation boundaries

No provider refund/void is implemented or inferred. Split/card/other/prepaid, historical pre-proof funding, offline cash receipts, issued gift value, actual goods handover, ambiguous histories or external effects need qualified separate reconciliation. No fabricated legacy funding backfill is supplied. Cancelling a corrected-but-unpaid sale is also a separate reconciliation path: the existing pending-cancellation guard continues to reject its historical funded attempts instead of silently restoring benefits/stock. The concrete shared manager queue, retained old-device intake and financial fences are implemented in cash-return-intents.md; root must mount the queue once for the current store and compose its inverse handover/import guard. It never drops/replays the physical cash-out. Neither SQL proof nor manager attestation proves what physically happened at a drawer.

The original source method remains read-only. No sibling patch, deployment, tax-invoice cancellation or real charge/refund/message/order was performed. These gates mean this slice alone does not certify production readiness.

## Scoped verification

From `backend`, using the pinned Node24 runtime:

```sh
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/checkout-payment-reversals
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/checkout/mysql.integration.test.ts -t 'payment|cash|projection|terminal|Paytm|Pine'
npx -y node@24.22.3 node_modules/typescript/bin/tsc -p tools/payment-reversals/tsconfig.json
```

From `frontend`:

```sh
PAYMENT_REVERSAL_BROWSER_TESTS=true npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/payment-reversals/browser.test.ts
npx -y node@24.22.3 node_modules/typescript/bin/tsc -p tests/payment-reversals/tsconfig.json
```

Native fixtures create random localhost-only schemas, use verified physical metadata and drop those schemas. Source zero-date fixtures use the original `STRICT_TRANS_TABLES` profile only on the isolated fixture connection; production transactions never alter SQL mode. The runtime rejects NULL fulfillment flags for reconciliation. Browser tests use ephemeral loopback ports/private Vite cache directories and close them; no shared dist/default ports or live services are used. Both owned strict/lint checks run alongside the meaningful source/native/browser tests.

Recorded focused checkpoint: 29 new backend checks (27 native MySQL + two source/validation checks executing five literal source cases), 19 existing payment/projection native regressions (47 unrelated cases not selected), eight actual Chromium workflows, both owned strict TypeScript configs and scoped lint pass. No full-project/build/default-port check or live integration was run in this worktree.
