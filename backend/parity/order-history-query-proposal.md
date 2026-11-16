# Public order query proposals (review only)

Current public facts now have explicit source DATETIME bounds; historical facts never fall back to MySQL. The native query preserves original fields, left joins and OrderStore multiplicity, ordered deterministically by order/association ID. No tax/price arithmetic or Product availability predicate was introduced.

Check actual existing index definitions before applying either candidate; do not create duplicate indexes from column-level metadata alone:

```sql
CREATE INDEX ix_order_history_created_id ON orders(created_at,id);
CREATE INDEX ix_order_history_store_order_id ON order_stores(store_id,order_id,id);
```

The first bounds native facts to the selected current date. The second supports the scoped association join and compound pagination. Optimizer choice depends on store/date distribution; neither is forced by the application. The isolated physical-schema native test executes EXPLAIN FORMAT=JSON before/after these candidates and verifies exactly identical selected rows. Its small fixture establishes eligibility and response conservation, not production speedup. Use representative read-only EXPLAIN/workload acceptance before any production DDL. No production DDL or data writes were performed.

Historical deployment should use the date-partitioned header/store/line and integer-sharded publication layout in `tools/order-history/publication.review.sql`, then qualify actual bound dry-run costs under the existing cap. Headers/child dates derive from Order.created_at; scope shard uses exact scope_id modulo 1024. The point-read manifest/fact requests share one budget and frozen publication identity. Merely clustering the 21M-order/47M-HP raw tables, raising byte caps or declaring warehouse-derived source counts is not an accepted fix.
