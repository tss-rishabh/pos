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

---

# Round 2: blockers answered (20 November 2026, 02:20–04:00 IST)

- **Branch:** `uat/mac-e2e`, now with the W25 allowlist merged (`cd29f658`).
- **Messaging:** live through the guard in both processes (`outbound.allowlist.active`, lists 1/1/1). The stack refuses to start otherwise.
- **Same harness:** `W26_MESSAGING=live` and `W26_SHAPES=1`. The second flag logs only the key shapes of API-v2 replies, plus error titles with digits and emails masked.
- **Coordinator decisions applied:**
  - 7630106 is unblocked.
  - The Redis TLS rule is unchanged; the loopback relay is kept for UAT.
  - S3 flows are not run on UAT.
  - BigQuery views are a deployment prerequisite (§R6).

## R1. `.env.uat` gaps: mapping (names only; values derived at run time, never printed)

| Rewrite setting | Source | Confirmed in code |
|---|---|---|
| `TSS_JWT_HS256_KEY` / `TSS_JWT_HS512_KEY` | Legacy `SECRET_KEY` / `SECRET_KEY_512` | Legacy `encodeJwt`/`encodeJwt512` (`helpers.py:527-532`); rewrite `checkout/crypto.ts` |
| `ORDER_RECEIPT_TOKEN` | Legacy `ORDER_RECEIPT_TOKEN` | `invoice-documents/options.ts`; `order/views.py:803,842` |
| `TSS_RETURN_SECRET` | Legacy `ORDER_RECEIPT_TOKEN` (sent as `X-POS-Secret`), so not generated | `return-workflow/gateway.ts:26` |
| `INVOICE_MIGRATION` (=1) | Legacy `INVOICE_MIGRATION` | Store receipt = `MAIN_API_V2_URL + 'pos-shop'` (`invoice-documents/options.ts`) |
| `ORDER_SHOP_RECEIPT_URL` | Legacy value (api-uat `soulv2/invoicer`) | Unused while `INVOICE_MIGRATION=1` |
| `TSS_PAYMENT_ORDER_URL` | Legacy `PAYMENT_MICROSERVICE_ORDER_URL` path, on api-uat (`/api/v2/payment/orders`; the legacy file has a loopback host) | `checkout/gateway.ts` confirm → `order/views.py:2882` |
| `TSS_POST_ORDER_BASE_URL` | Legacy `POST_ORDER_API_BASE_URL` (api-uat `/api/v2/orderrefund/`) | `exchangeReasons` → `order/views.py:1362` |
| `TSS_RETURN_ELIGIBILITY_URL` | Legacy `ORDER_RETURN_STATUS_CHECK_URL`. **The legacy file points at production `api.thesouledstore.com`; the api-uat value already in `.env.uat` was used** | `return-workflow/gateway.ts:18` |
| `TSS_RETURN_REFUND_URL` | Legacy `ORDER_RETURN_PAY_AMT_TSS_MONEY` (api-uat) | `return-workflow/gateway.ts:24` |
| `TSS_RETURN_PERIOD_DAYS` | Legacy `RETURN_PERIOD` | `return-workflow/gateway.ts:28` |
| `TSS_VINCULUM_RETURN_URL`, `_API_OWNER`, `_API_KEY` | Legacy `VINCULUM_RETURN_URL` (UAT tenant `thesouledstoreuat.vineretail.com`), `VINCULUM_API_OWNER`, `VINCULUM_API_KEY` | `helpers.py:1893`; the stack now proxies that UAT host |
| `TSS_VINCULUM_TRANSPORTER_CODE` (=28) | Legacy default `VINCULUM_TRANSPORTER_CODE` (`settings.py:564`) | `helpers.py:1924` |
| `TSS_GIFT_CARD_SALT` | Legacy `GC_SALTKEY` | `checkout/service.ts` gift-card serial check |
| `PAYTM_PROD_URL` | Legacy `PAYTM_PROD_URL` (staging ECR) | `payments/gateway.ts:37`; `terminal_helpers.py:397` |
| `API_V2_URL` | Legacy `API_V2_URL` (api-uat) | Customer lookup, cancellations, order SMS |
| `POS_CUSTOMER_APP_ORIGINS` | UAT site (rewrite-only allowlist, S42) | `application-links/contracts.ts` |
| `AUTO_CANCEL_DURATION_IN_MINUTES`, `DAY_CLOSE_TOLERANCE`, `DEFAULT_GC_EX_DAYS`, `ECOM_DELIVERY_CHANGES_TIME`, `GLASSBOX_FINANCE_FEED_MAX_DATE_RANGE_DAYS`, `JWT_CUSTOM_EXPIRY_MIN`, `PG_DISC_OTP_EXEMPT`, `PG_DISC_ROLE_PERM`, `PRODUCT_SYNC_URI` | Same-name legacy values (typographic quotes stripped) | Same names in the rewrite |
| `CUSTOMER_REGISTRATION_SECRET`, `DISCOUNT_APPROVAL_SECRET` | Freshly generated (rewrite-only) | `customers/service.ts`, `discounts/delivery.ts` |
| `POS_STOCK_PROJECTION_CONTRACT` | Rewrite-only deployment switch (`.env.example:187`), enabled so that order cancel can restore stock. The stock projection is not certified as procedure parity (`parity/checkout.md:90`) | `db/stock-projection/options.ts` |

