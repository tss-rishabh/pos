# Runnable screening quota projection publisher

Implementation only; no worker, migration, provider or cloud action was executed. Final validation remains deferred by the standing code-first work order.

The module `src/modules/legacy-order-imports/screening-counter/counter-generation-main.ts` is a standalone background process. Imports and an absent selector open no file, pool, SDK client or network connection. No interactive checkout/preview request invokes native historical capture or initializes a missing counter.

The concrete pipeline is:

1. An independently discovered or explicitly requested customer capture uses an independent native readonly account and a bounded REPEATABLE READ snapshot of actual screening markers and their original Order/HP inclusion predicate. The default full all-family v3 metadata audit qualifies its source; at most 10,000 rows leave the snapshot.
2. The immutable wrapper authenticates exact rows, source identity, head revision and the complete shared metadata configuration with a separate source HMAC. An AES-GCM journal retains it, the expected previous baseline generation, exact parameterized script and deterministic BigQuery job ID.
3. The independent warehouse writer claims one original script durably before submission. It dry-runs the bounded partitioned preflight and atomically inserts the exact snapshot rows plus one generation publication into existing tables. Unknown outcomes reconcile only the retained original job via GET; the response must prove exact script, typed parameter values, project, region and job ID. It never chooses another write job.
4. A distinct readonly warehouse client dry-runs and executes the existing generation/customer/shard-bounded SELECT. It independently compares every marker identity, inclusion bit, row count and digest with the authenticated source capture. No supplied report-reader credential can submit the materialization script.
5. The native projection account enters the dedicated `counter-publication` metadata purpose. This requires its exact configured principal, minimal projection rights, all-family audit/definitions/index/MDL and the identical source-attested configuration. It locks the genuine customer/head and checks physical origin, unchanged source head and the explicitly expected old generation before atomically replacing contributions and baseline. Source freshness is checked again before writes and at transaction completion.
6. A lost native acknowledgement stays `seeding` and recovers by reading the exact retained generation/signature. Recovery does not seed again, dispatch another warehouse job or recapture history. A crash after a durable claim and before its dispatch is retained for review; it is not permission to infer a negative outcome or generate a replacement.

The publication's completeness and `source_cdc_through_ms` describe this fully transferred immutable native snapshot through its finish time. They do not assert completeness of any missing raw BigQuery marker table, raw connector or unrelated historical dataset. A separately approved direct-snapshot publisher needs the two existing generation tables, not a fabricated raw marker alias. The review DDL is in `screening-counter-generation-warehouse.review.sql`; it is never executed by startup.

## Commands

With the worker selector configured:

- No arguments: supervised bounded drain loop with SIGINT/SIGTERM shutdown and sanitized lifecycle events.
- `prepare <customerId> [expectedGenerationHash]`: capture and queue one explicit customer. Omit the old generation only for an absent baseline; an existing baseline requires its exact expected generation for replacement.
- `advance <generationHash>`: perform one retained state transition.
- `drain`: perform one bounded pass.

The `prepared` event returns only the opaque generation ID and phase. No customer/marker IDs, credentials, source SQL, request parameters or driver/provider errors are logged. Journal records are encrypted. New captures/materializations/seeds require `POS_SCREENING_COUNTER_GENERATION_NEW_WORK_ENABLED=true`; original warehouse/native acknowledgement recovery remains available with it false. Capture evidence expires after 60 seconds; expired undispatched work fails without recapture. `materializing` and `seeding` retain unknown outcomes and original identities for review.

## Configuration

The exact selector is `POS_SCREENING_COUNTER_GENERATION_CONTRACT=pos-screening-counter-generation-worker-v1`. The process additionally needs:

