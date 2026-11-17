# Owned private source runtime and post-completion publication

This candidate executes the pinned API-v2 revision
`2960acbea10c4eaf16b6d99e15ff6e03ef7724c5` in the dedicated private process.
It does not change the protected source repository, public source service,
financial amount, stock projection, approval, or source order ownership.

The selected preparation and financial commands retain the original operation,
plan, current authority, contact, source time, and native preparation lease
bindings. A preview is still SELECT-only and always rolls back; it cannot mint
an order, payment, source absence, or source completion proof. Missing historical
facts still fail before source order dispatch. The actual membership eligibility
branch decides whether the preloaded warehouse document is required.

## Actual source effects and import boundary

The original `libs/celery.py` broadcasts fourteen `add_consumer` commands while
importing, builds two Redis-backed apps, and discovers unrelated workers. The
owned `private_celery.py` verifies its exact SHA-256, substitutes the two real
Celery app factories, and omits only those eager control/discovery statements,
the obsolete transport assignment, and the unused Redis broker expression.
No request asks a worker to change subscriptions. Operators must configure the
declared durable queues and their real approved consumers before activation.

Required private producer configuration:

- `POS_LEGACY_IMPORT_CELERY_CONTRACT=pos-import-owned-celery-v1`.
- `POS_LEGACY_IMPORT_BROKER_URL`: confidential `amqps://` URL, port5671/default,
  no query/fragment; never include it in application logs.
- `POS_LEGACY_IMPORT_BROKER_CA_FILE`: mounted CA file. Certificate and hostname
  verification are required for both source apps.
- `POS_LEGACY_IMPORT_EFFECT_QUEUES`: JSON list of exact allowed durable queue
  names, including the fourteen configured original consumer queues, the queues
  used by original selected producers, and `user_cart_track_0` through `_9`.
- `POS_LEGACY_IMPORT_DEFAULT_QUEUE`: declared default (default `pos-import-effects`).

Both apps require publisher confirmation, persistent delivery, no publish retry,
no dynamic queue creation, bounded connection establishment, and no eager task
execution. The original task's own app selects the route. Each broker publish
has a 5-second write/confirmation timeout. Task argument display headers are
static redactions; the actual source arguments are unchanged. A successful broker
confirmation is a **queue acceptance**, not proof that a downstream SQS, SMS,
warehouse, analytics, or CRM consumer finished its business effect.

`fast_queue_helper.py` is also pinned. Its actual partition function and actual
process-order/after-payment functions calculate the source payload, including
the Python integer hash, quantity/COD fields and wall-clock strings. The private
capture replaces only consumer control and `apply_async`. It records a
`cart-tracking` effect in the existing encrypted source outbox. Capture requires
the owned transaction and collector; a caught source exception cannot make a
refused capture look successful. Preview suppresses these producers. A final
order captures them, then broker dispatch happens only through the existing
once-only publication claim after commit. Unknown acknowledgments remain
uncertain and never resend automatically.

The source `push_process_order_event` call is in `ProcessingOrder.on_post`.
`push_after_payment_event` is called by `StoreUTM.on_get`; it is not called by
the selected private `PosOrder`/`SyncOrderById` chain. Its literal payload is
qualified, including the 365-day checkout marker, but this candidate does not
invent that call in another source entrypoint.

The private process installs its silent source logger before controller imports.
All eight known source Redis aliases are read-only before aliases can be
captured. Beaker source functions execute read-through against the current
owned transaction, with no Redis cache read/write or invalidation in that
frame; the exact original region declarations are initialized without importing
source main. An explicit qualified postcommit membership invalidation keeps its
original external port. No preview writes a cache merely because its SQL rolls
back. This policy applies only to the dedicated nonpersisted private cart.

The literal `CatalogController.pdp_data` reads `get_param('gender_type',None)`.
The private request now supplies that actual Falcon accessor over its empty
owned parameter dictionary; no external URL/query is introduced.

## Real public-origin completion delivery resource

`public-screening-writer/publication_resource.py` supplies the actual private
HTTP path for already completed Node-origin source effects. The existing private
WSGI runtime optionally mounts it, using a separate confidential caller key:

- `POS_PUBLIC_SCREENING_PUBLICATION_CONTRACT=pos-node-screening-publication-resource-v1`.
- `POS_PUBLIC_SCREENING_PUBLICATION_KEY`: independent from the source proof key,
  CSV source-auth key and public customer-context key.
- `POST /internal/pos/public-screening/publications` with strict JSON
  `{ "operationId": "original-uuid" }`.
- `GET /internal/pos/public-screening/publications/:operationId`, with no body.
- Header `X-POS-Public-Screening-Publication-Key`; optional bounded `X-Request-ID`.

