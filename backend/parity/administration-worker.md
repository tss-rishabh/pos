# Inventory synchronization worker

The worker consumes the rewrite-owned administration outbox on the **writer only**. It does not call `pos_stock_syncer`, mutate legacy product stock, or contact a payment provider. Apply `src/modules/administration/migration.sql` before starting it. The worker DB identity needs only `SELECT`/`UPDATE` on `pos_rewrite_administration_outbox`; API transactions separately enqueue events.

Entrypoint: `src/modules/administration/worker-main.ts`, compiled to `dist/modules/administration/worker-main.js`. Start the built runner with Node 24 LTS:

```sh
node dist/modules/administration/worker-main.js
```

The default is disabled. To enable, configure:

| Variable | Purpose |
| --- | --- |
| `ADMINISTRATION_WORKER_ENABLED=true` | Enables supervised delivery. |
| `MYSQL_WRITER_URL` | Writer connection with TLS in production; shared config also validates the application's reader and session configuration. |
| `PRODUCT_SYNC_URI` | Exact source environment path. There is no guessed endpoint default. |
| `PRODUCT_SYNC_BASE_URL` | Explicit base override, if used. Otherwise the migration flag selects `MAIN_API_V2_URL` or `API_V2_URL`, falling back to the configured selected `TSS_API_BASE_URL`. |
| `PRODUCT_SYNC_REPLAY_SAFE=true` | Deployment confirmation that the endpoint is replay-safe or honors `Idempotency-Key`. It remains disabled without this confirmation. |
| `PRODUCT_SYNC_HTTP_TIMEOUT_MS` | Bounded HTTP timeout, default 5000, allowed 100–10000. |
| `ADMINISTRATION_WORKER_INTERVAL_MS` | Poll delay, default 2000, allowed 250–60000. Failures back off to at most 60000. |
| `ADMINISTRATION_WORKER_BATCH_SIZE` | At most this many deliveries, default 25, allowed 1–100. |
| `ADMINISTRATION_WORKER_BATCH_TIMEOUT_MS` | Aborts the batch's in-flight HTTP after the deadline; default 20000, allowed 1000–60000. |

Production permits HTTPS only and rejects embedded URL credentials, cross-origin concatenation, redirects and malformed endpoint configuration. Local HTTP is allowed only outside production. Demo mode cannot contact a remote synchronization endpoint. No adapter is produced until endpoint and replay safety are configured; the parent uses the same adapter availability to gate API inventory writes.

`Helpers.sync_pos_product` (`helpers/helpers.py:191`) posts the selected API base concatenated with `PRODUCT_SYNC_URI`, with `Content-Type: application/json` and `{"product_id_list":[...]}`. Only status **200** is an acknowledgement. The adapter preserves integer JSON IDs without converting BIGINT values through JavaScript `Number`. The optional source troubleshooting flag is supported by the body constructor but is not invented for ordinary outbox events. Source-executed tests compare exact URL/body/Content-Type for both migration branches. `Idempotency-Key` adds the stable outbox ID and `X-Request-Id` propagates a safe originating trace ID.

Delivery is at least once: a crash after HTTP acknowledgement and before SQL commit can repeat an event. A local outbox alone cannot make an arbitrary remote HTTP service exactly once. Therefore enabling delivery requires verified upstream replay safety; merely sending the header does not prove it. The source routine's stock-write gate remains independent.

`administrationWorker` prevents overlapping batches in one process. Multiple instances claim rows with `FOR UPDATE SKIP LOCKED`. Fewer-attempt events run before failed events, so one failed item does not continually take priority over fresh events. The HTTP timeout and batch deadline bound network work. SIGTERM/SIGINT stops polling, aborts an in-flight request, waits for transaction cleanup and closes pools. The standalone runner enforces a ten-second shutdown deadline. An interrupted attempt remains pending.

Each delivery increments durable attempts, including failed calls. After ten attempts it stays pending and emits `administration.inventory-synchronization.retry-exhausted` for operational recovery. Alerts scan bounded pages so old exhausted events do not hide newer ones. Failed events are never silently marked delivered. Logs contain only static module/resource/event IDs, unique event instance IDs, originating request/user/store identifiers, effect ID, counts and stable error codes. HTTP bodies, URLs, credentials, names, email, phone, raw errors and stacks are never logged.

After investigating and confirming replay safety, requeue one pending event through the same runner:

```sh
node dist/modules/administration/worker-main.js --retry-event EVENT_ID
```

This requires configured/enabled delivery, resets only that pending event's attempt count and emits a safe recovery event. It does not send HTTP itself. Delivered events cannot be requeued. `retryInventorySynchronization(db, eventId)` is also exported for a future authenticated operational recovery surface; its caller must own access control and audit attribution.

Tests use an isolated local MySQL schema and injected fetch functions. They exercise the real queue/locks, retry persistence, duplicate-ID conflict handling, non-overlap, shutdown abort, exhausted-event recovery and sanitized events. No real synchronization request is made by the test suite.
