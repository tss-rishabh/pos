# Catalog and inventory query proposals

All measurements below come from a new localhost-only synthetic schema, then dropped. No live rows, writes, indexes or DDL were used. Existing physical indexes and available per-column collations are recreated from saved read-only metadata. Artifact: `parity/evidence/catalog-details/query-benchmark.json`. Reproduce with Node 24: `MYSQL_INTEGRATION_URL=mysql://root@127.0.0.1/pos_rewrite_integration node --import tsx tools/catalog-details/benchmark.mjs`.

The source parent-product datatable joins categories, selected stores and membership-location prices before grouping, transfers every matching product, repeats the query for search and paginates in Python. Its unused `get_product_stores` enrichment adds a further query. The rewrite counts products through `EXISTS`, materializes only page IDs before enrichment, and computes independent DISTINCT category/store aggregates. Aggregate sorts compute only their requested sort key before paging. Bound patterns retain the source raw-datatable wildcard/quote behavior; the separate stock matrix uses escaped ORM `icontains` patterns. Price ambiguity is detected rather than silently selecting a different location price.

In the 2,000-product, eight-store, 24-category, two-equal-price-location fixture, source EXPLAIN joins/sorts 768,000 rows and transfers 2,000 result rows. The rewrite materializes 25 IDs, enriches 25 products and transfers 26 rows including the count. Canonical first-page responses have identical SHA-256 hashes. Local samples before the final collation replay were approximately 1,612–1,673 ms for the source and 9.4–10.1 ms for count plus page; the artifact is authoritative for the latest replay. These are local fixture measurements, not production latency claims. No new index is needed for this rewrite: existing product parent/type and product-store/product-category keys are reused.

The verified inventory-audit tables have individual product/user indexes but lack a covering product/store/date key. Candidate DBA changes:

```sql
CREATE INDEX ix_product_inventory_scope_date ON pos_product_inventory_logs(product_id,store_id,created_at,id);
CREATE INDEX ix_held_inventory_scope_date ON pos_hold_stock_logs(product_id,store_id,created_at,id);
CREATE INDEX ix_storage_inventory_scope_date ON stock_storage_logs(product_id,store_id,created_at,id);
```

For 40,000 synthetic product-audit rows, the original count examines 40,000 product-index candidates to find 333 scoped/day rows. The proposed product-audit index examines those 333 rows through a covering range scan, with identical count and page response hashes. Its local count EXPLAIN changed from approximately 25 ms to 0.1 ms before final replay. The ID-sorted 25-row page still chose its existing product index and examined 3,000 rows; no page-query speedup is claimed. Held/storage index proposals share the predicate shape but are not separately benchmarked, so DBA review must validate their distribution, write/storage costs and chosen plans before deployment. Do not drop existing indexes as part of this proposal.

The old stock datatable loads deleted-parent lists in Python and repeats per-SKU ERP lookups. The new matrix uses anti/semi-joins, paginates in SQL, joins parent ERP once and fetches scoped store dictionaries in one bounded page query. Its 18 source-body fixtures prove response/search/sort behavior; this checkpoint does not claim an additional matrix latency benchmark.

Keep source `GROUP_CONCAT` connection limits/collations consistent when comparing the legacy response. Do not replace truncated or ambiguous legacy groups with invented totals/values. Production parity certification requires the actual reader settings and representative production-shape plans, while historical audit queries require configured BigQuery source-compatible views/UDFs without a MySQL fallback.
