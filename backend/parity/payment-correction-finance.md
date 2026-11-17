# Recorded payment corrections in finance

This composes the executable payment correction introduced in `parity/payment-reversals.md`. Original receipt, correction and each later incoming cash remain immutable. It does not create product returns, change revenue/quantity, refund a provider, or replay stock/wallet/membership work.

Current collection/day-close uses `collectionSnapshot(executor,storeId,date,corrections)`. `financeService` accepts the same options as its fifth constructor argument, after check-ins. Current ledger accepts them as the sixth `cashLedgerService` argument, after its clock. `reportService` accepts `dependencies.paymentCorrections`; an optional `paymentCorrectionQuery` is the private historical query port. Normal defaults read `paymentCorrectionFinanceOptions(process.env)`. `registerFinance(...,{paymentCorrections})` passes those options to its service and ledger. No parent app/config/migration file was edited.

Options are `{proofKey?,publicationTable?}`. Use the retained versioned `POS_PAYMENT_CORRECTION_PROOF_KEY_V1` and optional `BQ_PAYMENT_CORRECTION_PUBLICATIONS_TABLE`. Empty values remain unconfigured. Keep the proof key for historical reads even when new correction writes are disabled. Neither the session key nor a customer token is a substitute. Source/publisher readiness is a separate rollout gate; these settings alone do not prove it.

## Current money conservation

The same repeatable-read transaction reads source cash, offline receipt proof and native correction evidence. A managed order's current `OrderStore` cash baseline is removed once. Every immutable incoming cash movement is added on its recorded payment business date; every actual correction outflow is added to cash refunds on its correction date. Logical order count remains once, on the original order date. A later source payment/order/archive status cannot erase that cash. Genuine product-return cash refunds remain separate existing outflows.

Current ledger anchor, close, banking, source cash and correction evidence now use one read-only repeatable-read transaction. Frozen close figures remain unchanged; the correction writer's latest-close impact/status remains authoritative. Missing or changed proof, source ownership, original/later incoming movement, paired cash-out, oversized/truncated group or missing stable key refuses financial projection. The native reader checks JSON byte/count budgets before loading bodies (2MB per body,16MB combined;1,000 managed orders/10,000 movements maximum).

Daily store reporting keeps the literal source HP/product/category/status/tax/benefit predicates and native rounding. It removes only verified managed-order cash/count/payment residuals from the source aggregate, then adds actual-date incoming cash and one original-date order. This is necessary because source `pay_amt-cash-district` would otherwise report fictitious online money when reversal zeros current cash. The managed predicate uses the already verified bounded native order IDs, avoiding a cross-collation string join and a correlated rewrite lookup for every HP. It never expands quantity or fabricates a return/revenue row.

The DSR response adds `payment_correction_cash_out` and `cash_after_payment_corrections` when these projections are present. `cash` is gross recognized incoming cash, including existing ordinary/offline sales; the latter field subtracts only these payment-correction outflows, not unrelated product returns. Parent presentation can display both fields. One₹100 receipt,₹100 corrected tomorrow,₹100 re-paid the next day gives cash-in100/0/100, correction outflow0/100/0, and one order/unchanged source quantity and revenue.

## Historical publication contract

Historical or mixed ranges stay in BigQuery. No historical MySQL fallback is introduced. A private `pos-payment-correction-finance-publication-v1` partition is required for every requested store/date, including an explicit signed zero partition. Missing rows never become zero. Daily deltas share the existing DSR generation, source position, CDC watermark and publication timestamp. Each binds the existing native BigQuery store-row hash (or explicit null for no store row), exact managed-source cash/online/count removals, immutable incoming cash, correction outflow and logical count. The unchanged source quantity/revenue/benefit metrics remain in the source row. A mismatched baseline refuses the whole result.

Historical ledger's four source views must expose immutable `generation_id`. Every query binds the selected complete correction generation. A canonical baseline digest binds source anchor, latest close, banking and source/offline-only cash DTOs for each store/date. The sealed delta replaces the mutable cash baseline and adds outflow; it never adds these amounts twice to frozen close figures. If an earlier anchor is required, the full intervening chain must also have complete same-generation partitions. Explicit zero partitions are the only permitted missing-source representation.

`sealPaymentCorrectionPartition` is a private publisher primitive, not an HTTP endpoint or a claim that a publisher has run. A qualified publisher must execute native correction proof checks, independently prove source/warehouse completeness at one common source position, compute the original source baseline/managed contributions, and seal exact deltas after those checks. It must retain all imported offline-cash proof rules, immutable receipts and late close impacts. Cash and source rows must never come from independently advancing tables. The review-only relation is `compatibility/payment-reversals/history-publication.review.sql`; it is deliberately outside automatic MySQL migrations. No BigQuery DDL, publication job or live source/provider write was executed.

Reader safeguards include strict money/ID/body schemas, scope/kind/generation/position/timezone binding, constant-time HMAC comparison, duplicate/missing partition rejection, publication/CDC freshness and clock-skew checks,70,000 partition/16MB result bounds and no signing key in query parameters or logs. This contract is independent of the existing offline-only DSR publication; an old rollup/CDC marker cannot authorize corrected tender history.

Keep `POS_PAYMENT_CORRECTION_FINANCE_CONTRACT` unselected until the real immutable publisher/source barrier and all downstream exports/UI are qualified. Local native and controlled warehouse tests establish code behavior, not deployed BigQuery completeness or production readiness.

## Scoped checks

From backend:

```sh
npx -y node@24.22.3 node_modules/typescript/bin/tsc -p tools/payment-correction-finance/tsconfig.json
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test MYSQL_INTEGRATION_URL=mysql://root@127.0.0.1/pos_rewrite_finance_test npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/checkout-payment-reversals tests/finance tests/reports/warehouse-publication.test.ts tests/reports/warehouse-adapter.test.ts
```

Fixtures create/drop uniquely named localhost schemas and mock only external warehouse responses. Tests cover repeated corrections/re-payments, three distinct business dates, one logical order, retained quantities/revenue, no fake online residual, repeatable-read race, later refunds/status/archive changes, missing later incoming cash, malformed/oversized proof, actual current ledger, three-date historical DSR/ledger, common-generation/native baseline binding, signed zero vs missing partitions, stale/mixed/altered seals and no historical MySQL access. No whole-project verification, shared build/default port or live provider was used in this worktree.

Focused checkpoint:95 checks in13 files pass, including real isolated MySQL current/ledger/DSR/concurrency/rollback/proof/index cases, retained source regressions, and controlled immutable historical publications. The new strict config and scoped lint pass. This is a local implementation checkpoint; the finance rollout contract remains unselected.


## Cash-return control qualification update

The completed durable intent extension is documented in [cash-return-intents.md](cash-return-intents.md). Historical publication now requires `pos-payment-correction-finance-publication-v2`, including the current authenticated day/prefix heads and a fresh qualification generation separate from the immutable source data generation. v1/missing/lagging control metadata is rejected. Current DATA financial snapshots are bracketed by matching current writer head checks; pending physical cash returns block affected final figures. This extends the earlier v1 design above; it does not certify a deployed publisher or perform warehouse writes.
