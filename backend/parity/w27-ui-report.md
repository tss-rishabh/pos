# W27 report: UI cleanup (web, desktop macOS, desktop Windows)

Branch `ui/cleanup` from `a00ff061`. User request of 20 November 2026: remove keyboard shortcuts,
sound toggle, empty bell, flavour text and the online connection card; one Log in / Log out header
toggle; check-in moves into the header with a prompt after sign-in; consistent loaders, spacing,
modals and form controls; fix the screens in the user's screenshots. All runs used the synthetic
e2e seed on loopback services (private MySQL 8.4 with an empty `sql_mode` on 33927, private
redis-server, the W17 API-v2 stand-in). No production service was contacted. Production readiness
is not claimed; the release gate stays failing.

Work was split into four exclusive file sets (primary: shell, shared components, header, check-in,
offline/sync/fulfillment pages, removals, parity records, tests and verification; fork A: checkout
modal and payment form; fork B: orders and reports; fork C: administration, catalogue and counter
product cards). Each fork committed only its own paths.

## 1. Shared foundation (`frontend/src/styles.css`, `frontend/src/components/*`)

- **One spacing scale and control size:** `--space-1…8` (4–32 px), `--radius`, `--control-height`
  (38 px). Buttons share the control height.
- **Global form controls** (zero-specificity `:where()` rules, so component classes still win):
  every text input, select (custom chevron), multi-select list, textarea, checkbox and radio share
  one border, radius, height, type size and regular weight. A label wrapping a control stacks the
  caption over it; a label wrapping a checkbox/radio keeps both on one centred line. `fieldset`,
  `legend` and `details > summary` get one style. This removes the raw, unstyled native controls
  app-wide, not only on the screens below. Fixed on the way: the old `font: inherit` reset made
  every typed value semi-bold inside labels.
- **Layout utilities:** `.form-grid` (aligned responsive grid, actions on the baseline),
  `.form-actions`, `.toolbar`, `.tab-group` (segmented section tabs), `.truncate`, `.field`,
  `.page-actions`, `.status-chip`.
- **`Modal`** (`components/modal.tsx`): one dialog with fixed widths (sm 440, md 640, lg 880), a
  header with title, optional description and close button, a scrolling body and a footer for the
  actions; Escape closes the topmost dialog, focus moves in on open, Tab is trapped, focus returns
  to the opener. Bare legacy `.modal` markup gets the same box. All dialogs in the app now use it
  (checkout review, payment, fast cash, order detail/summary, invoice, sync conflict, offline
  receipt and manager review, fulfillment rejection, express editor, shipping label, nine
  administration dialogs, check-in prompt).
- **Loaders** (`components/loader.tsx`): `Spinner`, `Loader` (block/inline, polite live region),
  `Skeleton`, `SkeletonText`, `SkeletonCards` (catalogue grid), `SkeletonTable`. The existing
  `Loading` export now renders the shared `Loader`, so all 70 existing call sites changed at once.
  `.button[aria-busy='true']` shows a spinner; submit and action buttons that run a request are
  disabled and `aria-busy` while it runs.
- **`MultiSelect`** (`components/multi-select.tsx`): searchable checkbox list replacing raw
  `<select multiple>`; the trigger is named by the field label; empty means "all" where the
  legacy filter defines it; Escape closes, Clear empties. `.surface` no longer clips its panel.

## 2. Changes by request

