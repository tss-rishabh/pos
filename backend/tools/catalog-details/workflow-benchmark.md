# Native catalogue workflow benchmark

Implementation aligned onto rewrite `bfd2a64`. Node 24 syntax checks, Python
AST parsing, shell syntax, scoped ESLint and Prettier checks pass. **Native
validation passed eight three-boundary response gates and calibrated per-thread
counters across both profiles. Performance measurement has not run.**
The scoped validation is recorded in `native-validation.md`; no latency or
production-readiness claim follows. Run only after the complete verification run and other
local test/build/database workloads have stopped. The existing three-sample SQL
benchmark remains historical evidence; this workflow does not relabel it as an
application benchmark.

## Boundaries

`native-workflow-oracle.py` compiles the exact pinned Django view classes, their
real Product/ProductStore/Store/TssSetting model classes and five original
helpers from source commit `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.
Hashes must match the recorded source inventory. Real Django 4.2.5 ORM,
LoginRequiredMixin dispatch, Paginator, MySQL queries, ERP parent lookups and
DjangoJSONEncoder execute through `HttpResponse.content`. Request construction,
identifier wire mapping and JSON-lines transport are outside its timer. The
source principal is already authenticated; the original middleware, complete
deployed settings/router stack, process startup and source HTTP transport are
not measured.

The service boundary calls the actual candidate catalogue/matrix service with a
native, pre-resolved operator, then serializes the result to UTF-8 JSON bytes.
The HTTP boundary starts the real application in a separate process and makes
actual loopback authenticated requests using a native session. It includes
session/identity/operator/origin checks and complete received bytes. No response
interception, SQL doubles, mocked helpers or synthetic application routes are
used. These boundaries are reported independently; their different coverage
does not support an overall application or matched-boundary speedup ratio.

## Bounded synthetic data and cases

Both profiles use one own disposable MySQL 8.0.39 container, with successive
random schemas and distinct SELECT-only measurement actors. The container uses
two CPUs, 2 GiB RAM, a 256 MiB InnoDB buffer pool and a 1 GiB temporary data
directory. Replaying recorded columns, collations, primary and secondary
indexes precedes seeding. No performance index is added. The verified fixture
does not certify production foreign keys/triggers or the production optimizer's
cardinality distribution. ANALYZE and native session creation are setup costs.

The mixed profile has 2,000 products: 400 configurable parents, 1,200 variants
and 400 standalone products; eight stores; a pool of 24 categories, zero/positive
stock, deleted parents with live variants, flag differences, absent categories,
absent/null/equal duplicate membership prices, empty/digital products, diacritics,
literal wildcard text and an identifier above JavaScript's safe integer range.
Category combinations and the selected exclusive prices avoid undefined tie
ordering in aggregate-sort cases. Measurements retain exact source SQL mode,
rounding and GROUP_CONCAT behavior; differences must fail rather than be hidden.

Seven mixed scenarios cover single-store parent listing, eight-store deep page,
selective exclusive-price sort, category aggregate sort, matrix pages of 25 and
100 including ERP inheritance, and literal-wildcard matrix search. The dense
profile deliberately preserves the earlier worst fanout dimensions: 2,000 simple
products × eight stores × 24 categories × two equal membership-price rows,
with a 25-row catalogue page. These are source-derived synthetic cases, not
captured production request frequencies or production p95.

## Equality, counters and sampling

Each case first establishes connections/prepared forms, then compares all
original response fields, counts and row order at all three real boundaries.
Only established identifier-to-string mapping and object-key canonicalization
are permitted. Arrays, rows, decimal strings, nulls and concatenated category or
store names retain their exact order/value. No failing case is timed or omitted
to manufacture a faster result. Minimum returned-row assertions avoid timing an
accidental empty result. Every subsequent response must retain the exact hash.

An administrator observer reads native per-thread Performance Schema statement
summaries outside the timers. Dedicated actors isolate source, direct service,
HTTP authentication and HTTP business connections. Calibration executes a text
SELECT, prepared SELECT and CTE SELECT, derives event weights and verifies one
logical read for each. It refuses missing/unstable counters and connection-set
changes, cross-checks source totals against real Django execute wrappers on all
three aliases, and rejects writes/SQL errors. It does not assume `Com_*` values
exist in `status_by_thread`. Native event deltas retain rows sent/examined,
affected rows, warnings and errors without SQL text or parameter values.

Measurement mode runs 12 warmup triples then 216 retained paired triples per
scenario, concurrency one. All six source/service/HTTP execution permutations
repeat equally. Every triple, including warmups in every scenario/order, starts
after a fixed350ms pause outside all three timers and counter observation
intervals. This holds the arrival rate below the unchanged actual application's
240-request/minute limit (about171triples/minute maximum). Counter snapshots and
response comparison stay outside timers.
No outliers are discarded. Artifacts contain each raw observation, order,
response hash/bytes and query counts, plus per-case/per-boundary p50 and empirical
nearest-rank p95. There is no pooled percentile across unlike requests or claim
of statistical precision/production representativeness. Source parent catalogue
may issue fewer logical queries than the candidate while transferring more
joined rows; gains must follow actual evidence, not an assumed query reduction.

## Execution after the verification run is quiescent

Prerequisites: exact Node 24.22.3 used by the rewrite, existing isolated backend
dependencies with security mitigations verified, Docker with the pinned image
already available, `uv`, and a clean pinned source checkout. The runner creates
its own Python 3.12.15 environment and private uv/toolchain caches, installs its
hash-locked `workflow-requirements.txt`, and removes its own container/environment.
This retains pinned Django/PyMySQL versions and adds RSA support for MySQL's
default account authentication; no auth-plugin downgrade is used.
It never installs into shared node_modules or the original Python environment.
No production MySQL, BigQuery, AWS or provider credentials are accepted.

From `backend`, first perform a native correctness/calibration-only execution:

```sh
env PATH="/Users/rishabhbhatia/.npm/_npx/c9870267d9e0f935/node_modules/node/bin:$PATH" \
  CATALOG_WORKFLOW_SOURCE_ROOT=/Users/rishabhbhatia/code/backend-pos-web \
  CATALOG_WORKFLOW_QUIESCENT=yes CATALOG_WORKFLOW_MODE=validate \
  CATALOG_WORKFLOW_OUTPUT=/absolute/new-catalog-workflow-validation.json \
  sh tools/catalog-details/run-workflow-benchmark.sh