**Not set, with reasons:**

| Setting | Reason |
|---|---|
| `TSS_STORE_INVOICE_URL` / `TSS_POS_INVOICE_KEY` | These back the rewrite-only route `GET /stores/:id/orders/:id/invoice`. That route requires the path `/internal/pos/invoices/store`, which api-uat does not serve, and a key of at least 32 characters (legacy `POS_INVOICE_KEY` is empty). No UI calls the route; the UI invoice uses `pos-shop`, which works |
| `GLASSBOX_FINANCE_FEED_API_KEY` | The legacy UAT key is 12 characters; the rewrite requires at least 16 (`finance/feed.ts:21`). Setting it stopped start-up, so it is unset and the finance feed endpoint is off on UAT |
| `PG_DISC_STORE_MANAGER_PERCENTAGE` | The legacy UAT value is malformed JSON (the typographic quotes are mangled) |
| `SLACK_DEMO_URL` | Not allowlisted, and not needed |
| `BACKEND_SYNC_API_BASE_URL` | The legacy value is `localhost:3000`, so the Vinculum push job (`push_vinc_order_for_all`) is unconfigured |
| `API_V2_APP_ID` / `API_V2_APP_KEY` | **Wrong pair in `.env.uat`.** API-v2 checks `Ar_app_id/Ar_app_key` against its own `AR_APP_ID/AR_APP_KEY` (`api_v2 utils/auth.py:50-56`). `.env.uat` holds `APP_ID/APP_KEY`, and the legacy UAT file has no value. Result: `check-user-exclusive` answers 400 "Access not authorized", so "Fetch the User" cannot find any customer on UAT. **Needs the API-v2 UAT AR app credentials** |

## R2. New app bugs found on UAT and fixed (category a), one commit each

