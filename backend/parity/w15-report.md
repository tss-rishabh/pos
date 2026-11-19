# W15: legacy golden recapture

Branch `w15/goldens` from integration head `3a3e0ab5`. W15 recaptured the goldens lost when the Python/Go oracles were
deleted, and restored the parity assertions that depended on them. The legacy source was the pinned `78d5b63`; the
oracle runners were restored from `d7cfa66`. Everything ran outside the repository against synthetic fixtures on an
isolated loopback MySQL 8.4.11 (empty `sql_mode`) and Redis, which are now stopped. Nothing touched production.

The repository still contains no `.py`, `.go` or `.php` file. The full per-item disposition is in
`tests/golden/INVENTORY.md`, section "W15 disposition".

## 1. Items

### Captured: golden committed, test compares the rewrite against it

| Item                                                                                                                                                                                     | Golden                                            | Test                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| Order search: 42 of 43 datatable vectors, plus the source halves of three scope cases (franchise N-type ID bypass, explicit-ID cross-store, split-order store) and the query-count check | `order-search/native-datatable`                   | `tests/order-search/native.test.ts`                            |
| Default form: GET default window, type-switch POSTs, ajax range, checked radio, MRO. The rewrite's `sourceOrderDefaults` must reproduce the legacy window                                | `order-search/default-form`                       | `tests/order-search/default-range.mysql.test.ts`               |
| N and ST midnight end-minute datatable (orphaned by a3d42c52; a fresh capture equals the committed golden)                                                                               | `order-search/default-range-mysql`                | same file                                                      |
| W9 D2: catalog detail oracle (input hash `ac7b5d79…`)                                                                                                                                    | `catalog-details/mysql-integration.detail-oracle` | existing test, unchanged                                       |
| W9 D2: shipping-label handler (input hash `986f7ad2…`)                                                                                                                                   | `fulfillment/shipping-label-mysql-integration`    | existing test, unchanged                                       |
| Counter barcode dispatch: 15 scans through the pinned `AjaxCartView.post` up to its lookup                                                                                               | frontend `counter-catalog/source-barcode`         | `frontend/tests/counter-catalog/barcode.test.ts`               |
| Gift-card batch datatable (orphaned by 90603810)                                                                                                                                         | `administration/gift-card-batches-mysql`          | `tests/administration/gift-card-batches.mysql.test.ts`         |
| Store and operator archival, server-side dispatch (12 cases)                                                                                                                             | `administration/archival-workflow`                | `tests/administration/legacy-archival.mysql.test.ts`           |
| Lookup: postal view (11 pincodes)                                                                                                                                                        | `lookup-workflow/postal-native`                   | `tests/lookup-workflow/postal.mysql.test.ts`                   |
| Hyperlocal expiry alerts                                                                                                                                                                 | `global-reminders/expiry-native`                  | `tests/global-reminders/expiry.mysql.test.ts`                  |
| Release notes render                                                                                                                                                                     | frontend `global-reminders/release-notes`         | `frontend/tests/global-reminders/release-notes.test.ts`        |
| Cashier shortcuts help page                                                                                                                                                              | frontend `cashier-shortcuts/source-help`          | `frontend/tests/cashier-shortcuts/source-help.test.ts`         |
| Product feedback: read, submit and native rows                                                                                                                                           | `product-feedback/native-workflow`                | `tests/product-feedback-legacy.mysql.test.ts`                  |
| Customer profile updates                                                                                                                                                                 | `customer-profile/native-workflow`                | `tests/customer-profile-legacy.mysql.test.ts`                  |
| Notification workflow: rows, receipts, lists and bus payload                                                                                                                             | `fulfillment/notification-workflow`               | `tests/fulfillment/legacy-notification-workflow.mysql.test.ts` |
| Catalog products and stock-matrix page dispatch                                                                                                                                          | `catalog-details/page-dispatch`                   | `tests/catalog-details/legacy-page-dispatch.mysql.test.ts`     |
| Legacy fulfillment (orphaned by 7a2635ab): courier status, 9 outbound calls, rounding, holds, pack/RTO, transfer, arrival scheduling                                                     | `legacy-fulfillment/{domain,lifecycle-domain}`    | `tests/legacy-fulfillment/legacy-golden.test.ts`               |

With the live oracle in place, every comparison passed before its golden was frozen. Each capture ran twice and gave
byte-identical output.

