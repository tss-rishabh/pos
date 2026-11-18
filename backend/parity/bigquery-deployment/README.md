# BigQuery deployment review

This directory is a **local review package, not an applied migration**. The
authorized account can read the existing raw dataset and run query jobs. It
must not create datasets, streams, tables, views, functions, extracts, scheduled
queries, exports or IAM changes. No such action was executed.

The observed source is `tssgcp2025.tss_mysql_raw_layer` in `asia-south1`.
`tssgcp2025.pos_reporting` is a proposed separate reporting dataset, requiring
explicit infrastructure approval and a different deployment/publisher identity.
No artifact assumes that proposed dataset exists. No credentials are included.
The supplied reader grant covers `tss_mysql_raw_layer` only. Example relations
under `pos_reporting` require an additional approved reader grant; that grant
has not been requested or applied by this package. An approved publisher may
instead deploy separately prefixed curated tables in the existing authorized
dataset and configure those exact relation names.

## Artifacts and exact source facts

`plan.json` is reproducible with
`tools/operational-reports/build-bigquery-deployment-plan.ts`. It contains:

- Every verified `tss` MySQL source table/column type, nullability, default,
  physical collation and primary-key flag, with its metadata artifact/hash.
- Observed raw table/column matches, and factual absence in the saved warehouse
  inventory. Missing tables are not replaced by similarly named resources.
- Every `BQ_*`/`BIGQUERY_*` input referenced by the current server modules and its
  consumer files. These are contracts, not automatic raw-table aliases.
- All deterministic rewrite migrations/checksums and the tables they create,
  including offline receipt/proof and import/report state that is not deployed
  into the observed warehouse.
- Financial conservation rules and the separate inherited-admin-log actor
  namespace/provenance requirement.

The latest comparison has **106 verified source tables, 71 observed raw
candidates and 35 absent tables**. `auth_user` was added from the separately
verified inherited-history snapshot. Two other present source tables lack a
required HP-link column. Saved discovery is an observation, not an atomic
pipeline schema barrier.

The exact inherited log FK is
`tss.django_admin_log.user_id → tss.auth_user.id`; it does not establish that
the current `users.PosUser` writer uses that namespace. `mobile_cms.django_admin_log`
was discovered as a visible location, with no proven ownership by this POS.
The location evidence is `mysql-admin-shipping-schema.json` and
`mysql-auth-history-schema.json`. Do not join a mobile CMS grant/user table or
substitute `tss_pos_user` for the inherited actor. Establish the operational
database, router, configured auth model and FK lineage first. The history view
needs only actor ID/username/first/last name; password/contact/privilege columns
must not be published for that purpose.

## Nonfinancial projections

`legacy-report-export-projection.sql` is an executable **SELECT**, using the
actual observed `tss_report_exports` schema. It maps completion/status
precedence, empty-name fallback, exact string IDs, source KiB sizes and terminal
wall-clock fallback to the existing archive DTO. It excludes private file URLs,
source messages, arbitrary period JSON and contacts. This is a reviewed
projection for a publisher or CTE; it does not activate the archive reader.

`evidence/bigquery-raw-projection-validation.json` records a successful raw
query **dry run** and an actual BigQuery SELECT over three generated synthetic
fixture rows. It proves SQL/type handling, 64-bit string identities, flag/status
precedence, byte arithmetic and DATETIME fallback. No live source row was
selected. A dry run does not establish data completeness or search/sort
collation parity. The existing archive route retains writer-current owner/role
checks and protected private-file authorization.

For other nonfinancial views, use the exact field/join contracts in the consumer
files and existing parity maps (`catalog-details.md`, `operational-reports.md`,
`staff-performance.md`, `scheduled-reports.md`, `report-exports.md`, and the
administration maps). Several inputs cannot be built from the current raw
dataset: POS held/product/storage audit, slots, inventory-import state,
documentation, inherited logs and gift batches require
their missing source tables or minimal normalized publications. A similarly
named stock or voucher table is not their source.

Historical feedback now uses the actual raw feedback/order/store-association
facts plus bounded current primary question/customer/store dimensions. The
source question join is display-only, so absence of `nps_questions` in BigQuery
does not require a historical MySQL fact fallback. Native email equality retains
the verified source collation and supplies bounded customer IDs; contact text
does not enter warehouse predicates. `../feedback-history.md` and its query
proposal document 23 focused checks, 10 actual generated-literal BQ cases and a
577,884,239-byte metadata estimate under the existing cap. An optional curated
facts projection is review-only and uses a separate prefix in the existing raw
dataset; no DDL or raw source-row execution was performed.

Customer behavior history has a separate executable reader and review package in
`../customer-history.md`, `../customer-history-query-proposals.md` and
`../customer-history-projection-review.sql`. Its actual raw dry-run estimates
exceed the unchanged 1 GB budget. Four proposed customer-bucket fact projections
provide partition predicates while preserving source store/HP multiplicity;
the current products dimension remains explicit. Ten native-derived generated
BigQuery layout cases and their item/return continuations pass without selecting
source customer rows. No proposed projection was deployed, no byte cap was raised,
and source float encoding/update/delete/current-dimension propagation still need
post-deployment acceptance. The NPS-only input strips narrative tails and must
not replace a general feedback report.

