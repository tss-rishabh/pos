# Model history query candidate

The verified `django_admin_log` has indexes on its primary key, content_type_id and user_id. Object-specific daily history filters the content type, LONGTEXT object_id and DATETIME(6) action_time, then orders by action_time/id. The API already uses a bounded page and a single actor join, retaining exact source text collation and wall timestamps.

Proposed database change for review on the accepted operational log source:

```sql
CREATE INDEX ix_pos_admin_history_object_day
ON django_admin_log (content_type_id, object_id(191), action_time, id);
```

Keep the full `object_id = ?` predicate; the prefix index must never replace source text equality or cast IDs to numbers. Preserve native latin1_swedish_ci padding/collation. This index changes access paths, not selected rows or frontend values. Source object IDs used here fit within191 characters; index size and online-DDL support must be checked on the accepted source engine/version. No production DDL, live EXPLAIN, benchmark or optimizer selection is claimed. Apply only after representative source/rewritten response comparison and before/after EXPLAIN/latency verification. Historical requests remain on BigQuery; this candidate does not authorize a historical MySQL fallback.
