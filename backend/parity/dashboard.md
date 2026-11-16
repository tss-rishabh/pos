# Dashboard source contract and implementation

`dashboard/views.py:18–107` at source commit `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a` is the metrics dashboard. Its SHA256 is `431c56565123c1db019c84b1cb9d987ebc7e055aa4fa6d0fb6bc87d757a7ab2b`. `helpers/decorators.py:71–82` implements its `user_type_exempt("[2]")` restriction: franchise type2 is redirected to the shortcut page. Internal roles2–5 still use assigned stores; role1 uses current active stores. The shortcut/navigation page remains a separate surface.

| Source value | Exact behavior retained | Replacement reader/resource |
| --- | --- | --- |
| `store_count` | All active Store rows, globally for allowed internal operators. | PRIMARY, `GET /api/v1/dashboard/overview` |
| `user_count` | All active PosUser rows, including active franchise operators. | PRIMARY, same resource |
| `store_product_count` | Distinct parent-0 product IDs with any ProductStore association; no stock, deletion, availability, product-type or active-store filter. Missing Product joins do not count. | PRIMARY, one indexed `EXISTS` semijoin within the same three-count statement |
| `order_count` | Count OrderStore association rows joined to existing Orders with order_status≠0. Duplicate associations count separately. Missing status-dimension rows still count. Role1 scope is active stores; other allowed roles include inactive assigned stores. | BigQuery, `GET /api/v1/dashboard/orders/history` |
| Graph | Active stores in that scope; 12 calendar-month slots; source includes every year ≥ the current business year. Status0, orphan orders and all-zero dates do not contribute. | BigQuery, same historical resource |
| Additional explicit today slice | The same nonzero-status association predicate restricted to `[business-day start,next-day start)`. This is an explicit new label and does not replace the source all-history total. | DATA, `GET /api/v1/dashboard/orders/today` |

Counts and IDs use exact decimal strings, BigInt arithmetic and bound parameters. Source nullable store names remain null in the DTO; the redesigned page labels them “Unnamed store.” Graph rows have a stable numeric store-ID order. No financial mutations, revenue interpretation, customer-count interpretation, PII/body logging or internet telemetry are introduced. Source `LiveInternetDataView` has an acknowledgement GET and broken/unimplemented POST persistence; the metric page does not invent a speed-log feature. The separate motivational-quotes feature is owned by root.

## Source defects and safe behavior

The source graph groups by year/month, then overwrites the same month slot without ordering years. Its actual helper produces January `3` or `2` for grouped counts `(2026,2),(2027,3)` when row order reverses. The rewrite returns `DASHBOARD_MONTH_AMBIGUOUS` with the affected store ID rather than selecting an arbitrary year. Equal cross-year counts retain the source result. This refusal is explicit, tested and limited to genuinely non-unique source output.

The source performs one monthly query per active store and selects an ungrouped association ID. The replacement groups all scoped stores once on the warehouse, uses a sargable year-start wall date, and does not select that unused ambiguous ID. Current dimension counts use one SQL statement. The distinct-parent `EXISTS` query returns the same response as the original distinct join; native tests execute both and an actual MySQL JSON plan using verified physical indexes. These fixtures establish equivalence and query shape, not a production-size latency claim or a proposed live index change.

Writer authorization reads current active operator/type/role, assignment rows, active stores and monotonic authentication epoch before each read, then rechecks after completion. A changed assignment or restored credential epoch invalidates in-flight results. Browser role/store claims do not grant broader scope. Source metrics require no cashier check-in. Scope is capped at500 stores; monthly groups at24000, with explicit failure for wider data. API query objects are strict and accept no free-text parameters.

## Historical publication boundary

