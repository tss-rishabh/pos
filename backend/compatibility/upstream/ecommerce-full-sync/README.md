# Private full ecommerce synchronization bridge

This is executable receiver/worker code for the pinned API-v2 full-catalog builder. It does **not** call the old public `GET /syncproduct`: that handler returns `Sync Product Started` before the task has run, and cannot prove completion. No source sibling has been edited or deployed by this change.

`source-manifest.json` pins API-v2 commit `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`, all 263 tracked Python/requirements files, and the POS task at commit `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. Regenerate only against those exact clean commits with `tools/administration/ecommerce-sync/pin-source.py`. The source's complete `SyncProductFull().make_products()` supplies all product transforms/prices/variants/attributes. The bridge wraps its concrete Mongo, Redis and Akamai dependencies; it does not substitute the POS per-product sync endpoint or copy a subset of the catalogue fields.

## Deployment hooks

Deploy beside the existing API-v2 source in an isolated service/worker environment with its existing Python dependencies plus SQLAlchemy/PyMySQL. Keep this directory as an import root; `runtime:create_application()` is a WSGI application factory. Mount the exact private HTTPS resource `/internal/pos/ecommerce-full-syncs` and its `/:operationId` child without path rewriting. Restrict network access to the POS backend. Disable gateway/access request/query/body logging; the application emits only its fixed scalar event allowlist. Do not run it inside the public legacy app/Celery worker process.

Review and apply `migration.review.sql` to the **configured API writer** separately. It creates only three bridge-owned command/coordination/reconciliation tables. The POS migration runner must not apply this external migration. Runtime never creates schema.

Required bridge environment:

| Variable | Meaning |
| --- | --- |
| `POS_ECOMMERCE_FULL_SYNC_CONTRACT` | `pos-ecommerce-full-sync-v1` |
| `POS_ECOMMERCE_FULL_SYNC_SECRET` | Dedicated 32–256 character service key, also supplied to the Node adapter; never reuse customer/checkout/SSO keys |
| `POS_ECOMMERCE_FULL_SYNC_WRITER_URL` | Exact `mysql+pymysql://.../database`, no query options; writer must own the bridge tables |
| `POS_ECOMMERCE_FULL_SYNC_MYSQL_CA_FILE` | Trusted CA file; hostname-verified TLS is mandatory |
| `POS_ECOMMERCE_SOURCE_ROOT` | Source directory matching the pinned manifest; required for the worker |

The source runtime supplies its existing catalog SQL, Mongo, Redis, production-domain and Akamai settings. Verify that its SQL catalog reads observe the writer updated by the selected POS stock projection, and that its configured clients meet the deployment's private-network/TLS policy. No account, source database, provider URL or secret is inferred from the read-only discovery endpoint.

The full module uses `database.Session`, but its imported root `SyncProduct.configProduct` uses `SyncProduct.SessionR` for bundle/sub-variant stock. Inside the dedicated child only, `bind_stock_readers` binds that root helper alias to the same verified `database.Session` object as the full builder. Its guarded callable refuses any alias replacement and retains a failure even if legacy code swallows the error and restores the alias. The source SQL, selected rows, field conversions and option/age behavior remain unchanged. Before and after the full build, the writer session must report `@@global.read_only=0`; a named writer connected to a read-only replica cannot complete. The public app's `database.SessionR`, separate CMS readers and all other processes are untouched. This prevents ordinary replica lag from publishing old bundle/variant stock. Matching the configured API writer to the actual Node stock writer is still a deployment fact to verify; a server role flag alone cannot establish cross-service database identity.

Run the supervised consumer as `python runtime.py worker`. It polls every five seconds, claims one global catalog job, heartbeats while a spawned source process runs, and stops/kills that child on shutdown or a 30-minute timeout. The child disables logging and redirects stdout/stderr file descriptors before importing source code: the source's payload/raw-error logs never enter the parent/service logs. The parent emits `module`, `resource`, `eventId`, operation/worker/request/user IDs and a safe state only. No source JSON, Mongo URI, Redis key, CDN URL or raw exception is logged.

## Completion and recovery

POST accepts the exact immutable UUID/body once and returns a signed `queued` receipt. GET is read-only; its signed404 is the only evidence that the producer may retry POST with the **same** UUID/body. Request MACs bind purpose, timestamp, method, exact path and raw-body SHA256; responses bind purpose, UUID and raw response bytes. A stale/malformed MAC, unsigned404, source's legacy acknowledgment, unexpected result/body hash or unsupported redirect cannot complete the Node effect.

The worker preserves source writes: Mongo `$set`/upsert documents, Redis source key/encoder/SET when enabled, and six product/gender/platform purge URLs with the original 504-URL batch boundary. Success requires acknowledged Mongo writes, acknowledged Redis SETs when enabled, matching complete purge-URL digests, and HTTP201 Akamai acceptance for every batch. Mongo/Redis errors swallowed inside the old builder are retained by the tracker and refuse completion. `cdnBatches` proves accepted purge requests; it is **not** proof that every CDN edge has finished invalidating. The catalog digest covers the acknowledged source documents, not a warehouse publication generation. Source inactive/deleted-product removal semantics are unchanged: this source job upserts the selected active catalog; it does not delete all old inactive Mongo documents.

An interrupted/failed/unknown worker retains global ownership. **No automatic expired-lease takeover** can allow an old process to overwrite a newer catalog. GET reports `uncertain` after lease expiry. The source process must actually be stopped and all its writes settled before an operator reviews/requeues that same operation:

```text
python runtime.py reconcile-stopped <original-operation-uuid> <stopped-worker-instance-uuid> <review-evidence-sha256>
```

The command rejects live leases/wrong instances, appends an immutable reconciliation record and queues the original operation for a fresh full source run. It cannot manufacture a success proof. Keep the review evidence outside application logs; the digest is recorded. After actual provider recovery/requeue, the POS `Resume after reconciliation` control resets its original delivery checkpoint and checks provider GET before considering another POST. A known accepted UUID never becomes a replacement operation.

Before activation, route **all** overlapping legacy full-catalog and individual Mongo/Redis/CDN writers through the accepted coordination/cutover policy. The bridge only coordinates its own jobs. It cannot fence an independently running old `tasks.sync_product` or another service's cache writes. This is an explicit external writer/deployment acceptance boundary, not a claim of global exactly-once provider effects.

## Executed evidence

`tools/administration/ecommerce-sync/bridge-oracle.py` uses randomized localhost MySQL and the actual source Mongo effect block, Redis helper, Akamai class, URL-batching helper and enum. It exercises 20 concurrent acceptance calls, global claim/expired-worker fencing, exact signed protocol recovery, proof validation, stopped-worker review, acknowledged/failed provider fixtures, source-process privacy, and actual spawned-worker→source I/O→SQL proof→signed GET completion/timeout paths. The actual source `configProduct` is executed against deliberately different writer/replica quantities: binding changes only its stock result to the writer value, leaves public/CMS readers alone, and refuses alias reversion/read-only writers. `protocol_fixture.py` additionally drives the real Node HMAC adapter through the Python receiver and supervised worker to completion with lossless IDs above 2^53. All SQL/Mongo/Redis/CDN/source effects in this evidence are isolated or stubbed. This is not certification of a deployed API-v2/runtime/provider workflow.
