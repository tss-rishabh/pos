# W2 deletion follow-ups

Workstream W2 removed the subsystems listed in `AGENTS.md` ("Single-stack and
schema-freeze decisions" and "Revisions, 19 November 2026"). This file lists
what the deletions left for the re-homing workstreams (W3–W5) and the parity
evidence gaps they opened. Legacy references are to `backend-pos-web@78d5b63`
unless another repository is named. No entry below is implemented. Each one is
an open item, not parity evidence.

## Screening subsystem and CSV order import (commit 1)

- **W4: Membership-order cancellation fence.**
  `src/modules/checkout/cancellations/membership-fence.ts` used to require the
  four rewrite-installed `pos_rewrite_mem_*` triggers on `user_eav`/`users`. It
  read them through the deleted screening `native-head-metadata` routine. Those
  triggers do not exist in production and are forbidden by the schema freeze, so
  the trigger part of the fence and `membership-fence-contract.ts` were removed.
  The column and index checks remain. Decide whether membership cancellations
  need a Redis lock, or whether legacy behaviour is enough. Legacy cancels
  through `order/views.py:2900` (`AjaxOrderCancelView`) with no such fence.
- **W4: Import-order holds removed from financial writers.** Payments, returns,
  pending cancellations, the finalizer and the whole-order-status handover no
  longer call `assertImportOrderMutationAvailable`. The order-import binding
  table that held imported orders is gone. Legacy has no equivalent hold
  because CSV order punch-in is disabled (`core/urls.py:72-76`).
- **W4: Screening cancellation guard kept.**
  `cancellations/repository.ts` still refuses SKU 390238 cancellation
  (`CANCELLATION_SCREENING_UNSUPPORTED`). This mirrors API-v2
  `controllers/OrderController.py:5482`@2960acb and reads only production
  tables. It is not part of the deleted screening writer.
- **Test fixtures re-homed.** `tests/return-window/native.mysql.test.ts` used to
  borrow the deleted CSV-import financial fixture. It now uses
  `tests/return-window/native-fixture.ts`, which creates the same legacy tables
  and surviving migrations. Its assertions are unchanged.
  `tests/checkout/cancellation-benefits.mysql.test.ts` no longer installs the
  native head/trigger fixture and runs on a plain per-run schema.

## Cash-return intent protocol (commit 2)

The intent protocol from `e1e2fce` was reverted. The PREPARED, armed, attested
and recorded intents, the retained-device claims, the signed per-store and
per-day controls, the publication v2 head binding, the pending queue UI and the
whole-order handover barrier are gone. The recorded cash correction from
`8f82783` (`payment-reversals`) is back in its pre-intent form. The
`checkout/order-mutation-guards.ts` composition and the whole-order-status
`assertHandoverAvailable` barrier are deleted. Their only callers were the cash
return and import holds.

- **W4: Restore legacy `AjaxPaymentStatusView`**
  (`order/views.py:685-775`, route `order/urls.py:40`
  `ajax-payment-status/`). Legacy behaviour, POST form fields `order_id`,
  `pay_type` (is_manually_paid), `transaction_id`, `p_status`, `message`,
  `offline_payment`, `online_payment`, `o_status`:
  - When `pay_type` is set, `offline_payment + online_payment` must equal
    `orders.pay_amt`. Otherwise it returns `{"status":"fail","message":"Incorrect Pay amount."}`.
  - It updates every `order_stores` row of the order: `is_manually_paid`,
    `transaction_id`, `message`, `offline_payment`, `online_payment`.
  - It sets `orders.payment_statuses`/`order_statuses` to (`p_status`,
    `o_status`) when manually paid, otherwise to (1, 1). The line status is
    `order_status.order_status` of `o_status` when paid, otherwise `PLACED`.
  - Paid: it inserts a `comments` row "Store Order: {status} status changed by pos
    admin." (notify 0, current user), pushes the order to Kinesis
    (`Helpers.push_order_kinesis`) and to EM (`Helpers.push_for_em`).
  - Reverted: it inserts "Store Order: Status Reverted to PLACED by pos admin."
    and **deletes every `comments` row with `status_id=3`** for the order. The
    counter amount is handed back with no durable return record.
  - It updates every `has_products` row of the order to the line status.
  - It calls `mark_stale(store_id, order_close_date(order_id), 'MANUAL_PAID' |
    'PAYMENT_REVERSED', order_id)` (day-close staleness) and
    `Helpers.transaction_logger(order_id, store_id, 0, user, pay_dict,
    log_comment)` (`pos_transaction_log`).
  - It responds `{"status":"success","message":"Payment status updated successfully."}`,
    or `fail` with the exception text.
  W4 must decide whether the retained `payment-reversals` correction (which
  rejects the arbitrary status/amount reset) or a literal port is the parity
  target. Record that decision in `parity/payment-reversals.md`.
- **W4/W5: Day-close and ledger fences.** The DSR, ledger and day-close
  snapshots no longer read cash-return controls. Legacy relies on `mark_stale`
  instead (see above). The rewrite has no equivalent of `mark_stale` for
  reversals yet.

## Google SSO and desktop SSO (commit 3)

- Removed: `auth/google-sso*`, `auth/google-identity-schema.ts`,
  `auth/desktop-sso*`, the `/api/v1/auth/sso/*` and desktop pairing routes,
  `migrations/0007_google_identities.sql` and `0008_desktop_sso.sql`, the
  `OIDC_*`/`DESKTOP_SSO_ENABLED` config keys, the `openid-client` dependency,
  the desktop approval page, the Electron SSO navigation filter and the
  `POS_SSO_ORIGINS` workspace key. The `ssoOrigins` field is gone from the
  Electron workspace JSON. `workspace.json` must be rebuilt by
  `before-pack.cjs`; it keeps format version 1. Auth capabilities now return
  only `password` and `demo`.
- **W3: `src/config.ts` is a shared file.** This commit removed the OIDC keys
  from it. The production HTTPS check now covers only `TSS_API_BASE_URL`.
  Legacy login (`users/` password plus OTP/TOTP) is unchanged.

## `backend/compatibility/**` (commit 4)

The directory is gone: 506 files, about 75.8k lines. It held the upstream API-v2
and payments patches, the Go payment and exchange transactions, the Python
services (customer-contacts effects bridge, offline-cash pricing and template,
ecommerce full sync, invoice security and documents runtimes, the
pending-cancellation membership readers/producers), the Laravel website-handoff
receiver, the copied sync-API whole-order-status source, and their review SQL.
Nothing in the rewrite now patches or deploys anything into another repository.
The TypeScript callers below still expect those patched upstream contracts. Each
one must be re-homed so the rewrite talks to *unpatched* legacy services exactly
as legacy POS does. No stub was left in place of the deleted code.

- **W4: Checkout `pos/order` and confirmation still require patched upstream
  contracts.** `src/modules/checkout/gateway.ts` asserts
  `UPSTREAM_POS_CHECKOUT_PROJECTION_CONTRACT`, `UPSTREAM_POS_REFUND_ALLOCATION_*`
  and `UPSTREAM_POS_CUSTOMER_CONSENT_CONTRACT` before `pos/order`. It also sends
  `X-POS-Customer-Context*`, `X-POS-Projection-Key` and `X-POS-Customer-Consent`
  headers and requires matching response headers
  (`UPSTREAM_POS_CUSTOMER_CONTEXT_CONTRACT`,
  `UPSTREAM_POS_MEMBERSHIP_CONTEXT_CONTRACT`). Legacy
  `order/views.py:2844-2860` (`AjaxOrderView.order`) POSTs to
  `(MAIN_)API_V2_URL + 'pos/order'` with only `Content-Type` and `Authorization`.
  The confirmation proof table that the deleted payments patch filled
  (`checkoutProjections`) never fills against unpatched payments.
- **W4: Exchange, gift card, order SMS, invoice and feedback contracts.**
  `UPSTREAM_POS_EXCHANGE_STOCK_CONTRACT` (deleted `patches/api-v2-pos-exchange.patch`,
  `payments-pos-exchange.patch`), `UPSTREAM_POS_GIFT_CARD_CONTRACT`
  (`api-v2-pos-gift-card.patch`), `UPSTREAM_POS_ORDER_SMS_CONTRACT`
  (`payments/outbox.ts`), `UPSTREAM_POS_INVOICE_CONTRACT`,
  `UPSTREAM_POS_SCOPED_INVOICE_CONTRACT`, `UPSTREAM_POS_INVOICE_HISTORY_CONTRACT`,
  `UPSTREAM_POS_GLOBAL_ONLINE_INVOICE_CONTRACT` (`invoice-documents/options.ts`,
  `checkout/invoices.ts`, deleted `invoice-security`/`invoice-documents` patches)
  and `UPSTREAM_POS_FEEDBACK_PROOF_CONTRACT` (deleted post-order feedback patch)
  all expect behaviour that only the patches provided. Restore the legacy
  invoice/feedback calls of `order/views.py` (`ShowOrderInvoiceView`, line 778).
- **W4: Pending cancellation.** `cancellations/voucher-history.ts` refuses
  unless the non-production index `ix_pos_gv_history_order_voucher` exists. That
  index came from the deleted `pending-cancellation/voucher-history-index.sql`
  and is forbidden by the schema freeze. Membership cancellation also relied on
  the deleted API-v2 membership reader/producer patches. The test fixture now
  creates the index inline: `tests/checkout/cancellation-benefits.mysql.test.ts`.
- **W4: Global vouchers.** `GLOBAL_VOUCHER_LEGACY_CONTRACT` needs the deleted
  `global-vouchers/legacy-compatibility.review.sql`. That file ALTERs
  `coupons`/`gift_vouchers` dates to NULL and adds `GV_ADD` to the
  `gift_voucher_history.platform` enum. Per the 19 November revision, write the
  stored value (`''`) instead. Until then
  `tests/global-vouchers/mysql-fixture.ts` applies the DDL inline to its
  disposable schema.
- **W3: Customer contacts.** The source-effects outbox, worker branch,
  `/synchronization-retries` route, `CUSTOMER_CONTACT_EFFECTS_*` keys and UI
  retry were removed with the Python effects bridge. Legacy
  `order/views.py:3369` (`AjaxUpdateUserMobile`) and `:3385`
  (`AjaxUpdateUserEmail`) only update `users.telephone`/`users.email` after an
  "already registered" check. They have no OTP proof, no reference carry and no
  CRM effects. The surviving TS module still goes well beyond legacy and needs a
  parity decision. **Parity-evidence gap:** the reference-carry differential
  against the pinned API-v2 helpers (`tests/customer-contacts/references.mysql.test.ts`,
  4 cases) had no golden capture and was removed.
- **W5: Whole-order STORE status.** The private receiver (`receiver*.ts`,
  `runtime.ts`, `receiver:whole-order-status` script and Docker stage) depended
  on the copied sync-API source and is deleted. `legacy-order-status/transport.ts`
  still speaks the receiver's capability, receipt and signature protocol
  (`store-order/status/capabilities`, `x-pos-status-capability`,
  `x-pos-status-receipt`). Legacy `helpers/helpers.py:1133-1159`
  (`Helpers.call_status_api`) POSTs `{orderId, has_product_ids, platform}` with
  `x-api-key: BACKEND_SYNC_REPO_API_KEY` to `BACKEND_SYNC_API_BASE_URL +
  '/store-order/status'` (or `/order/status` for hyperlocal). It is called from
  `order/views.py:4420` (`AjaxUpdateStatusVincView`) and `core/tasks.py:226`
  (`push_vinc_order_for_all`), with the RTO notice at `order/views.py:5171`. The
  receiver tables in `legacy-order-status/migration.sql` are now unused (left
  for the Phase B table deletion).
- **W5: Ecommerce full sync.** `administration/ecommerce-sync` targets the
  deleted Python bridge (`ECOMMERCE_FULL_SYNC_URL`). Legacy `core/tasks.py:203`
  calls `MAIN_API_V2_URL + "syncproduct"`. Its isolated bridge test is deleted.
- **W5: Customer website handoff.** The receiver was the deleted Laravel
  candidate (`compatibility/upstream/customer-website-handoff`). Legacy
  `order/views.py:4515` opens `{WEB_URL}/pos/login/?token=…&api_key=…&pos_store_id=…&pos_user_id=…`.
  The receiver test is deleted.
- **W6: Offline cash pricing and template.** `checkout/offline-cash` still calls
  the deleted Python pricing/template service
  (`TSS_OFFLINE_CASH_PRICING_URL`/`TSS_OFFLINE_CASH_TEMPLATE_URL`,
  `UPSTREAM_POS_OFFLINE_CASH_*`). Also gone:
  `tests/checkout/offline-cash-import.mysql.integration.test.ts` and
  `offline-cash-source-pricing.mysql.integration.test.ts`, three Python unittest
  cases of `offline-cash-source-pricing.test.ts`, and
  `tools/checkout/offline-source-template-fixture.ts`. All of them needed the
  deleted CashExecutor or pricing runtime. The captured `--snapshot` golden case
  remains. **Parity-evidence gap:** `--native-snapshot` and
  `--native-driver-template` were never captured.
- **Device handoff.** `UPSTREAM_POS_DEVICE_HANDOFF_CONTRACT`
  (`auth/device-handoff.ts`) had no artifact under `compatibility/`. Confirm
  whether it names a patched upstream before relying on it.
- **Tests removed with compatibility code:**
  `checkout/{cancellation-membership-context,invoice-feedback}.test.ts`,
  `checkout/{gift-issuance,invoice-reader}.mysql.integration.test.ts`,
  `customer-website-handoff/receiver.test.ts`,
  `administration/ecommerce-sync/bridge.mysql.test.ts`,
  `legacy-order-status/{private-runtime,receiver-routes}.test.ts`,
  `legacy-order-status/receiver.mysql.test.ts` and
  `frontend/e2e/checkout/invoice-feedback.spec.ts`. Single cases that only read
  compatibility patches or Go sources were removed from `customer-context`,
  `gift-cards`, `global-benefit-policy`, `projection`, `invoice-security`,
  `invoice-documents/source` and `invoice-documents/mysql.integration` (Python
  scope probes).
- `parity/bigquery-deployment/plan.json` is stale: it still lists rewrite
  migrations removed in commits 1–4. Only the deleted compatibility proposal
  entry was removed by hand. Regenerating it with
  `tools/operational-reports/build-bigquery-deployment-plan.ts` also brings in
  unrelated drift.

## Python, Go and PHP removal (commit 5)

All 121 tracked `.py`, `.go` and `.php` files are gone, together with
`requirements*.txt`/`.in` files, `resources/auth/pyotp-2.9.0`,
`tools/order-search/run-oracle.sh`, `tools/verify-fixture-environments.mjs`,
`tools/pinned-source-env.ts`, the `inventory` npm script and every
`verify-project.ts` stage or environment variable that ran Python, Go or Docker
oracles. Generated TypeScript (`legacy-report-sql.ts`,
`offline-cash/legacy-import-schema.ts`, the operational report SQL modules) is
now frozen output. Edit it by hand against the pinned source.

**Parity-evidence gaps.** These assertions compared the rewrite with a live
legacy oracle. No golden capture exists, so they were removed rather than
given invented values:

- `backend/tests/inventory-workbooks/xlsx.test.ts` (10 cases). It compared
  generated workbooks with the legacy openpyxl workbook task
  (`report/tasks.py:25-164`). It needs a capture of the legacy workbook output
  plus a TS XLSX reader. **W5.**
- `backend/tests/order-search/native.test.ts`: 42 of 43 datatable vectors
  (`order/datatables/orders_datatable.py`) and the source-side halves of three
  scope cases (franchise online bypass, explicit-ID bypass, split-order store
  substitution). Vector 0 is still compared against the committed snapshot.
  **W5.**
- `backend/tests/order-search/default-range.mysql.test.ts`: the rendered
  default-form GET/POST case (`tests/order-search/default-form-source.py`, which
  needed Redis and never ran). **W5.**
- `backend/tests/customer-contacts/references.mysql.test.ts`: 4 differential
  cases against the API-v2 reference helpers (see commit 4). **W3.**
- `backend/tests/invoice-documents/source.test.ts`: the Python unittest suite
  over the invoice-documents runtime (it was partially captured). **W4.**
- `backend/tests/checkout/offline-cash-source-pricing.test.ts`: 3 Python
  unittest cases. `offline-cash-source-pricing.mysql` and
  `offline-cash-import.mysql` are removed (see commit 4). **W6.**
- Native legacy Django + MySQL + Chromium workflows, with their harnesses and
  browser tests: lookup (`core/urls.py:31,167`), product feedback,
  customer profile, cashier shortcuts (joined help/native reference), store and
  operator archival (`stores/urls.py:15-16`, `users/urls.py:19-20`),
  administration forms, global reminders and release notes, notification
  workflow, catalog-details native UI and workflow benchmark, and the
  unexecuted order-history native UI candidate. Their historical receipts and
  review notes remain under `backend/tools/**` as evidence only. **W3–W5:**
  replace each with golden captures or read-only live MySQL checks.
- `frontend/tests/counter-catalog/source-barcode.py` was a self-asserting
  barcode dispatch oracle, wired as the verifier stage
  `counter-barcode-source-dispatch-tests`. **W4.**
- Payment-correction and operational-report goldens still name their former
  `.py` oracle in metadata and lookup keys. That is provenance only; nothing
  executes them.

**Drizzle vs production schema (`tests/orm-metadata.test.ts`).** The new test
compares every non-`pos_rewrite_*` Drizzle table under `src/` with
`tests/golden/schema/production-schema.json` (column presence, normalized
`COLUMN_TYPE`, nullability, primary key). It found **432 mismatches**. They are
pinned in `tests/orm-known-mismatches.json`, so any new drift fails the test.
Nothing was fixed. Breakdown: `src/db/legacy-schema.ts` 394, legacy-fulfillment
7, global-vouchers 6, operational-reports 10, legacy-order-status 3,
checkout cancellations/benefit-adjustments/gift-card-issuance/offline-cash 9,
catalog-details 1, legacy-fulfillment lifecycle 2. By kind: 182 nullability,
about 250 types. The largest type groups are `int`/`tinyint` (32), `bigint`/`int`
(26), `varchar`/`enum` (33), `boolean`/`tinyint` (15), varchar lengths (about 40),
`decimal`/`double` (12), `text` variants (about 30), `datetime`/`timestamp` (4)
and `bigint`/`bigint unsigned` (3). The snapshot omits four tables that
Drizzle may need: `auth_group`, `auth_group_permissions`, `pos_user_groups`,
`pos_user_user_permissions`. **Owner: Phase E (W3–W5).**

`parity/release-coverage.json` and `parity/source-surface-map.json` still list
some deleted harness and evidence paths. The release gate treats a missing file
as unsatisfied, so the gate keeps failing. The surface map is regenerated by
the TS port in the next commit.

## Parity tooling ported to TypeScript (commit 6)

- `tools/parity/build-source-surface-map.ts` replaces
  `build_source_surface_map.py`. `tools/parity/python-source.ts` reads the
  pinned legacy Python as text (statement boundaries, top-level imports, string
  constants); nothing is imported or executed. The family definitions that the
  Python script built in code are frozen as data in
  `tools/parity/source-surface-families.json`. Equivalence check: on the
  pre-W2 tree (`d7cfa66`) the TS port's `source-surface-map.json` is
  byte-identical to the Python script's output. The Markdown differs only in
  the regeneration instructions.
- Family data now reflects the deletions. Deleted evidence paths and two review
  anchors on the removed membership-trigger fence are dropped.
  `legacy-order-imports` is `missing` with no code task (removed by decision).
  `legacy-paid-reversal`, `customer-website-handoff`, `legacy-vinculum-status`,
  `pending-order-cancellation`, `customer-contacts` and
  `ecommerce-inventory-sync` are `partial`, each with a remaining-code entry
  that points here. Result: 396 surfaces mapped, 8 code-task groups (was 2).
- `tools/parity/check-business-metrics-reachability.ts` replaces
  `check_business_metrics_reachability.py`. Its output equals the committed
  golden `tests/golden/core/business-metrics-reachability.json`.
- `generate_report_sql.py` was not ported. Its output
  (`src/modules/legacy-report-sql.ts`) is frozen.
