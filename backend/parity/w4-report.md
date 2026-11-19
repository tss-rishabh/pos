# W4 report — checkout, returns and payments

Branch `w4/checkout` from `1a651f9`. Legacy oracle: `backend-pos-web@78d5b63` (read-only export).
Implementation phase only: this is **not** parity certification. Nothing ran against a live
API-v2, payment terminal, SMS/email provider or production MySQL/Redis.

W4 ran as a lead plus five sub-workstreams with exclusive file ownership (payments, returns,
customer OTP/registration, cancel/order-copy/performance, discounts/wallet/vouchers).

## 1. What changed

### 1.1 Order submission — `pos/order` exactly as legacy (`order/views.py:2686-2897`)
- `checkout/gateway.ts`: every API-v2 call sends only `Content-Type: application/json` and the raw
  JWT `Authorization` (no `Bearer`, no `X-Request-ID`, no `X-POS-*`). The projection, refund
  allocation, consent and customer/membership context contracts and their response proofs are
  deleted (`projection.ts`, `refund-allocation.ts`, `refund-audit.ts`, `customer-consent*.ts`,
  `gift-card-issuance.ts`; `customer-context.ts` is a no-op shim for customer-insights).
- `pos/order`: success is HTTP 200 only (`:2753`); any other status is `ORDER_CREATE_FAILED` 502
  "Something Went Wrong. The order was not created; try again." and is retryable, as legacy.
  No client timeout on `pos/order` or the payment confirmation (legacy `requests.post` has none).
  A 200 without `order/method/isValid/name` (legacy KeyError → 500) is `CHECKOUT_OUTCOME_UNCERTAIN`.
- Payload (`payloads.ts`): legacy keys and order (`:2863-2877`), `tab_id` appended only for a
  walk-in cart, `payment_method` = `coc` when the unrounded quote total > 0, `gc_data` built from
  the current cart's `giftvouchers.items` with `""` for unpicked dates (`:2733-2747`).
- JWT (`crypto.ts`): never carries `iev` (`helpers.py:535-564`; every checkout caller passes only
  `user_id`). Walk-in subject is the operator's storefront account `users.user_type = '8'`
  (`:1518-1522`, legacy message on absence); `admin_user_id` stays the first `pos_admin_id`
  account (`:2861`).
- Submit no longer re-runs validatecheckout/processorder or re-checks spending verification
  (legacy `AjaxOrderView` does neither; the quote step is legacy `ajax-validate-process-order`).
- Guards before the order (`create_order.html:5055-5075`): empty cart → 422 "Please add some
  product into the cart."; master or any line salesperson unset/Not Selected → 422 "Please Select
  The Salesperson."
- Post-order sequence (`finalizer.ts`): line salespersons right after `pos/order`, per-product
  else master else **0** (`:2779-2795`); confirmation; invoice number even when the confirmation
  fails (`:2799-2809`); only after a confirmed order: `gift_vouchers.status = 0` (`:2815-2818`),
  NPS add-on (`:2821-2830`), order SMS job after commit (`:2831`). NPS defaults on and the SMS
  opt-out is gone (legacy checked, disabled box, `create_order.html:76,5646`).
- Test: `tests/checkout/order-submission.test.ts` completes a sale through the real gateway against
  a fake unpatched API-v2 and asserts headers, claims and the exact payload.

### 1.2 Legacy flags (`POSAdmin/settings.py`)
`config.ts`: `GLOBAL_SHOW_COUPON_MODULE`, `GLOBAL_SHOW_PG_DISCOUNT_MODULE`, `ENABLE_OLD_PG_DISCOUNT`,
`ENABLE_NEW_PG_DISCOUNT` (default 1), `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT` (0),
`TEN_PER_SWITCH` (1), parsed like Python `int()` (startup failure otherwise);
`EXCHANGE_ENABLED_STORE_IDS` (default `"1"`, `all`, comma ints, `:588-592`).
`legacy-flags.ts` resolves them per request from the checkout store `category` and the operator
`user_type` (`order/views.py:1562-1567`) and the checkout create/read responses return `flags`.
`CheckoutReview.tsx` hides the coupon block, the PG block and the old/new PG options accordingly;
the voucher-to-money control is gated in global-vouchers. `customer-insights/benefits-gateway.ts`
`TEN_PER_SWITCH` now defaults on (W4 smallest fix).

