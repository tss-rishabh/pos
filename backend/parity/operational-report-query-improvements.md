# Operational report database proposals

No live DDL or data write was executed. These proposals belong in the root `improve-query.md` review before deployment. Native measurements below use a guarded fresh local schema, synthetic rows and the saved read-only physical metadata.

## Flag-18 platform classification

Source: `HyperlocalAvailabilityReport.get_platform_count_by_id` in `report/views.py`. The source repeatedly calculates COUNT(flag_history) for each order to determine app versus web. The new scheduled adapter uses one bound EXISTS classification per eligible order, preserving duplicate flag behavior and reducing the distinct order set in one pass. Both predicates return the same boolean for zero, one or multiple matching flag rows; the source WHERE IN list already deduplicates order IDs. Availability's separate log counts remain separate. Groups that could exceed legacy GROUP_CONCAT's 100000-byte limit fail explicitly with `LEGACY_REPORT_RECONCILIATION_REQUIRED`, rather than silently reporting changed app/web totals.

Before predicate:

```sql
(SELECT COUNT(*) FROM flag_history f
 WHERE f.order_id = o.id AND f.flag_id = 18) > 0
```

Implemented predicate:

```sql
EXISTS (SELECT 1 FROM flag_history f
        WHERE f.order_id = o.id AND f.flag_id = 18)
```

Saved read-only metadata shows only single-column indexes on flag_history, including two order_id indexes. Proposed additive fix:

```sql
CREATE INDEX ix_flag_history_order_flag
ON tss.flag_history (order_id, flag_id);
```

This is a nonunique index: it does not remove or prohibit duplicate flags. Inspect existing production indexes before applying; do not drop source indexes without independent workload/foreign-key review. No response/calculation depends on this index's row order.

Reproduction from `backend/`:

```sh
MYSQL_INTEGRATION_URL=mysql://root@127.0.0.1/pos_rewrite_integration \
  npx -y node@24.22.3 tools/operational-reports/benchmark-flag-query.mjs
```

The tool rejects nonlocal hosts, creates/drops a fresh randomly named schema, recreates the verified source flag column types and all saved existing indexes, inserts 20000 synthetic flags and compares classification of 50 orders before/after the fix. Both responses have the same SHA-256 and classify 43 app orders. EXPLAIN ANALYZE reads 20 flag candidates per order before the fix (1000 total) and 0.86 matching covering-index rows per order afterward (43 total). The artifact is `evidence/operational-reports/flag-query.json`. These are local fixture row-access measurements, not live latency, production speedup or full data parity claims. Separate actual-source scheduled fixtures verify duplicate flags and eligibility counts.

## Other implemented query changes

Hyperlocal daily lifecycle timestamps now aggregate only displayed order/store pairs in bounded batches, while retaining all-history MIN per pair. The old full-table grouped derived relation is no longer computed for every page. Actual original SQL fixture equality is recorded in `hyperlocal-daily.md`. A candidate `(order_id,store_id,new_status,changed_at)` status-log index requires current index/workload inspection before any additive DDL is proposed as ready.

Flash-sales cash and Paytm amounts use eligible-order CTE aggregates and a batched store join. Source screen/export multiplicity differences and source ambiguous non-grouped store labels remain explicit in `flash-sales.md`; no production-plan label equality is claimed for ambiguous owners. The implementation does not silently alter the existing district/credit/quantity/refund calculations. Any further physical tuning must first reconcile those grouping ambiguities on approved production fixtures.

Cash-ledger balance calculation is unchanged. Its three independent historical warehouse reads now run concurrently after opening anchors are resolved; display filtering/pagination happens only after complete chain calculation. No new database index is asserted necessary from that scheduling change.