| # | Request | Result |
|---|---|---|
| 1 | Remove keyboard shortcuts | Deleted `pages/cashier-shortcuts/**` (help disclosure, preference, reference page, key handler incl. the F fast-cash key and R/P/PP/N/E/B/S/T), the "Shortcut reference" nav item and route, every `data-cashier-action`, `data-cashier-shortcuts` and `aria-keyshortcuts`, the `↵` hint in the search box, and the shortcut-request plumbing in `CheckoutReview`. The Fast Cash **button** (legacy feature) stays. The membership-display helper the review used moved to `pages/checkout/membership.ts` with its unit test (`tests/checkout-membership`). Browser/OS editing keys and the W24 Windows menu roles (undo/redo, cut/copy/paste, select all, zoom) are untouched. No backend shortcut-help route existed. |
| 2 | Log in / Log out toggle | One header control: the signed-in user (name, role · In-House/Franchise) plus **Log out**; the separate logout icon is gone. The sign-in page has the same header with **Log in** (focuses the form). Headings are plain: "Log in" and "Verify and check in". |
| 3 | Remove "Sound on" | The toggle, its stored preference and its sync events are removed. Legacy plays `notification.mp3` when a store notification arrives (`users/templates/admin/layouts/base.html:77,169`), with no setting, so that chime is kept: it is armed by the first user gesture and plays only for a newly arrived notification. |
| 4 | Bell only with real notifications | The bell renders only when the feed loaded for the checked-in store (the backend serves it) **and** holds notifications; an unread count is in its accessible name. It also stays while a revoked stream needs "Reconnect after checking store access". The queue indicator and arrival toasts are unchanged. |
| 5 | Loading states | Shared loaders everywhere (above); catalogue grid skeleton; skeleton rows in admin, orders and report tables; quote skeleton in checkout; loaders for the payment state, salespeople, discount approval, counters in the check-in prompt, sign-in options, offline billing status; busy states on Review sale, Save sale, Load more, check-in/out, Log out, quote, payment Submit/"Yes, sure!", Fast Cash Submit, Sync Order Cart, Place order now, reject, express save, label print, admin saves. Product count shows "Loading products…" instead of "0 loaded". |
| 6 | Remove quotes and flavour text | Removed: "Let's make it a good one.", the date label, "A little retail therapy." (now "Current sale"), "Walk-in customer / No customer attached" static row, "A fresh start", "Keep it souled" sidebar card, "RETAIL WORKSPACE", "WORKSPACE 01", "Desktop & web", the footer ("THE SOULED STORE · MADE FOR EVERYDAY RETAIL … All amounts in INR"), the catalogue footer hints, "Cart changes are saved on this device", every page eyebrow (40 `PageTitle` calls, e.g. "YOUR STORE, IN FLOW", "FROM FIRST SCAN TO FINAL RECEIPT", "STORE CONTROL", "YOUR WORK STAYS WITH YOU") and in-dialog eyebrows ("SALE REVIEW", "ORDER DETAILS", "REVIEW A SYNC CONFLICT", "EXPRESS FULFILLMENT", "MANAGER REVIEW", "ACCOUNT ACCESS", "STORE ADMINISTRATION", "STORE KNOWLEDGE", "ACCOUNT SECURITY", "STORE ACCESS", "OPERATOR SESSION"), the login story panel ("More time for your customers.", "GOOD DAYS START HERE", "Made for desktop & web", "Your store data stays scoped to your account."), report empty-state taglines ("The day, by the numbers", "What customers are telling us"), and the window title tagline ("Souled POS · Retail workspace" → "Souled POS"). **Motivational quotes:** the card (counter and rotating dashboard card), `components/motivational-quote.tsx`, the backend module `backend/src/modules/motivational-quotes/**` and its route `GET /api/v1/motivational-quotes/random`, its test, golden capture and e2e spec. The online-order type stays as a factual subtitle on the order detail page. The offline receipt keeps its store branding line. |
| 7 | Remove "Connected — bill from the counter" | The offline-billing status card is hidden while online with nothing waiting. A compact status strip appears only when offline, unavailable, with sales waiting or needing a manager, limit-blocked or after a sync error. The global offline banner and the "Connected / Sync pending" header link are replaced by compact header chips: **Offline** (also when the desktop bridge reports the store service unreachable), **N unsynced** and **N need manager** (desktop). The Sync center drops its "Connected to your workspace" card. Offline billing remains desktop-only. |
| 8 | Check-in in the header | The `/check-in` route and page (`pages/administration/check-in.tsx`), its nav item and the "Checked in at …" sub-bar link are removed. The header shows the authoritative status ("Checked in", "Checked in at <store>", "Not checked in", "Check-in unverified offline/unavailable", expiry in the tooltip) with **Check in / Check in here** and **Check out**. After an interactive sign-in without a current check-in (e.g. legacy "Not at the store"), a "Check in to your store" modal asks for store and counter from the operator's assigned stores; "Not now" keeps the legacy no-store choice; a reload is not a new sign-in. Backend unchanged: `PUT`/`DELETE /api/v1/operators/me/check-in`, legacy `check_in_*` keys, S-decisions. |
| 9 | Fix broken/unaligned screens | See §3. |
| 10 | Remove unnecessary UI | Everything in rows 1–8, plus: the sub-bar (`components/workspace-context.*`), the "Store catalog" pill, duplicate in-dialog headings and action rows in admin dialogs. "What's New" was **kept** (real content: the legacy `whatsnew.html` role-rename notes, golden-tested) and moved into the header. The In-House/Franchise account type was kept (legacy header) under the user's role. |