### 1.3 Controls-spec gaps closed (lead)
- Gift-voucher PIN asked only when API-v2 answers `is_pin_required` (`create_order.html:3433-3557`;
  route default `gc_pin` `0`; 422 `GIFT_VOUCHER_PIN_REQUIRED` "Please Enter the GIFT CARD PIN.").
- Salesperson (`order/views.py:2969-3019`): sale-level choice overwrites every line; "Not
  Selected" (0) removes ("Please Select Valid Salesperson." when nothing to remove).
- Customer OTP is 4 digits at the HTTP boundary and in the UI.
- Gift-card dates optional ("Today's"/"No Expiry", `create_order.html:205-206`, `:4385-4398`).
- Store-PG and removals have no role gate; only old-PG apply uses `PG_DISC_ROLE_PERM`
  (`:2237-2283`, "You do not have permission."). PG remark has no 35-char limit.
- Fast checkout (`order/urls.py:54`, `AjaxFastCheckoutView` `:3160-3364`, dialog
  `create_order.html:7242-7790`): `FastCashCheckout.tsx` on the online flow (quote → order →
  cash completion with Cash Recieved / Cash To Be Return / Order Message, received below payable
  raised to payable, zero payable → prepaid "Look like prepaid order…"). F clicks it.
- Shortcut help verbatim from `shortcuts.html`.

### 1.4 Sub-workstream results (summary; legacy refs in commits)
- **Payments** (`c73ee63`, `2a2cd80`, `f6e10a8`): definitive Pine/Paytm rejections are re-initiable
  (`terminal_helpers.py:56-157,392-418`); unknown active modes upload to Pine with that
  `AllowedPaymentMode` (`views.py:3047`); `AjaxPaymentStatusView` restored as
  `POST …/orders/:orderId/payment-status` (`:685-775`); `complete_order`/terminal loggers write
  production tables; payment form (message breakdown, change, auto-split/clamp, "Are you sure ?",
  "Select Payment Mode") and Pine polling 5 s × 63 with the legacy timeout text.
- **Customer OTP/registration** (`7488846`, `3c81c8d`, `80b2ab5`): synchronous API-v2
  `omnichannel-sendotp`/`verifyotp` (`:2536-2597`, 4-digit, CT only); registration as `:2416-2534`,
  verify → register → connect in one action; `worker:customer-otp` and its outbox deleted.
- **Cancel / order copy / performance** (`bc3e311`, `758eeef`, `0137ffe`, `54cc48f`, `e80bc45`,
  `0b44949`, `dff5492`): cancel via API-v2 `pos/cancel-pos-order` with legacy local writes
  (`:2900-2966`); order copy as `AjaxFetchTheProducts` (`:2045-2104`); `order_stores.performance_json`
  written for the sale's order (`:2697-2699,2801-2802`).
- **Discounts / wallet / vouchers** (`39b6a43`, `72ecf14`, `db78a25`, `a826552`, `6853736`,
  `cd15557`, `d7032e4`, `8c3ce62`, `04c571d`): PG OTP on the legacy key; manager OTP and "PG Discount
  Used" mails inline; `orders.store_disc_pg_*` and `store_pg_disc_addons`; wallet ledger columns;
  voucher Check and Top-up via API-v2 `gift_voucher_to_tss_money` (`:4518-4579`); W7 `''`
  platform and legacy dates kept.
- **Returns / exchanges**: see §1.5.

### 1.5 Returns and exchanges
Commits `0a04fce`, `0103e7b`, `2babb90`, `9a06469`, `1bdcf8b`, `6f52b91`, `390ca0c`, `ceaf796`, `19add9f`.
- One pure branch selector `return-workflow/exchange-cell.ts` reproduces `exchange-cell-guards.md` §2
  (`online/_return_exchange_cells.html`): retry/merged branches stay available for `prod_type == 8`;
  branch 6 shows "Not Applicable For Exchange" first for type 8; exact badge casing. Every row is
  tested against hand-derived golden JSON, and the returns UI renders through the same selector.
- Force return on store orders only when `hp.status == "DELIVERED"` and the current
  `products.prod_type != 8`, else "Not applicable for return" (`order/show.html` ~258).
- `exchangeFeatureEnabled(config, checkinStoreId)` from the operator's **check-in store**
  (`order/views.py:338-340`), returned in eligibility and gating the UI only (as legacy).