String filtering/grouping/order must preserve the verified per-column MySQL
collations and null/padding rules. BigQuery default comparisons and `und:ci`
are not certified substitutes for Latin1 Swedish, General CI or Unicode CI.
Review and validate the named matching/weight UDF contracts where required;
none was deployed with the read-only account. Preserve native source join
multiplicity, decimal/float conversions and business wall-clock DATETIME.

## Financial and offline cash publication

Raw orders/HPs/order-store tables exist. Banking, opening balances, day close and
rewrite offline cash/proof tables are absent. A recent per-table CDC watermark
does not prove a consistent cross-table snapshot, and one-hour `max_staleness`
does not satisfy the daily-report publication contract. Empty raw results do not
prove zero accepted receipts or zero outflows.

`daily-publication-review.sql` provides concrete proposed table schemas matching
`src/modules/daily-report-warehouse.ts`. It is not executed. Before publication:

1. Establish one source snapshot using the same read-only repeatable-read SQL
   as the current-day path, including source sales, accepted offline cash,
   sealed import proofs/link/key registry, banking/opening/close/outflow inputs.
   A CDC publisher may substitute only if it proves the same source transaction
   boundary across every input, complete backfill and delete handling.
2. Verify immutable signed receipt business date and payable amount. Recognize
   accepted/conflicted/importing/imported receipts once. Revocation, late arrival
   and source order return/status changes cannot erase physically received cash.
3. Verify sealed import proof and exact order/link ownership before replacing
   ordinary cash and logical order count. Keep imported mutable HP revenue,
   quantity and status behavior in the source sales projection. Surface pending
   offline order count where HP metrics are unavailable. Never synthesize them.
4. Preserve source float/arithmetic and join multiplicity. Use the pinned source
   baseline/SQL hash in the reader contract. Do not recompute financial truth
   using a convenient but unproved raw join or incomplete row subset.
5. Produce immutable generation rows for each authorized store/date/source and
   native row hashes using the exact expression in `plan.json`. Produce a
   manifest for **every** requested store/date partition, including explicit
   zero-row partitions. Zero, one or two source rows must agree with its manifest.
6. Publish the complete generation's manifests with a single source position,
   verified source progress, business timezone, contract, source baseline/hash
   and publication timestamp. Readers reject mixed generations, row/hash/count
   mismatches, future/stale timestamps, missing partitions or missing contracts.
   Do not publish `COMPLETE` before all required rows/proofs are durable.
   The source daily screen adds one minute before formatting its ending date.
   At business time 23:59 it therefore requests the following date as well.
   That partition must be published from the **same** generation/source position,
   including any actual forward-dated facts or an explicitly verified zero-row
   manifest. Its business date may be tomorrow; publication/watermark timestamps
   still obey the existing clock-skew/freshness rules. Never invent an empty
   future partition or supplement this financial report with a different DATA
   snapshot. Missing upcoming-day coverage retains the explicit unavailable result.
7. Validate late offline receipts against closed days: the current writer marks
   the latest close stale while retaining frozen figures. Historical publication
   must refresh the affected day and conserve its cash. A later generation can
   supersede an old one; existing generation rows stay immutable.

The cash ledger has additional source-compatible view contracts in `finance.md`
and `daily-report-offline.md`. Reconciliation, refunds and cash outflows remain
separate from incoming receipt cash. The reader account never authorizes or
performs a financial mutation.

## Deployment sequence and acceptance

1. Review the missing-table/column list, default/mobile CMS lineage, source
   timezone, CDC schema/backfill/delete behavior and allowed publication columns.
   Create only the minimal restricted inputs needed by the actual consumers.
2. Have an independently authorized infrastructure identity deploy the approved
   dataset/stream/views/functions/publisher. Keep the reports account read-only
   and avoid broad raw contact/token/credential replication for metadata views.
3. Run source-versus-warehouse differential fixtures against native collation,
   source arithmetic, duplicates, nulls, archived actors and 64-bit identities;
   verify empty partitions, delayed CDC, incomplete publication and failover.
4. Run the financial conservation/late receipt/import/return/day-close scenarios
   and prove source progress and hashes for one full publication generation.
5. Set the existing validated normalized relation/UDF/contract options only after
   that evidence is approved. Source metadata presence, successful dry runs and
   setting an environment variable are not acceptance evidence by themselves.
6. Run the project deployment/readiness checks with production authentication
   and restricted roles, then verify historical browser flows and protected
   downloads. There is no MySQL historical fallback if any required input fails.

Missing publication/transport inputs are data-pipeline deployment requirements,
not blanket code parity certificates. This package does not grant the reader
account write permission or apply anything to the live environment.