### Obsolete: the feature or the code under test is gone

- **Inventory XLSX workbook (10 cases).** The rewrite-only export was deleted, and legacy's URL is commented out.
- **Contact-reference differentials.** The verified-change challenge was deleted (970ca9f9), and the customer-contacts
  service went with it (decision 3).
- **Invoice-documents unittest.** It tested the rewrite's own API-v2 patch.
- **Offline-cash pricing unittests and the native snapshot/template drivers.** The module was deleted (W7).
- **Every `legacy-import-*` and `legacy-order-imports` row.** CSV import was deleted.
- **Screening and compatibility rows.**
- **Order-history native UI candidate.** It never ran, and its BigQuery routing was deleted.
- **Catalog workflow benchmark.** Performance evidence; W16 owns it.
- **Orphaned goldens with no remaining consumer:**
  - `checkout/order-messages`: API-v2 `omnichannel-sms` composes the text.
  - `checkout/cancellation-benefit-*`: API-v2 `pos/cancel-pos-order` owns the benefit arithmetic.
  - `legacy-order-status/commands`: the receiver was dropped, and `source.json` still covers the request shape.
- **Legacy-fulfillment leftovers:**
  - the exception-date formatter (its report URL is commented out);
  - `unhold_stock(order_push=True)` (no caller in this module);
  - saga-only checks.

These goldens are kept as provenance. Nothing reads them.

### Blocked: still missing parity evidence

- **Administration forms workflow (24 cases).**
  - The oracle prints no rows. It needs a re-authored ~750-line harness on the production snapshot, mapped onto the
    JSON APIs.
  - Its fixture depended on deleted migrations and `pos_rewrite_*` tables.
  - It never passed even with the oracle present (1 of 24).
- **Browser halves of every native workflow.** These are Chromium/UI evidence, outside W15's scope (Playwright/e2e).
- **`frontend/tests/finance/source-widget.mjs` browser half.** It runs pinned legacy JavaScript from the external
  checkout. The Python half stays captured.

## 2. Parity bugs found

Fixed, each small and local:

1. **`src/modules/catalog-details/service.ts`, metadata `selectedStoreIds`.** Legacy `Helpers.get_checkin_store`
   (`helpers/helpers.py:1791-1800`) preselects only an active `type="STORE"` check-in. The rewrite also preselected a
   `CORE_WAREHOUSE` check-in. Commit e3485cf4.
2. **`src/domain/python-round.ts`, `pythonRound2`.** It returned `Infinity` for |x| ≥ `MAX_VALUE/100`, where CPython
   `round(x, 2)` returns x. Values at or above 2^52 are now returned unchanged. Commit 9fc2a600.

Open, for W14 or the primary agent (not a small fix):

- **Stock-matrix store picker.** The frontend builds it from the shared catalog store list. For a role-4 operator that
  list holds every active store. Legacy, and the rewrite's matrix search, allow only assigned stores, so choosing an
  extra store returns 403.

## 3. Documented divergences

The tests assert each of these as intended, so they are not parity bugs. The primary agent should number the security
items S11+.

**Security:**

- **Customer profile, unauthenticated writes.** Legacy `users/views.py:1050` lists `View` before `LoginRequiredMixin`,
  so an unauthenticated caller can change a customer's birthday, anniversary or gender. The rewrite requires
  authentication.
- **Customer profile, SQL injection.** Legacy `users/views.py:684` builds the GSTIN UPDATE with an f-string. A `"`
  breaks the statement, and the raw MySQL 1064 error goes back to the client. The rewrite binds values and rejects that
  input.
- **Counter barcode input.** Legacy `int()` accepts a negative GTIN (`-1`) and non-ASCII digits (`１２`), then looks them
  up. The rewrite rejects both with "Enter a valid numeric barcode."
- **Notification mark-as-read.** For an operator who is not checked in, legacy said "success" and changed nothing. The
  rewrite returns 403 `CHECK_IN_REQUIRED`.

**Status codes and response shapes (S4 style):**

- **Status codes.** Legacy redirects (302) or returns HTTP 200 with `status: 400`; the rewrite returns 401, 403 or 400
  as appropriate. This covers feedback, profile, notification, catalog pages and archival.