- Return flow `views.py:885-976`, exchange flow `:978-1313` (API-v2 `pos/exchange`, 30 s timeout,
  unpatched — the exchange-stock proof contract is removed); refund preview by order + product
  (`:1421`); failed Vinculum return enqueues `core.tasks.push_vinc_order_for_all`
  (`calculations.py:160-170`); return/exchange mails inline after commit (`helpers.py:600,1203`).
- Exchange recovery claims in Redis per (store, order, line, claim) with request hash, operator,
  counter and verification id; `IDEMPOTENCY_CONFLICT` on a different hash; actor/check-in
  validation and fresh customer-proof renewal kept; the UI keeps "unknown" on 409.

### 1.6 Order SMS (`core.tasks.send_sms`, `core/tasks.py:70-81`)
`checkout/order-sms.ts`: `enqueueOrderSms(jobs, orderId)` → `core.tasks.send_sms` `{order_id}` on
queue `core`, after the finalizer transaction commits. Handler posts `{"order_id"}` to
`{TSS_API_BASE_URL}omnichannel-sms` with `Content-Type` only; non-200 throws
`ORDER_SMS_REJECTED` (legacy logs). Exported from `checkout/index.ts` as
`registerJobHandlers(registry, { config })`. The producer is injected (`jobs` option); app.ts
passes `undefined` until W8 wires the queue — **until then no order SMS is sent**.

## 2. `pos_rewrite_*` tables freed
checkout core: `checkout_sessions`, `checkout_operations`, `customer_cart_leases`,
`gift_card_leases`, `drafts`, `mutations` (drafts), `checkout_projections`,
`checkout_projection_lines`, `checkout_customer_consents`, `gift_card_issuances`.
payments: `payment_attempts`, `payment_provider_facts`, `legacy_payment_recoveries`,
`payment_outbox`, `payment_reversals`, `payment_correction_cash`, `payment_correction_orders`,
`payment_correction_close_impacts`.
customer: `customer_otp_challenges`, `_deliveries`, `_operations`, `_budgets`,
`customer_registrations`, `_registration_claims`, `_registration_limits`, `_registration_deliveries`.
cancel/copy/performance: `pending_order_cancellations`, `cancellation_membership_provenance`,
`membership_versions`, `order_copy_reviews`, `order_copy_commands`, `order_copy_cancellations`,
`checkout_performance`.
benefits: `discount_approvals`, `discount_approval_limits`, `discount_deliveries`,
`discount_audits`, `wallet_adjustments`, `wallet_consumptions`, `voucher_selections`,
`voucher_operations`, `voucher_pin_budgets`.
returns: `return_operations`, `return_outbox`, `return_verifications`, `return_verification_limits`, `exchange_recovery_claims`, `exchange_stock_confirmations` (`return-workflow/schema.ts` keeps compatibility definitions only for `legacy-order-status`).

Not freed by W4: `pos_rewrite_product_feedback_receipts` (`checkout/migrations/0016_product_feedback.sql`,
used by the product-feedback module). `checkout/schema.ts` keeps a deprecated
`checkoutSessions` definition only for `customer-contacts/commit.ts` and
`tests/customer-profile.mysql.integration.test.ts`; `checkout/customers/schema.ts` stays for
`customer-contacts/authority.ts`.
Deleted SQL: `checkout/migrations/0002,0003,0004,0005,0006,0007,0008,0009,0010,0014,0015,0017`,
`checkout/return-workflow/recovery-claims-migration.sql`,
`checkout/{payments,cancellations,order-copy,order-messages,payment-reversals}/*.sql`,
`customer-otp/migration.sql`, `global-vouchers/migration.sql`, `checkout-performance/migration.sql`
**`src/db/migrations.ts` still lists them** — primary must drop the paths.

## 3. Redis key families
All JSON unless noted; every key has a TTL (production is `noeviction`).

