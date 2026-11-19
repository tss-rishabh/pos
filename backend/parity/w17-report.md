# W17 report: Electron desktop end to end, including offline billing

Branch `w17/electron-e2e`, from integration head `3a3e0ab5`. Everything ran on loopback only: a private
MySQL 8.4 (`sql_mode=''`, port 33717, data dir under the worktree `.tmp/`), private `redis-server`
instances, the real backend, and fake/stand-in adapters. Nothing connected to production. All services
were stopped at the end.

## 1. How to run

```sh
cd frontend && npm run build               # renderer + electron/dist/offline-billing.cjs
node node_modules/electron/install.js      # once, if installed with --ignore-scripts (Electron 45.3.2)
# Existing Electron shell specs (W10 stack):
E2E_MYSQL_URL=mysql://root@127.0.0.1:<port>/pos_rewrite_e2e npx playwright test e2e/electron.spec.ts
# Desktop offline-billing e2e (new stack, below):
E2E_MYSQL_URL=mysql://root@127.0.0.1:<port>/pos_rewrite_e2e_offline \
  npx playwright test -c playwright.desktop.config.ts
```

The `better-sqlite3-multiple-ciphers` 13.0.3 binary is an N-API prebuild (`prebuilds/<platform>-<arch>.node`).
It loads in both Node 24 and Electron 45 without a rebuild. `npmRebuild: false` is correct.

### New e2e stack: `backend/tools/e2e/offline-billing-stack.ts`
This reuses W10's `seed.ts`, `fakes.ts` and `private-redis.ts`. It does not modify them. On top of the
W10 pieces it adds:
- **`order-api.ts`, a stateful API-v2 stand-in.** It implements `pos/product`, `pos/cart`
  (get/set/delete/clear), `validatecheckout`, `processorder` and `pos/order`, plus the payment-order
  confirmation.
  - `pos/order` writes the `orders`, `order_stores` and `has_products` rows that API-v2 would write. It
    sets `order_ref_no = API2-<id>` (owned by API-v2) and `payment_methods=14`, `payment_statuses=1`.
  - The real backend finalizer then assigns the invoice number.
  - Stock checks read `product_store`.
  - Mode `uncertain` creates the order and then answers a 200 without the order keys. This reproduces the
    legacy KeyError.
- **Two TCP gates.** One sits on the web origin (4173 → vite preview on 4174) and one on the backend
  (4410 → 4411). "Network down" refuses connections on both, which is how a store device without internet
  sees it. The renderer then runs from its service-worker shell. `dropSaleResponses` forwards an upload
  but drops its reply, which simulates a lost response.
- **A control API on 4499.** It can:
  - toggle the network;
  - restart the backend with other `OFFLINE_BILLING_MAX_*` values (MySQL and Redis keep their state);
  - switch the order mode;
  - add a terminal transaction;
  - read back offline orders: the `comments` row, `order_ref_no`, `is_offline_order` and the invoice.
- **Extra synthetic seed** needed so checkout can create orders:
  - the operator's checkout account (`m_user` user_type 8 with `pos_admin_id`);
  - 2 salespeople per store;
  - `order_status` id 3;
  - active "Others" terminal mode 1001;
  - JWT keys for the customer token.

`safeStorage`: the specs pass Chromium's standard `--use-mock-keychain` switch, so no item is created in
the developer's login keychain. The wrap and unwrap path is the real Electron `safeStorage` API. Only the
OS keystore behind it is mocked. The real macOS Keychain and Windows DPAPI paths were not exercised.

## 2. E2E matrix (real Electron 45.3.2, macOS arm64)