- `MYSQL_WRITER_URL`: the rewrite journal account.
- `POS_SCREENING_COUNTER_GENERATION_SOURCE_URL`: independent readonly native account.
- `POS_SCREENING_COUNTER_GENERATION_PROJECTION_URL`: separate narrowly granted native projection account. It must match `POS_SCREENING_COUNTER_PUBLISHER_GRANTEE` and the expected source host/schema.
- `POS_SCREENING_COUNTER_GENERATION_SOURCE_SERVER_UUID` and `POS_SCREENING_COUNTER_GENERATION_SOURCE_SCHEMA`: the exact native physical origin.
- `POS_SCREENING_COUNTER_GENERATION_SOURCE_KEY`, `POS_SCREENING_COUNTER_PUBLICATION_KEY`, `POS_SCREENING_COUNTER_GENERATION_JOURNAL_KEY`: three distinct printable 32–4096 byte keys.
- `POS_SCREENING_COUNTER_GENERATION_READER_KEY_FILE` and `POS_SCREENING_COUNTER_GENERATION_WRITER_KEY_FILE`: distinct absolute files with distinct explicit service-account identities in `tssgcp2025`. The reports reader may be used only as the reader; it is explicitly refused as writer. No ADC fallback exists.
- `BQ_SCREENING_COUNTER_PUBLICATIONS_VIEW` and `BQ_SCREENING_COUNTER_ROWS_VIEW`: the actual reviewed tables in `tssgcp2025` (the existing readonly reader setting names are reused).
- Existing exact shared metadata audit/origin/family definer settings and admin grantees; the counter family and independent publisher grantee must be present.

Optional source/projection CA settings are `POS_SCREENING_COUNTER_GENERATION_SOURCE_TLS_CA_FILE` and `POS_SCREENING_COUNTER_GENERATION_PROJECTION_TLS_CA_FILE`; otherwise the existing validated MySQL CA applies. TLS/hostname verification uses the shared pool implementation. Optional generation `MAX_BYTES` is at most 1GB, `TIMEOUT_MS` at most 10 seconds (default 8 seconds), and `INTERVAL_MS` defaults to 5 seconds. The source, projection and journal usernames must be distinct. Only the projection account receives reviewed counter-head/counter SELECT/INSERT/UPDATE and contribution SELECT/INSERT/DELETE; the source remains readonly.

The additive rewrite-owned `screening-counter-generation-migration.sql` installs the encrypted generation journal, generic demand queue and durable discovery/scheduler cursors. Legacy trigger/procedure/grant DDL and BigQuery DDL remain reviewed deployment actions. Existing `capture`/`complete` qualification tools remain available; the new runtime supplies the previously missing durable materialization, independent verification and native CAS composition.

## Automatic customer coverage

The normal loop and `drain` now run independent bounded discovery before capture/recovery. No per-customer CLI action is required for newly registered customers. Source discovery reads only current `users` IDs, quota heads and existing operational baselines over the readonly source pool. It performs no historical Order/HP/marker scan. The actual historical snapshot remains a separately claimed background phase.

The fast lane bootstraps from the newest bounded users page, retains its maximum PK, then keyset-polls IDs greater than that highwater. Existing history is covered independently by an ascending users-PK backfill lane, which wraps only after reaching an empty page. Every page admission and cursor movement share one rewrite journal transaction. A stale concurrent cursor cannot skip another worker's work. Generic demands deduplicate the exact customer/head/expected-baseline generation; creating the actual immutable generation and binding the claimed demand also share one transaction.

The scheduler reserves capacity for newest fast-lane demands and durably rotates the remaining capacity among retry/active work, older fast-lane work and historical backfill. Backoff advances failed requests' due times instead of pinning the queue head. A changed native head produces a new exact demand; failed generations are retried from a fresh genuine source capture, while uncertain original warehouse/native dispatches keep their retained identities. Invalid existing baseline evidence is retained for review/retry and never replaced with a guessed zero. One invalid customer's retry does not stop discovery or cursor admission for subsequent IDs.

Fresh-demand processing can advance its own bounded pipeline immediately rather than waiting behind every historical generation. Configuration bounds are `POS_SCREENING_COUNTER_GENERATION_DISCOVERY_BATCH_SIZE` (1–100, default 20 per lane), `POS_SCREENING_COUNTER_GENERATION_DISCOVERY_INTERVAL_MS` (1–60 seconds, default 5 seconds), and `POS_SCREENING_COUNTER_GENERATION_MAX_DISCOVERY` (2–10 demands per pass, default 2). The default byte budget is 50,000,000; table names are restricted to `tssgcp2025.tss_mysql_raw_layer`. Deployment must complete and reconcile the existing-customer baseline backfill before cutover; a cursor sweep alone is not proof that every pending/failed baseline was initialized. Fresh-user readiness and full-backfill timing require the later consolidated runtime qualification.
