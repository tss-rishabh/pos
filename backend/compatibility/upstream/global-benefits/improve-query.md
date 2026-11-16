# Global wallet query candidates

The replacement already binds all values through Drizzle, locks the customer row, selects at most10,001 candidate earning rows and applies consumption/audit changes in batches of200. It avoids the source's one UPDATE per consumed history. A250-history native fixture crosses the SQL batch boundary and verifies every allocation and replay.

The source/modern earning selector filters `user_id`, `is_expired=0`, `added_amt>0`, then orders by `created_at,id`. Existing metadata shows individual indexes but no covering user/expiry/FIFO index. These nonunique candidates preserve row sets, source monetary values and frontend responses:

```sql
CREATE INDEX ix_tss_money_active_fifo
  ON tss_money_history(user_id,is_expired,created_at,id);
CREATE INDEX ix_tss_point_active_fifo
  ON tss_point_history(user_id,is_expired,created_at,id);
```

`added_amt>0` remains a residual predicate. Do not replace the source `is_expired` policy with an invented date predicate or change cent/FIFO arithmetic while tuning. Explicit ascending ID makes equal-timestamp consumption deterministic; response amount/balance/receipt remains unchanged.

Validate index choice, cardinality, write cost and bounded lock behavior with production-like isolated data/EXPLAIN before rollout. These statements were not applied to the supplied reader or production, and no production performance improvement is claimed from metadata alone. The rewrite-owned operation/audit indexes are included in migration0014; they do not alter legacy tables.
