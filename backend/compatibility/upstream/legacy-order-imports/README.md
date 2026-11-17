# Private CSV financial receiver candidate

This is executable compatibility code, not an activated upstream service. It leaves the protected source repositories unchanged. The Node adapter, private source process, Go confirmation overlay, native hold guards, stock procedure and durable broker must be qualified together. All new contract flags remain unselected.

The source pins and generated patch hashes are in `manifest.json`. `prepare.py` verifies immutable source bytes (including the original CRLF model file) and composes the Go overlay onto the already reviewed ordinary checkout package. It never edits a sibling repository. Its default is verification; `--write` updates only this directory's three generated artifacts.

## Source orchestration

`runtime:create_application()` is a private WSGI factory. Run it in a separate process with the original API-v2 runtime dependencies and immutable source artifact. `POS_LEGACY_IMPORT_SOURCE_ROOT` and `POS_LEGACY_IMPORT_RUNTIME_ROOT` must resolve to that same artifact. The process imports actual source `PosProductDetail`, Cart, ValidateCheckout, ProcessingOrder, PosOrder, constructors, refund allocator and KinesisProducer. Source authentication decorators are removed only from compiled private classes after the independent capability/native authority checks. This factory must never be mounted in the public application.

The HTTP resources are POST `/internal/pos/legacy-order-imports/:operationId/order` and `/publication`. Each accepts only its strict purpose-bound signed capability and exact original plan/order. Node supplies independent `X-POS-Legacy-Import-Key`, operator and request correlation. The short capability binds operation, native request/plan hashes, isolated namespace, actor/store/counter/customer/contact/approval scope, stage nonce and a maximum 60-second window. Writer/current authority is rechecked after acquiring locks. A stale, changed or unknown command cannot create a new order.

The source cart is an empty in-memory Cart. The original POS persistent cart ignores tabId; neither MySQLCart.instantiate/save nor a guest/customer clear is used. Source Session.commit becomes flush under one actual outer MySQL transaction. Raw commits, implicit-commit SQL, cart persistence and direct HTTP attempts taint/reject the transaction, including swallowed exceptions. Order/HP/refund writes, exact source reference, signed source receipt, held public-order binding and encrypted source effects commit together. A failed source transaction rolls back before an immutable no-effects rejection is recorded under the same operation lock.

Offline creation retains method14. The separately patched Go confirmation requires both its existing projection/customer authentication and the private import capability. It locks current native plan/namespace/scope/contact/operator state, executes the original stock/wallet body once, and writes the import-confirmation receipt in that same transaction. Node then applies the literal dated cash/manual-other completion behavior: HP timestamps change, their PLACED status does not. Manual-other is an audited historical counter amount, never a fabricated provider charge.

Shopify retains method15/payment1/order1/INCOMPLETE lines. It does not invoke ordinary confirmation or manufacture a paid receipt. Node applies the selected transaction-scoped stock projection and durable inventory synchronization. The source payload still uses the first tax digit (`Tax18` becomes `1`); source constructors currently ignore the supplied tax/shipping/discount fields in the demonstrated plain profile. Tests preserve those outcomes, including source currency/address arguments, rather than choosing a new tax formula.

Publication executes the actual pinned KinesisProducer function into an encrypted intent recorder, alongside source cashback/warehouse/FB intents. `publish_once` resolves the actual Celery router, verifies durable/non-auto-delete queues and forces persistent mandatory messages with publisher confirms and no retry. The entire batch is checkpointed before publication; each acknowledged task identity is persisted. A partial/lost ACK freezes the original batch. Repeated calls never republish processing/uncertain work. Final publication proof means durable queue acceptance, not Kinesis downstream processing. Ordinary producer/engagement duplicates are suppressed for imports; other ordinary Go effects remain held until signed native completion is verified.

## Explicit source/schema corrections

`pos-import-source-model-v1` is a separate private ORM codec, default disabled. Native strict-mode oracles demonstrate that the unmodified Shopify constructor throws for unmapped `currency`/`currency_conv_rate`; ordinary source integer defaults for physical ENUM fields raise MySQL1265. The codec maps the two already-existing physical columns, writes source zero as ENUM label `'0'` (not physical reward default `'2'`), and fills source-omitted mandatory OrderStore/HP audit fields with the same empty/zero semantics used by the reviewed cash importer. It verifies the actual physical types/nullability/defaults first. It adds no legacy column or DDL.

Unset source date sentinels use the separately reviewed `pos-offline-cash-order-schema-v1` nullable-date profile. SQLAlchemy NULL is explicit so its scalar defaults cannot restore an empty date; courier empty becomes zero. No SQL mode is changed and no event date is invented. The previously approved per-HP refund patch/descriptor is preserved. These corrections are concrete code and independently tested; their live schema/runtime qualification remains open.

## Remaining CODE gaps, distinct from rollout

