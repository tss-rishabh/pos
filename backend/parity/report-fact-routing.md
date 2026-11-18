# Report fact-range routing audit — 18 November 2026

This correction applies the reader policy to the facts a source query actually
uses, rather than assuming that a UI date bounds every joined event. Interactive
current state and authorization remain on PRIMARY/writer. A report wholly within
the current business day uses DATA only for genuinely bounded fact cohorts;
older/mixed or undated historical facts use BigQuery. There is no historical
MySQL report fallback.

| Family | Current-day fact route | Historical/mixed route |
|---|---|---|
| DSR, feedback, cashier/salesperson performance, acceptance | Existing DATA fact cohort; current names/questions/access remain PRIMARY dimensions | Existing BigQuery contracts |
| Combined order transactions, order-date basis | DATA for the selected source sale cohort | BigQuery |
| Returned-orders and combined transactions, return-date basis | BigQuery: return date does not bound original Order/HP/refund fact age | BigQuery |
| Hyperlocal daily and date-selected fulfillment monitoring | BigQuery: pending expiry does not bound original Order/HP values or lifecycle logs | BigQuery |
| Scheduled hyperlocal timing | BigQuery: accepted log time does not bound original order creation time | BigQuery |
| Scheduled hyperlocal summary | Route the actual preceding-day-to-end order window; today's summary requires BigQuery | BigQuery |
| Scheduled availability/platform/delays/conversions and CRM candidates | Existing DATA for bounded current-day fact cohorts; store/slot configuration is PRIMARY | BigQuery; CRM mutation authority is independently rechecked on the writer |
| Finance reconciliation and flash sales | DATA sales plus full original return/refund query on BigQuery | Both components on BigQuery |
| Cash ledger display | DATA only with today's anchors and a same-RR-snapshot empty current-return cohort | Complete authenticated warehouse generation, also required for current-day return cohorts |
| Day-close history / completed export history | Existing bounded current DATA / operational queue metadata policy | BigQuery; COUNT must supply an actual valid row |

Source predicates, joins, float rounding, duplicate multiplicity, refund buckets,
paging and DTOs remain unchanged. In particular, flash-sales refunds still use
return/refund dates and retain order-store attribution, while its sale cohort
uses the order date. The source's refund-only groups remain absent if there is no
matching sale group. The two components retain the existing two-query aggregation
semantics; splitting readers does not create a common-snapshot guarantee. DATA
replication and compatible-view completeness/freshness must be qualified for
deployment. These report views are not silently promoted to the stronger
authenticated financial publication contract.

For ledger display, a bounded current ReturnOrder existence query can establish
that the full warehouse chain is required without reading older refund amounts.
When the initial routing check finds no returns, the DATA repeatable-read
transaction rechecks the cohort before aggregating. A return appearing before
that snapshot yields `LEDGER_HISTORY_REQUIRED`; refresh requires the complete
current-day publication. A return committed after that snapshot is outside that
consistent observation and is visible on the next refresh. The native no-return
path never executes an undated refund-log query. Its zero source-return amount
comes from the actual empty cohort, with immutable cash-reversal outflow still
included. Financial `collectionSnapshot`, close authorization and money mutations
continue to use writer-consistent native proofs.

Ungrouped warehouse COUNT queries require exactly one row and a non-null safe
nonnegative integer. Missing rows, NULL, booleans, unsafe counts or multiple rows
fail `REPORT_VIEW_INVALID`; an authenticated query result containing zero remains
zero. Grouped status counts may legitimately omit an absent group.

No new environment variable, schema or migration is introduced. The existing
returned-order, combined-order, hyperlocal, monitoring, scheduled, finance and
flash-sales BigQuery mappings are now necessary for these current-day historical
joins too. Missing mappings and failed queries are explicit failures. The ledger
also requires its existing complete generation, offline-cash contract, correction
partition/control proofs and current-day publication. Source windows are bound,
report ranges retain their existing maximums, complete output is capped at
70,000 input rows, and the shared SDK sets `maximumBytesBilled` and a ten-second
job timeout. Those limits can reject an expensive all-history join; predicates
are not removed and native history is not substituted to make it pass.

Local validation uses guarded disposable native schemas and the actual pinned
Django source SQL/reducers. Warehouse fixture ports consume independently
executed literal source queries or native captured projections; the application
does not obtain a native history fallback. Monitoring executes its full warehouse
join projection with only isolated MySQL dialect substitutions. This is source
fixture/routing evidence, not live BigQuery view publication, cost, freshness or
full feature certification. No production rows, providers or source writes were
used.

Validation checkpoint: 30 scoped unit/source checks and 51 unique native checks
across the nine affected report/finance/monitoring fixture files passed. A separate
filtered run of the existing native payment-reversal ledger case passed (the
other 54 cases were intentionally outside that run). Changed TypeScript source
and fixtures pass strict checking and ESLint. The native fixture URL is
`MYSQL_INTEGRATION_URL` on a disposable localhost instance; the existing reversal
fixture uses `CHECKOUT_MYSQL_TEST_URL` with path `/pos_rewrite_checkout_test`.
No shared/full-project verifier or production warehouse query was run here.
