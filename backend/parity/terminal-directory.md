# Payment-terminal directory implementation

Pinned original: `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.
`core/templates/edc_edit/edc_detail_and_edit.html:275` exposes provider selection,
13 data columns, page lengths 10/25/50/100/500, visible-column CSV, an all-row
CSV action, column visibility and reload. The previous replacement rendered
only terminal/provider/counter/status plus edit/delete, omitting these controls.

The replacement now uses `POST /api/v1/admin/payment-terminals/search` and
`frontend/src/pages/administration/terminal-directory.tsx`. It keeps existing
create/edit/delete dialogs, adds the missing non-secret data columns and
provider selection, and reuses the catalog table's column selector, safe CSV
encoder and pagination. Both CSV actions follow the selected columns; the
all-matching variant reads bounded 500-row pages, refuses above 70,000 rows or
32 MiB, aborts on unmount, and refuses changed result counts or incomplete pages.
It creates no financial command, provider request or write operation.

The selected-store view remains the initial scope; all-permitted-stores restores
the original cross-store directory for an authorized global manager. Restricted
operators see only their current native store assignments (and franchise
category where applicable). Writer authorization locks span the primary-reader
query. Search values stay in a private POST body and are bound through Drizzle;
sort names, provider, pagination and store IDs are validated. Provider tables
are filtered by store before the union, replacing original full table loads
and per-machine counter/store queries. Count and rows are separate bounded
queries; no deployed performance benchmark or query-plan acceptance is claimed.

The original `core/datatables/edc_details_datatable.py` puts Paytm
`merchant_key` in `merchant_id` and includes Pine `security_token` in JSON.
The rewrite deliberately excludes both credentials from every directory DTO
and CSV. Paytm's displayed merchant identifier is its non-secret MID; the
existing editor continues to accept credentials only as write-only fields.
Terminal mutations now also recheck current role/store authority under native
locks before changing terminal configuration, including destination stores.

This is implementation evidence, not parity certification. The integrated
backend and frontend strict programs compile. Focused native and browser checks below establish their stated fixture behavior;
performance and the consolidated project gate remain separate.
No live database, terminal, payment provider or production deployment was used.

Validation found and fixed a native union defect: provider text columns using
different utf8mb4 collations produced `ER_CANT_AGGREGATE_NCOLLATIONS`. Directory
projections now explicitly convert their non-secret strings to utf8mb4 with
`utf8mb4_unicode_ci` before union/search/sort. This preserves the Unicode text
and exact serial-number strings; it neither projects nor converts credentials.
Base terminal metadata does not record deployment column collations, so the
mixed-collation fixture is compatibility evidence, not a claim that those are
the deployed collations.

Six focused native MySQL8.0.39 cases pass: actual two-provider SQL, duplicate IDs
and provider paging, escaped search/strict inputs, current role/type/assignment
revocation, mixed collations/Unicode, and native terminal mutation refusal with
retained credentials. They use source-verified physical table types in a new
disposable local schema. No payment provider is called. Focused strict typing
and lint pass.

Two focused Chromium checks also pass against the actual React page with isolated
API fixtures: existing edit/delete preserves exact bigint serials and blank
credential inputs; visible-row/full-result CSV follows hidden columns, escapes
formula cells, exports all 503 rows through two bounded requests, and refuses a
changed result count without downloading a partial artifact. These browser
fixtures prove UI behavior, not deployed SQL connectivity or stable snapshots
when source rows change without changing counts.

Ten administration native cases cover sorted cursor binding, archived/Unicode
rows, current scoped authority, selected-store detail/PNG, bounded safe CSV, and
registered export admission through the real builder with unknown-ACK recovery
and revoked download denial. Four further browser checks cover collection
controls, selected-store QR, operator assignment and guide read/download.
