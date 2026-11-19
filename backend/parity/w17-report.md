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

- **Backend down behind a reachable web origin forces the login page.** This is UI/API-client ownership
  (`src/hooks/use-pos.ts` `useOperator`, `src/api/client.ts`). When nginx answers 502, the renderer treats
  it as an error, not as offline, and shows "Could not connect" on the login page after a reload. Offline
  billing is then unreachable until the backend is back. A total network loss works (cached session plus
  service worker).
- **W10 stack (`stack.ts`) cannot create orders.** It has no `TSS_JWT_HS256_KEY`, no operator checkout
  account, no salespeople, no `order_status` 3, no terminal mode 1001, and a generic API-v2 fake. This
  probably explains some failing web checkout specs (W14). The pieces are in the W17 harness and could be
  reused.
- **NEEDS USER DECISION: card/UPI references from a standalone terminal.**
  - The sync requires the reference to exist in `pos_terminal_transactions`/`pos_paytm_transactions` for
    the store, otherwise `TENDER_REFERENCE_NOT_FOUND`. A standalone terminal never writes those rows, so
    in practice every offline card/UPI sale goes to a manager. The e2e seeded the reference to test the
    automatic path.
  - The tender settles as the "Others" mode 1001. If that mode is inactive in production, the order is
    created but payment fails, and the sale shows `REJECTED` with the order already recorded. A manager
    "accept" re-runs only the payment.
- **Linked uncertain orders have no POS invoice number.** The finalizer never ran for them, the same as
  the legacy KeyError outcome. Recovery (invoice and confirmation) is not implemented for `link-order`.
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