| Key | TTL | Shape |
|---|---|---|
| `pos:checkout:{checkoutId}` | 2 d open; 30 d once an order exists or uncertain | CheckoutState |
| `pos:checkout_draft:{operatorId}:{draftId}` | as the sale | checkoutId (string) |
| `pos:checkout_op:{checkoutId}:{operationId}` | 30 d | operation receipt `{id, checkoutId, status, requestHash, result, errorCode}` |
| `pos:checkout_lock:{checkoutId}` | 120 s | lock token (replaces `FOR UPDATE`) |
| `pos:customer_cart_lease:{customerId}`, `pos:gift_card_lease:{serial}` | 12 h | `{checkoutId, expiresAt}` (+ `:lock`) |
| `pos:draft:{op}:{store}:{draftId}` / `pos:drafts:{op}:{store}` / `pos:draft_lock:{op}` | 2 d | Draft / id list (≤100) / lock |
| `pos:idem:draft:{op}:{mutationId}` | 24 h | `{requestHash, result}` |
| `pos:payment_attempt:{attemptId}` | 24 h | `{orderId, storeId, operatorId, requestHash, status, transactionId, provider, legacyStatus, message, amounts}` |
| `pos:payment_lock:{orderId}` | 120 s | SET NX |
| `pos:customer_otp:{id}`, `pos:customer_otp_lock:*`, `pos:customer_otp_budget:customer:{id}:{day}` | proof+1 h / 30 s / 2 d | challenge, lock, counter (6/day) |
| `pos:customer_registration:{id}`, `…_claim:*`, `…_lock:*`, `…_limit:*` | 180 s–2 d | registration state, claims, cooldown 60 s / per-hour sends |
| `pos:order_cancellation:{orderId}` | 24 h | SET NX `{status, operatorId, token}` |
| `pos:idem:checkout-performance:{op}:{operationId}` | 24 h | `{requestHash, storeId, receipt}` |
| `{uid}_{store}_{counter}_{tab}` (legacy key) | `PG_DISC_OTP_EX_VALUE` | `{hmac: [managerId, amount]}` |
| `pos:discount_approval:{checkoutId}` / `_limit:{op}` / `_lock:{op}` / `pos:discount_audit:{orderId}` | OTP TTL / 600 s / lock / 30 d | approval, budget, lock, addon row marker |
| `pos:wallet_adjustment:{operationId}` | 24 h | SET NX claim |
| `pos:voucher_selection:{id}` / `pos:voucher_op:{id}` | 300 s / 24 h | selection / receipt |
| `pos:return_op:{id}` / `pos:return_line_op:{order}:{line}` / `pos:return_line_lock:*` | 7 d / 7 d / 120 s | operation JSON / latest op id / lock |
| `pos:return_verification:{id}` | expiry + 300 s | return customer-proof JSON |
| `pos:exchange_recovery_claim:{store}:{order}:{line}:{claim}` (+ `…_claim_id:{claim}`) | 30 d, not refreshed | `{requestHash, operatorId, counterId, verificationId, …}` |

## 4. Shared-file edits
- `src/config.ts`: the seven legacy flags (+ exported `legacyInt`, `exchangeStoreIds`).
- `src/app.ts`: one configured state store (`configuredStateStore`) and session store passed to
  checkout, global vouchers; drafts use it; dead payment-reversal and order-copy-history wiring
  removed; customer OTP/registration call sites (W4-customer).
- `.env.example`: `REDIS_URL`, the flags (commented legacy defaults), `REDIS_VERIFIED_USER_OBJECT_EXPIRY`;
  removed ~50 obsolete `UPSTREAM_POS_*`, `TSS_POS_*`, `CUSTOMER_OTP_*`, `GLOBAL_VOUCHER*`,
  `ORDER_SMS_*`, `POS_PENDING_CANCELLATION_*` settings and the invalid `TEN_PER_SWITCH=false`.
- `backend/package.json` (W8 owns): remove `worker:financial-outbox` (`checkout/worker.ts`
  deleted) and `worker:customer-otp`.
- New job name: none (`core.tasks.send_sms` is already in `contract.ts`).

## 5. Caller fixes outside W4 ownership
- `customer-insights/checkout-scope.ts`, `adjustments.ts`: read/replace the sale through the Redis
  session store (was `pos_rewrite_checkout_sessions`).