- **Postal lookup.** With no match, legacy returns `data: {}`; the rewrite returns `null`.
- **Expiry alerts.** With no check-in, legacy returns an empty list; the rewrite requires a check-in. Its timestamps
  use a space where legacy's ISO format has a `T`.
- **Gift-card list.**
  - A missing creator is `[]` in legacy and `''` in the rewrite.
  - Legacy search raises `FieldError`; the rewrite keeps a working id search (N7).

**Approved earlier:**

- S45: franchise users see only their own stores.
- Store lists are ordered by name.
- The views.py:3915 transfer-reason fix and the views.py:3504 split-order fix.
- RTO receipt restocks only once.

## 4. How to recapture

Everything below lives outside the repository. In this session it was
`/private/tmp/claude-501/-Users-rishabhbhatia-code-pos-rewrite/28d85421-8f78-4245-9e1f-adeedac46e72/scratchpad/oracles/`.

1. **Oracle runners.** Export them from git history:
   `git archive d7cfa66 $(git ls-tree -r --name-only d7cfa66 | grep -E '\.(py|sh)$' | grep -E '^(backend/tools|backend/tests|frontend/tests)/') | tar -x -C oracles/tree`.
   - Point the runners at a git clone of `backend-pos-web` detached at `78d5b63`. Either symlink it as
     `oracles/backend-pos-web`, which is where `parents[4]/backend-pos-web` resolves, or rewrite the hard-coded checkout
     path.
   - Copy `backend/parity/legacy-inventory.json` into `tree/backend/parity/`.
2. **Python.** `uv venv --python 3.10 oracles/venv`, then
   `uv pip install django==4.2.5 pymysql==1.1.1 sqlparse==0.4.4 asgiref==3.7.2 typing_extensions==4.7.1 redis==4.6.0 async-timeout==4.0.3 channels==4.0.0 channels-redis==4.1.0`.
3. **Services.** Start MySQL 8.4 with
   `mysqld --initialize-insecure`, then run it with `--bind-address=127.0.0.1 --sql-mode='' --mysqlx=OFF`. Start
   `redis-server --bind 127.0.0.1`. Set each suite's `*_MYSQL_TEST_URL` to that server.
4. **Capture harness** (`oracles/capture/`):
   - `capture.setup.ts` is a vitest setup file that `vi.mock`s `backend/tests/golden/load.ts`. For each `area/name` in
     the JSON map named by `GOLDEN_ORACLES` (`{cmd, args, cwd, env}`), it runs the real oracle on the exact bytes the
     test passes. It hashes the input after placeholder substitution, appends `{area, name, inputSha256, args, status,
stdout, stderr}` to `GOLDEN_RECORD_FILE`, and returns the live output, so the test asserts against the live
     oracle.
   - `run.sh <map> <record.jsonl> <test files>` runs vitest with that setup and `fileParallelism: false`.
   - `gen.mjs --record R --golden area/name --out backend/tests/golden [--oracle --runtime --test]` writes the golden
     in the existing shape. It keeps raw `stdout` when JSON parsing would lose precision (more than 15 digits, or -0).
     It refuses two different outputs for the same input. Run prettier on the JSON afterwards.
5. **I/O-only wrappers** live in `oracles/runners/`; legacy code runs unchanged. They:
   - freeze `datetime.now` at a wall time given on stdin (default form, profile, feedback);
   - seed `check_in_{actor}` in Redis (default form, expiry);
   - widen schema-name guards to the current fixture prefixes (gift cards, lookup, archival);
   - report the reached `ProductBarcode.objects.filter` kwargs instead of asserting them (barcode).

   The frontend goldens that take fixed input (barcode, release notes, shortcuts) were written directly from the
   runner output with the same metadata shape.

6. **Each golden's `runtime` and `oracle` fields** record the runner and environment. The capture maps used were
   `oracles.{w9,os,df,gc,lf,w15n,w15n-catalog,w15archival,w15b-feedback,w15b-profile,fork-lookup,fork-reminders}.json`.

## 5. Checks

- **Backend and frontend:** `npx tsc --noEmit -p .` and `npx eslint .` pass.
- **Affected vitest files:** all pass on the loopback MySQL with every gate set, both in live-oracle capture and in
  golden replay.
- **`find . \( -name '*.py' -o -name '*.go' -o -name '*.php' \) -not -path '*/node_modules/*'`:** empty.
- **Shared files:** none edited. Outside `tests/`, the only src edits are the two parity fixes in §2.
