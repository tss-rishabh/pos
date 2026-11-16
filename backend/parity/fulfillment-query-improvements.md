# Fulfillment query improvements

These changes preserve the selected frontend rows and values. No legacy indexes or data were changed. Apply any suggested index only after comparing its definition with live metadata and representative EXPLAIN results.

## Business-day expiry filters

The source uses `pending_expires_at__date=today` / `accepted_expires_at__date=today`, and the global monitor uses date comparisons on `pending_expires_at`. MySQL applies `DATE(column)`, which prevents the date portion of a composite index from providing the range bound.

```sql
-- Source predicate (example)
WHERE store_id = ? AND status = 'PENDING'
  AND DATE(pending_expires_at) = ?

-- Rewrite predicate; bind the business-local day and next midnight
WHERE store_id = ? AND status = 'PENDING'
  AND pending_expires_at >= ?
  AND pending_expires_at < ?
```

For MySQL DATETIME values, both predicates select exactly the same local-day rows, including fractional seconds and excluding NULL. The rewrite also preserves the source distinction between qualifying line statuses and the minimum expiry calculated across all store lines for an order.

Candidate indexes, only when no equivalent index already exists:

```sql
CREATE INDEX ix_eli_store_pending_day
  ON express_line_item (store_id,status,pending_expires_at,order_id);
CREATE INDEX ix_eli_store_accepted_day
  ON express_line_item (store_id,status,accepted_expires_at,order_id);
CREATE INDEX ix_eli_packed_audit
  ON express_order_status_log (order_id,new_status,store_id,changed_at);
```

`tools/fulfillment/explain-local.mjs` creates and drops its own randomly named local-only fixture database. On the local MySQL 8.4 fixture with 20,000 rows and the same covering index, the source and rewrite returned the identical 250 order IDs. The source used `ref` access with key parts `store_id,status` and estimated 2,000 examined rows; the rewrite used `range` access with key parts `store_id,status,pending_expires_at` and estimated 250 rows. This demonstrates sargability on that fixture, not a production latency claim.

Reproduce from `backend` with the explicitly isolated local integration URL:

```sh
MYSQL_INTEGRATION_URL=mysql://root@127.0.0.1/pos_rewrite_integration \
  node tools/fulfillment/explain-local.mjs
```

## Refund rows in a multi-store ledger

The cash snapshot retains the source `EXISTS` predicate so duplicate return rows never multiply a refund log. The multi-store current-day ledger performs two batched aggregate queries rather than two queries per store. Its refund join is to a distinct set of `(store_id,order_id,has_product_id)` return keys for the day, which is the same semi-join as the per-store EXISTS check.

```sql
SELECT r.store_id,SUM(a.refunded_amt)
FROM amount_to_be_refunded_log a
JOIN (
  SELECT DISTINCT store_id,order_id,has_product_id
  FROM return_orders
  WHERE store_id IN (...) AND created_at >= ? AND created_at < ?
) r ON r.order_id=a.order_id AND r.has_product_id=a.has_product_id
WHERE a.refund_mode='cash' AND a.is_refunded=1
GROUP BY r.store_id;
```

Candidate covering index if absent:

```sql
CREATE INDEX ix_return_store_day_refund
  ON return_orders (store_id,created_at,order_id,has_product_id);
```

Isolated MySQL tests include duplicate return rows and verify the source cash-refund total and ledger totals. Banking overrides and closed-day snapshots remain unchanged. Historical chains use configured warehouse contracts, so this optimization does not bypass the three-reader policy.

## Glassbox strict-mode compatibility

The copied source feed SQL selects non-grouped payment/store projections while grouping per HP ID. `strictFeedProjection` makes that original arbitrary-row behavior explicit with `ANY_VALUE`, preserving the source MAX refund aggregation. This allows `ONLY_FULL_GROUP_BY` without changing the original business predicates or forcing a production SQL-mode change. The source and rewrite query results and response builder are compared on an isolated fixture containing both return-query branches and a return for an older sale. Conflicting multiple active payment/store rows remain an ambiguous source-data case and require a separately agreed deterministic rule before stronger parity claims.