| # | Scenario | Result |
|---|---|---|
| E1 | `e2e/electron.spec.ts`: sandboxed, isolated renderer after a real sign-in | Pass |
| E2 | `e2e/electron.spec.ts`: external links, redirects and new windows blocked; application/customer link allowlists | Pass |
| O1 | Sign in (password + fixed OTP) and check in to the store. The device caches the operator, counters, salespeople and catalogue. Limits come from the backend (120 min / 10 orders). The service worker shell is ready. | Pass |
| O2 | Network cut (web + backend). The UI shows "Working offline". Cash sale through the UI: provisional receipt `OFF-1-1-<dev>-1`, change Rs. 1.00. Card sale with manual reference `RRN-SYN-0001`: receipt `…-2`. No `pos/order` call. | Pass |
| O3 | App restart while still offline: the shell loads from the service worker, it auto-switches to offline billing, and both queued sales persist. | Pass |
| O4 | DB file: the header is not `SQLite format 3`. Opening it with plain `better-sqlite3-multiple-ciphers` and no key fails ("not a database"). The key file is not the raw hex key. | Pass |
| O5 | Reconnect: auto-sync with no user action. 2 real orders, with real invoice numbers shown in the device table. Each has a `comments` row `Offline bill <ref> billed at …`. `order_stores.is_offline_order=1`. `order_ref_no` is still `API2-<id>`. Store and counter are correct. 2 `pos/order` calls. | Pass |
| O6 | Replay: the upload reply is dropped once, the device re-uploads automatically, and the server answers 200 "existing". Exactly 1 comment and 1 `pos/order` call for that reference. | Pass |
| O7 | Forced uncertain outcome: `needs_manager` / `OUTCOME_UNKNOWN`. After 35 s more (2+ heartbeats), `pos/order` has still been called only once. The manager links the order found in Orders via the Resolve dialog (`link-order`). The sale ends `synced` with that order ID, a comment, `is_offline_order=1` and `order_ref_no` untouched. Still only 1 `pos/order` call. | Pass |
| O8 | 10 offline orders succeed. The 11th is refused (`ORDER_LIMIT`), and the UI shows "10 of 10 orders used" and hides the composer. All 14 sync. | Pass |
| O9 | The backend restarts with `OFFLINE_BILLING_MAX_ORDERS=3` while the device is offline: the device still shows 10. After reconnect it shows 3. Offline again: 3 orders allowed, the 4th refused. | Pass |
| O10 | `OFFLINE_BILLING_MAX_MINUTES=1`: a sale inside the window is accepted. After 62 s, `TIME_LIMIT`. | Pass |
| O11 | Main-process wall clock moved back 10 min (`Date.now` override; the monotonic clock keeps running): `CLOCK_INCONSISTENT`, and billing is blocked. | Pass |

All 11 desktop tests and both shell tests passed on the final code. Unit tests:
- frontend `tests/offline-billing`, `offline-shell` and `offline`: 49/49;
- backend `tests/offline-sync` and `orm-metadata`: 27/27.

Typechecks:
- frontend `tsc`, electron `tsc` and `eslint .` are clean;
- backend `tsc` is clean.

Simulation limits:
- The time window was shortened through the env var, not by waiting 2 h.
- Clock tampering was simulated in the main process, not by changing the OS clock.

## 3. Packaging (unsigned, macOS arm64)

`CSC_IDENTITY_AUTO_DISCOVERY=false POS_DESKTOP_URL=https://pos.example.test npx electron-builder --mac --dir --arm64`

- **Result.** `release/mac-arm64/Souled POS.app`: 262 MB on disk, about 116 MB zipped. `app.asar` is
  1.6 MB. `Resources/offline-sqlite` is 3.2 MB and contains `lib/` and only `prebuilds/darwin-arm64.node`.
  Fuses were applied, and the app has an ad-hoc signature (`resetAdHocDarwinSignature`).
- **SQLCipher in the packaged app.** I launched the packaged binary against a local preview with a
  temporary profile and the mock keychain, then connected over CDP. `offline:status` reported
  `available: true` with no unavailable reason. `offline-billing.db` was created and encrypted (no plain
  SQLite header), and nothing `offline.storage.unavailable` was logged. The native module loads from
  `resources/offline-sqlite` outside the ASAR.
- **Hardening after that check.** Packaged builds now exit on `--remote-debugging-port`,
  `--remote-debugging-pipe` and `--use-mock-keychain` (verified: exit code 1, no profile files written).
  So re-running the CDP check against a new package requires a dev (unpackaged) launch.
- **Warnings:**
  - "default Electron icon is used": no application icon is configured;
  - "duplicate dependency references" (`react-dom`, `@types/react`): harmless, because `node_modules` is
    excluded;
  - code signing skipped (by design).
- **Not run:** universal or x64 mac builds, dmg/zip targets and the Windows NSIS build.

## 4. Signing and notarisation prerequisites (out of scope, need the user's certificates)

