# Private customer history bridge

The compiled command `npm run receiver:origin-history` starts the private HMAC
history service. The backend Docker target `origin-history-receiver` runs the
same entry point on port 4424. Implementation is pending the final validation
phase; this document does not certify production readiness.

Select `POS_SCREENING_ORIGIN_HISTORY_BRIDGE_CONTRACT` as
`pos-screening-origin-history-bridge-v1` and
`POS_SCREENING_ORIGIN_HISTORY_CONTRACT` as `pos-screening-origin-history-v1`.
An absent bridge selector exits without opening credentials, pools or listeners.
Demo mode is rejected when selected. The process does not require the public
application's sessions, web origin, source writer or payment configuration.

Mount the supplied reports reader service-account JSON as a read-only file and
set its absolute path in `POS_SCREENING_ORIGIN_HISTORY_READER_KEY_FILE`. The
service requires the supplied reports reader identity, project `tssgcp2025`,
dataset `tss_mysql_raw_layer` and location `asia-south1`. It exposes only bounded
SELECT queries with dry-run byte qualification, a query deadline, no pagination
and cancellation. It does not publish warehouse data or capture MySQL history.
No credential file is included in the image.

`POS_SCREENING_ORIGIN_HISTORY_BRIDGE_CONCURRENCY` bounds simultaneous history
reads (default 8, allowed 1–32). Excess authenticated work receives HTTP 429 with
a fixed error code. There is no unbounded in-process request queue. Each slot is
released when its read settles, including error and cancellation outcomes.

Configure the independently qualified publication and count views using
`BQ_SCREENING_ORIGIN_HISTORY_PUBLICATIONS_VIEW` and
`BQ_SCREENING_ORIGIN_HISTORY_COUNTS_VIEW`. Set independent source proof and
publication keys through `POS_SCREENING_ORIGIN_PROOF_KEY` and
`POS_SCREENING_ORIGIN_HISTORY_PUBLICATION_KEY`. The private source deployment
uses the same source proof key and an HTTPS
`POS_SCREENING_ORIGIN_HISTORY_BRIDGE_URL` ending in
`/internal/screening-origins/history`. Terminate TLS on a private gateway and
restrict ingress to cooperating source workloads. The listener defaults to
loopback; the container explicitly binds its private interface to `0.0.0.0`.
Do not mount this route on the public POS ingress.

Optional missing-generation demand persistence requires
`POS_SCREENING_ORIGIN_HISTORY_DEMAND_CONTRACT` set to
`pos-screening-origin-history-demands-v1`, an independent
`POS_SCREENING_ORIGIN_HISTORY_JOURNAL_KEY`, and a dedicated TLS MySQL
`POS_SCREENING_ORIGIN_HISTORY_JOURNAL_URL`. Mount a CA file using
`POS_SCREENING_ORIGIN_HISTORY_JOURNAL_TLS_CA_FILE` when needed. This queue is
application metadata, not a source sales database. Apply the registered
`history-generation-migration.sql` through the normal reviewed migration
deployment; the receiver never applies DDL. Its database principal needs only
the journal table's required SELECT/INSERT/UPDATE grants. The independent
publisher consumes the retained demands; the receiver cannot run that publisher.

Missing or invalid history never becomes a zero count. A qualified generation
can be reused while its source identity, customer revision and writer definition
remain identical. Each response is freshly signed for its original operation
with at most a 60-second lifetime. A changed revision requires another qualified
generation.

`GET /health/live` reports process liveness only. It does not assert warehouse
publication completeness. Logs contain fixed module/resource/event identifiers,
request IDs, authenticated staff IDs when available, status and timing; they
exclude request bodies, URLs, cookies, raw errors, SQL and credential values.
SIGINT/SIGTERM close the listener before the optional journal pool. The process
enforces a bounded shutdown deadline.