| Commit | Bug | Proof |
|---|---|---|
| `05d296c4`, `74eff68d` | The counter in-stock page pinned `FORCE INDEX (idx_store_id_stock_is_avail_is_del)`. With the index missing (UAT) every page failed with `ER_KEY_DOES_NOT_EXITS`, which also emptied the offline catalogue. Now the optimizer hints are `INDEX(product_store idx_…)` plus `NO_INDEX_MERGE(product_store store_id, is_avail, is_del)` | Loopback, production-shaped fixture (324k `product_store` rows in the store): **EXPLAIN equal to the former FORCE INDEX table by table** (range on the index, ~68k rows, ~100 ms both). Live read-only plan-gate output identical before and after (16/16 paths, 3 bounded plans, 0 diffs). Index dropped: identical page via the `store_id` ref (314 ms); the old statement fails `ER_KEY_DOES_NOT_EXITS`. New `tests/catalog/in-stock-index-hint.mysql.test.ts` (fails on the old code). W16 `products-plan-orm.mysql.test.ts` 3/3. Tool: `tools/catalog-index-hint-plan.ts`. **On UAT:** the catalogue loads in ~0.3 s and the offline cache holds 6,450 products. A two-index `INDEX(idx, store_id)` variant was rejected because it changed a search plan |
| `667038bf` | `ECOM_DELIVERY_CHANGES_TIME` was capped at 3600 in both the options and the service. The legacy UAT value 7200 stopped API start-up. Legacy has no bound (Redis EX) | `tests/administration/settings-options.test.ts`: 2 fail before, 13 pass after |
| `a88f22d0` | Every checkout mutation re-took the customer's 12-hour cart lease before its action. On a submitted or cleared sale the action is refused, but the lease stayed, blocking the customer with `CUSTOMER_CART_BUSY` for 12 h | New case in `tests/checkout/service.test.ts` (fails before, passes after); checkout suites 190/190 |
| `0abc6fe8` | The job worker claimed with `LMOVE`/`BLMOVE` (Redis 6.2+). **UAT Redis is 6.0.16** (shared with legacy Celery): 1,100 claim failures, and no job ever ran (order SMS and the other legacy jobs). Now uses `RPOPLPUSH`/`BRPOPLPUSH` (Redis 2.2+) | `tests/jobs/claimer-commands.test.ts`; `queue.redis.test.ts` 14/14; Redis compat probe passes; on UAT the queued jobs then ran |
| `18f62c77` | `storedEnumValue` matched ENUM members exactly. Payment completion writes the `order_status` name `'Delivered'`, which MySQL stores as `'DELIVERED'` (`_ci` collation); the rewrite wrote `''`. Every paid line had a blank status, so Returns and Exchange offered nothing | `tests/db/stored-enum-value.test.ts` (4 fail before, 8 pass after). Full backend suite with loopback MySQL: 991 passed. On UAT, orders after the fix have line `DELIVERED` |
| `f23870f5` | The return/exchange Vinculum payload ran `orders.zone_id` (TEXT state name) through `wireId()`, so every real return failed with 422 `UPSTREAM_IDENTIFIER_RANGE`. Legacy forwards it unchanged | `tests/checkout/returns-state.test.ts` (fails before); golden `returns-parity` unchanged and passing |

**Three-client rule** (all six fixes are backend-only):
- **Web:** full Playwright suite on the local stack, **41/41**.
- **macOS:** desktop offline suite on the local stack, **12/12** (§R5), plus every UAT desktop spec in this report.
- **Windows:** not run (no push). **For the primary agent:** run the `windows-latest` leg of `desktop-platforms.yml` on `uat/mac-e2e` for `05d296c4`, `74eff68d`, `667038bf`, `a88f22d0`, `0abc6fe8`, `18f62c77` and `f23870f5`. `0abc6fe8` also changes the Memurai compatibility probe (now `RPOPLPUSH`/`BRPOPLPUSH`).

## R3. Round-2 flow matrix (macOS desktop app on UAT)