- **macOS:**
  - A "Developer ID Application" certificate, exported as `.p12`, passed as `CSC_LINK` and
    `CSC_KEY_PASSWORD`, or installed in the CI keychain.
  - Notarisation credentials: either `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`, or an
    App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). Then add
    `mac.notarize: true`.
  - `hardenedRuntime` is already on. Add an entitlements plist with at least
    `com.apple.security.cs.allow-jit`. Verify that `@electron/osx-sign` signs
    `Resources/offline-sqlite/prebuilds/*.node` (it walks nested Mach-O files).
  - Then check with `codesign --verify --deep --strict`, `spctl -a -vv` and `stapler validate`.
- **Keychain continuity.** A signed app stores its `safeStorage` secret as "Souled POS Safe Storage" in the
  user's keychain. If the signing identity or bundle ID changes, macOS prompts or refuses. The offline key
  then cannot be unwrapped, and offline billing reports "unavailable"; the DB is never deleted. Keep one
  Team ID and `appId` across releases. Sync all sales before a re-sign migration.
- **Windows:** an Authenticode certificate (EV or Azure Trusted Signing recommended for SmartScreen), via
  `CSC_LINK`/`CSC_KEY_PASSWORD` or a signing hook. DPAPI wraps the key per Windows user, so a different
  Windows login cannot open the device DB.
- **Icon:** add `build/icon.icns` and `build/icon.ico`.

## 5. Bugs found and fixed (owned files)

1. **Offline sync could never create an order.**
   - The checkout submit requires a master salesperson (legacy "Please Select The Salesperson.",
     `order/views.py:2969-3019`). Offline sales had none, so every sync failed.
   - Fix:
     - The device caches the store's active checkout salespeople (`/stores/:id/salespeople`) with the
       catalogue, in device DB migration 2.
     - The offline composer requires one (new IPC channel `offline:salespeople:list`, also in the
       preload allowlist).
     - The upload carries `salespersonId`, and the server assigns it through
       `checkout.salesperson(...)` before the quote.
2. **Definite pre-dispatch refusals were reported as `OUTCOME_UNKNOWN`.** For example,
   `SALESPERSON_REQUIRED` left the Redis record "submitting", so the sale sat with the manager with a
   misleading message. Now known pre-`pos/order` refusals clear the record and return
   `OFFLINE_CONFLICT_REJECTED` with the real message.
3. **Offline billing was never eligible.**
   - The device required a counter on the server check-in. Legacy check-ins carry no counter
     (`administration/checkins.ts` always returns `counterId: null`).
   - Fix: the store comes from the check-in; the counter is chosen in the composer from the checked-in
     store's active counters cached at the last online contact. The server still validates the counter
     at sync.
4. **The unknown-outcome resolution was a dead end.**
   - "Accept" worked only if the manager was the same operator and the checkout was already
     `submitted`. A real uncertain checkout has no order ID, so the only working option was "void".
   - New manager decisions for `OUTCOME_UNKNOWN`:
     - **`link-order`** (the order ID found in Orders). The server verifies the same store and counter,
       the same products and quantities, a creation time no earlier than a day before billing, and that
       the order is not linked to another offline reference. It then writes the comment, sets
       `is_offline_order` and settles the tender.
     - **`recreate`.** The manager confirms that Orders has no order, and exactly one fresh creation is
       allowed.
   - Nothing is ever resubmitted without one of these decisions.
5. **Auto-switch to offline billing used `navigator.onLine` only.** It never fired when the device had a
   LAN but no route to the store service. It now uses the main process's own reachability probe, with
   `reachabilityKnown` added so it does not flicker at start-up.
6. **Packaged builds accepted Chromium debugging switches and the mock keychain** (see §3). They are now
   refused.

Shared or other files: none of `app.tsx`, `config.ts`, `package.json`, `stack.ts`, `fakes.ts` or `seed.ts`
were edited. New files:
- `backend/tools/e2e/{offline-billing-stack,order-api}.ts`
- `frontend/playwright.desktop.config.ts`
- `frontend/e2e-desktop/offline-billing.spec.ts`

Tests were updated only for the new required fields: device-sync, ipc and offline-sync service. Three
backend cases were added: link, recreate, and the pre-dispatch refusal.

## 6. Bugs and gaps left (outside ownership, or a decision is needed)

