# Historical customer feedback with current dimensions

Baseline: `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`,
`report/datatables/nps_datatable.py:AjaxNpsDataListView`.

The source LEFT JOINs questions only to display their current question text. It
does not filter by question, question activity or question creation date. The
question ID is a verified primary key. Customer first name/email/telephone and
store name likewise come from current mutable dimension rows. These are distinct
from historical feedback/order/store-association facts.

## Reader and API contract

The existing `POST /api/v1/reports/customer-feedback/search` response is unchanged.
Sensitive filters remain in the POST body; the response is private/no-store.
Current business-day facts continue through the data reader. Historical/mixed
ranges query only BigQuery facts. Current question/customer/store lookups use the
primary reader; current operator/assignment checks use short writer transactions.
Neither primary nor writer reads any historical feedback/order facts.

The default historical input binds the observed, verified relations:

```dotenv
BQ_CUSTOMER_FEEDBACK_TABLE=tssgcp2025.tss_mysql_raw_layer.tss_nps_feedback
BQ_CUSTOMER_FEEDBACK_ORDERS_TABLE=tssgcp2025.tss_mysql_raw_layer.tss_orders
BQ_CUSTOMER_FEEDBACK_ORDER_STORES_TABLE=tssgcp2025.tss_mysql_raw_layer.tss_order_stores
```

The optional `BQ_CUSTOMER_FEEDBACK_VIEW` now means a **facts-only** projection,
with this exact row contract:

`feedback_id,store_row_id,order_id,customer_id,store_id,question_id,feedback,feedback_date,order_date`

It must retain every feedback × order-store occurrence, including the null
store row for an online order. It must not join/deduplicate customer/question
dimensions or discard inactive customers/questions. IDs retain exact INT64
values; question IDs are nullable signed INT32; dates are business wall-clock
DATETIME. No matching deployed view was observed. A former contact/question-text
view must be revised to this contract; an incompatible schema fails validation
rather than being silently treated as equivalent. No view or table was created.

## Source arithmetic, scope and paging

One BigQuery SELECT returns both the total and requested page. It preserves
source order-store join multiplicity, all order statuses, positive order IDs,
order-date bounds inclusive at both ends, selected orders/stores, and source
out-of-range page fallback to page one. `recordsTotal` and `recordsFiltered`
correspond to the same post-filter total. No DISTINCT, per-order deduplication or
per-row query is introduced. Source filtering uses order date, even when the
feedback creation date falls outside that range.

Source ordering is `o.id DESC` and leaves ties undefined. The candidate adds
feedback-ID/store-row-ID descending tie ordering for stable pages. Native fixture
comparisons explicitly apply that candidate tie policy; they do not claim a
defined original ordering among equal order IDs.

Internal role 1/user type 1 can include all stores and online orders. Other
operators remain assigned-store scoped. Franchise users must select assigned
franchise stores, even when their role is 1. This retains the source franchise
empty-selection result and closes the source's missing-assignment/direct-request
exposure. Writer-current active operator, role/type and assignments are checked
before external work, before contact enrichment and before returning data.
Revocation during the query denies the result. No SQL lock spans BigQuery work.

Historical facts are checked against the requested store/customer/order/date
scope before contact lookup. Restricted customer name/email/telephone fields are
masked with the existing source-derived functions after enrichment. Missing
current joined rows stay null, missing store names use `Online Orders`, inactive
questions stay visible and nullable question text stays null. Blocked/inactive
customer records remain historical dimensions; they do not authorize a sale or
customer login.

## Exact bounded email filtering

The source's `users.email = <value>` uses verified `utf8mb3_general_ci` and PAD
SPACE behavior. BigQuery `LOWER(raw_email)` does not reproduce accented or padded
matches. The primary reader therefore resolves matching customer IDs with one
bound native equality query, retaining the column's actual collation. Those
IDs, rather than the email or contact fields, enter the warehouse predicates.
The ID set is checked again after query work; a changed result returns a static
409 response so the operator can search again.

At most 500 email matches and 500 distinct current dimension IDs are accepted.
The equality lookup requests one extra row and returns
`CUSTOMER_FEEDBACK_DIMENSION_TOO_WIDE` when the bound is exceeded; it never
truncates matches or changes the predicate. Page size is at most 500. Customer,
store and question enrichment is batched once per dimension with bound IN
queries. A missing current question table is an explicit dependency failure;
the missing BigQuery copy of that current dimension is not a historical-fact
fallback or a reason to fabricate answers.

Source interpolation of email/store values is replaced by bound predicates.
Quote/injection-shaped input cannot widen a native lookup. No input email,
contact, feedback answer, SQL payload, token or raw SDK exception is logged.
The frontend binds each request to its captured operator and explains historical
replication lag/current dimension values without changing the report design.

## Cost and evidence

The actual raw dry run estimates **577,884,239 bytes**, below the unchanged
1,000,000,000-byte cap. It reads no source row payload. Every runtime request is
estimated before execution and retains the server byte/time limits; over-budget
work fails with `CUSTOMER_FEEDBACK_PROJECTION_REQUIRED`, without a MySQL fact
fallback. Removing the large raw customer join also avoids deploying guessed
warehouse collation functions or a missing questions copy.

`feedback-history-query-proposals.md` documents the observed index/cost evidence
and a review-only date-partitioned fact projection for further optimization.
Raw CDC can lag and does not establish a common snapshot with current dimensions;
this is an observed feedback display, not financial publication or an exact
as-of report.

Evidence is deliberately bounded:

- Fifteen native MySQL checks and eight service checks pass. The source SQL is
  obtained by executing the exact pinned datatable AST against an inert cursor,
  then executed on generated native fixture rows with verified physical types
  and collations. Counts/current-dimension output and paging are compared to the
  candidate. This is SQL/formatter-derived evidence, not full Django HTTP parity.
- Primary and authority fixture databases deliberately contain no orders or
  feedback tables. Successful searches and revocation checks therefore prove
  that the candidate does not use those databases for historical facts.
- Native fixtures include duplicate store rows, online/missing store/users,
  null/missing/inactive/current-edited questions, blocked customer dimensions,
  inclusive dates, feedback-date/order-date differences, franchise scope and
  email case/accent/PAD SPACE behavior. A 501-match lookup fails explicitly.
- `parity/evidence/feedback-history/query-plan.json` records local EXPLAIN
  estimates: native equality uses the verified existing `email` index with 2
  candidate rows; functional LOWER scans the 504-row fixture index. This is
  optimizer/index eligibility evidence, not live latency or new-index advice.
- `tools/operational-reports/validate-feedback-history.ts` executes ten actual
  BigQuery SELECTs containing generated CTE literals only. All ten match native
  fact totals/paging, with correctly serialized DATETIME/array parameters. It
  also records the raw metadata-only estimate. No live customer/feedback row,
  cloud DDL, UDF, copy/export or external write was performed.

Reproducible artifacts are in `parity/evidence/feedback-history/`. Native checks
use `MYSQL_INTEGRATION_URL=mysql://root@127.0.0.1/pos_rewrite_integration` (localhost
is also accepted), create only randomized
`pos_rewrite_feedback_history_{facts,primary,authority}_test_*` databases and
drop them afterward. Strict tests and direct-SDK tools are included in the
existing operational report tsconfigs.