| # | Flow | Result | Evidence and notes |
|---|---|---|---|
| 1 | Start-up with the derived env, guard confirmed in API and worker | Pass | After fixes `667038bf` and the feed key removal |
| 2 | Counter catalogue list and text search | Pass (after `05d296c4`/`74eff68d`) | 30 per page, ~0.3 s |
| 3 | Offline catalogue cache | Pass | 6,450 products |
| 4 | Confirm prices (API-v2 `cart` / `pos/product`) | Pass for product 262148 | Most other store-7 products answer 404 "Not found" / "Product Not found in given store": **(b)** the API-v2 UAT catalogue mirror (Mongo/Redis `productsv2`) does not hold them. Also one `pos/product` call took 49 s on API-v2 UAT |
| 5 | Customer lookup "Fetch the User" | Fail **(b, env)** | 400 "Access not authorized" (wrong `API_V2_APP_ID/KEY`, see R1) |
| 6 | Connect customer 12132565 | Pass, through the app's own connect endpoint | The same `PUT …/customer` "Connect the User" sends, called from the page because of #5. The connected id was checked before every use |
| 7 | Salesperson guard | Pass | `'0'` is refused (`SALESPERSON_NOT_SELECTED`, "Please Select Valid Salesperson."); a real store-7 salesperson is accepted |
| 8 | Final quote and legacy flags | Pass | |
| 9 | Cash, then `pos/order`, payment confirm (`payment/orders` 201), invoice number | Pass | Orders 19055005 and 19055009 |
| 10 | Tax invoice preview (`pos-shop`) | Pass | Frame rendered |
| 11 | Others (1001) with manual reference | Pass | 19055006 and 19055010; `order_stores.message` = the reference |
| 12 | Pine Labs UAT | Not offered **(c)** | Store 7 / C1 payment options are "Online Others" plus Paytm machines 1–5 only; no Pine Labs terminal is mapped in UAT |
| 13 | Paytm staging | Order created, payment refused **(c)** | 19055007: Paytm answered `0029 Invalid Merchant or Terminal`. No staging terminal; the order stays pending |
| 14 | Fast cash | Pass | 19055008 |
| 15 | Line status after payment | Pass after `18f62c77` | 19055005, 19055006 and 19055008 were written before the fix; their cleanup is in the ledger |
| 16 | Customer OTP for 12132565 | **Sent** | Guard permitted it; API-v2 `omnichannel-sendotp` answered 200. Trace `e687bc9e-9acb-4161-83eb-8e454d3361cd`. Verify not completed: the code reaches only the user |
| 17 | Customer contacts, profile, benefits (reads) | Pass | Customer insights fail **(b, env)**: `CUSTOMER_INSIGHT_*` is not configured (informational banner) |
| 18 | Order search, summary, detail | Pass | |
| 19 | Payment status on the pending Paytm order | No control shown | The detail offers "Refresh payment state" only |
| 20 | Cancel the pending order | Pass (needs `POS_STOCK_PROJECTION_CONTRACT`) | 19055007 cancelled, line CANCELLED, stock +1 |
| 21 | Return (cash order 19055009) | Fail **(c)** | After fix `f23870f5`, three attempts: Vinculum UAT did not confirm the inbound, so the legacy outcome "Order is under process, Please try again in 5 minutes." (`RETURN_WAREHOUSE_PENDING`). The follow-up `push_vinc_order_for_all` job is unconfigured (`BACKEND_SYNC_API_BASE_URL`, (b, env)). No refund or return row |
| 22 | Exchange (Others order 19055010) | Fail **(c)** | Only size L is in stock (other sizes 0), so a same-size exchange. Vinculum UAT did not confirm; `pos_exchange_log` 81 `FAILED_NEEDS_MANUAL_FIX` |
| 23 | Order SMS | Permitted, not delivered **(c)** | After the worker fix `0abc6fe8`, API-v2 UAT `omnichannel-sms` answered 500 |
| 24 | Offline: cash and card-reference sales | Pass | Receipts `OFF-7-7-5DB39517-1/-2` |
| 25 | Offline: restart while offline | Pass | Queue persisted; encrypted DB |
| 26 | Offline: reconnect, auto-sync into UAT | **Pass** | Orders 19055011/19055012 with invoices; `Offline bill …` comments; `is_offline_order=1`; card reference in `order_stores.message`, `is_manually_paid=1`; one finance reconciliation comment. With a product the API-v2 mirror lacks, the sync is held as `needs_manager` / `STOCK_SHORTFALL` (correct: no order) |
| 27 | Offline: limits from the backend (`maxOrders 1`) | Pass | The device adopted the limit; `ORDER_LIMIT` after 1 sale |
| 28 | Walk-in order SMS | **Suppressed** | Trace `9c4f04bb-3788-4cdd-a023-485ea9b75bd2` (account 7630106 not listed) |
| 29 | Offline unknown-outcome resolution | Not run | Needs a deliberately lost `pos/order` reply on a real order |
| 30 | Order copy | Not run | Time |
| 31 | Force return / type-8 rule | Not run | No type-8 order |
| 32 | Hyperlocal / express actions on own orders | Not applicable | POS store orders are neither hyperlocal nor express; the pages render (round 1) |
| 33 | Website handoff ("Place order now!") | Not run | It would open the system browser with a live customer login |
| 34 | Discount manager OTP | Not run | Store-manager mapping not configured (R1) |
| 35 | WhatsApp invoice | Not enabled | `ENABLE_WHATSAPP_INVOICE` is absent (legacy default False) |
| 36 | Exports, gift-card batch and archive mail | Not run on UAT | No isolated bucket (coordinator decision); the local stack covers them |

