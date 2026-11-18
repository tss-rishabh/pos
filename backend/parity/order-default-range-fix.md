# Original rolling order window correction

Historical first-fix record (9eaff84/e54d11d). The active store-page type-switch behavior is corrected separately in [order-type-range-retention-fix.md](order-type-range-retention-fix.md). The original online-view arithmetic prefix mentioned below does **not** establish rendered online defaults: its actual context supplies an empty range and HL, while active store-page radio changes retain the existing window.

Source pinned at `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`: `helpers/helpers.py:496` and `order/views.py:70,232` subtract five local wall days and format to minute precision. Store-family views add one minute to the end; online does not. The rewrite previously opened today only.

The additive options metadata now supplies server business-zone defaults. The App anchors them once per operator/role/store authority scope. Explicit URL calendars remain authoritative. Focus, reconnect, refresh and sorting do not regenerate the initial window or discard operator edits. Switching untouched type defaults selects the original ST/HL/HE versus N end. Applying unchanged calendar dates retains precise bounds. Opening historical rows sends their day only to the bound detail query, preserving the list and its filters.

Ordinary mixed searches still use the existing complete whole-window warehouse publication/common checkpoint. Only the source-permitted future midnight fraction uses bounded primary facts, enriched and reduced with original association multiplicity. No future warehouse manifest is invented. Calendar/report future policy is unchanged. Undated interactive detail includes the original exact future endpoint only when it reaches the ordinary exclusive midnight boundary; one captured clock is used across authorization. All existing actor/store/post-read checks remain.

## Focused checks

Node 24.22.3, own mitigated dependency copies, isolated local MySQL 8 fixture; no live database/provider calls.

- Backend and frontend main strict TypeScript: passed.
- Changed-file ESLint and whitespace check: passed.
- Backend `tests/order-search/default-ranges.test.ts`: 10 passed. Executes literal pinned Python helper/view prefixes for ST/N across midnight, year, leap-day and DST vectors; checks unchanged ordinary mixed planning and rejects tampered future bounds.
- Frontend `tests/order-history/client.test.ts`: 3 passed. Includes authoritative server/device-clock separation, explicit/invalid/unknown-age links, and N versus store-family ranges.
- Backend `tests/order-search/default-range.mysql.test.ts`: 2 passed. Exact original Django SQL versus native supplementary facts yields all four duplicate-association rows; scoped denial retained. Native authorized detail includes the midnight point and excludes +1 second, normal-day future, explicit future, and a clock-crossing authorization widening. Explicit historical lookup still requires historical publication.
- Vite production build: passed.
- Actual production routed App with real demo-cookie/backend HTTP, `e2e/order-default-ranges.spec.ts`: 2 passed; precise payloads, unchanged Apply dates, real tab-focus transition, offline edit retention, reconnect metadata, reload, explicit and invalid URL controls. No response interception.

The first browser attempt incorrectly expected focus metadata refetch despite production globally disabling that behavior. It timed out at the original 45-second deadline; the harness now performs real tab focus and checks retained edits. No production setting, deadline, retry or assertion count was loosened. The original explicit-URL case passed on that attempt.

These are focused regression checks, not admission of the whole order template, financial actions or warehouse provider publication. The pending joined source/App/warehouse workflow remains separate. Demo UI exposes ST only; N/store switching is source-derived/helper coverage here. Fresh consolidated r9 and exact-head Windows/macOS CI remain Root-owned.

## Reproduce

From backend with Node 24: `ORDER_DEFAULT_SOURCE_ROOT=/absolute/backend-pos-web node node_modules/vitest/vitest.mjs run tests/order-search/default-ranges.test.ts`.

From backend with an owned loopback schema-template URL, own Python/Django environment and pinned source: `ORDER_SEARCH_MYSQL_TEST_URL=mysql://root@127.0.0.1:<owned-port>/pos_rewrite_order_search_test ORDER_SEARCH_ORACLE_PYTHON=<owned-python> ORDER_SEARCH_SOURCE_ROOT=/absolute/backend-pos-web node node_modules/vitest/vitest.mjs run tests/order-search/default-range.mysql.test.ts`.

From frontend: `node node_modules/vitest/vitest.mjs run tests/order-history/client.test.ts`; then `node node_modules/vite/bin/vite.js build` and `node node_modules/@playwright/test/cli.js test e2e/order-default-ranges.spec.ts` with Node 24 first on PATH. Native fixtures create/drop their own random schema; remove only the exact owned disposable container and its volume afterwards.
