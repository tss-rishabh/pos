# Ecommerce threshold inventory and full-catalog synchronization

Source: POS `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`, `core/views.py:2083–2180` (`PosEcomSetting`, `AjaxEcomSettingUpdate`), `core/tasks.py:182–210` (`sync_ecom_inventory`, `full_ecom_product_sync`). API-v2 full builder and direct-consumer hashes are recorded in `compatibility/upstream/ecommerce-full-sync/source-manifest.json`. Source siblings remain read-only.

## Preserved behavior

The existing role1 ecommerce settings operation still compares threshold/availability, applies the source cooldown and queues source-shaped threshold/availability notices plus inventory sync. Its success message remains `Ecom Setting Updated! Please wait, It will take time to reflect`; this acknowledges accepted work, not completed synchronization. Unchanged values queue no effects.

The stock task selects **every** `product_store` row with the selected store and `stock > ecom_threshold`. There is no added product-type, product deletion, association availability or association deletion filter. Equality with the threshold is excluded. The source's `Updated by System`/actor0 same-quantity stock refresh is applied using the explicitly selected `configuredSystemStockProjection`, never a legacy self-committing `CALL`. Selected rows and original quantities are staged server-side into bounded checkpoint rows; each has a visible `PENDING`, `PROCESSED` or `SKIPPED` result. Unsupported/ambiguous/missing projection inputs block with a static diagnostic rather than disappearing from the selection.

The existing stock projection remains its separately documented opt-in candidate (`pos-stock-projection-70b801-v1` plus `pos-system-stock-projection-70b801-v1`). This work does not newly certify the inaccessible deployed stored procedure or claim Vinculum parity. Physical/aggregate stock logs follow that projection. The source selection can omit below-threshold SKUs when thresholds change: that behavior is retained and explicitly **not** called a complete recomputation of every store SKU.

After all selected rows are handled, the concrete private full-sync adapter runs the source's complete ecommerce catalog builder. The old `GET /syncproduct` returns `Sync Product Started` before actual work and is refused as completion evidence. Completion requires the bridge's authenticated immutable receipt and actual mandatory Mongo/Redis/CDN acknowledgments. See its [deployment and recovery contract](../compatibility/upstream/ecommerce-full-sync/README.md).

## Deliberate safety corrections

* Source QuerySet materialization can pass an old quantity to a later `CALL`, overwriting a concurrent sale. The rewrite rereads each current association quantity under writer locks, preserving the current POS quantity while refreshing its aggregate projection. If an association was removed, it is explicitly skipped rather than resurrected. Held stock is preserved.
* Source outer exception handling can leave a partial series of independently committed calls and swallow the failure. Every rewritten projection/audit/checkpoint advances atomically in one writer transaction; a failure rolls back that row and stops the job with its original ID. Already completed rows are not repeated.
* Source downstream Mongo/Redis/CDN failures and a started-only GET response can look successful. The new receiver/worker preserves the full source transformation but refuses success on mandatory I/O failure. Unknown outcomes retain global catalog ownership; only explicit stopped-worker reconciliation can rerun the same full-sync operation.
* The imported source bundle/sub-variant helper reads root `SyncProduct.SessionR` despite the full builder using `Session`. In the purpose-scoped child only, that known alias is guarded and bound to the same writer Session; actual source SQL/row/field semantics are preserved. Read-only-server checks run before/after the full build, alias reversion is retained as a failure even if swallowed/restored, and public/CMS reader namespaces are untouched. This fixes stale replica stock without a global app connection rewrite; the actual cross-service writer identity remains an explicit deployment acceptance fact.
* Existing settings role1 bypass could expose another/non-franchise store to type2 users. Reads, mutations, recovery and resume now recheck the current writer assignment plus FRANCHISE category. Internal type1 role1 retains its authorized scope.
* A lost settings reply or a404 does not erase the original browser action. A non-PII actor/store journal persists the original UUID and exact input before dispatch. Recovery reads its receipt; retry is explicit and identical. `Cancel if not accepted` atomically fences that original UUID using the existing settings registry/receipt before allowing a replacement. If already accepted, cancellation reports the original accepted effect and does not undo settings or cancel its sync. A late original PUT replays the cancellation receipt even after settings are restored.

The existing per-store settings outbox remains the only POS delivery queue. An asynchronous `pending` outcome does not increment failure attempts or mark delivery complete. It is bounded by the worker polling/batch limits and preserves FIFO ordering; failed earlier notices/effects still require existing settings-worker recovery. No parallel job framework or financial API was introduced.

The verified `product_store` metadata already supplies `idx_store_id_stock_is_avail_is_del` with leading `(store_id,stock)`, so the exact source predicate has an eligible range index without adding availability/deletion predicates. No legacy index/DDL improvement is required or applied by this slice. Staging uses server-side `INSERT … SELECT`, a configured selection cap, indexed pending-row lookup and bounded public cursor pages; it does not materialize the store's entire selection in JavaScript. The full source builder retains its original bulk query/transform shape in its dedicated supervised process; no new performance benchmark of the deployed catalog is claimed.

## Integration hooks

Exports from `src/modules/administration/ecommerce-sync/index.ts`:

```text
readEcommerceSynchronizationOptions(env?)
ecommerceInventorySynchronization(config, db, options?, {projection?, fullSync?}?)
registerEcommerceInventorySynchronization(app, service)
```

