# W20 report: web e2e console errors and failed requests (release blocker 2)

Branch `w20/console-clean` from `1ed3b130`. Scope: make the real-stack web Playwright run
(`frontend/playwright.config.ts`, `backend/tools/e2e/stack.ts`) produce zero unexpected console
errors and zero unexpected failed requests, and enforce zero from now on.

## 1. Result

| | Baseline (`1ed3b130`) | Final |
|---|---|---|
| Tests | 41/41 pass (W18) | 41/41 pass, with the zero-error fixture enforced |
| Unexpected console errors | 188 | 0 |
| Unexpected failed requests (HTTP ≥ 400, `requestfailed`, WebSocket handshake failures) | 156 | 0 |
| Uncaught page errors | 0 | 0 |
| Declared deliberate failures (per-test `network.expectFailure`) | — | 23 failed responses/requests + their 23 console lines, plus 1–2 timing-bound cancellations |

Method: every observation was captured by the new shared fixture (§3) and written with
`E2E_NETWORK_AUDIT_FILE` as JSONL: spec, test, kind, method, URL path (never the query string),
status or Chromium error code, and console text with query strings removed. W18 parsed traces and
reported 180 console errors / 169 failed requests; the baseline here is the same run measured by
the fixture, which also counts WebSocket handshake failures and `requestfailed` events separately.

Final verification: two consecutive full runs on the final code, 41/41 passed each, 0 unexpected console errors and 0 unexpected failed requests (runs 8 and 9; earlier iterations exposed and fixed the timing cases in §2 G and the lookup race).

## 2. Baseline by category and root cause

| Cat. | Baseline requests / console | Root cause | Fix |
|---|---|---|---|
| A. Pre-login probes | 66 / 66 | The shell probed `GET /auth/sessions/current` (401 when signed out) and the login page probed `GET /auth/challenges/current` (401 without a pending password step) on every load | New public `GET /api/v1/auth/session-state` → `200 {session: null \| {user, sessionExpiresAt}, loginChallengePending}`. The shell's operator query uses it (`frontend/src/hooks/use-pos.ts`). The login page restores a challenge only when `loginChallengePending` is true (`frontend/src/pages/login.tsx`). `GET /auth/sessions/current` and every protected resource still answer 401 |
| C. Mock gaps (wallet, returns) | 33 / 33 | `wallet-adjustments.spec` and `returns.spec` route all `/api/v1/**` but did not mock `/operators/me/check-in`; unmocked calls got the fixture's 503 or a `blockedbyclient` abort, and the notification stream reached the real backend without a cookie (401) | Both specs mock `session-state` and `check-in` (`{data: null}`, not checked in). With the D1 fix the shell then requests no notifications and opens no stream |
| D1. Notifications without check-in | 13 / 12 | After switching to store 2 (`order-link`, `product-feedback`) the panel polled `GET /stores/2/notifications` and opened the stream; the server answers 403 `CHECK_IN_REQUIRED` (S56). Legacy shows notifications only for the checked-in store | `NotificationsPanel` reads the shared `my-check-in` query (`frontend/src/hooks/use-store-check-in.ts`) and requests the feed, expiry reminders, read receipts and the stream only for an unexpired check-in at the selected store, and only online. Otherwise it shows "Check into this store to see its notifications." A 1008 close also refreshes the check-in |
| D2. Invoice preview "Blocked script execution … sandboxed" | 0 / 28 | Not the app. Reproduced on `checkout-recovery` with `--trace on` (2 messages) vs `--trace off` (0): Playwright's trace DOM snapshotter injects a script into every frame, and Chrome blocks it in the preview frame, which is correctly `sandbox="allow-same-origin allow-modals"` with CSP `script-src 'none'` (S20) | The sandbox, CSP and sanitiser are unchanged. The five specs that render the preview (`invoice`, `exchange`, `order-payments`, `real-order`, `checkout-recovery`) use `sandboxedFrameTrace`: traces on failure keep screenshots and sources but no DOM snapshots |
| D3. Store refresh after logout | 1 / 1 | `retail` logout: a still-mounted workspace re-fetched `GET /stores` after the session was deleted (401) | `useStores`/`useCounters` pass `operatorId`, so once sign-out clears the request operator the client aborts locally instead of sending a request that can only 401 |
| E. Favicon | 0 / 12 | `index.html` had no icon link, so Chrome requested `/favicon.ico` (404) | `<link rel="icon" href="/icon.svg">` (the existing precached icon) |
| F. Requests while offline | 6 / 6 | After `context.setOffline(true)` the app still issued session, store, counter, catalog and stock reads and opened the stream (`ERR_INTERNET_DISCONNECTED`) | `openResponse` (`frontend/src/api/client.ts`) throws `NetworkError` without a request when `navigator.onLine === false`, so callers take their cached/queued path; the notification stream is not opened offline. `retail.spec` waits for the reloaded counter to settle before dropping the network (an in-flight read would otherwise fail) |
| G. Cancelled requests (`ERR_ABORTED`) | 7 / 0 | (1) `order-link` navigated with `page.goto` while store-2 reads were in flight; (2) opening a paid order: the payment panel's mount read called `detail.refetch()`, which cancelled the in-flight detail read and fetched it again (seen as `orders/6008` aborts in `retail` and `order-default-ranges`); (3) superseded searches: per-keystroke catalog search (`cashier-shortcuts`) and the order-list refresh after a payment (`order-payments`); (4) the Electron shell cancelling the fixture's external redirect | (1) the spec waits for `networkidle` before navigating; (2) `operations.tsx`: a mount-time payment read refreshes only when the loaded detail is not already paid and shares an in-flight read (`cancelRefetch: false`); a payment action still supersedes; `retail.spec` closes the order only after its details loaded; (3) and (4) are correct app behaviour and are declared per test (see §3) |
| H. Fixture-order mock gaps | 7 / 7 | Orders that exist only in a spec reached the real backend for sub-resources (404): `order-link` (its route pattern matched one path segment, so its `cancellations`/`payment-context` mocks never ran; `invoices/capabilities`, `payment-options` unmocked), `discount-approval` (`7701/payment-context`), `checkout-recovery` (`8801` invoice preview after completion) | Mocks completed with schema-valid fixtures (the `order-link` mocks were also invalid against the strict schemas); the 8801 preview is served with the backend's own `invoicePreviewHtml`/`invoicePreviewPolicy` |
| B. Intended negative cases | 23 / 23 | The spec asserts the failure | Each is declared in its test with an exact method, path, outcome and count (§3) |
| Also fixed | — | `useStores`/`useCounters` wrote the shared `lookups` row with an unsynchronised read-modify-write; concurrent loads could drop the stored store list, and the offline reload then showed "Select a store" (seen once in `retail`) | Both writes run in one Dexie `rw` transaction |