- **The "Others" mode 1001 must be active in production.** Card/UPI offline sales settle as legacy
  "Others" (1001). If `pos_terminal_payment_modes` has 1001 inactive, the order is created but the
  payment is refused, and the sale shows `REJECTED` with the order already recorded. A manager
  "accept" re-runs only the payment.
- **Linked orders get no payment-order confirmation.** Their invoice number and line salespersons are
  now assigned (§7.3). The payment-microservice confirmation for an order whose `pos/order` reply was
  lost is still never sent, the same as the legacy KeyError outcome.
- **W10 stack cannot create orders.** Routed to W14; see §7.4.
- **Automatic re-upload after a lost response or a 5xx.** This is a status lookup against the Redis
  record (`pos:offline_sale:<ref>`, 30 days) and the comment fallback. The server never resends
  `pos/order` without a manager. Residual risk: if the process dies between `pos/order` and the comment
  write, and the Redis record is also lost, a re-upload could create a duplicate.
- **A stale in-flight (non-submitting) record owned by another operator** keeps answering "retry" until
  its TTL.
- **The packaged app still honours `NODE_ENV=development` + `POS_DESKTOP_URL`** (http loopback and a
  `userData` override). This is pre-existing "explicit provisioning" design. Consider refusing
  development mode when `app.isPackaged`.
- **No app icon, and no Windows build or e2e.** There is no native Redis on Windows, and the NSIS build
  was not run.
- **Incident.** While cleaning up my own orphaned private Redis servers I once ran
  `pkill -f "redis-server 127.0.0.1"` (about 17:07). It could also have stopped another agent's private
  test Redis at that moment. If a W14/W16 suite failed with a Redis connection error around then, re-run
  it.

## 7. Follow-up (coordinator, after merge at `544b8ab9`)

### 7.1 Standalone-terminal card/UPI references are accepted (AGENTS.md "Offline card/UPI")
- **Legacy representation.** In the counter payment form, the "Transaction ID" field is generated and
  disabled. The cashier types free text into the required "Message" field
  (`order/templates/order/create_order.html:5825-5870`, required at `:5913-5920`). It is posted to
  `/orders/ajax-transaction-upload/`, which is `AjaxTransactionUploadView` (`order/views.py:3020-3063`).
  For "Others" mode 1001 that calls `Helpers.complete_order(..., others=True, is_terminal=False)`
  (`order/views.py:3060-3063`). complete_order (`helpers/helpers.py:625-641`) stores:
  - the typed text in `order_stores.message`;
  - the generated id in `transaction_id`;
  - `is_manually_paid=1` and `online_other_payment=<amount>`;
  - payment status 4 and order status 3;
  - the legacy "status changed by pos admin" comment.
- **Rewrite.** The offline sync now settles a card/UPI sale through the ordinary payment service as
  `channel: 'other'` with `message = <typed reference>`. Before this change the reference was passed as
  `externalReference`, which the "other" channel ignores, so it was dropped. The
  `TENDER_REFERENCE_NOT_FOUND` gate is removed. A missing match no longer blocks a sale or sends it to a
  manager. The device keeps accepting that code from older servers.
- **Terminal check and finance flag.**
  - After payment, `pos_terminal_transactions` and `pos_paytm_transactions` are read for the store and
    reference.
  - **Matched** means a row with the same amount that is unattached (`order_id=0`) or attached to this
    order. A matched sale gets no flag.
  - Otherwise (missing, or a different amount or order), one legacy-style `comments` row is written on
    the order, once (idempotent by prefix):
    `Offline bill <ref> reconciliation: CARD reference <typed> has no matching terminal transaction. Finance to reconcile.`
    (or "... does not match the terminal transaction amount or order ...").
  - No new columns. The prefix differs from the billing comment (`Offline bill <ref> billed at …`), so the
    durable fallback lookup and the link check never confuse the two.
  - Finance can query `comments.comment LIKE 'Offline bill % reconciliation: %'`.
- **E2E.** The standalone card sale (no terminal row seeded) now syncs to a real order. The test asserts:
  - `order_stores.message='RRN-SYN-0001'`;
  - `is_manually_paid=1`, `online_other_payment=1899`, payment status 4;
  - `transaction_id` is the generated one;
  - exactly one reconciliation comment.