Construct one service in the API and another in the settings worker using the same config. Pass `service.ready ? service.synchronizeEcommerce : undefined` into the existing `createSettingsDelivery(config, db, workerOptions, {synchronizeEcommerce})` injected options; pass `ecommerceSyncVerified: service.ready` into administration settings options. Register the new routes. The existing `worker:settings` process then drains projection/full-sync recovery without a second POS worker. Disabled/demo/unselected projection or absent full adapter keeps ecommerce writes unavailable.

Apply `src/modules/administration/ecommerce-sync/migration.sql` after `settings-migration.sql` in the POS writer migration registry. It creates only `pos_rewrite_ecommerce_inventory_syncs` and `..._sync_rows`; existing settings effects and receipts remain authoritative. The external API-v2 `migration.review.sql` is separate and must not be automatically applied by the POS migration runner.

| Node option | Default |
| --- | --- |
| `ECOMMERCE_FULL_SYNC_CONTRACT` | unset; accepted value `pos-ecommerce-full-sync-v1` |
| `ECOMMERCE_FULL_SYNC_URL` | unset; exact private HTTPS `/internal/pos/ecommerce-full-syncs`, no credentials/query/hash/trailing slash |
| `ECOMMERCE_FULL_SYNC_SECRET` | unset; dedicated 32–256 characters |
| `ECOMMERCE_FULL_SYNC_TIMEOUT_MS` | 5000 (100–10000) |
| `ECOMMERCE_SYNC_BATCH_SIZE` | 25 (1–100) |
| `ECOMMERCE_SYNC_MAX_PRODUCTS` | 50000 (1–200000); oversize selections block before staging or projection |

Current-role/store-authorized routes, all private/no-store with explicit resource/action trace:

```text
GET  /api/v1/admin/stores/:storeId/ecommerce-settings/operations/:operationId
POST /api/v1/admin/stores/:storeId/ecommerce-settings/cancellations
GET  /api/v1/admin/stores/:storeId/ecommerce-inventory-syncs/:syncId
GET  /api/v1/admin/stores/:storeId/ecommerce-inventory-syncs/:syncId/records?after=<id>&limit=50
POST /api/v1/admin/stores/:storeId/ecommerce-inventory-syncs/:syncId/retries
```

Cancellation body is `{operationId, original:{operationId,expectedVersion,threshold,active}}`; retry body is `{operationId}`. Operation/status/row reads perform no sends or projections. Stock reads here are writer-consistent mutation/recovery authority, not a historical reporting scan; no historical MySQL/BQ fallback is introduced.

The existing `StoreSettingsAdministration` now mounts `EcommerceDeliveryAdministration({user,storeId})`. It shows accepted/queued, projected-but-full-sync-pending, unknown, blocked and proven-completed states separately, paged per-row diagnostics, original-operation recovery and explicit resume. It preserves captured actor guards and aborts old owners. No root app/navigation integration is required for this child component.

## Focused evidence and limits

```text
ECOMMERCE_SYNC_MYSQL_TEST_URL=mysql://root@127.0.0.1:3306/pos_rewrite_integration \
  npx -y node@24.22.3 node_modules/vitest/vitest.mjs run \
  tests/administration/ecommerce-sync tests/administration/settings.test.ts --maxWorkers=1
npx -y node@24.22.3 node_modules/typescript/bin/tsc \
  -p tools/administration/ecommerce-sync/tsconfig.tests.json --noEmit
```

Run from `backend`. The fixture creates/drops a fresh `pos_rewrite_ecommerce_sync_<random>` localhost schema using verified physical metadata and actual new migrations. It never mutates the supplied source endpoint. The POS source oracle uses existing cached Django4.2.5/PyMySQL1.1.1 via `uv`; the bridge oracle uses the existing `compatibility/upstream/offline-cash-pricing/.venv/bin/python` (SQLAlchemy/PyMySQL, no install).

```text
ADMINISTRATION_BROWSER_TESTS=true npx -y node@24.22.3 node_modules/vitest/vitest.mjs run \
  tests/administration/ecommerce-sync --maxWorkers=1
npx -y node@24.22.3 node_modules/typescript/bin/tsc \
  -p tests/administration/ecommerce-sync/tsconfig.tests.json --noEmit
```

Run from `frontend`; browser tests use their own random Vite port/temp dependency cache and controlled API/provider responses, without shared dist/default servers.

Evidence covers source exact `>` membership (including deleted/unavailable rows), same/current quantity, held preservation, actual system projection/audits, selected unsupported inputs, removed associations, bounded staging/batches, pending-attempt accounting, concurrency/FIFO, original UUID recovery/cancellation races, writer-current franchise authority, lossless IDs above 2^53, signed/bounded full-sync protocol, actual source I/O bodies/504 batching, isolated bridge SQL migration/claims, source-process privacy and supervised completion/failure/timeout roundtrips. Component/oracle tests do not certify the full deployed legacy/request/side-effect workflow.

Executed focused evidence: 15 native service cases plus the bridge wrapper (16 Python/source/native subcases and the actual Node/Python supervised completion roundtrip); five signed-HTTP and three existing settings units; nine existing settings/native regressions; six new Chromium flows plus two journal units and one existing settings Chromium regression. Backend/frontend scoped strict checks and lint passed. The new receiver source binding also proves writer quantity versus a deliberately lagging replica, refusal of alias reversion, and refusal of a read-only server.

Outstanding acceptance is concrete: select/accept the existing stock candidate, deploy the private pinned source bridge/schema and dedicated worker, align source catalog reads with the real operational writer, accept all overlapping catalog-writer cutover/coordination, and verify real configured Mongo/Redis/Akamai and Slack operation. No live sends, source DDL, source modifications or production deployment occurred here. No AWS/boto3 calls were added or changed; the source CDN consumer is Akamai.