- `customer-insights/benefits-gateway.ts`: `TEN_PER_SWITCH` legacy default.
- `src/modules/customer-otp/authority.ts` (W4) and `frontend/tests/order-payments/order-payments.browser.test.ts` (W4-cancel).
- `tests/mysql.integration.test.ts` (draft service now Redis).
- Still broken / to migrate by their owners: `customer-contacts/commit.ts` writes the deprecated
  MySQL session table (feature slated for deletion); `tests/customer-profile.mysql.integration.test.ts`;
  `offline-sync/routes.ts` should pass `{ stateStore }` to `paymentService` (it now gets the
  app's configured store via `sharedStateStore()`); finance/reports should drop the empty
  payment-correction overlay (`cash-projection.ts` returns no rows); W5 `order-history/copy-adapter.ts`
  is now unused; `tools/checkout/membership-native-bridge.ts` and tools tsconfigs for
  cancellations/order-copy/checkout-performance reference deleted files.

## 6. Security decisions (for S11+)
1. Gateway never follows redirects with the JWT (legacy `requests` follows).
2. Transport failure or unreadable 200 from `pos/order` stays "uncertain" (no automatic retry);
   only a definite non-200 is retryable as legacy.
3. Customer OTP: POS-side 5-minute expiry, 5-attempt lock, 6 codes/customer/day; proofs bound to
   sale/return, customer and contact; the bare legacy `{user}_{tab}` verified flag is not written.
4. Registration codes stored as HMACs; registration details encrypted at rest in Redis.
5. Manager PG OTPs stored HMAC'd (not plaintext); approval enforced server-side with 5 attempts;
   old-PG role gate enforced server-side.
6. Wallet/voucher APIs enforce the franchise (`user_type` 2) exclusion server-side; voucher calls
   send the customer `Authorization` (legacy none); voucher codes random; mail content escaped.
7. Order cancel enforces the template's eligibility (method 14, Pending, Order Placed), store scope
   and access; Redis in-flight lock against double stock restore; 30 s timeout.
8. Order copy reads only the connected customer's orders or the operator's stores' orders.
9. Payment-status (AjaxPaymentStatusView) limited to roles 1–3 with store access; settled or
   cancelled orders cannot be paid again; Paytm cancel checks status first.
10. Customer verification is enforced server-side when a benefit is applied (legacy trusts the
    client `is_verified`), but not re-checked at order time (legacy).
11. Returns: force return and super-admin override accepted server-side only when the template
    would offer them (legacy server accepts them unchecked); refuses to mark as delivered an order
    that is not this line's replacement.

## 7. Legacy → new messages (S4)
| Legacy | New |
|---|---|
| pos/order non-200 "Something Went Wrong" (HTTP 200 body 400) | 502 `ORDER_CREATE_FAILED` "Something Went Wrong. The order was not created; try again." |
| confirmation non-200/201 "Something went wrong" | 502 `ORDER_CONFIRMATION_FAILED` (order kept; invoice generated) |
| toast "Please Select The Salesperson" | 422 `SALESPERSON_REQUIRED` same text |
| toast "Please add some product into the cart" | 422 `CART_EMPTY` same text |
| "Please Select Valid Salesperson" (200, is_not_valid) | 422 `SALESPERSON_NOT_SELECTED` |
| GC PIN prompt (`is_pin_required`) | 422 `GIFT_VOUCHER_PIN_REQUIRED` "Please Enter the GIFT CARD PIN." |
| "Please add/save Gift Card No." (fast) / 500 (normal) | 422 `GIFT_CARD_NUMBER_REQUIRED` "Please add/save Gift Card No." |
| "User doesn't have any account as store-front user…" (error page) | 409 `OPERATOR_CUSTOMER_MAPPING_MISSING` same text |
| Customer OTP "Wrong OTP" 400 / "OTP Not Sent" 400 | 400 `CUSTOMER_OTP_INVALID` / `CUSTOMER_OTP_NOT_SENT` |
| Mobile/Email already registered | 409 `CUSTOMER_PHONE_REGISTERED` / `CUSTOMER_EMAIL_REGISTERED` |
| Cancel non-200 "Something went wrong" | 409 (502 on API-v2 5xx), same text |
| Copy "Please Connect The User" (204) / "Please Enter Correct Order Id" (204) / "Could not read cart" (400) | 409 / 404 / 502 |
| Pine Open / Already Completed / Invalid Merchant / Duplicate / Not Active | 409 same text |
| Pine timeout / "INVALID PLUTUS ID" | 502 `PAYMENT_OUTCOME_UNCERTAIN` / 200 failed "Time Out, Initialize Transaction Again" |
| "Incorrect Pay amount." / "TRANSACTION NOT FOUND" | 422 / 404 |
| OTP check not verified (PG) / "You do not have permission." | 422 `DISCOUNT_APPROVAL_CODE_INVALID` / 403 same text |
| voucher flag off | 403 `VOUCHER_TO_MONEY_DISABLED` |
| warehouse failure (same text) | 502 `RETURN_WAREHOUSE_PENDING` |
| "Already refunded" / window and refund messages | 409, legacy text ("alreday" spelling fixed) |
| exchange messages | 409/422 verbatim |
| failed replacement | 502 "Item returned, but the replacement order could not be created: {API-v2 title}" |

## 8. Remaining gaps (not done; a stub is not done)
- **Order SMS is not sent until W8 wires `JobProducer`** (app.ts passes `undefined`).
- `tests/checkout/mysql.integration.test.ts` deleted: it exercised the removed rewrite tables/proofs.
  Lost MySQL coverage to rebuild in the validation phase: Redis session concurrency (twenty
  concurrent opens per draft, operation replay across restarts), invoice CSP serving, prepaid
  settlement read, order finalizer writes (invoice/NPS/salesperson) against real MySQL.
- `frontend/tests/order-payments/` browser + `e2e/checkout/order-payments.spec.ts` not adapted to
  the new payment API.
- `service.ts` still carries the rewrite customer-OTP fallback path and order-copy binding fields
  (`orderCopy`, `cartCopyHash`); W4-cancel proposed an `addOne` port.
- Controls-spec rows still open: #12 (line quantity edits inside an open checkout), #13 (Money/Points
  toggle initialisation, `used/total` badge, "(Partial Money Applied)"), #19 Self Verify (needs
  decision), #20 employee-coupon domain rule, #21 done, #22 `check-user-exclusive` lookup, #23
  product picker columns/troubleshoot, #24 verified/applied state prefill, #25 website handoff (not
  W4-owned), #26 automatic prompts, #27 cart-read failure message, #28/#29/#32 labels and toasts,
  #31 fast-cash env name `AUTO_CANCEL_DURATION_IN_MINUTES`, #17 order created before the payment
  form (rewrite still creates the order first in the normal path).