Both methods verify the retained source creation, genuine signed Node completion,
COUNTED reservation, native financial projection/lines, and sealed original
effects. There is no generic paid flag, cart reload, stock mutation, confirm,
or order redispatch. GET never inspects routing or publishes. POST calls the
original producer dispatcher only for a verified pending effect. Processing,
uncertain, accepted and cancelled states cannot cause another send.

Response is strict `{data,proofHash}`. `data` contains only
`contract=pos-node-screening-publication-v1`, operation/creation/completion/effects
hashes, status, original delivery IDs/kinds and safe integer `updatedAt` epoch
milliseconds. The proof is the existing source HMAC under purpose
`legacy-order-imports.source.public-screening-publication.v1`. Accepted delivery
count/order must match the sealed intent kinds. Logs contain only static
module/resource/eventId, validated requestId and actor ID from the verified
creation. No payload, contact, credential, path/query or raw exception is logged.

Default selection is off. With a retained valid caller key and the resource
selector disabled, the running private service keeps a GET-only mount; POST
is refused before publication. Do not remove retained proof/caller keys while
unknown deliveries still need reconciliation. The resource belongs behind private HTTPS/mTLS, not
the public cashier gateway. The Node worker must persist its original POST
dispatch before sending; after any unknown reply it uses only GET.

## Executed evidence and limits

Focused source/resource tests live in `tools/source-runtime-acceptance` and
`tests/source-runtime-acceptance`. They prove literal FastQueue payload/partition
equivalence (including full-width IDs and nullable contacts), refused unowned
captures, preview suppression, both task apps' routing, cache isolation and
private HTTP/auth/log projection. Native resource cases validate real COUNTED
and projection proofs, bad auth, tampering, exact lost-response GET recovery,
and no resend after an unknown broker ACK.

The actual source Catalog→Cart(add/get)→Validate→Processing/calculator→PosOrder
classes run through the owned native receiver with declared synthetic
catalog/Mongo/pricelist/cart-store/address I/O. Actual constructors, HP/refund
SQL, transaction rollback and source receipt/outbox binding use disposable
MySQL. A full-width product ID is preserved. A late failure removes the header,
HP and effects and retains a signed no-financial-effect rejection. The selected
Node preparation factory/core also invokes the actual rollback-only source
preview before final order dispatch; an active member works with no warehouse
configuration. That fixture deliberately stops before Go/payment/provider
confirmation and does not certify it.

`bootstrap_probe.py` initializes the real SourceRuntime in the existing source
dependency image with `--network none`, while refusing every Redis command,
Celery control/publish and boto3 API call. It compiles source settings with a
generated fixture environment and disables dotenv discovery. It opens no
developer/source `.env`. Success proves bootstrap/dependency safety, not live
catalog consistency or every original product initializer/pricing wrapper.

No source consumer/provider or deployment was activated. Actual production
catalog/cache/pricing combinations, broker/consumer TLS/ACL/queue configuration,
consumer privacy and delivery, and the previously documented shared writer,
warehouse publication and financial cutover qualification remain acceptance
requirements. These tests are not a blanket production parity certificate.

## Root integration inputs

No SQL migration or Node dependency is added. Keep the Node `cart-tracking`
publication kind from the reporting composition. The legacy-import generator
must include/hash `private_celery.py`, `private_cache.py`, `cart_tracking.py` and
the changed runtime/source/receiver/effects files. The public-screening generator
must copy/hash `publication_resource.py`. Root owns those manifests/packaging.

Executed at this handoff: the owned Vitest group passes 17 cases (14 native
cases plus three Python-oracle launch cases); those launch cases execute
20 source/resource Python tests. The existing protocol nine cases and
source-session five cases pass. Scoped TypeScript, ESLint and diff checks pass.
The actual-dependency Docker bootstrap reports zero external calls. A separate
checkout-owned cross-boundary native test also used this actual WSGI resource:
genuine Node cash completion/COUNTED→POST accepted→lost reply→new GET-only worker,
with the original cash amounts unchanged. That test is owned and registered by
the checkout agent, not counted in the 17-case group here.

Run from `backend` with the pinned original source in
`POS_LEGACY_IMPORT_SOURCE_ROOT`:

```sh
npx --offline node@24.22.3 node_modules/vitest/vitest.mjs run tests/source-runtime-acceptance --maxWorkers 1
npx --offline node@24.22.3 node_modules/typescript/bin/tsc -p tools/source-runtime-acceptance/tsconfig.json
```

For native cases use the fixture-only
`CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1:3306/pos_rewrite_checkout_test`.
Each suite creates and drops its own random schema. No live reader/writer URL
is accepted by the Python native drivers. Native setup should run without
concurrent heavy fixture-DDL batches; timeouts are unchanged.
