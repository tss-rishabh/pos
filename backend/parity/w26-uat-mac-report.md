# W26 report: the macOS desktop app end to end against UAT

- **Branch:** `uat/mac-e2e`, from `bebded05`, merged with `refactor/single-stack-schema-freeze` at `cd29f658` (the W25 allowlist guard).
- **Machine:** this Mac (arm64), Node 24.22.3, Electron 45.3.2, Playwright 1.65.1.
- **Run window:** 20 November 2026, 01:21–02:20 IST.
- **Stack:** the real API and the real `worker:jobs` on UAT MySQL (`tss`), the shared UAT Redis and API-v2 UAT.
- **Credentials:** read at run time from `backend/.env.uat` and `~/.config/pos-uat/*`. None was printed, logged or committed.
- **Data:** no seeded or synthetic data was used.

**Bottom line.**
- Login, session, check-in, reads, admin, finance and day close work on UAT from the macOS app.
- **Checkout could not create a single order.** Three things stop it, and none is a code defect:
  1. operator 268's linked storefront account in UAT is disabled;
  2. `.env.uat` has no API-v2 JWT signing keys;
  3. UAT lacks a production index that the counter catalogue relies on.
- Because checkout is blocked, everything downstream of an order could not run: payment modes, invoices, returns and exchanges, the customer flows, offline sync, and most messaging.
- **One real app bug was found and fixed:** the API would not start with the legacy env value `COMMON_GROUP_ALERT_ON=1`.

## 1. How it ran

| Piece | What ran |
|---|---|
| Backend | `backend/tools/uat-e2e/uat-stack.ts` (committed). The real API (`src/server.ts`) and worker (`src/jobs/worker-main.ts`), using `.env.uat` plus command-line overrides only. `.env.uat` was not edited |
| Messaging | `W26_MESSAGING=live` after the coordinator's message. Both processes logged `outbound.allowlist.active` with phones=1, emails=1, slackWebhooks=1. The stack refuses to start otherwise |
| Guards (environment only, app unchanged) | Host check: every MySQL, Redis and HTTP host must be UAT or it refuses to start. An API-v2 reverse proxy that logs method, host and path only. An egress CONNECT allowlist: BigQuery, and in live mode Netcore, Gupshup and Slack. No AWS credentials. Freshdesk removed: its URL is the production helpdesk |
| Redis | UAT Redis is plaintext on its private VPC address (configured as UAT_EXPECTED_REDIS in the gitignored .env.uat). The app accepts plaintext Redis only on loopback (S13, S37), so the stack runs a loopback TCP relay to it |
| Desktop dev build | `npm run build`, then Electron 45 driven by Playwright `_electron` (`frontend/playwright.uat.config.ts`, `frontend/e2e-uat/01…10`), with the macOS mock keychain |
| Web | One Chromium spec (`10-web-smoke`) against the same backend |
| Packaged build | Unsigned `release/mac-arm64/Souled POS.app` and the CI native-smoke flavour (`release-smoke/`), built with `electron-builder --mac --dir --arm64` |

To re-run: start the stack with `W26_MESSAGING=live node --import tsx tools/uat-e2e/uat-stack.ts` from `backend/`, then run `npx playwright test -c playwright.uat.config.ts` from `frontend/`. Day close runs only with `W26_DAY_CLOSE=1`.

## 2. UAT baseline (before any write)

`npm run test:live-readonly` against UAT with `POS_PROD_RO_READONLY_PROOF=grants`.
- The UAT account has full DML grants. The session flag `transaction_read_only=1` was verified, so the session proof applied.
- **First run (19:21 UTC, before any write):** 91 tests passed, 3 failed, 2 skipped.
  - The summary line and evidence file were **not** written, because of a tooling bug (fixed in `9029e455`, §5).
  - The schema drift from that run is committed as `parity/evidence/w26-uat/uat-schema-drift-baseline.json`.
- **Re-run after the fix (02:17 IST):** 93 passed, 3 failed, 2 skipped. Evidence: `parity/evidence/w26-uat/live-readonly-uat-2026-11-19.json`.
  - Paths: 12 pass, 3 fail, 1 skip.
  - 338 statements, 0 locks, 0 refusals.

