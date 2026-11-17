# Current source controls for coupon publication

Implementation is complete in this change; parity and testing are deferred until
the remaining feature/integration code is complete, following the user's work
order. This document does not certify deployment or production readiness.

The private source factory optionally mounts:

```text
GET /internal/pos/coupon-history/controls/current
X-POS-Coupon-History-Controls-Key: <separate confidential caller key>
```

Enable it with `POS_COUPON_GENERATION_CONTROLS_CONTRACT` set to
`pos-csv-coupon-generation-controls-v1` and
`POS_COUPON_GENERATION_CONTROLS_KEY` set to an independent key. Both are required;
the default is unselected. The caller key must differ from the source proof,
import, customer-context, publication, negative-recovery, history and birthday
guard keys. Serve this route only through the private authenticated ingress.

The resource has no query, body, customer ID, order nonce, request hash or plan.
It snapshots the source's two actual global Redis keys with bounded GET-only
access before SQL. Literal source automatic/birthday control functions run
against that frozen snapshot and bounded current coupon/settings reads. The
original usage-count call stops before any historical SQL executes. Source
fallback cache writes remain invocation-local and do not modify Redis.

The writer snapshot is READ ONLY, repeatable read, and always rolled back. It
checks the installed writer-definition bodies and reads the actual source
server/schema plus controls/coupon head revisions. The current coupon input
hash and the exact cache/settings combination use the existing source
`coupon-configuration` signing purpose. The response is `{data, proofHash}`;
the proof uses `coupon-generation-config` under the retained source proof key.

The descriptor includes only its contract, coupon ID, configuration/input
hashes, source zone/day/second, writer identity/definition, two heads, observation
time and expiry. Expiry is bounded by 60 seconds and the source day boundary.
Raw cache/settings values, coupon codes, credentials and personal data are not
returned or logged. Resource events include the module/resource, event ID,
event instance ID, request ID and a null user ID for this service operation.

The background publisher derives its generic scope from this authenticated
descriptor. Its separate writer-origin snapshot must recheck the descriptor
before qualifying historical data. Checkout readers consume only prepublished
generations; this endpoint neither calculates history nor refreshes a generation
for a checkout request. Missing controls or writer coverage are unavailable
states, never an inferred empty history.

The Node application installs `couponHistoryRuntime` in its configured source
preparation factory. `CSV_COUPON_GENERATION_CONTRACT` selects
`pos-csv-coupon-generation-runtime-v1`; `CSV_COUPON_PUBLICATION_KEY` is independent
of the membership publication key, coupon history key and source proof key.
The reader is constructed without network or database work. An explicitly
supplied reader remains available for composed runtimes. Invalid selected
configuration enters the existing preparation-unavailable guard, preserving
immutable completed-result recovery. The reader uses the application's
read-only warehouse identity; publisher credentials are configured separately.

Deployment must populate the generation, candidate, order, log and control views
listed in `backend/.env.example` and provide their exact source comparison
fingerprint. Declaring view names does not populate them. A missing, stale or
unqualified generation pauses preparation without a synchronous native history
query or publication attempt. This runtime connection is implemented; validation
is deferred with the rest of the final verification phase.

Preparation also exposes a `couponHistoryDemand` queue port. After authenticating
the source preview and checking the original operation, plan, customer and keys,
an incomplete-generation read can enqueue the exact history scope and witness.
The queue performs no historical query or publication. Preparation retains its
original failure and cannot dispatch an order; queue failure does not replace
that result. The concrete encrypted demand queue is installed by the application
factory; its executable background worker remains a separate implementation
handoff. The coupon publication key participates in
the preparation boundary's complete key-separation check.

The configured import factory selects the concrete encrypted queue with
`CSV_COUPON_GENERATION_DEMAND_CONTRACT=pos-csv-coupon-generation-demands-v1`
and `CSV_COUPON_GENERATION_JOURNAL_KEY`. The journal key must differ from every
financial, membership and coupon authentication/proof key used by preparation.
The selector also requires the configured warehouse reader and a writer-capable
rewrite journal connection. Construction performs no I/O. The additive
`coupon-generation-demand-migration.sql` creates only the encrypted operational
queue and is registered in the deployment migration plan; the application does
not create it on startup. Queue selection remains blank by default.

The shared private runtime mounts the resource after source construction, while
validating its selector/key before database bootstrap. The source manifest
includes all three new modules. No production keys, DDL, cache writes, warehouse
writes or financial actions are executed by this implementation handoff.