- Payments: provider-approved but DB write failed is only marked uncertain in Redis; auto-cancel
  minutes sent as a number.
- Cancel: API-v2 success then local transaction failure → 500 and a 24 h lock (manual reconcile);
  product sync skipped unless `PRODUCT_SYNC_*` configured; guest cart not cleared after copy.
- Registration WhatsApp fallback is an in-process timer (lost on restart, as legacy thread).
- PG OTP can be re-requested after 60 s when the amount changes (legacy blocks 10 min).
- Stale parity docs: `customer-otp.md`, `pending-order-cancellation.md`, `order-copy.md`,
  `checkout-performance.md`, `payment-reversals.md`, `order-payments.md`, `checkout.md`.
- Returns: stored refund amount assumes API-v2 sends a float; a Redis failure after the database
  commit needs manual review; `legacy-order-status` (not W4) and its tests still use the old
  return-operation table/signatures; `tests/customer-website-handoff/service.mysql.test.ts`
  imports the deleted `customer-otp/worker.js`.
- `tools/checkout/**` (dispatch-payment-outbox, membership-native-bridge, contract tsconfigs),
  `tools/container-fixture.cjs`, `tools/verify-project.ts` reference deleted W4 files (not W4-owned).

## 9. NEEDS USER DECISION
1. **Self Verify (Without OTP)** registration (`create_order.html:4856-4857`, `views.py:2448`):
   legacy trusts a client `self_verify=1` and registers any phone without proof. Not implemented.
2. **Normal-path order before payment** (row C-21): legacy creates the order only after the
   operator confirms the payment form; the rewrite creates it at "Create order". Keep or reorder?
3. Returns, exchanges and return-date extension keep a customer OTP step that legacy does not have
   (legacy returns need no OTP, `order/views.py:885-914`). Keep or remove?
4. Refuse exchanges server-side when `EXCHANGE_ENABLED_STORE_IDS` excludes the check-in store, and
   refuse force-return of `prod_type == 8` server-side? Legacy gates both in templates only.

## 10. Checks at the end of W4
- backend `npx tsc --noEmit -p .`: 0 errors; `npx eslint .`: clean.
- backend `vitest` over `tests/checkout`, `checkout-order-copy`, `checkout-performance`,
  `checkout-payment-reversals`, `customer-otp`, `global-vouchers`, `return-window`,
  `catalog-barcode`, `orm-metadata` (0 mismatches), `customer-benefits`, `mysql.integration`:
  32 files / 176 tests pass, 11 files skipped (MySQL-backed, no `*_MYSQL_TEST_URL` in this run).
  The sub-workstreams ran their MySQL suites on isolated loopback MySQL 8.4 (ports 34061–34065,
  empty `sql_mode`): payments native, cancellation, order copy, performance, discounts, wallet,
  vouchers, customer OTP/registration (9/11; the 2 clear-flow failures were fixed afterwards in
  `09aaede` but not re-run on MySQL), returns 9/9 and return-window native 14/14.
