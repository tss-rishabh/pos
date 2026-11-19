# W19: verify-project browser harnesses (release blocker 1)

**Branch:** `w19/verify-harnesses` from `1ed3b130`. **Status:** The three harnesses are rewritten and pass. `verify-project` now runs to completion, including its Playwright stage: 86/86 checks executed, 85 passed. The release gate fails, as required. One Playwright spec, `e2e/retail.spec.ts`, fails because of a state-dependent product/spec problem outside W19 ownership (see Verification).

## Problem

`tools/verify-project.ts --mysql --browser --release` failed `order-search-browser-tests`,
`order-history-browser-tests` and `daily-reports-browser-tests` (`w18-verification.md` §1 rows 17–18,
§4). They were standalone mocked-API harnesses from 18 November that mounted page components in a Vite
fixture and answered every `/api/v1/**` call from a stub. Later changes broke them. The removed demo
mode, zod on every route, authentication before validation (S50), lock-free order reads, MySQL for
all order history, the request-reference UI, the W14/W16 report store source
(`/api/v1/reports/store-cash-balances/stores`) and the new response contracts all changed what the
pages request and render. Because the verifier stops before `browser-tests` once any check has
failed, the Playwright suite never ran inside it.

## What changed

Each harness is now a Playwright spec that runs on the real e2e stack
(`backend/tools/e2e/stack.ts`). The stack provides a seeded loopback MySQL schema
(`pos_rewrite_e2e_harness`), a private `redis-server`, fake adapters, the real backend, and the
built app served by `vite preview`. Each spec:
- signs in through the real login page (password, fixed OTP, store check-in);
- drives the routed App;
- asserts figures that it derives from the seeded rows and its own fixture rows, never from the
  response under test.

| File | Purpose |
|---|---|
| `frontend/tests/harness/playwright.config.ts` | Harness config: stack + preview web servers, `outputDir` outside the verifier's checksummed inputs, service workers blocked, the production day-close rollout default `COCO` |
| `frontend/tests/harness/support.ts` | Schema URL guard, fixture runner (zod-validated manifest), sign-in reusing `e2e/support/login.ts`, a locator handler that answers the day-close reminder with "Not now" as a counter operator would, page-error collector |
| `backend/tools/e2e/harness-fixtures.ts` | Synthetic rows written through the ORM into existing production tables (ids 6101–6206, no DDL). Sets `orders` and `reports`; prints a manifest |
| `frontend/tests/order-search/real-stack.harness.ts` | Order search (legacy `orders_datatable.py`) |
| `frontend/tests/order-history/real-stack.harness.ts` | Orders page and details (legacy `OrdersView` / `ShowOrderDetailsView`) |
| `frontend/tests/reports/real-stack.harness.ts`, `tsconfig.json` | Daily store sales (legacy `AjaxDailyStoreReportView`) |
| `frontend/tests/harness/vite.config.ts`, `ports.ts` | The harness stack gets its own ports, backend 4420 and preview 4183, so a parallel stack on 4410/4173 cannot collide. The config refuses a run of more than one harness, because the fixture sets exclude each other and each run needs its own stack |
| `backend/tools/verify-project.ts` | The three checks now run `playwright test -c tests/harness/playwright.config.ts <dir>/`, one stack per harness. New check: `daily-reports-browser-fixture-typecheck` |
| `backend/tools/e2e/stack.ts` | Optional `E2E_DAY_CLOSE_ENABLED_STORE_IDS`, validated. The default `'0'` leaves the Playwright suite unchanged |
| Deleted | `tests/{order-search,order-history}/{browser-check.mjs,fixture.tsx,fixture.html}`, `tests/reports/{browser-check.mjs,browser-entry.tsx}`, and the `daily-reports` entry in `tools/run-browser-fixture.mjs`. `order-search/source-snapshot.json` stays, because the unit and native tests still use it |

### Assertions (old mocked check → real-stack equivalent)

**Order search** (one test, 12 steps):
1. **Default search.** Exactly one default search. It carries the operator header and a UUID
   `X-Request-Id`, has no query string, and its body is ST, store 1, draw 1, page 1/25, `id desc`,
   with server placement bounds. The response is `pos-source-order-search-v1`, `reader: primary`,
   with **11 rows**, in this exact order: the legacy double reverse join shows 6105 twice, because it
   has `order_store` rows in stores 1 and 2. 6106, which is outside the window, and the
   non-store-type orders are absent.
