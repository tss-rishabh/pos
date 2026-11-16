# Nine-column inventory workbooks

Implemented in the existing durable report-export lifecycle as `current-inventory-workbook` (XLSX). This is separate from the seven-column catalogue snapshot. No new route, SQL migration, queue or storage bucket is required.

## Pinned source and response contract

Source commit: `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. Exact source files/hashes and the six task/helper definitions are in [inventory-workbooks-source.json](inventory-workbooks-source.json). The real `process_export_master`, `generate_store_excel_chunk`, `merge_store_chunks`, `merge_all_stores_and_upload`, `debug_print_result` and `get_total_rows_for_store` functions execute in the isolated Python oracle with source-pinned openpyxl 3.1.2. Celery, SQL and storage are synthetic adapters; no source application is imported and no network is used.

The final headers are exactly `StoreName, ParentID, ChildID, Product, Erp Product, Variant, Category, Inventory, GTIN`. Selected stores retain request order, with a `Store_<id>` sheet for each store having candidate products. Stores with no candidates are skipped. A store with candidates but no final rows retains its empty sheet without a header, matching the source. Nonempty sheets contain exactly one header across page/chunk boundaries. Cells retain source scalar/null values and plain default Calibri 11 formatting; compressed ZIP bytes, timestamps and application metadata are not claimed to be byte-identical.

The source caller passes increasing chunk arguments 50000, 100000, ... . Its ordinary same-job chunk filenames therefore differ. Concurrent exports of the same store, duplicate store selections and the shared merged filename can collide across tasks/jobs. The replacement rejects duplicate selections and uses private UUID directories and opaque immutable object keys; it does not reproduce these filesystem collisions or silently skip missing chunk files.

## Source SQL semantics retained

Current inventory is a background **DATA-reader** report, with an explicit READ ONLY / REPEATABLE READ transaction. Its first SELECT establishes the shared inventory snapshot; all later pages use that snapshot. It has no date range or historical MySQL fallback. Report-history archive routing remains the existing BigQuery-only contract; no missing BigQuery publication is fabricated.

Candidates are product types 1/4/5 with an undeleted selected-store association. Global product availability/deletion and positive stock are not added as filters. Zero and negative stock remain visible. A parent needs an undeleted `product_store` association **in any store**, as in source. Missing parent/artist/store joins remove rows. Parent category excludes 162/148 and retains source 153-priority/order semantics. `has_options.attr_val` is **not restricted to Size**: the source attribute LEFT JOIN does not filter the option. Source Latin1 text is decoded using its actual column mapping; binary comparisons are used only for ambiguity detection. GTIN values remain exact stored integers.

Unused warehouse/attribute joins and the overwritten COUNT are removed. A bounded indexed keyset page replaces loading every product ID and every merged workbook into RAM. The two bound SELECTs per page replace cross-join multiplication; there are no per-row network queries. Equality of `p.id` and `ps.product_id` makes ordering/cursoring the signed physical association key equivalent for valid associated IDs and permits an ordered range index.

The source `GROUP BY p.id` can select arbitrary byte-distinct option/GS1/category-tie values. The new query first detects those distinctions and fails closed with a diagnostic such as “SKU 101 has conflicting variant values.” It never silently chooses Size, a first GS1, a case-folded variant, or a category tie winner. Duplicate byte-identical rows remain equivalent. This integrity refusal is explicit; arbitrary source outcomes are not claimed as parity.

## Deliberate bookkeeping and file-safety corrections

- Record the actual exported data-row count; the source writes `export_rows_count=0` even after computing its total.
- Complete an all-empty request with a `NoData` workbook. The source master otherwise returns without finishing the job.
- Write product/parent/GTIN IDs as literal strings so Excel does not round values beyond 15 digits. Source numeric-cell loss is demonstrated by the real oracle and cannot be reconstructed in already-written old files.
- Write all text as literal inline strings. Formula-shaped product/ERP/variant/category text remains visible text; the source openpyxl assignment can create formula cells. The oracle proves the original formula versus the corrected literal cell.
- Retain source 32767-character text truncation and reject illegal XML controls. Workbook rows, sheets, compressed bytes, expanded XML, page size, runtime and staging retention are bounded.

## Existing export lifecycle and security

The ordinary create/read/list/file routes and actor guards are reused. Request normalization preserves workbook store order and accepts only unique selected stores plus optional label/note; no fake report dates are sent. Writer-current operator, assignment and franchise-category authorization is rechecked at create, worker claim/lease renewal, storage reservation and download. A changed role/assignment/category cannot authorize a cached request. File contents are never logged.

BUILDING leases renew every 10 seconds and stop on authority/claim loss or shutdown. The worker writes a private 0600 spool beneath an owner-checked 0700 directory, streams it through zip.js, seals/fsyncs/checksums it, then uses the existing immutable conditional encrypted S3 PUT. The XLSX storage lease exceeds its bounded upload timeout. A lost PUT response remains STORING and is recovered by HEAD against the saved size/checksum without rebuilding or sending another PUT. Local artifacts are disposed after the attempt, and bounded UUID-only stale staging cleanup runs before builds. CSV defaults, byte content, key extensions and recovery behavior remain compatible.

Legacy XLSX files remain internal-administrator-only. A scoped `.xlsx` key and exact XLSX MIME are required. Before any file bytes are returned to the browser, a bounded private spool is checked for ZIP structure/counts/sizes/CRC and streamed through namespace-aware SAX/OpenXML validation. Encryption, macros, unknown package parts, external relationships, traversal, DTD/entities, formulas, defined names, unbounded tokens, unsafe extensions and incomplete relationships are rejected with `LEGACY_WORKBOOK_UNVERIFIED`. The exact ordinary source workbook is accepted. This certifies the accepted plain package subset, not every historical file; uncertain old workbooks require explicit safe reconciliation. Browsers validate MIME and stream-size limits, capture the initiating operator before awaits and suppress late downloads after identity changes. Downloads remain in-app attachments for web and Electron.

## Executed evidence

At this checkpoint the owned backend tests pass **34 cases**, including **16 native MySQL cases**, plus **13 existing CSV export/storage regression cases** (47 together). They cover actual source workbook merges, 50000/50001 candidate boundaries, SQL result equality on the verified physical schema, unfiltered Color options, category priority/exclusions, missing joins, wide IDs, ambiguity refusals, reader snapshots during concurrent updates, concurrent request deduplication, unknown streaming PUT/HEAD recovery, current authorization changes, heartbeat renewal, shutdown and safe legacy files. Three command/owner unit cases and five actual Chromium UI/download/recovery cases pass. Strict backend/frontend fixture configurations and focused lint pass. These are synthetic/local proofs, not production-data or live-upload acceptance.

The isolated 5001-product query-plan artifact is [inventory-workbooks-query-plans.json](inventory-workbooks-query-plans.json). An optional source-compatible covering-index candidate and its limits are documented in [inventory-workbooks-query-improvements.md](inventory-workbooks-query-improvements.md). No production DDL has been run and no production latency improvement is inferred from local cost estimates.

Deployment still requires configured private report storage, DATA-reader credentials/capacity, writable bounded private staging, and acceptance of actual reader replication lag and any source ambiguity diagnostics. Historical export metadata still requires its verified BigQuery publication (the discovered raw dataset lacks rewrite report-export tables). The separate dormant custom-date CSV/order-punch jobs remain outside this workbook slice.
