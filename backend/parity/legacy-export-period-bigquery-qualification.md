# Legacy export period: bounded BigQuery qualification

The 18 November 2026 follow-up qualifies the changed `time_period` projection in
`src/modules/operational-reports/raw-legacy-export.ts`. It does not refresh the
other report plans or establish publication completeness. The saved result is
`evidence/bigquery-raw-projection-validation.json`, checked at
`2026-11-18T03:55:52.269Z`, using Node 24.22.3 and the explicitly supplied read-only
BigQuery credential. Credential contents, SDK errors and business rows were not
printed or saved.

| Operation             | Boundary                                                                                                                                                                 | Recorded result                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Raw projection schema | `tssgcp2025.tss_mysql_raw_layer.tss_report_exports`, `asia-south1`; **dry run only**, one bound date interval and owner, limit 25, 10 MiB maximum, 10-second job timeout | Exact 15 fields, including `time_period STRING`; estimated 857,776 bytes; `executed:false`                                             |
| Literal SQL           | Only three generated CTE rows; no source relation; 1 MiB maximum, 10-second job timeout, at most four retrieved rows                                                     | Three expected rows matched; original NULL, empty and date-label values retained; job complete, zero bytes processed/billed, cache hit |

The raw and literal statement SHA-256 values are recorded separately. Literal
values also exercise wide IDs, source completion precedence, error normalization,
name fallback, KiB conversion and terminal-date fallback already present in this
projection. The literal query compares results in memory and persists only the
case count, successful comparison, digest and allowlisted job metadata.

The validator requires an absolute explicit credential path, the official Google
endpoint and strict TLS; it refuses the emulator and disabled TLS verification.
SDK retries are disabled. Missing schema, missing byte estimates, unexpected
field order/type, failed jobs, excess bytes or a result mismatch fail the check.
A 40-second process watchdog bounds the complete tool. Unknown exceptions produce
only static resource/stage/code diagnostics, including failures before client
creation. The child process used for the cloud follow-up discarded SDK stderr;
no raw diagnostic was inspected or retained. The saved evidence establishes the
validated schema/job result; it is not a separate process-exit attestation.

Before the cloud call, a captured-output regression threw a synthetic SDK-shaped
error containing a bearer header, body, cause and hostile serializer. It verified
empty stdout and exactly the static error event on stderr. That check and the two
existing raw-projection tests pass. The focused column/tool TypeScript program
and changed-file ESLint also pass on Node 24.22.3.

No business-row SELECT, DDL, dataset/view/UDF creation, artifact export, provider
action or IAM change was performed. The returned schema is the dry-run output
schema, not a new full raw schema capture. This evidence does not establish CDC
coverage, archive publication/generation, freshness, collation equivalence,
deployed view compatibility or complete source-workflow parity. Those acceptance
requirements remain separate.