| Path | Result | Cause (category b: UAT schema or data drift) |
|---|---|---|
| schema | fail | 30 of 99 tables drift from the production snapshot. Besides the four the primary found, these matter: `product_store` is missing `idx_store_id_stock_is_avail_is_del`; `vinculum_auto_delivered_logs.order_id` is not indexed; `salespersons.user_type` is `varchar(45)` (production: `tinyint`); `pos_paytm_machines.device_serial_no` is `int`; `has_products.status` enum differs; `pos_exchange_log` datetimes have no fractional seconds; `store_day_close` has an extra `pincode_system` |
| catalog-product-barcode | fail | `ER_KEY_DOES_NOT_EXITS`: the counter catalogue's `FORCE INDEX (idx_store_id_stock_is_avail_is_del)` index exists in production but not in UAT |
| reports-scheduled-hour | fail | `ER_BAD_FIELD_ERROR`: `hyperlocal_to_online_order_logs.reason` and `remark` are missing in UAT |
| orders-store-list-detail | skip `RO_PLAN_ROWS` | Full scan of `vinculum_auto_delivered_logs`, because UAT has no `order_id` index |

## 3. Flow matrix (macOS desktop app on UAT unless noted)

Legend:
- **Pass:** it worked on UAT.
- **Fail (x):** it failed, with category (a) app bug, (b) UAT schema or data drift, or env gap, or (c) UAT external-service or infrastructure limitation.
- **Blocked:** not reachable because an earlier step failed.
- **Not run:** a rule or safety reason, given.