```

Only after that passes, replace `validate` with `measure` and use a fresh output
path. A hard 30-minute coordinator budget, source-call 20-second deadline,
HTTP 15-second deadline and existing candidate 10/15-second SQL bounds prevent
unbounded work. Dense source requests that exceed bounds fail the run; do not
silently shrink that case or increase only its limits. Run no other benchmarks
concurrently. Failures retain a sanitized incomplete artifact. The file contains
no credentials, cookies, request payloads or raw SQL. Source hashes, all candidate
production input hashes, locks, schema facts, runner code and host/container
metadata identify the executed graph. Inputs must remain unchanged.

The next action is a fresh measurement-mode run only after Root explicitly
releases that phase and confirms other heavy workloads remain idle. Any schema/response/counter
defect must be reported and corrected before measurements. No release ledger
promotion is owned by this benchmark.

## Arrival-rate correction

The first unpaced measurement stopped during the second case's warmups after
retaining216 first-case samples. Its generic HTTP failure did not record status;
that immutable partial result is not retrospectively labelled429 or combined
with the paced run. No complete measurement claim follows from that artifact.

A dedicated bounded diagnostic then used the actual authenticated native API
with no limiter override: first240 requests returned200, requests241–242
returned429. Only ordinal/status and allowlisted error codes were retained;
there was no matching public error-code field, recorded as null. See
`backend/parity/evidence/catalog-details/workflow-quota-diagnostic.json`.
The production global max240/1minute setting applies to both catalogue routes
without a route override. The new fixed inter-triple pacing preserves all
vectors,216 samples/case, warmups, balanced orders, full equality checks and the
30-minute total/20-second source/15-second HTTP limits. It adds638.4seconds of
intentional untimed spacing over8×228triples. The paced arrival method differs
from the partial unpaced run and does not prove throughput or productionp95.
