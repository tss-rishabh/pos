# Delivery timing and order settings

The module implements source timing create/edit, single/all availability, global threshold/buffer updates and e-commerce controls. Source-extracted checks compare hours:minutes arithmetic and all five notice forms. Isolated MySQL covers concurrent edits, role/store checks, replay, ordering and recovery. No live provider, inventory procedure or entire legacy HTTP workflow is certified.

## Deployment

Apply `src/modules/administration/settings-migration.sql` after administration/media migrations. It creates only rewrite-owned effects, replay records, cooldowns and a registry row. Root injects `createSettingsDelivery(config, db, readSettingsWorkerOptions())`, passes the cooldown and closes the adapter at shutdown. Construction makes no connection/send.

| Setting | Behavior |
| --- | --- |
| `COMMON_REDIS_URL` | Distinct common cache; never falls back to notification/check-in Redis. Production requires `rediss:`. |
| `SLACK_URL` | Source common-channel webhook. Approved HTTPS Slack hosts and `/services/` paths only. |
| `ECOM_DELIVERY_CHANGES_TIME` | Source default 180 seconds; bounds 1–3600. |
| `SETTINGS_WORKER_ENABLED` | Defaults to false. |
| `SETTINGS_WORKER_INTERVAL_MS` | Default 2000; bounds 1000–60000. |
| `SETTINGS_WORKER_BATCH_SIZE` | Default 5; bounds 1–25. |

Run `npm run worker:settings` under supervision. No real sends occur in demo/disabled mode. Common-cache clients are lazy, bound queued commands/timeouts, disable offline queuing and destroy stalled connections. The [official command options](https://github.com/redis/node-redis/blob/master/docs/command-options.md) explain timeout scope: an already-written command may have taken effect, so SET retries remain idempotent.

Missing adapters reject before mutation. Responses expose editing availability, never credentials/URLs. Threshold changes set exactly `HYPERLOCAL_STOCK_THRESHOLD`; buffer changes set `ORDER_CREATION_BUFFER_TIME_IN_SEC` in seconds, followed by the source notice. Arbitrary setting keys cannot be submitted.

## Consistency

Strict validation bounds stock integers, positive hours:minutes durations and exact times including seconds. Durations can exceed one day; zero stock threshold is supported. Negative thresholds are deliberately rejected. Source notice text/HH:MM display and business-local timestamps are preserved, with user/store text Slack-escaped against injected mentions.

Timing moves require current access to both active sales stores. Store locks protect weekday uniqueness. Writer-current roles/assignments are checked inside the mutation transaction. State hashes reject stale edits and changed whole-store collections. Stable operation UUIDs replay committed results without adding effects; conflicting reuse fails. Duplicate source setting rows remain supported: reads use first PK and writes update every matching row. Bounded reads reject overlarge unreconciled collections rather than truncate.

Outbox effects commit with database changes. Per-resource ordering prevents stale cache retries overtaking newer changes; unrelated resources can progress. SET is idempotent. Slack is at least once: a crash after acceptance but before SQL acknowledgement can duplicate a notice. An arbitrary idempotency header cannot prove otherwise.

Failed attempts persist; the tenth blocks that resource and emits a recovery event. Restart re-alerts blocked rows. Polling is bounded, batches have a 20-second deadline and cannot overlap, and shutdown aborts in-flight work. Events include module/resource/event/effect/request/user/store identifiers plus static codes. Names, payloads, webhooks, email, raw responses and errors are never logged. Names are loaded only to deliver the authorized source notice.

After resolving an adapter failure, requeue one pending effect:

```sh
npm run worker:settings -- --retry-effect EFFECT_UUID
```

Recovery resets only attempts, cannot replay acknowledged effects and makes no immediate send. Review possible Slack duplicate delivery before recovery.

## E-commerce dependency

Real writes remain closed unless `ecommerceSyncVerified` and an injected `ecommerce.inventory.sync` delivery are provided. Source calls `pos_stock_syncer_bk` for eligible products, then full product sync. The self-committing backup/divergent inventory model do not verify that integration; see `administration-stock-dependency.md`. The default worker has no invented replacement.

The verified adapter accepts `(eventId, storeId, signal?)` and must support safe retry/checkpointing. Changed values enqueue source threshold/availability notices followed by inventory sync and persist the configured cooldown. No-change requests produce no effects/cooldown. SQL replaces the new app's Redis throttle; it does not coordinate with running legacy instances. Quiesce legacy writers or supply an explicit shared-throttle bridge before mixed deployment. Inability to inspect a procedure is not proof of global absence.
