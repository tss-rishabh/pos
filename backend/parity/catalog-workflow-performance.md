# Local catalogue workflow performance evidence

The complete paced measurement succeeded on the `e1abe45` benchmark method,
with the `bfd2a64` candidate production graph and pinned original source
`78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. This measures eight bounded,
source-derived synthetic catalogue/matrix cases; it is not production p95 or
whole-application performance acceptance.

All eight cases retained216 paired triples each:1,728 triples/5,184 measured
boundary observations. Each of six execution orders occurred36 times per case,
after12 warmup triples. Every response hash matched its full original-field
parity gate. The922 executed input hashes remained unchanged. Native text,
prepared and CTE counter calibration passed independently for both profiles;
all observed native warnings were0 and read-only/error guards passed.

## Independent boundary results

All timing cells are **p50 / empirical p95 in milliseconds**. Read counts are
source / service / authenticated HTTP. No cross-boundary speedup ratio is
computed: the source is preauthenticated pinned Django view dispatch through
serialized response content; the candidate service includes validation and JSON
bytes; HTTP additionally includes actual session/identity/operator/origin checks
and complete loopback transport. The original authentication middleware and
full original HTTP stack are not timed. Source query instrumentation executes
inside its handler timer. No pooled percentile across cases is reported.

| Case                             |    Source handler | Candidate service | Authenticated HTTP |       Reads |
| -------------------------------- | ----------------: | ----------------: | -----------------: | ----------: |
| parent-one-store                 |     17.36 / 24.28 |      6.99 / 12.32 |      10.78 / 17.99 |   2 / 3 / 6 |
| parent-eight-store-deep          |     42.20 / 48.08 |     10.70 / 15.62 |      14.41 / 18.09 |   2 / 3 / 6 |
| parent-selective-exclusive-price |     52.85 / 70.29 |     51.76 / 70.86 |      55.50 / 71.94 |   3 / 4 / 7 |
| parent-category-aggregate-sort   |     81.06 / 95.52 |     38.66 / 51.08 |      43.18 / 54.26 |   3 / 3 / 6 |
| matrix-first-25                  |     79.38 / 89.41 |     13.39 / 18.00 |      16.92 / 21.89 |  58 / 4 / 7 |
| matrix-own-erp-100               |   150.50 / 166.04 |     24.81 / 33.05 |      28.58 / 35.61 | 108 / 4 / 7 |
| matrix-literal-wildcard          |     27.58 / 32.77 |     22.65 / 29.19 |      26.15 / 31.06 |  10 / 4 / 7 |
| dense-parent-first               | 1182.43 / 1222.93 |     11.12 / 17.41 |      15.67 / 21.44 |   2 / 3 / 6 |

The matrix's per-row ERP reads are removed:58/108 source reads for25/100 rows
become4 service business reads, or7 including actual HTTP authentication reads.
Parent catalogue read count can increase (2→3, or3→4 for exclusive-price sort);
its gains depend on reducing joined-row materialization, not an assumed universal
query-count reduction.

**Selective exclusive-price sorting showed no improvement in this run.** Its
source/service/HTTP p95s were70.29/70.86/71.94ms. Do not hide that case, infer
statistical significance from this small difference, or claim every path became
faster. Follow-up should inspect that service's current conflict/count/page SQL
and native query costs over the same immutable fixture before proposing any
change; it must preserve exact membership-price safety and response behavior.
No production SQL or schema change is part of this benchmark delivery.

## Method and environment

The mixed profile preserves2,000 products with parent/variant/standalone shapes,
eight stores, a24-category pool, source-specific stock/deletion/membership
branches and exact identifiers/money. The dense profile remains2,000 simple
products ×8stores ×24categories ×2equal-price membership rows. Recorded column,
collation and primary/secondary index metadata were replayed without a new
performance index. Models, paginator, stock helpers and per-row ERP lookup are
actual pinned Django code; candidate services and authenticated application are
actual runtime code. No API interception, response substitution, row/array
sorting or decimal coercion was used to force equivalence.

MySQL8.0.39 used the pinned image,2CPU/2GiB limits, a256MiB InnoDB buffer pool
and a1GiB data tmpfs. Node24.22.3/Python3.12.15/Django4.2.5/pinned PyMySQL ran in
owned dependencies/environments; native RSA auth dependencies were hash locked.
No other agent build/browser/database job ran concurrently. Unrelated user
background services remained running (roughly0–1.2% container CPU before start)
and desktop activity was not stopped. This is a controlled local workload,
not a dedicated production-like performance host or a throughput benchmark.

Every warmup and retained triple used a fixed350ms pause outside all three
boundary timers and native-counter observation intervals. This respects the
unchanged global240requests/minute API limit; a separate bounded authenticated
probe observed240HTTP200 followed by2HTTP429 without an override. The earlier
unpaced partial run retained one216-sample case then failed with an unrecorded
HTTP status; it is preserved separately and not pooled or retroactively assigned 429. Arrival pacing changed for the successful run. All216samples, vectors,
orders, comparison assertions and30-minute/20-second source/15-second HTTP
budgets remained intact; no outlier or failed observation was discarded.

## Artifacts and limits

- Full raw samples, native per-event row/query counts, response hashes, session
  profiles, source/production/tool hashes and environment facts:
  `evidence/catalog-details/workflow-measurement.json`.
- Initial correctness/counter gates: `workflow-validation.json`; quota probe:
  `workflow-quota-diagnostic.json` in the same evidence directory.
- Earlier validation setup failures and unpaced partial measurement are retained
  privately; none is an accepted full performance result.

The exact owned measurement container was verified absent after cleanup. Its
bounded tmpfs created no anonymous data volume; its private Python environment
and caches were removed. No production/provider query, live data mutation,
shared dependency install or release-ledger promotion occurred. No UI rendering,
offline checkout, payment/report pipeline or platform-wide performance claim
follows from these two catalogue handlers.

Raw measurement SHA256: `f7b6ee62f1022a600be52bd6e146bac802b51ae73033834ee7d4024b302c4b95`.