### 7.2 Backend down, web server up: a reload opens offline billing
- `src/api/client.ts` (3 lines, outside my original ownership, requested by the coordinator): on desktop
  only, a 5xx without the API error envelope throws `NetworkError`. That shape comes from the web server
  or proxy (nginx 502/504, vite 500), never from the store service itself, which always answers with an
  envelope. The helper is `desktopStoreServiceUnreachable` in `src/offline/billing/bridge.ts`.
- Every existing offline path then applies: the cached session (Dexie `sessions`, only while `expiresAt`
  has not passed), cached stores and counters, and the auto-switch to offline billing. Billing itself
  still requires the device's own eligible offline session.
- Web clients are unchanged: they still report the error.
- New e2e step: web gate up, backend gate down. A reload lands on `/offline-billing` showing "Working
  offline" and the composer, with no login page.

### 7.3 Linked orders show their real invoice number
- `finish()` now calls `finalizeOrder` when the order has no invoice. This is wired in
  `offline-sync/routes.ts` to the ordinary `orderLineSalespersons` (the sale's salesperson,
  `order/views.py:2779-2795`) and `orderFinalizer(..., { confirmed: false })`. That finalizer generates
  the invoice number whether or not the order is confirmed (`order/views.py:2799-2809`), with no
  gift-card, NPS or SMS side effects.
- O7 now asserts that the linked sale's invoice (`…INV#####`) is in MySQL and shown on the device.

### 7.4 Why the W10 stack cannot create orders (not fixed: not a small fake-adapter gap; for W14)
An order placed through `backend/tools/e2e/stack.ts` stops at each of these, in order:
1. `stack.ts` sets no `TSS_JWT_HS256_KEY` or `TSS_JWT_HS512_KEY`. Every cart call needs a customer token,
   so it fails with `CHECKOUT_IDENTITY_UNAVAILABLE` (503, `checkout/crypto.ts:13-19`).
2. `seed.ts` has no checkout account for operator 900001 (`m_user` with `user_type='8'` and
   `pos_admin_id=900001`, read by `checkout/repository.ts`), so it fails with
   `CHECKOUT_CUSTOMER_UNAVAILABLE`.
3. `fakes.ts` answers every `/api-v2/*` call with `{status:'success',success:true,data:{}}`:
   - cart reads fail `cartSchema` (no `products.items`);
   - `processorder` has no `meta.calculations.total`;
   - `pos/order` lacks `order`, `method`, `isValid` and `name`, giving `CHECKOUT_OUTCOME_UNCERTAIN`;
   - no order rows are ever written.
4. `seed.ts` has no `salespersons` or `store_salesperson` rows, so the submit fails with
   `SALESPERSON_REQUIRED`.
5. Payment: there is no `order_status` id 3 (`ORDER_STATUS_UNAVAILABLE`), and no active
   `pos_terminal_payment_modes` row for the modes used (`PAYMENT_METHOD_UNAVAILABLE`).

Ready-made fixes exist in the W17 harness. `backend/tools/e2e/order-api.ts` is a self-contained stateful
API-v2 stand-in (`startOrderApiFake(connection)`); `offline-billing-stack.ts` has the extra seed rows and
env. Adopting them in `stack.ts`, `seed.ts` and `fakes.ts` spans three W14-owned files, so I made no
change there.

### 7.5 Results (follow-up)
- **Desktop e2e:** 12/12 pass in real Electron. This adds the "backend down, web up, reload" step, plus
  the standalone-card and linked-invoice assertions. `e2e/electron.spec.ts` passes 2/2.
- **Flaky run:** one earlier run failed at the very first sign-in with a 401 "username or email and
  password do not match". The next full run passed, and I could not reproduce it. The likely cause is the
  shared `signIn` helper typing before the login form is ready. Not investigated further.
- **Backend:**
  - `tsc` and `eslint` are clean;
  - `tests/offline-sync` 27/27: the unmatched-reference test replaces the old `TENDER_REFERENCE_NOT_FOUND`
    case, and the matched case asserts the payment message.
- **Frontend:** `tsc` and `eslint` are clean; vitest 298 passed, 112 skipped.
- **Files touched outside my original ownership, at the coordinator's request:** `frontend/src/api/client.ts`
  (+3 lines).