## 3. Enforcement: shared fixture

`frontend/e2e/support/fixtures.ts` exports `test`/`expect`; every web spec now imports them. An
automatic `network` fixture watches every page in the context (and Electron windows passed to
`network.watch`). After each test it fails on any console error, uncaught page error, HTTP ≥ 400
response, failed request or failed WebSocket handshake that the test did not declare. There is no
global allow-list or filter.

`network.expectFailure({ method, path, outcome, times? })` declares one deliberate failure for that
test only. `path` is the exact path (or an anchored RegExp for generated UUIDs); `outcome` is the
status or Chromium error code; the declared count must be met exactly, so stale expectations fail.
The matching Chrome "Failed to load resource" console line is covered only for that request.
`upTo` exists only for `net::ERR_ABORTED`, for app cancellations whose occurrence is timing-bound;
it is used twice (`cashier-shortcuts` catalog search ≤ 4, `order-payments` list search ≤ 2).

Declared negative cases: application-links 409 (expired QR), clearance 409 ×2 tests, customers 404
lookup ×2 tests + 503 registration, exchange 422, invoice 403 (revoked), order-link 404 (store 2),
order-payments `ERR_CONNECTION_RESET` (lost response), checkout-recovery 503 submission + 503
reconciliation, profile 400 (wrong password), retail 403 (day-close rollout), wallet
`ERR_FAILED` + 404 status reads (×2 committed, ×5 uncommitted), electron `/redirect` `ERR_ABORTED`.

## 4. Files

- Backend (auth route, minimal): `backend/src/auth/routes.ts` (new public route),
  `backend/tests/auth/login-flow.test.ts` (signed out / pending / signed in / unreadable cookie,
  400 on an unknown query key), `backend/tests/route-validation.test.ts` (public-route list).
- Frontend app: `src/api/client.ts`, `src/api/schemas.ts`, `src/hooks/use-pos.ts`,
  `src/hooks/use-store-check-in.ts` (new), `src/pages/login.tsx`,
  `src/pages/fulfillment/notifications.tsx`, `src/pages/operations.tsx`, `index.html`.