2. **Legacy payment labels and store label**, from the real `order_store` and terminal rows:
   - `POS Counter: CASH + Online (Other) +UPI`
   - `POS Counter (Pending)`
   - `: CASH  ` (for a method-less paid order, as legacy)
   - the store label `Bandra Flagship (Counter 01)`
3. **Mobile and email filters.** Only in the POST body, never in the URL or storage. They return
   6008, 6005 and 6002.
4. **Method, payment-status and order-status filters.** 14/Pending/1 returns 6002 and 6001;
   14/Paid/3 returns 6104. Clearing them restores 11 rows.
5. **Server sort by amount.** Ascending amounts against the seeded prices.
6. **Page size 5.** Pages 1/2/3 of 3 with 5/5/1 rows; `Next` and `Last` send `page`.
7. **Column hiding and the page CSV.** Exactly the visible columns and rows.
8. **Online (N).** 6101, with link `/orders/details/N/6101?operatorId=900001&storeId=1`.
9. **Local delivery (HL).** 6102, with its HL link.
10. **Express (HE).** Zero or two stores raise the alert and send no request. Store 2 returns 6103
    with link `storeId=2`. Explicit IDs work.
11. **In queue.** The ID and date inputs are disabled, the body has `inQueue` and no placement
    window, the result is 6102, and the link is HL.
12. **Server validation.** An invalid mobile returns a real 400. The message, "Try again" and the
    **request reference** equal to the response `X-Request-Id` are shown.

**Order history** (one test):
1. **Default window.** The server-clock defaults equal an independent computation (five days back,
   one minute ahead, minute floor). The first search uses them, and the date inputs show them.
2. **Explicit past date.** An explicit past calendar date is read from MySQL (`reader: primary`) and
   returns exactly 6106, which is absent from the default list. There is no warehouse notice.
3. **Details by id only.** The detail request has no query string. The dialog shows the reference,
   amount, product and placement date, and closing it keeps the explicit dates.
4. **Exact link.** `/orders?orderId=6106` opens without a date filter.
5. **Unknown order.** A real 404 shows the server message and the request reference.
6. **Online view.** HL with no date range, which returns 6102.

**Daily reports** (one test):
1. **Store options and request.**
   - Store options come from the operator's real scope.
   - A same-day report sends one request with `storeIds=1,2` and the date, and the operator header.
   - It is answered by the **MySQL data reader** running the bound legacy store and online SQL.
2. **All 33 columns.** Exact per-store and total figures, derived by hand from the fixture rows:
   - store revenue = ROUND(price / 1.05, 2);
   - online revenue through `pos_online_orders`;
   - cash, Card / UPI, quantities, AOV and basket size.
   - The exclusions are implied by the exact totals: yesterday's order, a cancelled line and every
     seeded non-India order. Tightening or loosening the filters fails the harness.
3. **Table controls.** Search, sort and page size send no new request, and the totals stay the full
   report's.
4. **CSV exports.** The visible-columns CSV has 32 columns and follows the search. The complete CSV
   has 33 columns, every row and the totals.
5. **Column persistence.** The column choice persists across a reload.
6. **Warehouse routing.** A range beyond today routes to the warehouse. The stack has none, so it
   returns a real **503** with its message and request reference.

### Coverage moved, not dropped

| Old check | Now covered by |
|---|---|
| 61-row paging, formula-injection CSV cells, and the "Data updated through" warehouse freshness notice (synthetic BigQuery publication) | `e2e/daily-report.spec.ts`, which the verifier runs in `browser-tests`. That spec still stubs the report response. The freshness notice needs a warehouse publication, which the stack cannot provide |
| Rolling defaults surviving focus, reconnect and reload | `e2e/order-default-ranges.spec.ts` (`browser-tests`) |
| BigQuery-era UI text ("Verified historical snapshot", "Live queue with historical details", 503 publication-required) | Removed from the product (MySQL for all order history), so not re-asserted. The harness instead asserts that past dates read MySQL |
| Detail request carrying the list's dates | Legacy reads details by id only (`1827c91a`). The harness asserts that the request has **no** dates |

## Verification

Environment: everything ran on loopback. MySQL 8.4.11 ran on 127.0.0.1:33919 with `sql_mode=''` and its data
under `.tmp/w19`. Redis instances were private, and the runtime was Node 24.22.3 with Chrome. The verifier ran from a
throwaway detached worktree at `/private/tmp/claude-501/w19v/`, beside a clean clone of `backend-pos-web` at
`78d5b63` and a symlink to `backend-sync-api`, as in W18 §4. Its fixed outputs, `evidence/verification.json` and
`shipping-label.png`, stayed in that tree.

