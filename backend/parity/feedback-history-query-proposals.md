# Feedback query evidence and deployment proposal

Baseline: `report/datatables/nps_datatable.py` at
`78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.

The historical reader now scans only feedback/order/store-association facts in
BigQuery. Current questions and contact dimensions are bounded primary lookups.
Native email equality preserves source `utf8mb3_general_ci`/PAD SPACE behavior;
functional LOWER cannot supply that equivalence.

The verified source already has the nonunique `users.email` index. A generated
504-row native fixture EXPLAIN chooses `ref`/`email` with an estimated 2 rows for
`email=?`, versus an index scan with an estimated 504 rows for
`LOWER(email)=LOWER(?)`. Do not add duplicate index DDL. Both predicates are bound
and the runtime uses native equality. The index is recreated only in an isolated
local fixture to match saved source metadata. This is index eligibility evidence,
not live latency, hardware-normalized performance or a source table modification.

Actual metadata-only raw dry run: **577,884,239 estimated bytes**, under the
unchanged 1 GB cap. A LIMIT/page does not eliminate the broad raw scan: source
orders are ID-clustered, not date-partitioned. Each runtime request retains a
dry-run budget check and server billing/time cap. No raw source row was executed
by the validation tool.

The proposed DATETIME date partition and four-column clustering use the
[documented GoogleSQL DDL syntax](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/data-definition-language).
Bound filters isolate `order_date`; actual post-deployment bytes must verify
[partition pruning](https://docs.cloud.google.com/bigquery/docs/querying-partitioned-tables).

`feedback-history-projection-review.sql` supplies an optional review-only
date-partitioned facts table and exact source SELECT. Its example uses a distinct
`pos_reporting_` prefix in `tssgcp2025.tss_mysql_raw_layer`, where the supplied
reader already has dataset read access. Deployment/population requires a
different authorized publisher; the read-only account does not execute it. If a
separate reporting dataset is chosen, its additional reader grant must also be
authorized. Actual post-deployment partition pruning/bytes and permission checks
remain required; this proposal does not claim that the table exists.

The row grain is feedback ID × order-store row ID, including null store rows for
online orders. Source duplicate same-store associations must remain distinct.
The publisher must propagate order dates/owner updates, store associations and
all updates/deletes, not use append-only copies. Current names, contacts and
question text remain current primary dimensions. No frozen question text,
LOWER-based email substitute, contact publication or question-activity filter is
introduced by the optimized facts projection.

Activate a separately deployed projection only by configuring the exact verified
`BQ_CUSTOMER_FEEDBACK_VIEW` facts contract, then re-run native/generated-BQ and
source comparisons. Ten executed generated-literal BigQuery vectors match native
source fact/paging results; native tests also compare enriched frontend fields.
Evidence and limits are in `feedback-history.md` and
`parity/evidence/feedback-history/`. The unchanged frontend response, source total
multiplicity, inclusive dates and page-one fallback are the acceptance criteria.

No live MySQL writes/DDL, BigQuery DDL, UDF/view creation, source-row output,
copy/export, notification or provider action was performed. This display does
not weaken financial publication/offline cash conservation gates.
