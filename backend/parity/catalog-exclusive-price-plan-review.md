# Selective membership-price sort: read-only plan review

No application query, index, physical column, source handler or response changed.
The complete paired benchmark found broadly similar costs for this case
(source/service p95 70.29/70.86ms); this is no statistically established regression
or improvement. All216 samples remain in the published benchmark artifact.

## Observed workload and estimated plans

Native measurement counters consistently recorded59,228 rows examined/997 sent
for the source and35,640 examined/34 sent for the candidate service. HTTP added
the expected authentication reads. These are actual aggregate per-invocation
counters; they do not identify each statement's elapsed time.

Six `EXPLAIN FORMAT=JSON` plans were then collected on a separate owned
MySQL8.0.39 mixed fixture with the same2,000 products and associated stock,
category/price rows, indexes, collations and seeded branches. Its server was bounded to1CPU/1GiB, concurrency1 and the same
256MiB buffer pool. No ANALYZE statement execution, timer, new benchmark or live
database was used. The source's two exact SQL strings were compiled by the pinned
datatable AST with an empty cursor double solely to recover query text; no
response/parity/timing result was inferred from that compiler. Candidate SQL was
compiled by the actual ORM query builders. Only allowlisted plan structures,
table/index names, estimates and query fingerprints were retained; SQL,
attached conditions and literal values were stripped.

| Statement/block                       | Estimated query cost | Observed plan shape                                                      |
| ------------------------------------- | -------------------: | ------------------------------------------------------------------------ |
| Source unfiltered query               |             10514.29 | Parent index, full pre-pagination joins, temporary grouping/filesort     |
| Source filtered query                 |             10514.92 | Same pre-pagination joins and grouping/filesort                          |
| Candidate active stores               |                 3.62 | 8 primary-key range rows                                                 |
| Candidate counts                      |              4145.49 | Store-driven eligibility semi-join, duplicate-removal temporary table    |
| Candidate global price-conflict guard |              4145.49 | Same store-driven eligibility sweep, plus correlated price-choice lookup |
| Candidate page inner selection        |              4145.49 | Same eligibility sweep before25-row materialization and sort             |
| Candidate page outer projection       |                96.85 | 25 selected IDs enriched; this excludes the separate inner block above   |

Optimizer costs are unitless estimates, not milliseconds. Nested costs are not
added as though each were an independent full query. In all three candidate
eligibility blocks, the optimizer starts from8 stores, follows `store_id` to an
estimated7,603 stock associations, looks products up through PRIMARY and weeds
out duplicate product IDs with a temporary table. The product lookup contributes
an estimated read cost1900.75 in each block; it occurs before the selective price
sort can choose its25 rows. `pricelist` already uses PRIMARY, with roughly one
row/lookup and a small estimated0.37 cost per correlated lookup. The plans show
no missing-index full scan of the membership-price table.

This identifies repeated store/product eligibility and duplicate-removal work as
a structural candidate for investigation. It does **not** establish a per-query
latency ranking: no actual statement timers or EXPLAIN ANALYZE were collected.
The unchanged native aggregate counters and these estimated plans explain why
counting fewer returned rows alone did not guarantee a latency improvement.

## Parity-safe proposal for review, not implemented

For exclusive-price sorting only, consider computing the existing global
filtered price-conflict flag inside the existing counts scan, removing the
separate repeated eligibility sweep. Keep active-store validation and page
enrichment unchanged. The conflict aggregate must retain the exact existing
`COUNT(DISTINCT price) + NULL-choice` rule, evaluated only when the original
search predicate matches an eligible product, with empty aggregate mapped to0.
It must cover every filtered product, including off-page products. Restricting
the guard to the selected25 IDs would change safety behavior and is not proposed.

This targets repeated work shown in the plans, rather than removing a query
solely to improve its count. It is still a hypothesis: merging aggregates can
change optimizer choices or evaluate more price lookups on an early-conflict
input. Before app edits or a claim of improvement, a coordinated diagnostic
should attribute native per-statement work and compare the proposed plan.
Then source/real-service/authenticated-HTTP parity must cover missing prices,
all-NULL prices, equal duplicates, different prices, NULL/non-NULL mixtures,
off-page conflicts, empty results, page/tie ordering and literal wildcard/search
behavior. Any measurement must retain the same paced paired method and all
samples under a separately released idle slot.

No global optimizer switch, forced index, LIKE-prefix replacement, global
membership-price materialization or schema migration is justified by this one
fixture. Existing rounding, index/collation behavior, error code and frontend
response must remain unchanged. No `improve-query.md` fix or production SQL is
represented as validated by this read-only review.

The six sanitized plans are in
`evidence/catalog-details/workflow-exclusive-price-estimated-plans.json`.
The exact owned container and its anonymous volumes were verified absent after
cleanup. No release ledger was promoted.
