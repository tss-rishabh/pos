# Private source eligibility bridge

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
The same limit covers customer history, membership, coupons and both cart
preview routes together; enabling another reader does not multiply capacity.

Membership is selected separately with
`POS_SCREENING_ORIGIN_MEMBERSHIP_HISTORY_CONTRACT` set to
`pos-screening-origin-membership-history-v1`. It reuses the real generic member
publication configured by `PUBLIC_SCREENING_MEMBERSHIP_BIGQUERY_CONTRACT`,
`BQ_PUBLIC_SCREENING_MEMBERSHIP_PUBLICATIONS_VIEW`, its source time zone and
`POS_MEMBERSHIP_PRODUCT_IDS`. The source capture key is
`TSS_POS_LEGACY_IMPORT_PROOF_KEY`; the independent publication key is
`PUBLIC_SCREENING_MEMBERSHIP_PUBLICATION_KEY`. Both differ from the origin key.
The private source's `POS_SCREENING_ORIGIN_MEMBERSHIP_HISTORY_URL` ends in
`/internal/screening-origins/membership-history`; its transport derives the
separate sibling `/membership-preview` route. Final commands and server-issued
preview contexts have separate schemas, signatures and lifetimes. A preview
cannot authorize an order or payment.

Coupon reads are selected with `POS_SCREENING_ORIGIN_COUPON_HISTORY_CONTRACT`
set to `pos-screening-origin-coupon-history-v1` and the existing generic coupon
publication view configuration. They use the same generic source capture key
and an independent `CSV_COUPON_PUBLICATION_KEY`. The private source selects
`POS_SCREENING_ORIGIN_COUPON_CONTRACT=pos-screening-origin-coupon-v1` and an
HTTPS `POS_SCREENING_ORIGIN_COUPON_HISTORY_URL` ending in
`/internal/screening-origins/coupon-history`. Cart rehearsal uses the separate
`/coupon-preview` route and its server-only preview proof. Current-controls-only
coupon branches carry no fabricated historical facts.

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

Optional member demands use the existing
`PUBLIC_SCREENING_MEMBERSHIP_DEMAND_CONTRACT` and
`PUBLIC_SCREENING_MEMBERSHIP_GENERATION_JOURNAL_KEY`. Optional coupon demands
select `POS_SCREENING_ORIGIN_COUPON_DEMAND_CONTRACT` as
`pos-screening-origin-coupon-demands-v1`, using
`CSV_COUPON_GENERATION_JOURNAL_KEY`. Each journal key is distinct from origin,
capture, document and publication keys. These queues use the TLS journal URL
above even when customer-history demands are disabled. The configured database
must be the same database used by the corresponding standalone generic
publisher's `MYSQL_WRITER_URL`; the receiver account needs only its queue-table
DML. The coupon demand bind and generic generation journal share a native
transaction in that publisher. No native source transaction crosses warehouse
access or queue admission. Apply the registered member/coupon queue migrations
before enabling demands. The member/coupon publisher accounts and independent
warehouse writers remain separate from this reader process.

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