**Round-2 counts (36 rows):**
- **20 pass:** #1–3, 6–11, 14–18, 20, 24–28. This includes #16 (OTP sent) and #28 (send correctly suppressed).
- **2 partial:** #4 (only the API-v2-mirrored product) and #19.
- **6 fail:**
  - (b): #5.
  - (c): #12, #13, #21, #22, #23.
- **7 not run:** #29–31, #33–36.
- **1 not applicable:** #32.
- **(a) found and fixed this round: 6.** None open.

## R4. Messaging summary (round 2)

| Flow | Outcome | Trace |
|---|---|---|
| Customer OTP (12132565) | **Sent**, API-v2 200 | `e687bc9e-9acb-4161-83eb-8e454d3361cd` |
| Order SMS, customer orders | Permitted; **API-v2 UAT 500, not delivered** | `f7646089…`, `fb6d5792…`, `cad548b7…`, `2633606a…`, `7c44f848…`, `e286a2d4…` |
| Order SMS, walk-in offline orders | **Suppressed** (`not-allowlisted`) | `9c4f04bb-3788-4cdd-a023-485ea9b75bd2` |
| Return and exchange mails | Not reached: Vinculum did not confirm | |
| Discount manager OTP, WhatsApp invoice, gift-card mail | Not run (#34–36) | |
| Slack (round 1) | Report: delivered; day-close store channel: suppressed; common copy: delivered | See ledger M1–M2b |

## R5. Local-stack verification of the fixes (web and macOS)

- **Web:** full Playwright suite, **41/41**, Chromium, real stack, loopback MySQL 8.4 (port 33926).
- **macOS desktop offline suite:** **12/12** on the final code (6.2 min). It was also 12/12 earlier, on `05d296c4`.
- **Backend:** full vitest with loopback MySQL integration, 991 passed and 0 failed (318 skipped by their env gates).

## R6. Deployment prerequisites (recorded per decisions 2 and 4)

1. **Redis.**
   - Production Redis must be `rediss://`, or a TLS or relay sidecar must be confirmed (S13/S37 unchanged).
   - It must also accept `RPOPLPUSH`/`BRPOPLPUSH`. After `0abc6fe8`, Redis ≥ 2.2 is enough; before it, Redis ≥ 6.2 was needed, and UAT runs 6.0.16.
2. **BigQuery** (`plan.json` / `bigquery-deployment/README.md`; each input from the current server modules):

   | Area | Views and settings needed |
   |---|---|
   | Daily report, past days | `BIGQUERY_DAILY_ROLLUP_TABLE`, `BIGQUERY_DAILY_REPORT_PUBLICATIONS_TABLE`, `BIGQUERY_DAILY_REPORT_OFFLINE_CONTRACT` |
   | Dashboard | `BQ_DASHBOARD_FACTS_VIEW`, `BQ_DASHBOARD_PUBLICATIONS_VIEW`, `BQ_DASHBOARD_CONTRACT`, plus `BIGQUERY_FOOTFALL_TABLE` and `BIGQUERY_TARGETS_TABLE` |
   | Order transactions | `BQ_STORE_ORDER_SALES_VIEW`, `BQ_STORE_ORDER_RETURNS_VIEW`, `BQ_ONLINE_ORDER_SALES_VIEW`, `BQ_ONLINE_ORDER_RETURNS_VIEW` |
   | Returned orders | `BQ_RETURNED_ORDERS_VIEW` |
   | Flash sales | `BQ_FLASH_SALES_{LINES,ORDERS,ORDER_STORES,STORES,RETURN_ORDERS,REFUND_LOGS,AUTOMATED_REFUNDS,PAYTM_TRANSACTIONS}_VIEW` |
   | Hyperlocal daily | `BQ_HYPERLOCAL_DAILY_VIEW` |
   | Hyperlocal acceptance | `BQ_HYPERLOCAL_ACCEPTANCE_VIEW` |
   | Scheduled Slack reports | `BQ_HYPERLOCAL_{ORDER_FACTS,ORDER_LOGS,AVAILABILITY,CANCELLATIONS,DELIVERY_ISSUES,CRM_TICKETS}_VIEW` |
   | Salesperson and cashier performance | `BQ_SALESPERSON_PERFORMANCE_VIEW`, `BQ_CASHIER_PERFORMANCE_VIEW` |
   | Customer feedback history | `BQ_CUSTOMER_FEEDBACK_{VIEW,TABLE,ORDERS_TABLE,ORDER_STORES_TABLE}` |
   | Customer history | `BQ_CUSTOMER_HISTORY_{ORDERS,ORDER_STORES,LINES,PRODUCTS,FEEDBACK}_TABLE`, `BQ_CUSTOMER_HISTORY_LAYOUT` |
   | Order history (warehouse) | `BQ_ORDER_HISTORY_{HEADERS,LINES,STORES,PUBLICATIONS}_VIEW` |
   | Finance ledger, day-close history, feed | `BQ_FINANCE_{CASH_COLLECTIONS,CASH_COLLECTIONS_OFFLINE_CONTRACT,DAY_BANKING,DAY_CLOSES,OPENING_BALANCES,RECONCILIATION_SALES,RECONCILIATION_RETURNS}`, `BQ_PAYMENT_CORRECTION_PUBLICATIONS_TABLE` |
   | Inventory audit | `BQ_PRODUCT_INVENTORY_AUDIT_VIEW`, `BQ_STORAGE_INVENTORY_AUDIT_VIEW`, `BQ_HELD_INVENTORY_AUDIT_VIEW`, `BQ_INVENTORY_AUDIT_LIKE_UDF` |
   | Administration history | `BQ_ADMINISTRATION_HISTORY_{VIEW,MATCH_UDF,CONTRACT}` |
   | Special-permission activity | `BQ_SPECIAL_PERMISSION_ACTIVITY_{VIEW,MATCH_UDF}` |

   None is set in `.env.uat`. The package states that the `pos_reporting` dataset and its views need approved deployment.
3. **API-v2 UAT data and credentials:**
   - the AR app credentials (R1);
   - the product mirror for store-7 products (#4);
   - `omnichannel-sms` returns 500 (#23);
   - the Vinculum UAT tenant does not confirm POS returns (#21–22).
4. **UAT schema:** `product_store.idx_store_id_stock_is_avail_is_del` is still missing. The app now degrades gracefully, at ~0.3–0.45 s per page.

UAT writes for round 2 are listed in `w26-uat-writes.md` (Round 2): 8 orders and their rows, `pos_exchange_log` 81, and one Redis lease key deleted.