The executable bound BigQuery adapter is `src/modules/dashboard/warehouse.ts`. Its reviewed producer schema, digest definition and normalized projection are in `tools/dashboard/publication-contract.json` and `publication-projection.sql`. It requires immutable generation `pos-dashboard-orders-v1`, a common verified source checkpoint, exact per-store source/warehouse counts and digests, explicit zero-store manifests and unique physical association IDs. It exposes the accepted generation and `asOf`. An all-zero source date may map to nullable monthly DATETIME only while retaining its exact original wall string for digest reconciliation; other unrepresentable dates fail publication.

Saved `evidence/bigquery-schema.json` proves raw `tss_order_stores`/`tss_orders` schemas exist, but their independent CDC progress and one-hour max_staleness do not prove a common source snapshot or source-matching publication. No configured accepted dashboard publication, live GCP query, publisher deployment, DDL or live writes are claimed. Missing, stale, incomplete, duplicate, foreign-scope or hash-mismatched facts return explicit errors; there is no historical MySQL fallback or invented zero total. The UI keeps current metrics available while showing that historical failure and a safe retry. Historical data never enters offline financial state.

## Wiring

- Backend: `registerDashboard(app, config, db, readDashboardOptions())`, exported from `src/modules/dashboard/index.ts`. No rewrite migration or background worker.
- Frontend: default/named `DashboardPage({user})` from `frontend/src/pages/dashboard/index.tsx`, available to source-allowed internal roles1–5. Root owns application/navigation wiring.
- Options: `BQ_DASHBOARD_FACTS_VIEW`, `BQ_DASHBOARD_PUBLICATIONS_VIEW` (strict fully-qualified identifiers), `BQ_DASHBOARD_CONTRACT=pos-dashboard-orders-v1`; all unset by default. `DASHBOARD_PUBLICATION_MAX_AGE_SECONDS=3600`, range60–86400. Future timestamps beyond30seconds and publications older than that window are refused at exact nanosecond boundaries.
- All three routes declare module/resource/action tracing and private no-store caching. Parent request tracing supplies sanitized request/operator IDs; no query text, raw upstream error, contact, token, body or count-row payload is logged by this module.

## Executed evidence

`tests/dashboard` includes23 backend checks:11 isolated native MySQL cases and12 unit contract/warehouse cases. The pinned Django4.2.5 oracle executes actual DashboardView/decorator methods, with only the fixed `tss.order_stores` schema qualifier redirected to a freshly created localhost fixture. The source code is hash-checked and stays read-only; its prints are suppressed. It compares global counts, parent-association flags, non-role1 and role1 scope, duplicate associations, inactive assignments, status0/missing status rows, orphans, all-zero dates, full-width IDs and literal month-overwrite permutations. Other native checks cover exact-day bounds/readers, writer role/type/epoch changes, missing-history refusal, traced HTTP DTOs/input/auth and executable query equivalence/plans.

Four controlled Chromium workflows mount the actual DashboardPage with synthetic HTTP replies: exact counts/12-month graph/filter/literal names, publication absence and recovery without fabricated totals, delayed prior-actor refusal and source franchise denial. They are component/browser evidence, not configured production BigQuery or full deployment certification.

```sh
# backend; only a fresh randomized localhost schema is mutated
DASHBOARD_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_dashboard_test \
  node node_modules/vitest/vitest.mjs run tests/dashboard
node node_modules/typescript/bin/tsc --noEmit -p tools/dashboard/tsconfig.tests.json
node node_modules/eslint/bin/eslint.js src/modules/dashboard tests/dashboard tools/dashboard/fixture.ts

# frontend; isolated random Vite port/cache, no shared dist/default ports
ADMINISTRATION_BROWSER_TESTS=true node node_modules/vitest/vitest.mjs run tests/dashboard/browser.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tests/dashboard/tsconfig.tests.json
node node_modules/eslint/bin/eslint.js src/pages/dashboard tests/dashboard
```

Use the repository-pinned Node24 runtime (current local invocation `npx -y node@24.22.3`). The native source oracle requires `uv` and pinned `django==4.2.5`/`pymysql==1.1.1`; it receives its synthetic database URL on stdin only.
