# Correction ledger query access

Source handler: `order/views.py:687–775`, revision `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. The unsafe delete/arbitrary flag reset is replaced by the explicit compensation workflow documented in `parity/payment-reversals.md`; those behavior changes are intentional security/accounting corrections, not a query-only parity claim.

The rewrite's original payment outbox has a pending-worker index beginning `(status,created_at,id,kind)`. That index does not bound an order-only `FOR UPDATE` history read or an order/kind/delivered lookup. As completed jobs accumulate, using it for a correction can scan/lock unrelated jobs.

The additive rewrite migration supplies:

```sql
ALTER TABLE pos_rewrite_payment_outbox
 ADD INDEX ix_payment_outbox_order_state(order_id,kind,status,id);
```

The selected rows and frontend response are unchanged. The existing pending-worker index remains available. Native isolated EXPLAIN compares the indexed/unindexed result sets and checks `ref` access on the new index. This is a new rewrite table index, not a live source change.

The new managed-order financial reader is indexed `(store_id,order_date,order_id)` and movements are indexed `(store_id,business_date,id)`/`(order_id,id)`. Receipt lookup uses unique original-payment and cash-return UUID indexes. Compensation validation uses three bounded batches for up to 100 old attempts rather than per-attempt SQL queries. Monetary sums use integer cents and source keys remain exact decimal strings. Native fixtures check the day projection index with EXPLAIN and compare identical money/count results; no production query was run or altered.
