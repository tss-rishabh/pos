# W14 report: green suites on the real stack

Branch `w14/green-suites`, from integration head `3a3e0ab5`. Not rebased onto `ec84abc2` /
`544b8ab9` (coordinator merges). One commit per root cause; every commit ends with the trailer.

## 1. Environment

- Private loopback MySQL 8.4.11 (`--sql-mode=''`, port 33914, datadir under the worktree's
  `.tmp/`), private loopback `redis-server`; both stopped at the end. Tests spawn their own Redis
  where they need one.
- Backend gates: every variable from `grep -rho "process.env\.[A-Z_]*" tests` plus the
  `verify-project.ts --mysql` list, each on its required schema (`pos_rewrite_integration`,
  `pos_rewrite_auth_test`, …, `pos_rewrite_inventory_jobs_test`), `ORDER_DETAIL_BROWSER_TEST=true`.
  `POS_PROD_RO_MYSQL_URL` (live read-only) was **not** set: no production connection.
- `ORDER_SEARCH_SOURCE_ROOT` must be a git checkout that has the pin `78d5b63`
  (`he-store-validation` runs `git show <pin>:<path>`). The exported legacy copy is not a git
  repository, so these 4 cases fail with it; with `/Users/rishabhbhatia/code/backend-pos-web`
  (which `verify-project.ts` already uses and which contains the pinned commit) they pass. The
  content read is the pinned commit either way.
- `order-history/online-detail` (browser case) serves `frontend/dist`; build the frontend first.
- Frontend browser suites enabled with every `*_BROWSER_TESTS=true` gate.
- Playwright ran the full suite except `electron.spec.ts` (W17). Because other agents use ports
  4410/4173 concurrently, I ran it through an **uncommitted** local config
  (`playwright.w14.config.ts` + `vite.w14.config.ts`) that only changes the ports (4914/4974).

## 2. Before / after

| Suite                                                        | Before (base `3a3e0ab5`)                                                                       | After                                                                                                                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend vitest, all MySQL gates, `--no-file-parallelism`     | 208 files: 8 failed, 199 passed, 1 skipped. 1150 tests: **17 failed**, 1116 passed, 17 skipped | 209 files: 2 failed, 206 passed, 1 skipped. 1153 tests: **2 failed** (both W15 goldens, §4), 1134 passed, 17 skipped                                                                        |
| Frontend vitest (default)                                    | 57 passed, 15 skipped files; 294 passed, 112 skipped                                           | 72 passed (browser gates on); 405 passed                                                                                                                                                    |
| Frontend vitest, browser gates on                            | 5 files failed; **12 failed**, 394 passed                                                      | 72/72 files; **405 passed, 0 failed** (one rewrite-only case removed, §3)                                                                                                                   |
| Playwright (Chromium, real stack, all specs except Electron) | 35 run: 22 passed, **13 failed**; `order-payments.spec.ts` did not load                        | **39 passed, 0 failed** (final full run). One earlier full run had a single `retail` failure at the offline-reload step that did not reproduce (6/6 isolated, 39/39 next full run); see §4. |
| Frontend `npm run build`                                     | passes                                                                                         | passes                                                                                                                                                                                      |
| Frontend image                                               | **fails** (`npm ci` native build)                                                              | builds                                                                                                                                                                                      |
| Backend image                                                | builds                                                                                         | builds                                                                                                                                                                                      |
| Container smoke (both fresh images)                          | not run with a fresh frontend image                                                            | 10/10 checks pass (evidence file restored afterwards; `backend/evidence/**` unchanged)                                                                                                      |
| Backend / frontend `tsc` + `eslint`                          | pass                                                                                           | pass                                                                                                                                                                                        |

## 3. Root causes and fixes

### Product bugs fixed

1. **Device-handoff service route returned 400 before authenticating** (`88d346cc`). The strict
   route schema validated the body before the handler checked `x-pos-auth-key`, so an
   unauthenticated caller learnt the body contract. A `preValidation` guard now answers 401
   first, as the other service routes do.
2. **"Close order" unreachable on long order details** (`1de97a22`). `.modal-backdrop` centred
   every dialog in a fixed, non-scrolling flex box, so a dialog taller than the viewport overflowed
   above it and its top (with the close button) could not be reached. The backdrop now scrolls and
   a tall dialog starts at the top (legacy Bootstrap modal behaviour); short dialogs stay centred.
   Applies to every dialog using `.modal-backdrop`.
3. **Fast Cash from an unquoted sale lost its dialog** (`953b3756`). Fast Cash takes the final
   quote first; the quote made the sale non-editable for a moment, which unmounted the editable
   block containing `FastCashCheckout`, discarding the dialog state. The click (or the legacy F
   shortcut) quoted but never showed "Fast Checkout (Cash Only)!". The component is now mounted
   outside that block; its trigger shows only while the sale is editable.