## 3. Screens from the user's screenshots

- **Header (2.07.27 AM):** store and counter selectors, divider, check-in status and toggle on the
  left; status chips, bell (only with data), What's New, user and Log out on the right; one height,
  one gap scale, sticky.
- **Counter (2.05.20 / 2.47.04 / 2.47.08 AM):** plain title; catalogue toolbar aligned (out-of-stock
  checkbox, count, cached badge, Inventory reload); **product cards** (fork C) hold the image
  button, name and price, a two-column grid with all five legacy picker columns (Barcode, Spl.
  Price, Ex. Price, Holded Stock, Storages Stock, incl. "Barcode Missing (Please ask administrator
  to set barcode)"), and a footer with "Product details" / "Troubleshoot product"; legacy highlight
  colours kept as a left accent; storage stock wraps instead of clipping.
- **Checkout review modal (2.57.18 AM, fork A):** shared lg Modal "Confirm the sale"; sections in
  order: status messages; summary with Refresh sale; current checkout items as a table (product,
  unit/sale price, quantity input, Remove); salesperson assignments as an always-open grid of
  styled selects; customer section (details, insights, benefits, history in one button row with a
  full-width panel; contact, Sync Order Cart and Place order now as styled rows); bordered
  collapsible option sections with form grids; the quote breakdown; payable; one action row (Clear
  checkout | Get/Refresh final quote, Fast Cash); Proceed For Payment or the payment form. **The
  "This breakdown is not a current final quote… / Quote amounts are unavailable…" block is
  removed**: the breakdown shows only for a current final quote with amounts; a skeleton shows while
  a quote is requested; legacy rows/labels and cashback/membership logic unchanged.
- **Payment form (2.57.21 AM, fork A):** "Amount due" panel over an aligned grid (Transaction ID,
  Cash To Be Accepted, Cash Received, Cash To Be Return, Card/UPI, Payment Mode and the conditional
  District/Credit-Pincode IDs), full-width Message textarea, confirm row. Label typo fixed to
  **"Cash Received"**; the legacy validation message "Provide a value in Cash Recieved" and every
  other legacy message are kept verbatim.
- **Orders (3.25.05 AM, fork B):** Stores, Payment method, Payment status and Order status are
  searchable multi-selects in one aligned grid; checkboxes on one row with Apply filters; count
  chips share one pill style; one table toolbar (Export page CSV, Visible columns popover, Rows per
  page); Online orders / Refresh orders in the title actions; order detail and summary are shared
  Modals. All filters, default ranges, request bodies and messages unchanged.