- Source imported membership, upgrades and automatically added free memberships are rejected before PosOrder with `ORDER_IMPORT_MEMBERSHIP_PROFILE_REQUIRED`. The ordinary membership staging/Go activation producer exists elsewhere, but this private import pipeline does not yet capture its exact prior entitlement/revision/provenance or qualify method15 activation. It must be wired with the existing producer in a later bounded slice, never backfilled from guessed historical state.
- Automatic coupon/wallet/GV/payment discounts, complementary/freebie lines, or any cart SKU/quantity not in the approved CSV manifest are rejected before PosOrder. No old benefits are silently carried, removed or replaced. Source cashback earning and its captured task are supported; this restriction concerns spending/extra allocation profiles.
- Screening SKU390238 has coupled native ticket-count behavior and is explicitly rejected pending its own source-qualified counter profile.
- Offline source calculation/tender mismatches, including nonintegral totals where the source integer payable differs from the CSV float sum, are refused. The original helper can record a different counter tender from its header. Supporting that behavior requires a distinct exact tender/header proof and finance conservation extension; the guard is not a claim that every original decimal/automatic-discount import is complete.
- The disposable native driver executes the real PosOrder bodies, constructors/defaults/refund/reference/flag/address-mapping writes and producer function, with synthetic catalog/cart/delivery I/O and a pre-existing fixture address. It does not certify the entire deployed catalog/cache/address-creation runtime. A full sandbox run of the actual private SourceRuntime, actual source settings and durable broker/consumers is still required. Unpatched independent writers and historical funding reconciliation remain activation blockers.

## Deployment hooks (not executed)

Use `gunicorn -c gunicorn.conf.py 'runtime:create_application()'` from this directory in the isolated existing source runtime. The config binds localhost8127, disables access/error/request dumps, and uses two single-thread workers. Private TLS/mTLS ingress is required. Set:

```text
POS_LEGACY_IMPORT_SOURCE_CONTRACT=pos-legacy-order-import-source-v1
POS_LEGACY_IMPORT_MODEL_CONTRACT=pos-import-source-model-v1
POS_LEGACY_IMPORT_SOURCE_ROOT=<immutable API-v2 artifact>
POS_LEGACY_IMPORT_RUNTIME_ROOT=<same artifact>
POS_LEGACY_IMPORT_MYSQL_WRITER_URL=mysql+pymysql://<writer>/<schema>
POS_LEGACY_IMPORT_MYSQL_CA_FILE=<verified CA file>
POS_LEGACY_IMPORT_KEY=<independent private capability key>
POS_LEGACY_IMPORT_PROOF_KEY=<independent source receipt key>
BUSINESS_TIMEZONE=Asia/Kolkata
```

The actual source Celery app must have AMQPS, `broker_transport_options.confirm_publish=true`, `task_publish_retry=false`, persistent default delivery mode and qualified routes/queues. Source debug/print/application logging is closed before its imports; this process emits only static module/resource/event identifiers with validated request ID and capability-authenticated operator. No body, URL, SQL exception, credentials, customer contact or queue payload is emitted. Logger failure cannot reverse committed work.

Apply the reviewed Go overlay via `payments-import-overlay.patch` after the existing ordinary checkout compatibility patch. Go additionally needs `POS_LEGACY_IMPORT_CONFIRMATION_CONTRACT=pos-legacy-order-import-confirmation-v1`, the two private keys above, and `POS_LEGACY_IMPORT_FINANCIAL_PROOF_KEY`: derive it from the retained Node master using `financialImportKey(master,'proof').toString('hex')`, never reuse the master. Apply `api-import-guard.patch` to cooperating public API-v2 writers with that derived proof key. The middleware guards both order IDs and HP-derived order IDs and has no public bypass. It also reserves legacy customer-JWT `custom_created_at` and custom price/tax/shipping/currency/address override fields for the private receiver; deploying it requires cutting the old CSV/custom-override caller over to the new reviewed path. Ordinary empty override placeholders remain accepted. Deploy all nine rewrite-only tables first; missing tables/keys fail closed. Do not deploy or alter live DDL from this artifact automatically.

## Scoped evidence

From `backend`, using the pinned Node24 and existing locked Python runtime:

```sh
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test node node_modules/vitest/vitest.mjs run tests/legacy-import-financial/adapter.mysql.test.ts tests/legacy-import-financial/source.mysql.test.ts tests/legacy-order-imports/plans.test.ts
node node_modules/typescript/bin/tsc -p tools/legacy-import-financial/tsconfig.json
compatibility/upstream/offline-cash-pricing/.venv/bin/python -B compatibility/upstream/legacy-order-imports/test_protocol.py -v
compatibility/upstream/offline-cash-pricing/.venv/bin/python -B compatibility/upstream/legacy-order-imports/prepare.py
sh compatibility/upstream/legacy-order-imports/run-go-tests.sh
```

The MySQL driver creates/drops only guarded fresh localhost schemas. The Go runner copies the reviewed source to a temporary directory and uses pinned, portless disposable MySQL/Go containers with existing module caches and `GOPROXY=off`. No upstream service, provider, mail, upload, deployment or live data was called.
