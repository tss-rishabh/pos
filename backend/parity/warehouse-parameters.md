# BigQuery parameter wire validation

The pinned @google-cloud/bigquery 9.6.1 SDK serializes a plain string with an
explicit DATE, DATETIME, TIME or TIMESTAMP type as an empty parameterValue.
The resulting SQL parameter is NULL, even though its runtime input is present.
This can silently remove rows from bounded historical queries. The shared
warehouse adapter now uses SDK scalar wrappers before serialization, including
typed arrays and typed nulls. Full-width INT64 strings stay strings.

The SDK's string TIMESTAMP constructor also emits nine fractional digits for a
microsecond value. The actual BigQuery query API rejects this representation.
The adapter removes only extra zero padding beyond six digits and rejects real
sub-microsecond precision. Callers must choose the correct explicit boundary
rounding for their predicate instead of silently widening or narrowing it.
For example, import-history uses a microsecond ceiling for a `<cutoff` warehouse
predicate and the matching millisecond ceiling for the source DATETIME(3)
`>=cutoff` predicate. Its age classification still compares exact instants.

Fourteen local tests exercise the real SDK wire serializer and shared adapter,
including temporal arrays, nulls, non-UTC timestamp offsets, microseconds,
full-width IDs and rejected nonzero nanoseconds. The read-only verification
tool executes one generated-value SELECT with no FROM clause and no source
table access. All seven typed field checks passed using the supplied reader
account. Evidence: `evidence/bigquery-parameter-validation.json`; reproduction:

```sh
GOOGLE_APPLICATION_CREDENTIALS=/absolute/private/reader.json \
  node --import tsx tools/warehouse/verify-parameters.ts
```

The file is passed to Google Application Default Credentials; the tool neither
prints nor copies key contents or raw provider errors. This proves wire-level
parameter behavior, not historical data replication, source parity or latency.

[SDK scalar wrappers](https://googleapis.dev/nodejs/bigquery/latest/BigQuery.html),
[BigQuery query parameters](https://docs.cloud.google.com/bigquery/docs/parameterized-queries).
