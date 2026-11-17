# Independent first-order history publisher

The command is `npm run worker:origin-history`, selecting the compiled
`history-generation-worker-main.js`. Publisher implementation is still being
integrated. Image build, native capture, warehouse writes and final acceptance
have not been performed for this implementation.

The dedicated container includes the reviewed Python capture dependencies:

```sh
docker build -f compatibility/upstream/screening-origins/OriginHistoryContainerfile \
  --target origin-history-publisher \
  --build-arg ORIGIN_HISTORY_CAPTURE_DEPENDENCY_IMAGE="$POS_SOURCE_DEPENDENCY_IMAGE" \
  -t pos-origin-history-publisher .
```

The dependency image must be pinned by digest, contain Python with SQLAlchemy,
PyMySQL and cryptography, and support the pinned Node binary on the selected
architecture/libc. The image definition checks those runtime dependencies during
build. It copies compiled backend code, production Node dependencies and owned
capture helpers. It never embeds the original application source or credentials,
and it opens no listener. The ordinary backend Node image alone cannot execute
Python capture.

For new work select
`POS_SCREENING_ORIGIN_HISTORY_PUBLISHER_CONTRACT=pos-screening-origin-history-publisher-v1`
and `POS_SCREENING_ORIGIN_HISTORY_PUBLISHER_ENABLED=true`. The shared encrypted
journal requires independent `POS_SCREENING_ORIGIN_HISTORY_JOURNAL_KEY`,
`...JOURNAL_URL` and optional `...JOURNAL_TLS_CA_FILE`. Register/apply the existing
rewrite journal migration through the controlled migration role, never from
the publisher constructor.

Mount separate reader and writer JSON files using
`POS_SCREENING_ORIGIN_HISTORY_READER_KEY_FILE` and
`POS_SCREENING_ORIGIN_HISTORY_WRITER_KEY_FILE`. The supplied reports reader
account is strictly a reader: it cannot be selected or repurposed as the writer.
The publisher requires an independently provisioned writer identity. Retain
independent `...CAPTURE_KEY` and `...PUBLICATION_KEY`; neither may reuse the
journal or source-command proof key. No ADC writer fallback is used.

`POS_SCREENING_ORIGIN_HISTORY_SOURCE_KEY_FILE` points to a private JSON file
containing `url`, `sourceSchema`, `sourceServerUuid` and `tlsCaFile`. This is an
explicit read-only account against the authoritative writer origin; a replica
cannot impersonate its UUID or mutable head. The native account cannot update
orders, change control heads or create/replace routines/triggers. Supply reviewed
`...DEFINER`, `...AUDIT_DEFINER` and `...ADMIN_GRANTEES` matching the separate
manual privilege rollout. The image provides absolute `...SOURCE_PYTHON` and
`...SOURCE_MODULE` defaults for the actual capture process.

The four writer tables are selected explicitly through
`BQ_SCREENING_ORIGIN_HISTORY_{ORDERS,MANIFESTS,COUNTS,PUBLICATIONS}_TABLE` using
owned `pos_origin_history_` names in `tssgcp2025.tss_mysql_raw_layer`.
They are separate from the bridge's independently qualified reader view aliases.
Warehouse DDL remains review-only. Capture, immutable materialization, independent
reader comparison and final publication are separate retained stages; only a
qualified publication is consumable by the bridge. Lost writer-job responses
retain their original job identities for GET-only reconciliation.

Use `...PUBLISHER_INTERVAL_MS`, `...PUBLISHER_DEADLINE_MS` and
`...PUBLISHER_BATCH` to bound each cycle; `...PUBLISHER_ONCE=true` performs one
cycle. Disabling new work must retain the journal key and original writer
credentials needed to reconcile unknown jobs. Do not erase journal rows or
replace job references to retry publication. All selectors remain blank or
disabled in the example environment; no configuration here activates a service.