**Static checks**
- Frontend `tsc` (app, plus the order-search, order-history and reports harness configs): 0 errors.
- Backend `tsc`: 0 errors.
- `eslint`: clean in both packages.
- Prettier: clean on the changed files.

**Final run.** Evidence: **`backend/evidence/verification-ebc823f6-single-stack.json`**, a new file.
- **Totals.** Exit 1, `productionReady: false`. 86/86 checks executed, with no unexecuted check:
  **85 passed**, `changedInputs: 0`, source and rewrite baselines unchanged.
- **`backend-tests`:** 1186 tests passed and 18 skipped.
- **Harness checks:** `order-search-browser-tests`, `order-history-browser-tests` and
  `daily-reports-browser-tests` pass, and so do all their typecheck checks.
- **`browser-tests` (Playwright suite) ran:** 40/41 passed. **Failure:** `e2e/retail.spec.ts:4` "desktop web
  flow…", line 27. After `context.setOffline(true)` and a reload, the app shows "Select a store" and
  "Select your store to start", so the saved ₹1,998.00 cart is never rendered: the store and counter
  selection is lost on the offline reload.
  - **Reproduction:** `--repeat-each=3` on one stack passes the first time and fails on repeats 2 and 3 at
    the same line. In the full suite it runs after about 30 other specs and fails.
  - **Code changes:** none in `frontend/src` or `backend/src` since W18's 41/41 run (`8a7530aa`).
  - **Root cause:** not isolated. The failure depends on state the earlier sessions leave in the same
    stack, and its trigger looks like the store selection not being restorable offline.
  - **Owner:** frontend/e2e (W20). Not worked around.
- **Release gate:** fails by design.

**Earlier runs, not kept as evidence:**
- **Run 1** (`9dc778f7`): the same 85 passed. `browser-tests` could not start, because W20's e2e stack
  (`pos-w20-console`) held 127.0.0.1:4410/4173.
- **Run 2:** W20's stack took the ports again, so the three harnesses could not start. That led to the
  harness port isolation in `ebc823f6`.
- **`backend-tests` flake in run 2:** `tests/checkout/customer-mysql.integration.test.ts` › "locks a
  registration after five wrong codes and rate-limits resends per phone" failed once ("promise
  resolved … instead of rejecting"). It passed in runs 1 and 3 and 11/11 in isolation. It is recorded as a
  flake; owner: checkout.

**Standalone harness runs:** each directory passes on its own, including while another stack is up on
4410/4173.

## Shared-file edits
- `backend/tools/e2e/stack.ts` gains an optional env override (`E2E_DAY_CLOSE_ENABLED_STORE_IDS`,
  validated). The behaviour is unchanged when it is unset.
- No changes to `src/app.ts`, `src/config.ts`, `.env.example` or the `package.json` files. I did not
  touch W20's or W21's files: the frontend app, the `e2e/` specs, `private-images.tsx` and the
  desktop spec. `e2e/support/login.ts` is imported, not edited.

## Security decisions
None. The harnesses refuse non-loopback MySQL and only use schema `pos_rewrite_e2e_harness`. Fixture
rows are synthetic, contact filters are checked to stay out of URLs and storage, and no live service
is contacted.

## Remaining gaps / notes
- `backend/tools/e2e/*.ts`, including the existing `seed.ts`, is not covered by any typecheck config.
  Under the full production-row types, both `seed.ts` and `harness-fixtures.ts` omit NOT NULL columns
  that `sql_mode=''` defaults, so adding them to a strict tsconfig fails until the inserts list every
  column. This was left as it was, matching the existing seed.
- `parity/order-history.md`, `parity/order-search.md`, `parity/order-browser-default-fixture-repair.md`
  and `HANDOFF.md` §7 still name the deleted `browser-check.mjs` files. The doc owners or the primary
  agent should update them.
- The day-close reminder can appear during its nag windows under `COCO`. The harness dismisses it
  ("Not now") instead of seeding a close.
- No product bug was found by the harnesses: every assertion matched legacy behaviour on the first real run.
  The retail offline-reload failure above is the one product/spec issue seen, and it is outside W19.
- **Coordination:** the Playwright suite (`playwright.config.ts`) and the e2e stack default to fixed
  ports 4410 and 4173. Two agents running e2e at once collide, and a verifier run fails `browser-tests`.
  Either serialise e2e runs across agents or give `playwright.config.ts` configurable ports (W20/primary).
- `frontend/test-results/harness/` receives traces only on failure. It is outside the checksummed inputs.
