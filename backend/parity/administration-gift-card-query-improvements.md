# Gift-card batch query improvements

Source list performs repeated counts, fetches a page, then fetches creators separately. The replacement uses one consistent read-only count plus one bounded LEFT JOIN page, selects no filenames/archives/secrets, and preserves exact IDs and source full-name trimming. Paging fallbacks and filtered total contracts are checked against pinned Django on isolated MySQL. Current-day reports use the data reader; all historical requests use BigQuery. Live collection mutation authorization remains writer-consistent.

The source search is not a valid query optimization target: it raises `FieldError` for every nonempty term. The corrected actual-field search is explicitly a behavior repair, documented separately, and is not advertised as response-identical query tuning. Leading-wildcard search cannot use a conventional B-tree seek; day scope and reader time/size bounds limit MySQL work.

Fresh physical metadata shows no `created_at` index on `gift_card_collection`. Review this writer-side candidate (do not execute it against the supplied reader):

```sql
ALTER TABLE gift_card_collection
  ADD INDEX ix_gift_card_collection_created_id (created_at,id);
```

It supports the current-day interval scan without changing rows or response values. Confirm the operational writer's current index set, table size, EXPLAIN ANALYZE for representative date/sort/page combinations, DDL lock/online behavior and write cost before application. No live DDL or production latency result is claimed. Offset pagination is retained for source arbitrary-page semantics; extremely deep historical pages run in the warehouse rather than primary MySQL.

Rewrite current-job reads use the actor/creation index and a25-row limit; worker scans use phase/lease/creation indexes and a25-candidate bound. Archive blobs and sealed secrets are absent from polling/list projections. The BIGINT/VARCHAR job-to-collection join casts the job identifier to SIGNED explicitly, avoiding mixed numeric-string DOUBLE comparison. Actual collection status mutations lock the physical primary key; they neither update voucher rows nor infer undeclared financial references.