- **Reports export (2.10.26 AM, fork B):** searchable store multi-select (empty = all permitted
  stores, hint kept; the three store-required kinds still say "Choose the stores to include."),
  aligned grid, aligned history toolbars; the same treatment for daily store sales (legacy "Select
  all stores" / "Clear all stores" kept), order transactions, customer feedback and the shared
  report view.
- **Administration (2.10.32 AM, fork C):** page links in one compact toolbar; the six sections as a
  `.tab-group` with arrow-key navigation; aligned table toolbar; one-line cells truncated with the
  full value as a tooltip; pagination bar; nine dialogs on the shared Modal.
- **Also:** offline billing (compact strip, Modal receipt/review; print still one page), sync center,
  fulfillment rejection/editor/shipping label, catalogue/matrix/audit store multi-selects, gift
  vouchers, wallet adjustments, product feedback.

## 4. Removals, complete list

Frontend: `src/pages/cashier-shortcuts/{help.tsx,preference.ts,reference.tsx,shortcuts.ts}`,
`src/components/motivational-quote.tsx`, `src/components/workspace-context.{tsx,css}`,
`src/pages/administration/check-in.tsx` (and its CSS), routes `/shortcut-reference` and
`/check-in`, nav items "Shortcut reference" and "Store check-in", the sound toggle and its
`pos-notification-sound:*` preference, the offline banner, the footer, the sidebar note, all
eyebrows and taglines listed in §2, the static walk-in row, the counter date label, the catalogue
footer, the quote-breakdown placeholder. Tests: `tests/cashier-shortcuts/{source-help.test.ts,
tsconfig.json}`, `tests/golden/cashier-shortcuts/source-help.json`,
`e2e/checkout/cashier-shortcuts.spec.ts`, `e2e/motivational-quotes.spec.ts`.

Backend (the only contract change, a route that served only the removed UI):
`GET /api/v1/motivational-quotes/random` with `backend/src/modules/motivational-quotes/{index,pool}.ts`,
`backend/tests/motivational-quotes.test.ts`, `backend/tests/golden/core/motivational-quotes.json`.

Records updated: `tools/parity/source-surface-families.json` (families `cashier-shortcuts` and
`motivational-quotes` marked removed by user decision like `legacy-order-imports`; `check-in` and
`shared-shell` point at the new header components) and the regenerated
`parity/source-surface-map.{json,md}`; `parity/release-coverage.json` (`core/urls.py:66`,
`order/urls.py:57`, `order/templates/order/shortcuts.html` set to **blocked** with the removal noted:
the gate has no disposition for user-removed legacy surfaces, so the primary agent/user must record
one); `parity/cashier-shortcuts.md`, `parity/motivational-quotes.md`, `parity/rewrite-status.md`,
`spec.md` (annotated), `tests/golden/INVENTORY.md`, `tools/verify-project.ts` (dropped the
`cashier-shortcuts-fixture-typecheck` stage and its MySQL schema env). Historical evidence receipts
are untouched.

## 5. Behaviour fixes found while testing

- **Check-out refetched store features (403):** a check-out refreshed every operator query at once,
  so notifications and expiry reminders refetched for the store just left. A check-in also
  cancelled reads it had just started (`ERR_ABORTED`). Now the check-in record is refetched (or
  cleared on check-out) first, and the remaining reads refresh once without cancelling in-flight
  ones (`components/check-in.tsx`).
- **Desktop Offline indicator:** with the store service unreachable but the OS online,
  `navigator.onLine` stayed true; the header chip now also follows the desktop bridge's
  reachability.
- **Controls rendered semi-bold** (font shorthand reset); fixed globally.

## 6. Tests changed (no assertion about real behaviour weakened)

- New `e2e/workspace-header.spec.ts` (real stack): Log in toggle focuses the form; sign-in with "Not
  at the store" shows the check-in prompt; check-in from the prompt; no check-in link, sound
  control, empty bell, Offline chip, "Keyboard shortcuts" or "Shortcut reference"; header Check out
  → Not checked in → Check in; reload shows no prompt; Log out; exactly PUT/DELETE/PUT 2xx.
- `e2e-desktop/offline-billing.spec.ts`: header check-in status, Check out and Log out present; no
  bell, no sound button, no Offline chip and no check-in prompt online; no status card online
  (replaces the "Connected — bill from the counter" heading); Offline chip while offline; "2 sales
  waiting to sync" after two offline sales.
- `e2e/support/login.ts`, `e2e/login.spec.ts`, `e2e/retail.spec.ts` (Log out toggle, Log in
  heading, Offline chip instead of banner), `tests/catalog-details/native-ui-workflow/browser.mjs`.
- Fork A: `tests/checkout-actions/browser.test.ts` (stale quote and after removal: the breakdown and
  any stale amount are absent), `e2e/checkout/real-order.spec.ts`, `e2e/checkout/order-payments.spec.ts`,
  `e2e-uat/11-checkout-orders.spec.ts` (label names).
- Fork B: order-search and reports real-stack harnesses, `e2e/daily-report.spec.ts`,
  `tests/finance/review-browser.mjs` (multi-select driving),
  `tests/operational-reports/browser-check.mjs` (answers the header's check-in read).
- Fork C: `e2e/stock-matrix-stores.spec.ts` (multi-select; still asserts only authorised stores and
  the 200 search), `e2e/checkout/product-feedback.spec.ts` (title), catalogue harness helper.
- UAT harness (W26, not run here): `e2e-uat/01-login-pages.spec.ts`, `03-reads-session.spec.ts`,
  `06-admin-reports.spec.ts` follow the removed routes and the new controls.
- Removed with their features: the shortcut and quote tests listed in §4.

## 7. Verification per client

**Static and unit (macOS, Node 24):**
- Frontend `npm run typecheck` (app + electron) clean; `npm run lint` clean; prettier clean on all
  touched files (three pre-existing files from `bfc58a04` are unformatted, untouched).
- Frontend vitest: 293 passed, 111 skipped (gated); with all seven `*_BROWSER_TESTS=true` gates:
  **404/404** in 74 files.
- Backend `tsc` and `eslint src tests tools` clean; vitest 852 passed, 457 skipped (MySQL-gated).
- `tools/parity/build-source-surface-map.ts --check` passes after regeneration.
- Fork-run browser checks: administration 63/63 (incl. all 18 `workflows.test.ts`), counter barcode
  and product feedback 29/29, catalogue `browser-check.mjs` 12/12, invoice-documents, report columns,
  operational-reports export/ledger, finance review; real-stack harnesses order-search 1/1,
  order-history 1/1, reports 1/1.

**Web (Playwright, real stack, Chromium):** two consecutive full runs on the final code (runs 6
and 7), **37/37 each, 0 unexpected console errors, 0 unexpected failed requests** (47 declared observations each:
23 console + 24 request, all per-test `network.expectFailure`). Earlier runs exposed the two
check-in refresh bugs in §5 (fixed, then the header spec passed 5/5 with `--repeat-each=5`).

**macOS desktop:**
- Electron shell specs (`e2e/electron.spec.ts`, part of the web suite runs): 2/2 in both runs.
- Desktop offline billing suite (`playwright.desktop.config.ts`, real Electron + real stack):
  **12/12** (6.1 min) on the final code, real Electron + real stack, mock keychain; receipt
  printToPDF 97,646 B, **1 page** (the receipt now sits in the shared Modal). The first run on the
  intermediate code failed one new assertion (the header Offline chip did not follow the desktop
  bridge's reachability), which led to the §5 fix.
- Dev build: the macOS Electron screenshots (§8) were taken from the dev shell
  (`NODE_ENV=development`, `POS_DESKTOP_URL`, mock keychain) against the real stack.
- Packaged build: the unsigned review `.app` and the CI-only native-smoke flavour both package
  cleanly with electron-builder `--dir` (as the CI macOS steps do, `POS_DESKTOP_URL` set to the
  review placeholder). `tools/smoke-desktop-package.mjs` passed its integrity, flavour,
  `NODE_ENV`-refusal and debugging/mock-keychain switch-refusal stages, then stopped at
  `initial-native-launch` (`FIXTURE_REPORT_TIMEOUT_LOADED`): packaged builds refuse the mock
  keychain, so on a developer Mac the first launch waits on the login Keychain (W24 §1 records the
  same reason for not running it locally). The fixture page is synthetic, so this stage does not
  exercise W27 code; the packaged runtime proof is item 5 of the CI checklist. The evidence files
  the partial run rewrote were restored, not committed.

**Windows desktop:** not run locally (no Windows host); see §9 for the `windows-latest` checklist.
No Electron main/preload/IPC/packaging file changed; the UI changes reach Windows through the
shared renderer bundle.

## 8. Screenshot index (`backend/parity/w27-screens/`)

Synthetic seed data only. `web/` (Chrome, 1440×900) and `macos/` (Electron dev shell, 2×), each
with `before-*` (at `a00ff061`) and `after-*` (final):

| # | Screen | Notes |
|---|---|---|
| 01 | Sign-in | after: plain header with Log in |
| 02 | OTP step | after: "Verify and check in" |
| 03 | After signing in with "Not at the store" | after: header "Not checked in" + check-in prompt |
| 04 | Check-in | before: `/check-in` page; after: "Check in to your store" modal |
| 05 / 07 | Counter (viewport / full page) | header, toolbar, cards with the legacy info block inside |
| 06 | Header only | |
| 08 | Checkout review | |
| 09 | Checkout with a final quote | |
| 10 | Payment form | |
| 11 | Orders | |
| 12 | Reports export | |
| 13 | Administration | the seeded e2e operator is SM, so this shows "access required"; the admin layout is in `fixtures/` |
| 14 | Offline billing | after: no status card online |
| 15–19 | Dashboard, Returns, Day close, Sync, Profile | |
| 20 | Shortcut reference | before only (removed) |
| 21 | After Log out | after only |

`fixtures/` (browser fixtures, synthetic data): administration stores and operators tabs, store
detail Modal, counter product cards.

Capture tool: `frontend/tools/w27-screens.mjs <before|after> <outDir> [baseURL] [web|electron]`.

## 9. Windows CI checklist (`windows-latest` leg of `.github/workflows/desktop-platforms.yml`)

The primary agent must push `ui/cleanup` and confirm on Windows:

1. Frontend vitest (unit) green; the browser vitest files green.
2. Web Playwright suite (`e2e/`, real stack, MySQL 8.4 + Memurai): 37/37, 0 unexpected, including
   the new `e2e/workspace-header.spec.ts` (check-in prompt after sign-in, header check-in/out,
   Log out toggle, no bell/sound/connection card) and the updated `retail`, `login`,
   `daily-report`, `stock-matrix-stores`, `real-order`, `order-payments`, `product-feedback` specs.
3. Electron shell specs (`e2e/electron.spec.ts`) 2/2, including the W24 Windows menu assertions
   (hidden menu, Edit/View roles, clipboard, Ctrl+= / Ctrl+- / Ctrl+0 zoom): unchanged code, but
   they must still pass now that no app-level key handler exists.
4. Desktop offline billing suite 12/12 with real DPAPI, including the new header assertions
   (check-in status, Check out, Log out, no bell/sound/prompt, no status card online, Offline chip
   when the stack's TCP gates cut the network, "2 sales waiting to sync") and the receipt print:
   the receipt is now inside the shared Modal; confirm printToPDF and the spooled Windows print are
   still **one page** (W24 G10 behaviour, print CSS updated for the modal header/body/footer).
5. Packaged-app smoke (`tools/smoke-desktop-package.mjs`) and the NSIS lifecycle smoke: no shell
   change, but the renderer bundle changed (window title is now "Souled POS").
6. Visual spot check on Windows Chromium/Electron at 100 % and 125 % scaling: header wraps cleanly,
   custom select chevrons render, Modal widths and the product-card info grid fit, the multi-select
   panel is not clipped.
7. macOS leg: the same suites (the local macOS results are in §7).

## 10. Follow-up fixes after the coordinator's screenshot review

- **Quote breakdown:** a row appears only when the final quote carries its value; no "Unavailable"
  text anywhere; the round-off deduction sign goes on numbers only (`-₹0.49`); with no breakdown
  rows the dialog shows "Confirmed payable" alone (the e2e stand-in quote carries only the total,
  so `after-09/10` now show the payable alone). `tests/checkout-actions` adds a `payable-only` mode
  and checks partial rows, the sign and the absence of placeholders.
- **Orders payment method:** legacy `get_method_name` (`order/datatables/orders_datatable.py:264-303`)
  returns `f"{pay_method}: {cash} {other} {online}"`, so an order without a method name is
  `": CASH  "`. The server value and the page CSV keep that legacy string; the table now joins the
  parts only when both exist (`order-history/payment-method-label.ts`, unit-tested; the
  order-search harness expects `CASH`).
- **Truncation:** one `TextCell` (`components/text-cell.tsx`) for plain-text cells in the orders,
  report-view, order-transactions and daily-sales tables: one line, ellipsis, full value in the
  tooltip. The orders table uses a fixed layout so it fits its panel instead of running past the
  edge.
- Re-verified on the final code: web Playwright two runs 37/37, 0 unexpected (runs 10, 11; shell
  specs 2/2 in each); macOS desktop offline suite 12/12 (receipt 1 page) on `21b10473` (the later
  change is orders-table CSS only); vitest 407/407 with all browser gates; order-search,
  order-history and reports harnesses 1/1; report-columns fixture pass. Screenshots `after-08…11`
  (web and macOS) recaptured.

## 11. Follow-ups for the primary agent

- Record a release-gate disposition for user-removed legacy surfaces (three entries now `blocked`).
- `operational-reports` still routes the salesperson performance, cashier performance and
  hyperlocal acceptance pages; AGENTS.md deletes the four rewrite-only **exports**, and the release
  notes name "Staff Performance" as a legacy report, so the pages were left as they are.
- Three pre-existing prettier deviations (`src/api/types.ts`, `src/offline/review-snapshot.ts`,
  `src/offline/sync.ts`).
