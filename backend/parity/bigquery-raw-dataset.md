# Authorized raw BigQuery dataset discovery

The user authorized strictly read-only discovery of
`tssgcp2025.tss_mysql_raw_layer` in `asia-south1` using the supplied reader service
account. The SDK receives the key path through the process environment. No key
contents, credentials or customer rows are included in these artifacts. No DDL,
UDF/view creation, export, extract or external write was executed.

## Saved evidence

- `evidence/bigquery-schema.json`: 220 table schemas, routine inventory,
  `INFORMATION_SCHEMA.TABLES` CDC watermarks and selected `TABLE_OPTIONS`.
- `evidence/bigquery-source-coverage.json`: structural comparison against 106
  source-verified MySQL table schemas, including the inherited-auth snapshot. 71 exact `tss_` name/column candidates are
  present; 35 source tables are absent. This comparison does not establish row
  equality or publication consistency.
- `tools/operational-reports/discover-bigquery.ts` and
  `map-bigquery-source.ts`: bounded reproducible metadata-only tools. Artifacts
  are published with atomic rename. Error outputs contain static codes, not SDK
  requests, credentials or raw exception messages.

The first snapshot listed 217 tables; a subsequent snapshot listed 220. Recent
table creation timestamps identify externally changing return-courier/zone
tables. These snapshots are observations of a live dataset, not an atomic
source-schema migration barrier.

## Observed structure

Every listed object is a table; no views or routines were listed. Physical names
use a `tss_` prefix, for example `tss_orders`, `tss_has_products`,
`tss_order_stores`, `tss_stores`, `tss_pos_user`, `tss_users` and
`tss_user_stores`. Core IDs are BigQuery `INTEGER`, money columns such as
`orders.pay_amt` and `has_products.price` are `FLOAT`, and the examined source
creation/update/time-slot columns are `DATETIME`. Do not reinterpret these
wall-clock fields as UTC timestamps without an explicit source-time contract.

Core tables declare primary-key columns and have a
`datastream_metadata STRUCT<uuid STRING, source_timestamp INTEGER>`. This shape
is consistent with Datastream merge mode; it is not independent verification of
the live stream configuration or complete backfill. Datastream documents
different metadata and deletion behavior for merge and append-only tables.
[Datastream destination documentation](https://docs.cloud.google.com/datastream/docs/destination-bigquery)

No explicit field/default collation was observed. A default BigQuery string
comparison or `und:ci` replacement is not proof of equivalence to verified
MySQL `latin1_swedish_ci`, `utf8mb3_general_ci`, `utf8mb3_unicode_ci` or
`utf8mb4_general_ci`. Existing source collation gates remain necessary where a
query depends on those semantics. No UDF was created to bypass that limitation.

## Freshness and consistency limits

214 tables, including orders, HPs and stores, explicitly declare
`max_staleness = 0-0 0 1:0:0` (one hour). Per-table apply watermarks differ; they
represent apply progress rather than a source transaction/publication ID. A
runtime merge does not advance that metadata watermark. A quiet table's old
watermark alone does not establish that its data is stale, and a recent
watermark does not certify a consistent cross-table financial publication.
[BigQuery CDC documentation](https://docs.cloud.google.com/bigquery/docs/change-data-capture)

Datastream documents `source_timestamp` as the source change time in UTC epoch
milliseconds. The schema alone establishes its integer type, not a publisher
heartbeat or the completion of a multi-table report generation.
[Datastream event documentation](https://docs.cloud.google.com/datastream/docs/events-and-streams)

No publication-generation/CDC manifest table was identified by inventory, and
none of the existing daily-report publication/row-hash contracts is established
by this discovery. Missing or empty raw tables must not be interpreted as
verified empty financial report partitions. Historical requests retain the
BigQuery-only rule; there is no MySQL history fallback.

## Source gaps that affect activation

| Family                                                 | Observed result                                                                                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core sales/orders/HPs/stores/operators/customers       | Corresponding `tss_` tables exist; exact columns are in the coverage artifact                                                                      |
| Day close, banking, opening balance/cash out           | `store_day_close`, `store_day_banking`, `store_cash_opening_balance` and the new rewrite state are absent                                          |
| POS inventory/held/storage audit                       | Specific `pos_product_inventory_logs`, `pos_hold_stock_logs`, `pos_inventory_sync_log`, `stock_storage_logs` and storage tables are absent         |
| Other stock data                                       | `tss_hold_stock_store` and `tss_products_inventory_logs` exist; the latter is a different audit source and is not a substitute for absent POS logs |
| Feedback                                               | `tss_nps_feedback` exists; source `nps_questions` is absent                                                                                        |
| Gift batches and inherited administration history      | `gift_card_collection`, `django_admin_log` and `auth_user` are absent; `tss_pos_user` and `tss_django_content_type` exist                          |
| CSV imports, documentation, special-permission history | Required source and rewrite tables are absent                                                                                                      |
| Legacy export metadata                                 | `tss_export_reports` and `tss_report_exports` exist; existing current download authorization/private storage rules still apply                     |
| Offline cash and new rewrite history                   | No `pos_rewrite_*` tables are listed. Their absence is not proof of zero accepted receipts or imports after a future cutover                       |

Two observed source tables also lack a verified MySQL column:
`extend_applicability_for_return_exchange.has_product_id` and
`product_rating_user.has_product_id`. Readers that need those links cannot
silently replace them with `NULL` or broaden the query to a whole SKU/order.

Raw adapters can now bind actual qualified tables and validate explicit
projections with read-only dry runs. Deployment still requires the missing
tables, source/CDC/publication evidence and any needed collation contract; a
successful schema query is not whole-source or production parity certification.

One source-specific exception to copying a missing dimension is established:
the feedback report joins `nps_questions` only to display current text, without
question/date/activity filtering. Its historical adapter now reads BQ facts and
uses bounded current primary question/customer/store lookups. Native email
equality preserves source collation without a warehouse LOWER substitute. This
does not read historical MySQL feedback facts or relax other publication gates.
See `feedback-history.md` for native/generated-BQ evidence and the measured raw
query budget.

`bigquery-deployment/` contains the generated exact source-schema/input plan,
a reviewed nonfinancial legacy-export SELECT projection, proposed financial
publication schemas and a deployment/acceptance sequence. Its SQL is not
applied. `bigquery-raw-projection-validation.json` records a successful actual
raw schema dry run and three synthetic-literal SELECT cases; no live source row
was selected. This is separate from financial/offline cash conservation and
does not activate the configured archive readers.
