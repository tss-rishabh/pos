# Order-list database proposals

Review only; no live DDL/writes. Source fields/counts/multiplicity stay unchanged. The isolated native test creates each candidate index, compares identical query rows before/after, then uses representative EXPLAIN to verify index eligibility. Small synthetic fixtures establish syntax/equality, not production latency.

```sql
CREATE INDEX ix_pos_order_date_id ON orders(created_at,id);
CREATE INDEX ix_pos_order_store_lookup ON order_stores(order_id,store_id,id);
CREATE INDEX ix_pos_store_order_lookup ON order_stores(store_id,order_id,id);
CREATE INDEX ix_pos_terminal_order_platform ON pos_terminal_transactions(order_id,is_active,platform,id);
CREATE INDEX ix_pos_paytm_order_platform ON pos_paytm_transactions(order_id,is_active,platform,id);
CREATE INDEX ix_pos_hl_unpacked ON hyperlocal_order_log(order_id,action,is_pack,is_rto,is_refunded);
CREATE INDEX ix_pos_express_store_order ON express_line_item(store_id,order_id);
CREATE INDEX ix_pos_hp_order_status ON has_products(order_id,id,status);
```

Compare saved existing indexes and actual plan/cardinality before choosing nonredundant candidates; date-range and ID ordering may require a filesort. Do not promise every index is optimal on production. Separate any-store and selected-store joins are intentional: replacing them with one join/DISTINCT changes source row counts. Provider/HP/store enrichment is batched for the selected page (seven SELECTs for normal ST, optional phone probe and location dimensions), replacing the original per-row helper queries (the11-row synthetic source page executes over100). It shares one native RR READ ONLY transaction. Queues retain explicit membership revalidation; optimizing history must not move old header facts back to PRIMARY.

For historical searches, deploy the reviewed thin date/scope index plus immutable sharded payload/publication contract in `tools/order-search/publication.review.sql`. Raw order/HP ID clustering cannot be treated as a cheap complete source-filter index. Runtime dry-run budget and complete publication/hash checks are mandatory even for zero matches. Contacts use private MySQL-weight HMACs, preserving frontend-visible comparisons without publishing raw phones/emails or applying incompatible warehouse Unicode folding.
