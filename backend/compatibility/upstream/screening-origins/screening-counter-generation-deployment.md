# Independent screening quota publisher

The standalone entry is `npm run worker:screening-counter`. The backend image
target `screening-counter-worker` runs the same compiled module. Its contract
is disabled by default. Packaging and source implementation do not establish
production acceptance; final validation follows completion of feature code.

Select `POS_SCREENING_COUNTER_GENERATION_CONTRACT` as
`pos-screening-counter-generation-worker-v1` only after the additive journal
migration, reviewed source trigger/owner installation, complete warehouse
tables and participating writer cutover are ready. The worker does not install
native triggers, change grants or create warehouse schemas. Apply the registered
`screening-counter-generation-migration.sql` through the normal migration plan.

The default command runs a bounded discovery/publisher/recovery loop. Explicit commands
are `prepare <customerId> [expectedGenerationHash]`, `advance <generationHash>`
and `drain`. Pass them after `--` with npm. Preparation captures a genuine
source snapshot and queues it; it is an infrastructure operation, never an
interactive checkout fallback. No supplied customer ID is treated as authority
to create a sale or payment.

With new work enabled, current-user PK discovery feeds an encrypted durable
demand queue automatically. A newest-customer lane runs independently of the
backfill lane; fair retry rotation prevents a failed identity from starving
older work. Cursor advancement and queue admission share a transaction, as do
demand binding and generation creation. Discovery reads current users, heads
and baseline metadata only; historical source capture belongs exclusively to
the background generation worker. New customers therefore do not require an
operator to run `prepare` individually. The `drain` command also performs a
bounded discovery/preparation pass.

Configure independent accounts and mounted credential files:

| Purpose | Configuration |
| --- | --- |
| Native source SELECT capture | `POS_SCREENING_COUNTER_GENERATION_SOURCE_URL`, `SOURCE_SERVER_UUID`, `SOURCE_SCHEMA`, optional `SOURCE_TLS_CA_FILE`, all with the same `POS_SCREENING_COUNTER_GENERATION_` prefix |
| Native projection CAS | `POS_SCREENING_COUNTER_GENERATION_PROJECTION_URL`, optional `PROJECTION_TLS_CA_FILE` with the same prefix |
| Durable encrypted journal | Existing rewrite `MYSQL_WRITER_URL`, independent `POS_SCREENING_COUNTER_GENERATION_JOURNAL_KEY` |
| Capture proof | `POS_SCREENING_COUNTER_GENERATION_SOURCE_KEY` |
| Publication proof | Existing `POS_SCREENING_COUNTER_PUBLICATION_KEY` |
| Warehouse SELECT verification | `POS_SCREENING_COUNTER_GENERATION_READER_KEY_FILE` |
| Warehouse immutable materialization | `POS_SCREENING_COUNTER_GENERATION_WRITER_KEY_FILE` |

The reports service account supplied for this project is strictly the warehouse
reader. Use a separate writer service account with narrowly scoped rights to
the reviewed publication tables. Credential files are mounted read-only and
never copied into the image. Source, projection and journal native principals
must remain separate. All proof/journal keys are independent.

Configure `BQ_SCREENING_COUNTER_PUBLICATIONS_VIEW` and
`BQ_SCREENING_COUNTER_ROWS_VIEW` for the approved project/dataset/location. The
worker retains the immutable warehouse job identity before dispatch, recovers
that original job after an uncertain response, independently reads and compares
the published rows, and only then attempts native projection CAS. A lost native
commit acknowledgment is recovered from its retained generation, never by
blindly reseeding. Replacing a baseline requires its exact expected generation.

`POS_SCREENING_COUNTER_GENERATION_NEW_WORK_ENABLED` defaults to `false`; keep
it false during recovery-only operation. This stops new dispatch without
discarding retained jobs. The loop interval defaults to 5000 ms, query timeout
to 8000 ms, and maximum bytes to 50000000. The options parser bounds all three.
Discovery batch size defaults to 20 (maximum 100), its interval to 5000 ms,
and new preparations per cycle to 2 (allowed 2–10) through the corresponding
`DISCOVERY_BATCH_SIZE`, `DISCOVERY_INTERVAL_MS` and `MAX_DISCOVERY` variables
under the `POS_SCREENING_COUNTER_GENERATION_` prefix. Both discovery and new
capture stop in recovery-only mode.
No worker-owned source transaction spans a warehouse call or sleep.

Use the shared metadata options described in `head-participants.review.md`,
including `POS_SCREENING_COUNTER_PUBLISHER_GRANTEE`. Ordinary source/application
qualification rejects that publisher as its current caller. The dedicated
publication qualifier requires that exact publisher, validates its minimal
projection rights and all reviewed metadata, and compares the configuration
against the independently authenticated source snapshot inside the CAS
transaction. It does not grant the publisher financial or source-writer rights.

Do not reopen quota-dependent writers during an incomplete baseline cutover.
After feature implementation, validate original-job recovery, concurrent source
changes, failed native acknowledgments, account separation, warehouse budgets
and source-equivalent counts using isolated writable fixtures before deployment.