- Playwright: `e2e/support/fixtures.ts` (new) and all 24 web specs.
- Outside strict ownership (smallest caller fix): `frontend/tests/operational-reports/browser-check.mjs`
  also answers `session-state` (it mocked only the old probe).
- Shared files: none (`app.ts`, `config.ts`, `package.json`, Playwright config untouched).
  Not touched: W19's `verify-project` harnesses, W21's administration profile-image test and the
  Electron offline time-window spec, `frontend/src/offline/billing/**`, `frontend/electron/**`
  (its offline server still uses `GET /auth/sessions/current`, whose 401 contract is unchanged).

## 5. Security decision candidate (for the primary agent to number)

**Public sign-in state probe.** `GET /api/v1/auth/session-state` is `public`: it validates its
(empty) query and bounded headers first, as S50 prescribes for public routes, and returns
`200 {session: null, loginChallengePending}` when signed out, or the caller's own principal and
expiry. `loginChallengePending` only says that this browser holds an unexpired, correctly sealed
password-step cookie (no Redis read, no account data). Nothing about another account is exposed,
responses are `no-store` (global hook), and every protected resource, including
`GET /auth/sessions/current`, still requires a session and answers 401 before validation (S50).
Chosen over turning `sessions/current` into a 200, which would change a protected resource's
contract and break the Electron offline server that maps its 401 to "signed out".

## 6. Checks

- Frontend: `tsc`, `eslint .` clean; `vitest run` 298 passed / 111 skipped. With all
  `*_BROWSER_TESTS=true`: 407 passed, 2 failed in `tests/administration/workflows.test.ts`
  (profile-image upload, W21's known flake; authenticator QR, passes when run alone).
- Backend: `tsc`, `eslint .` clean; `tests/auth`, `route-validation`, `observability`,
  `sessions` 50 passed / 1 skipped.
- Web e2e (real stack, isolated loopback MySQL 8.4 on 33920): two consecutive full runs, 41/41 each, zero unexpected.

## 7. Remaining gaps

- The desktop Playwright config (`playwright.desktop.config.ts`) does not use the shared fixture;
  W21 owns its flaky spec. Extending zero-error enforcement there is follow-up work.
- Electron windows are watched from launch; console output emitted before `_electron.launch`
  returns is not observable.
- Production readiness is not claimed; this closes release blocker 2 only.

## 8. Follow-up: repeated runs on the same stack (W19 finding)

W19's verifier saw `retail.spec.ts:4` fail on repeats on one stack: after going offline and
reloading, the shell showed "Select a store" and the saved cart never rendered.

**Root cause: a product bug, fixed in this branch before the merge.** `useStores` and
`useCounters` (`frontend/src/hooks/use-pos.ts`) both wrote the shared IndexedDB `lookups` row
with an unsynchronised read-modify-write. When the two responses land together, the second write
can put back the stale empty `stores` half. Offline, the shell restores its store list from that
row, finds none, clears the selection and shows "Select your store to start". Warm-stack timing
on repeats makes the interleaving likely. W19 ran on a base that did not have the fix. Neither
check-in, session or seed state is involved. Evidence on integration head `ecc966a9`:
`--repeat-each=3` of the retail test passes 3/3. With the transaction temporarily reverted,
repeat 2 fails at the same line (`retail.spec.ts:27`). The fix is the §2 "Also fixed" row: one
Dexie `rw` transaction per write. This matches legacy, where the selected store stays selected.

**Second issue found by the same-stack runs: spec state leakage.** `order-payments.spec.ts`
paid the seeded unpaid orders 6001 and 6002, so a second run on the same stack found them
already paid. Each test now adds its own new unpaid counter order through
`backend/tools/e2e/fixture-orders.ts`. That helper writes the same row shape as the seed
(`orders`, `order_stores`, `has_products`; auto-increment id; loopback `pos_rewrite_e2e*` schema
only, through `e2eDatabaseUrl`) to the schema the running stack seeded. The seed is unchanged.

**Same-stack verification.** One stack was started once (`backend/tools/e2e/stack.ts` and
`vite preview` on 4410/4173). The full suite then ran twice in a row against it through a
temporary, uncommitted config with `reuseExistingServer: true`: run 1 41/41 and run 2 41/41, each with 0 unexpected console errors and 0 unexpected failed requests (23 declared failures + 23 console lines and 1 timing-bound cancellation each). Before the order-payments change, the same procedure gave 41/41 then 39/41: both order-payments tests failed on run 2.