4. **Stock-matrix store picker offered unauthorised stores** (W15 finding, `63c09433`). The picker
   used the generic catalog store list and re-derived the matrix scope in the browser. New
   `GET /api/v1/catalog/inventory/stores` returns exactly the matrix search scope, legacy
   `ProductsStockView.get_queryset` (`core/views.py:183-190`): role 1 → every active store, other
   roles → assigned active stores; franchise refused like the search. The search and the list share
   one scope builder. Tests: production-DDL MySQL case, routing-security list, real-stack e2e with
   an active unassigned store seeded.
5. **Frontend image could not build** (`d5dad1aa`). `npm ci` compiled
   `better-sqlite3-multiple-ciphers` (desktop offline billing only; needs a toolchain), and
   `npm run build` also typechecks/bundles `electron/`, absent from the image. The web image now
   installs with `--ignore-scripts` and builds only the web bundle.
6. **Global rate limit not configurable** (`ded7e949`). The full Playwright suite (one loopback
   IP) exhausted the fixed 240/min budget and later specs failed with 429 on sign-in.
   `API_RATE_LIMIT_PER_MINUTE` (default 240, production unchanged); the e2e stack sets 20000.
7. **Web e2e stack could not create orders** (coordinator item; W17 report §7.4, `f1cb9dfc`, `a2a09e23`).
   All five gaps are closed:
   - signing keys: `stack.ts` sets random `TSS_JWT_HS256_KEY` / `TSS_JWT_HS512_KEY`;
   - operator checkout account: `m_user` 700100 (`user_type='8'`, `pos_admin_id=900001`), in `stack.ts`;
   - API-v2: W17's stateful cart/order stand-in `tools/e2e/order-api.ts` (byte-identical to the
     integration copy, so the merge is clean) replaces the generic envelope for API-v2 and the
     payment-order call; `pos/order` writes real `orders`/`order_stores`/`has_products` rows;
   - salespeople: two active salespeople in both stores, in `stack.ts`;
   - payment rows: `order_status` id 3 (seed, `3b11843c`), active "Others" terminal mode 1001
     (`stack.ts`), and `payment_method` 14 'coc' (seed, see 8).
     New `real-order.spec.ts`: quote → salesperson → legacy payment form → one real order submission
     (the confirmed payment travels with it) → "Payment confirmed. Your sale is complete." → invoice.
8. **Order list failed once a counter order existed** (`a2a09e23`). Counter orders
   carry payment method 14 ('coc', `order/views.py:2730`); without that `payment_method` row the
   legacy method label cannot be built and the search answers `ORDER_SEARCH_DATA_INVALID`, failing
   every later order-list spec in a full run. The seed now has row 14 (also helps W17's stack).

### Decision: `exclusivePrice` (`d465ecc7`)

Legacy `PriceList.price` is a `DecimalField` over the production **FLOAT** column
(`core/models.py:119`). Django's MySQL backend has no DecimalField converter, so the driver float
`799.0` reaches `DjangoJSONEncoder` unchanged and the DataTables column
(`order/templates/order/create_order.html:1786`, `{ "data": 'exclusive_price' }`) shows **799**.
The rewrite's `"799"` (MySQL's FLOAT text) already matches. The golden oracle had been fed the
fixture string `'799.00'`, which a FLOAT column cannot return, so the assertion normalises the
oracle value with `String(Number(...))`. No product change. Note for W16 (catalog owner): with no
`pricelist` row legacy returns `0` (shows `0`) where the rewrite returns `'0.00'`; the rewrite UI
formats both as currency.

### Test or fixture was wrong (legacy-based)

