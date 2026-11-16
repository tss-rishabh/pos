# Workbook query improvements (review only)

Verified metadata: `evidence/mysql-inventory-workbooks-schema.json`. No live query, DDL, EXPLAIN or row reads were sent to the supplied reader for this slice. Physical schema/default/collation/index metadata was provided by the root read-only probe.

The pinned source loads every candidate ID and multiplies parent-store, warehouse, options, attributes and GTIN joins before grouping 50000 IDs. It also runs a COUNT whose result is overwritten by `len(product_ids)`. The replacement keeps the exact response for unambiguous source rows with two bounded, bound-parameter SELECTs per keyset page, removes the redundant COUNT and unused joins, and checks byte-distinct grouped output ambiguities explicitly. Changing the option to Size or selecting a first GTIN would change source responses and is not a response-identical optimization.

An optional covering index for the candidate page is:

```sql
CREATE INDEX idx_workbook_store_deleted_product
  ON product_store (store_id, is_del, product_id);
```

The currently named `idx_store_id_product_id_is_del` has verified physical column order `(product_id,store_id,is_del)`. Its name is not evidence of the proposed store-leading index. The row query already uses the verified unique `(product_id,store_id)` association and indexed options/GTIN/category product keys.

`tools/inventory-workbooks/explain.ts` creates a fresh randomized localhost schema from the exact metadata, restores its verified indexes, inserts 5001 synthetic products, captures JSON plans, adds this candidate **only in that fixture**, and verifies the before/after 250-ID page response is exactly equal. The artifact shows the candidate changing association access from an index scan (1249 estimated rows examined for the limited page) to a covering range scan (1000 estimated eligible rows in its range), with no filesort in either final query. Its local total cost estimate is slightly higher (463.88 versus 451.13); this is not evidence of lower production latency. Retain it as a review candidate and evaluate representative store/deletion distributions, writer index cost and actual execution plans before any deployment decision. The bounded reader/streaming changes do not require this DDL.

The optional index does not fix data ambiguity. Conflicting option/GTIN/top-category labels must be reconciled against intended source data; the application exposes a safe SKU-only diagnostic rather than changing the selected business value.