| # | Area | Flow | Result | Evidence and notes |
|---|---|---|---|---|
| 1 | Login | Password, then the fixed OTP for user 268, check-in to store 7 | Pass | `01-login-pages`; 20 successful sign-ins in the run |
| 2 | Login | Counter C1 and check-in page (store 7, expires 23:59:57) | Pass | `03` check-in step |
| 3 | Login | Logout returns to sign-in | Pass | `03` |
| 4 | Login | Session expiry: `pos_session` cookie removed in the `persist:souled-pos` partition, then a reload shows sign-in | Pass | `03` |
| 5 | Login | Staff login OTP resend | Pass | First attempt got 429 `LOGIN_RESEND_WAIT` inside the 30-second cooldown, as designed. After the cooldown: 200, but user 268 is the fixed-OTP user, so no mail is sent (`identity.login-otp.fixed-issued`) |
| 6 | Login | Transient start-up failures | Fail (c) | One `ETIMEDOUT` and one `AUTH_STORE_UNAVAILABLE` from a VPN blip to UAT RDS and Redis. Recovered; the Redis relay now uses TCP keepalive |
| 7 | Counter | Barcode scan of a real store-7 product (GTIN 8907880531278, Rs. 49) adds it to the sale | Pass | `02` |
| 8 | Counter | Store catalogue list and text search | Fail (b) | `GET /stores/7/catalog/products` 500 (`ER_KEY_DOES_NOT_EXITS`, the missing UAT index). 42 failed calls |
| 9 | Catalog | Product details and store stock (product 214648) | Pass | `03` |
| 10 | Catalog | Inventory matrix and catalogue search | Partial (b/c) | The page renders. The one catalogue-details search in the sweep hit `ER_QUERY_TIMEOUT` on UAT |
| 11 | Checkout | Review sale, then "Confirm prices online" | Fail (b) | 403 `CUSTOMER_DISABLED`. The checkout session uses the operator's storefront account: the lowest-id `users` row with `user_type=8` and `pos_admin_id=268`. That is **7630106**, which has `is_block=1` and `is_disabled=1`. Legacy `MUser.objects.filter(...).first()` (`order/views.py:1518`) picks the same row. 12132565 is the second such row |
| 12 | Checkout | Next step after #11: customer token signing | Fail (b, env) | Shown by reading the code, not observed. `.env.uat` has no `TSS_JWT_HS256_KEY` or `TSS_JWT_HS512_KEY` (legacy `SECRET_KEY` / `SECRET_KEY_512`), so `issueCustomerToken` would answer 503 `CHECKOUT_IDENTITY_UNAVAILABLE` |
| 13 | Checkout | Quote, salesperson guard, legacy flags, coupons, PG discount, vouchers, wallet, points | Blocked | By #11 |
| 14 | Checkout | Attach customer 12132565 and customer OTP | Blocked | Needs a checkout session (#11) |
| 15 | Checkout | Cash; Pine Labs UAT; Paytm staging; Others (1001) with manual reference | Blocked | By #11. No terminal call was made. Pine Labs UAT is configured (`PINELAB_URL`). The UAT file names Paytm `PAYTM_URL`, but legacy and the rewrite read `PAYTM_PROD_URL`, so the stack maps it |
| 16 | Checkout | API-v2 `pos/order`, then the invoice | Blocked | Zero API-v2 calls in the whole run |
| 17 | Checkout | Fast cash (F) | Fail (b) | Same 403 `CUSTOMER_DISABLED` |
| 18 | Orders | Order search by ID and date (existing store-7 order 19054775) | Pass | Read only. HTTP outcomes only, no screenshots of another customer's data |
| 19 | Orders | Store order summary dialog | Pass | |
| 20 | Orders | Invoice preview | Fail (b, env) | 503 `INVOICE_UNAVAILABLE` "Invoice delivery is not configured.": the invoice renderer settings are missing from `.env.uat` |
| 21 | Orders | Online and express detail; order copy, cancel, payment status | Not run | Only allowed on orders created in this run, and there are none (#11) |
| 22 | Returns | Return, exchange, force return (type-8 and exchange-store rules) | Blocked | No own orders |
| 23 | Fulfillment | Hyperlocal progress, local deliveries, monitor pages | Pass | They render, with no orders. The actions are blocked: no own orders |
| 24 | Fulfillment | Sync centre page; order-status push | Pass (page) / Blocked (push) | |
| 25 | Customer | Website handoff, contacts, profile (12132565) | Blocked | Needs a connected checkout customer (#11) |
| 26 | Reports | Daily store sales, order transactions, customer feedback | Pass | |
| 27 | Reports | Returned orders, flash sales, hyperlocal daily, day-close history | Fail (b, env) | 503 `DEPENDENCY_UNAVAILABLE`: no `BQ_*` view names in `.env.uat` |
| 28 | Reports | Scheduled Slack report `hyperlocal-store-status` (service API, inline) | Pass | **Delivered** to the allowlisted Slack. Trace `e01a2df2-9296-48f0-8b0d-a33e94fe9add` |
| 29 | Reports | Scheduled `hyperlocal-summary` | Fail (b, env) | BigQuery view not configured |
| 30 | Reports | Export through the job queue (order transactions, store 7) | Fail (c) | 503 `REPORT_STORAGE_UNAVAILABLE`. The only bucket in `.env.uat` (`pos-store-tss`) is not UAT-isolated, so the stack withholds it and AWS credentials. Nothing was queued or written |
| 31 | Finance | Cash ledger, day-close page (system figures) | Pass | |
| 32 | Finance | **Day close for store 7, run once at the end** | Pass | `store_day_close` id 36, `store_day_banking` id 8. Request `4091097b-247a-4cf4-aaa0-42955c3a7f4e` |
| 33 | Finance | Day-close pending alert, scoped to store 7 | Pass | Store-7 Slack **suppressed** (`outbound.suppressed`, `not-allowlisted`). Common-channel copy **delivered**. Trace `2cc995f8-4f7c-44d2-a4b1-e704b8e7aba0` |
| 34 | Admin | Administration, barcodes, application links, countries, gift vouchers, wallet adjustments, profile, documentation pages | Pass | |
| 35 | Admin | Store 7 edit: `per_hour_threshold` 5 → 6, then reverted to 5 | Pass | Final value checked by SQL |
| 36 | Admin | Model accounts and model history | Pass | Correctly refused (403 `MODEL_ADMINISTRATION_DENIED`): user 268 is not a superuser |
| 37 | Admin | Permission history (older dates) | Fail (b, env) | BigQuery history not configured |
| 38 | Gift cards | Batch list | Pass | Each view writes a legacy audit row (ledger rows 3–4) |
| 39 | Gift cards | Small batch through the queue, plus delivery mail | Not run (c) | It needs the S3 archive bucket, which UAT does not have (#30) |
| 40 | Shell | Notifications, shortcut reference, dashboard cards | Pass | |
| 41 | Shell | Dashboard history | Fail (b, env) | 503 `DASHBOARD_PUBLICATION_UNAVAILABLE` (BigQuery) |
| 42 | Offline | Device eligibility, counter cache and limits from the backend (120 min / 10 orders) | Pass | `05` |
| 43 | Offline | Network cut shows "Working offline" | Pass | |
| 44 | Offline | Bill cash and card reference offline | Fail (b) | The device caches 0 products: the catalogue is cached from the same failing read (#8) |
| 45 | Offline | App restart while offline | Pass | The service-worker shell auto-opens `/offline-billing`. The DB file has no SQLite header |
| 46 | Offline | Reconnect and auto-sync into UAT orders (comments, `is_offline_order`, 1001 with the reference in `order_stores.message`) | Blocked | Nothing to sync (#44). Sync would also hit #11 and #12 |
| 47 | Offline | Limits: backend restarted with a 1-order limit | Pass | The device adopted `maxOrders: 1` after reconnect and kept it offline |
| 48 | Offline | Unknown-outcome resolution | Not run | It needs a real `pos/order` with a lost reply. Not possible without an order (#11) |
| 49 | Packaging | Unsigned release `.app` and native-smoke flavour build; `verify-desktop-package.mjs` | Pass | Both builds verified (fuses, ASAR integrity, flavour) |
| 50 | Packaging | Packaged native-smoke app launched against the UAT workspace | Pass (launch) | It reached the backend: session-state, capabilities, readiness. It created an encrypted `offline-billing.db` through the **real login Keychain** (item "Souled POS Safe Storage"). UI not driven: packaged builds refuse CDP (S59) |
| 51 | Web | Chromium sign-in and day-close page on the same UAT backend | Pass | `10-web-smoke` |

**Exact counts (51 rows):**
- **27 pass.**
- **2 partial:** #10 and #24.
- **12 fail:**
  - (a): 0 still open. The one app bug found was fixed (§5).
  - (b), including env gaps: 10 (#8, 11, 12, 17, 20, 27, 29, 37, 41, 44).
  - (c): 2 (#6, #30).
  - (d) blocked by the messaging rule: 0. The allowlist was live for the whole run.
- **7 blocked:** #13, 14, 15, 16, 22, 25, 46, all by #11 or #44.
- **3 not run:** #21, 39, 48.

API calls recorded from the app: 566. 500 succeeded, across 51 distinct endpoints. The 66 errors are fully listed in the matrix rows above.

## 4. Messaging flows (allowlist live, per the coordinator's instruction)

| Flow | Outcome | Trace |
|---|---|---|
| Slack: scheduled report | **Delivered** (allowlisted `SLACK_URL`) | `e01a2df2-9296-48f0-8b0d-a33e94fe9add` |
| Slack: day-close pending alert to the store-7 channel | **Suppressed** (`outbound.suppressed`, flow `report-slack-post`) | `2cc995f8-4f7c-44d2-a4b1-e704b8e7aba0` |
| Slack: the same alert's common copy | **Delivered** | `2cc995f8-4f7c-44d2-a4b1-e704b8e7aba0` |
| Staff login OTP (email) | Not sent: fixed-OTP user, by design | `5d352496-dcf0-44d1-a3bb-bbbd157ed711` |
| Customer OTP for 12132565 | Not reached | Checkout session refused (#11) |
| Order SMS (`omnichannel-sms`) | Not reached | No order |
| WhatsApp invoice | Not enabled | `ENABLE_WHATSAPP_INVOICE` is absent from `.env.uat`; the legacy default is False |
| Return and exchange mails | Not reached | No order |
| Discount manager OTP | Not reached | No checkout |
| Gift-card delivery mail | Not reached | No S3 bucket (#39) |

The allowlist status of the test identities was checked without printing any value:
- customer 12132565's phone and email are listed;
- operator 268's email is listed;
- `SLACK_URL`, `LOGIN_SECURITY_SLACK_WEBHOOK` and `SLACK_WHATSAPP_ALERT_WEBHOOK` are listed;
- the store-7 `slack_group_url` is **not** listed.

The egress log shows exactly two Slack connections and no other provider traffic.

## 5. Fixes (one commit per root cause)

1. **`dbd36fde`: Finance alerts parse `COMMON_GROUP_ALERT_ON` as legacy `int(env, 0)`.** Category (a).
   - **Bug.** The UAT env, generated from the legacy env, sets `COMMON_GROUP_ALERT_ON=1`. `financeAlertOptions` accepted only `true` or `false`, so `registerFinance` threw at start-up and **the API refused to start**. Production would do the same with its legacy value.
   - **Root fix.** Legacy reads the value as an integer (`settings.py:515`), and `fulfillment/options.ts` already does. Any non-zero integer now enables the copy; `true`/`false` stay accepted.
   - **Test.** New `tests/finance/alert-options.test.ts`: 5 of 9 cases fail before the fix and all 9 pass after. Related suites pass: finance, outbound and fulfillment, 137 tests.
   - **Three-client proof:**
     - **Web:** Playwright Chromium `e2e-uat/10-web-smoke.spec.ts` passed against the fixed backend with the value `1`.
     - **macOS:** every desktop spec in this report ran on the fixed backend. Without the fix the backend does not start.
     - **Windows:** not run (no push). **For the primary agent:** run the `windows-latest` leg of `desktop-platforms.yml` on this branch. The change is backend-only, so it is not platform-specific code.
2. **`9029e455`: live read-only summary.** Tooling, not client-facing.
   - **Bug.** A drifted 800-character enum type broke `assertAggregateOnly`, so no summary or evidence was written for runs with that drift.
   - **Fix.** Long types are now summarised as their first 60 characters plus the length and a SHA-256 prefix.
   - **Test.** New `tests/live-readonly/schema-summary.test.ts`.
3. **`c47c95f4`: the UAT harness** (§1). Test tooling only.

Not changed (outside my ownership, or not an app bug):
- **The outbound adapters and their guard (W25).**
- **Config.**
- **`FORCE INDEX` in `catalog.ts`.** This is correct for production; on UAT it causes the (b) failure. Note for the catalog owner: one missing index takes down both the counter catalogue and offline billing.
- **`ER_KEY_DOES_NOT_EXITS` returned as 500 `INTERNAL_ERROR`.** Acceptable: no SQL text leaks.

## 6. For the primary agent: what unblocks the rest of the scope

1. **UAT data.** Operator 268's lowest-id linked storefront account, 7630106, is blocked and disabled. Legacy and the rewrite both select it. Either:
   - unblock it in UAT; or
   - test with an operator whose first `users` row with `user_type=8` and `pos_admin_id=<op>` is active.

   Customer 12132565 is itself a type-8 account linked to 268, not a regular customer.
2. **`.env.uat` gaps.** The rewrite reads these and the UAT file lacks them:
   - `TSS_JWT_HS256_KEY` and `TSS_JWT_HS512_KEY` (legacy `SECRET_KEY` and `SECRET_KEY_512`). These are required for every API-v2 cart call.
   - The invoice renderer settings: `TSS_STORE_INVOICE_URL`, `TSS_POS_INVOICE_KEY`, `ORDER_SHOP_RECEIPT_URL` and `ORDER_RECEIPT_TOKEN`.
   - `TSS_PAYMENT_ORDER_URL`, `TSS_POST_ORDER_BASE_URL`, `TSS_RETURN_REFUND_URL`, `TSS_RETURN_ELIGIBILITY_URL`, `TSS_RETURN_SECRET`, `CUSTOMER_REGISTRATION_SECRET`, `DISCOUNT_APPROVAL_SECRET` and `TSS_GIFT_CARD_SALT`.
   - The `BQ_*` view names.
   - `POS_CUSTOMER_APP_ORIGINS`. The stack set it to the UAT site.
   - `PAYTM_PROD_URL`. The file has `PAYTM_URL`; the stack maps it.
   - A UAT-only S3 bucket and credentials.
3. **UAT schema.** Add `product_store.idx_store_id_stock_is_avail_is_del` (it is in production). Without it there is no counter catalogue, no search and no offline billing.
4. **UAT Redis has no TLS.** The app refuses plaintext non-loopback Redis, so deployments need `rediss://` or a local TLS or relay sidecar. Confirm what production uses.

Once these are fixed, re-run `e2e-uat/04-checkout` and `05-offline`. They continue through payment, `pos/order`, the invoice and sync, and they record order IDs in the ledger automatically.

## 7. Write ledger

See `backend/parity/w26-uat-writes.md`:
- the store-7 threshold edit and its revert;
- two gift-card-view audit rows;
- day close id 36 and banking id 8;
- `last_login` updates;
- `pos:` Redis keys with TTLs;
- 2 Slack posts delivered and 1 suppressed.

No orders or invoices were created.

## 8. Housekeeping

- Every process this run started was stopped by its own PID: the stack and its backend, worker and preview, the Electron apps, and the packaged app. The ports 4760–4767 are free.
- Local-only artifacts under `.tmp/w26/` (git-ignored): logs, screenshots and the API/outbound call logs.
- `frontend/release*/` are build outputs and are not committed.
- The verifier's rewrite of `backend/evidence/desktop-package-*.json` was restored.
- The packaged launch created or used the login-Keychain item **"Souled POS Safe Storage"**. Delete it in Keychain Access if you do not want it kept.