| Commit                 | Failure                                     | Root cause → fix                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caa73f44`             | `administration/collections` ×7             | Duplicate `'Alpha'` store names violate production `store_name_unique` (latin1_swedish_ci, which also rejects case-only ties). Names made distinct; the collation-tie paging case moved to non-unique `city_name` ('Pune'/'PUNE').                                                                                |
| `3a818f13`             | `customer-history` Latin1                   | Expected a strict-mode rejection. Production `sql_mode` is empty: latin1 stores `'??'` with warning 1366. The case now asserts that on the unchanged column.                                                                                                                                                      |
| `3b11843c`             | invoice / order detail on real stack        | e2e seed used payment status 1 = 'Paid' and order status 2 = 'Delivered'. Legacy paid store order = payment 4, order 3 (`order/views.py:1225`, `helpers.py:633`). Seed fixed.                                                                                                                                     |
| `7a753668`             | `invoice.spec` download                     | Document path moved to `/invoices/{kind}` (2aa2f33d).                                                                                                                                                                                                                                                             |
| `4198c08b`, `6fa18114` | `returns`, `exchange`                       | No `return-eligibility` fixture (legacy cell selector, 2babb90f); exchange clicked the deleted "Find confirmed replacement" (no backend route) — now reads the outcome with "Check exchange status". Shared fixture `e2e/support/eligibility.ts`.                                                                 |
| `d47fe6fd`             | `order-default-ranges`                      | Detail request no longer carries dates (legacy ShowOrderDetailsView by id + `cr`).                                                                                                                                                                                                                                |
| `0d7ce703`             | `checkout-recovery` ×2, `discount-approval` | Rewrite-only "Create order" became legacy "Proceed For Payment" + payment form (5b6d1e78).                                                                                                                                                                                                                        |
| `e36e8b56`             | `customers` ×2                              | Legacy "Fetch the User" (404 "User Not Found.") and "Get OTP" → "Verify with OTP" (verify + register + connect).                                                                                                                                                                                                  |
| `612f4396`             | `gift-card`                                 | Legacy blank dates ("Today's" / "No Expiry", f69a23fb).                                                                                                                                                                                                                                                           |
| `2b4f862d`             | `cashier-shortcuts` ×2                      | F opens the legacy Fast Checkout dialog (after fix 3); N has no enabled target (NPS Feedback checked + disabled, `create_order.html:76`).                                                                                                                                                                         |
| `63916e35`             | `order-payments.spec.ts` did not load       | Imported deleted `recordedLegacyInputSchema`, drove deleted controls. Rebuilt **on the real stack**: seeded unpaid orders 6001/6002, legacy form payment, and a lost response read back by "Check payment status" without a second POST.                                                                          |
| `f0a4b0df`             | admin browser ×2                            | Error alert now carries the request reference (80b43d4f); customer fragment token is `1.` + token (e235e710).                                                                                                                                                                                                     |
| `309b3a0b`             | customer OTP browser ×3                     | Legacy 4-digit OTP (09aaede8).                                                                                                                                                                                                                                                                                    |
| `5ae59834`             | checkout-actions, counter-catalog browser   | Legacy "Membership Savings" label; error text followed by the request reference.                                                                                                                                                                                                                                  |
| `7140f86b`             | order-payments browser ×5                   | Ported to the legacy form and current contracts. **Removed** the "lost committed legacy adoption" case: `legacy-payment-recoveries` was a rewrite-only flow deleted in f6e10a8c with no backend route; legacy has no such adoption (uploaded terminal payments use the show.html status modal, `TerminalStatus`). |

Environment-only (no commit): `he-store-validation` ×4 (git checkout needed), `online-detail`
browser case (frontend `dist` needed).

## 4. Left over / other owners

- **W15 (goldens):** `catalog-details/mysql.integration` (detail-oracle input `ac7b5d79…`) and
  `fulfillment/shipping-label-mysql.integration` (input `986f7ad2…`) still fail on this base
  (missing captures). W15 recaptured both on `ec84abc2` (its report rows W9 D2), so they should
  pass after the merge. I also touched one golden-consuming assertion on request
  (`exclusivePrice`, §3).
- **W17 / coordinator — merge note:** `seed.ts` now seeds production status ids (order status
  **3** 'DELIVERED', payment status 4 'Paid', 1 'Pending'). `tools/e2e/offline-billing-stack.ts`
  on `544b8ab9` inserts `OrderStatus` id 3 itself after `createE2eDatabase`, which will now be a
  duplicate key and stop that stack at startup. On merge, drop that insert (`offline-billing-stack.ts` lines 132-139 on `4bee6f1d`): the seed provides it. It is the only collision; the offline stack does not insert `payment_method` 14. The seed also
  adds active store 3 (unassigned) and unpaid orders 6001/6002; the offline stack's other inserts
  (MUser 700100, salespeople, payment mode 1001) are in its own file and do not collide with
  `stack.ts`, which seeds the same rows only for the web stack's own database.
- **Electron e2e** (`electron.spec.ts`): not run (W17).
- **Flaky:** `retail.spec.ts` failed once at the offline reload (`₹1,998.00` not shown after
  `setOffline(true)` + reload) in one of three full runs; it passed 6/6 isolated, paired with
  `real-order`, and in the final full run. Likely service-worker timing under load; not changed.
- **Console errors / failed requests in e2e:** the remaining recurring ones are the pre-login
  session probes (`GET /auth/sessions/current` 401, `GET /auth/challenges/current` 401, logged by
  Chrome as console errors) on every sign-in, the legacy 404 "User Not Found." customer lookup in
  `customers.spec`, and `sessions/current` checks after logout. All other API failures seen were
  fixture drift fixed above. Turning the 401 probes into 200 `{authenticated:false}` would change
  the auth contract; left for the auth owner.
- **Product question (not changed):** the default 240/min budget is per client IP. Counters behind
  one store NAT share it; consider keying by session for authenticated routes.
- **Shared-file edits:** `backend/src/app.ts`, `backend/src/config.ts`, `backend/.env.example`
  (one env var), `frontend/src/styles.css` (dialog backdrop).