- frontend `npx tsc --noEmit -p .`: 0 errors; `npx eslint .`: clean; W4 page tests 15 files /
  120 tests pass, 7 browser files skipped. Playwright/e2e not run.

## Follow-up (20 November 2026, on integration head `4730258`)

Decisions applied (user and primary agent; `AGENTS.md` "Checkout", S33–S36):

1. **No customer OTP on returns, exchanges or return-date extension** (`order/views.py:885-914`,
   `:978-1313`). Deleted: `pos:return_verification:*` (+ lock), the five `/return-verifications/**`
   routes, `verificationId` inputs, `return-workflow/{verification,verification-state,local-verification,schema}.ts`,
   the customer-otp return purpose and the UI step. Lines come from
   `GET /api/v1/stores/:storeId/orders/:orderId/return-lines` (check-in required). Recovery claims
   keep `IDEMPOTENCY_CONFLICT` and actor/check-in validation; proof renewal is gone with the proof.
   Commits `9682767`, `9b9c661f`, `3f8bfe7b`, `33db0eca`, `85ed2c6f`.
2. **Order after payment confirmation (C-21, `create_order.html:6177-7239`).** "Proceed For Payment"
   opens the payment form first (options from `GET …/checkout-sessions/:id/payment-options`, the
   counter's machines as `terminal_helpers.py:273-317`); confirming it posts
   `order-submissions` with `payment`, which validates the split against the quote *before*
   `pos/order`, then creates the order and starts that payment. A payment rejection after the order
   exists is returned as `paymentError` and the order's payment panel continues. Zero payable is the
   direct prepaid path. Without `payment` (offline sync) the server still creates the order and the
   payment follows separately. Commits `a6f2b3c`, `5b6d1e7`.
3. **S36 Self Verify (Without OTP)** (`create_order.html:4856,4996`, `views.py:2429-2448`):
   `POST …/customer-registration-challenges/self-verifications {telephone}` is accepted only for the
   phone this sale's registration OTP was delivered to, within the OTP window; registration is
   audit-logged with IDs only; the checkout is not marked verified (S33). Refusals: 409
   `CUSTOMER_SELF_VERIFY_OTP_NOT_SENT` / `_PHONE_MISMATCH` / `_EXPIRED`. Commits `a361f98`, `4455742`, `b9b19b2`.
4. **S35 on the server**: exchange refused when `EXCHANGE_ENABLED_STORE_IDS` excludes the check-in
   store (`check_in_{uid}`) → 403 `EXCHANGE_NOT_ENABLED` "Not applicable for exchange"; type-8
   exchange where templates hide it → 409 `EXCHANGE_NOT_APPLICABLE` "Not Applicable For Exchange";
   force return only for a store order, `DELIVERED`, current `prod_type != 8` → 409
   `RETURN_NOT_APPLICABLE` "Not applicable for return". Shared guard functions in `exchange-cell.ts`.
5. **Check-in tests**: W4 return/return-window MySQL suites use the legacy `check_in_*` Redis keys;
   no W4 test seeds `pos_rewrite_operator_checkins`. (`tests/checkout/mysql.integration.test.ts` was
   deleted earlier.)
6. **Open controls rows closed**
   - #12 cart lines: quantity edit and Remove inside an open checkout (`ajax-cart` set/delete).
   - #13 TSS Money/Points switches initialised from the cart, apply on toggle, verified + balance > 0
     gate, `used/total`, "Desired Tss Money" partial with "(Partial Money Applied)" (`WalletControls.tsx`).
   - #17 = item 2.
   - #20 employee coupon needs verification only for an `@thesouledstore.` email (customer's, or
     the operator's for walk-in) → 403 "Please verify the user to use Employee Coupon." (`views.py:2365-2391`).
   - #22 lookup via API-v2 `check-user-exclusive` (mobile + email, legacy masks, blocked/unknown →
     404 upstream text, exclusive and cashback pre-display) and "Connect the User" switches the
     customer within a sale (`is_cart_sync = 0`, no sync/clear). Needs `API_V2_APP_ID`/`API_V2_APP_KEY`.
   - #23 picker: barcode, Spl./Ex. price, held and storage stock (`GET …/catalog/stock-locations`),
     barcode-missing marker, only stock > 0 with barcode billable, Inventory reload.
   - #24 "User is verified !" / "Verify the user to use Tss Money/Points/Voucher !"; coupon, voucher
     and PG amounts prefilled from the cart.
   - #26 Birthday Missing prompt (per customer/tab dismissal) and insights opened on connect.
   - #27 cart read: upstream `title` or "We have a little problem, please try again later !" (502 `CART_UNAVAILABLE`).
   - #28 legacy summary labels ("Cart Total", "Discount"/"Membership Savings" incl. prod_type 5
     relabel, "Round Off Value -", "Total Payable (₹)", points without ₹).
   - #29 toasts "Applied Succesfully", "Removed Succesfully", "Applied/Remove", "OTP Sent To
     Managers", "Order Created!".
   - Also: a cleared sale releases every lease it holds (per-sale lease index
     `pos:checkout_leases:{checkoutId}`, 30 d) and carried gift-card serials stay held; the
     customer registration MySQL suite now passes 11/11.
7. **Stale references**: removed deleted files from `tools/checkout/*.tsconfig.json`,
   `verify-project.ts`, `container-fixture.cjs`; deleted `tools/checkout/{membership-native-bridge,dispatch-payment-outbox}.ts`
   (they only drove deleted modules); stale test options fixed. Listed, not mechanical:
   `backend/package.json:15,19` worker scripts (W8); `.github/workflows/desktop-platforms.yml:115-119`
   (deleted payment-reversals browser test); `tools/parity/source-surface-families.json:2303`
   (order-messages → `order-sms.ts`); golden fixtures / `INVENTORY.md` rows and hash receipts in
   `tools/{customer-profile,fulfillment,global-reminders}` for deleted tests;
   `container-fixture.cjs:27` customer-contacts worker (not W4).

Still open / needs decision:
- **#25 website handoff**: owned by `customer-website-handoff` (not W4).
- Picker troubleshoot (`catalog-details`, not W4): legacy is one click for any signed-in user;
  the rewrite is role 1 / user_type 1 with preview/apply and a background job.
- Order SMS still waits for W8's `JobProducer`.

Second follow-up (coordinator, 20 November 2026):
- **#26 temp.id email popup** (`create_order.html:7926-7990`, trigger `:1710`, `:2275`;
  `extra.exclusive_product` = added `prod_type == 5`, `order/views.py:1732`): `MembershipEmailPrompt.tsx`
  opens after a product add that brings a new membership line while the connected customer's email
  contains `temp.id` (read from W5's contact workspace). Submit checks the legacy email pattern
  ("Please provide a valid email"), posts W5's `…/customer-contacts/email` (legacy `ajax-m-user-email`,
  S19); success shows the server message and reloads the sale (legacy "Window reloading..."),
  failure shows the server message and keeps the popup open (legacy re-opens it). W5's contract
  covers what legacy needs; no backend change.
- **S35 ordering**: `exchanges.start` runs a read-only preflight (`repository.exchangePreflight`)
  before `begin`: exchange-enabled (check-in store) and store type-8 refusals, and for an online
  type-8 line the API-v2 eligibility answer decides the merged cell, so every refusal happens before
  the PENDING `pos_exchange_log` insert. The returns MySQL suite asserts no `pos_exchange_log` row and
  an unchanged `has_products.status` after a refused online type-8 exchange (49/49 on isolated MySQL).
- `API_V2_APP_ID` / `API_V2_APP_KEY` documented in `.env.example` (lookup answers 503 when unset).
- Commits `692e25bb`, `d034c9b3`.

Lead-side edits outside W4 ownership in this follow-up: `customer-insights/insights.tsx`
(`initiallyOpen` prop), `src/app.ts` (stock-locations route), `tests/customer-otp/*`,
`frontend/e2e/{returns.spec.ts,checkout/exchange.spec.ts}` (returns sub-agent).

Checks: backend tsc 0 errors, eslint clean, full vitest 680 passed / 2 failed (the two expected
`migrations.test.ts` cases: deleted SQL still listed in `migrationPaths`), MySQL suites env-gated
except where noted; customer registration MySQL 11/11 and returns/return-window MySQL (74) were run on
isolated loopback MySQL 8.4. Frontend tsc 0, eslint clean, vitest 297 passed (browser files skipped).
Playwright/e2e not run.
