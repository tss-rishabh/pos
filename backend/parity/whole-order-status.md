# Whole-order STORE status requests

This implements `AjaxUpdateStatusVincView` and `push_vinc_order_for_all` as a
separate whole-order feature. Express PACK/SHIP and local-delivery commands are
not used as evidence for it. The private receiver that executed copied sync-API
STORE functions (`compatibility/upstream/whole-order-status`) was deleted on 19
November 2026, together with its handover barrier. Sections below that describe
the receiver are historical. See `w2-followups.md` for the legacy sync-API
dispatch that must replace it.

## Source evidence

POS source pin: `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.

- `order/views.py:4420`: `AjaxUpdateStatusVincView` selects **every** physical HP
  ID, preserving duplicate SKUs and zero-quantity rows; supported stages are
  PACK/SHIP/DELIVER. There is no catalog join or fulfillment subset selection.
- `helpers/helpers.py:1133`: default `is_hyperlocal=False` means
  `/store-order/status`, with exactly `orderId`, `has_product_ids`, `platform`.
- `core/tasks.py:226`: `push_vinc_order_for_all` selects the same complete HP set
  and forces PACK. `order/libs/calculations.py:167` invokes it after a failed
  warehouse return, rather than as a normal paid-order callback.
- `order/views.py:451` and `order/templates/order/show.html:293`: four status
  columns, default `-`/empty date, and successful PACK implies successful CREATE.
  The original query does not order duplicate logs; the rewrite uses PK order
  for deterministic presentation. Ordinary single-current-log values agree.

Sync source pin: `70b80159016db39a73572f80bfa87c47201c0a9f`.

- `new-src/api/services/vinculum/storeOrderVinc.ts`: seven extracted functions
  implement the original STORE payloads, strict vendor success
  (`responseCode === 0 && responseMessage === 'Success'`), quota/failed/unexpected
  classifications, successful/already-successful chaining and both Netcore POSTs.
- `new-src/config/server.config.ts:306`: initial delays 300/60/60 seconds and
  retry delays 60/60/60. Rate-limit defaults are PACK 0, SHIP 0, DELIVER 100 per
  300 seconds. The rewrite serializes pacing in SQL across workers.
- `new-src/api/models/orderModel.ts:487`: log upsert matches order/minimum HP/stage;
  this key and source IST log timestamps are retained. The source Netcore left
  joins preserve missing catalog rows, parent URL fallback and repeated HP rows.

`compatibility/upstream/whole-order-status/source-manifest.json` records the exact
upstream file digest and extraction. `pinned-source.js` is executable generated
source without the original bootstrap, credentials, global logger or DB imports.
`pos-source.json` contains three pinned POS fragments for portable tests; native
Django differential checks require the actual original checkout.

## Authority and deliberate corrections

- Source browser authentication/arbitrary-order bypass is removed. Each new
  request requires current active operator, role/type, store assignment, check-in
  and paid whole-store order authority. Other-store associations, split/HL/Express
  scope and unproven partial SUCCESS logs fail closed. An OrderStore association
  never grants another store's HP subset.
- The first POST freezes UUID, exact HP/order/store/counter/customer/reference
  snapshot and hashes. ID strings and BigInt binds remain exact above `2^53`.
  The source `parseInt`/`Math.min` precision loss is corrected explicitly.
- A harmless, authenticated nonce challenge qualifies the receiver before the
  first effectful POST. Old source task acknowledgements cannot qualify it.
  Signed queued acknowledgement means accepted work, never vendor completion.
- Native per-stage claims and immutable per-attempt rows fence vendor dispatch.
  Timeout, malformed reply, uncertain DB completion and expired claims become
  UNKNOWN; GET recovery never dispatches again. No `force`/clear-success path is
  exposed. Already successful stages continue the chain without another send.
- A source negative code is automatically retried **only** with the explicit
  `vinculum-status-no-effect-v1` vendor contract and configured response-code
  allowlist. The source retry delay is retained and the stage budget is bounded
  (default 5, maximum 20). Unknown/UNEXPECTED responses are never made retryable
  by that setting. Without qualification, negative results remain recorded
  rejections for reconciliation. Quota and not-created retry cases execute in
  native tests with this explicit contract, not an inferred production promise.
- Return repair requires the durable original return operation to be definitively
  rejected with `RETURN_INBOUND_REJECTED` and no uncertain stage. It queues PACK;
  it does not alter return, refund, cash, stock or the original failed outcome.
  Proven full-set legacy PACK/SHIP success can continue directly to DELIVER.
- Netcore retains the literal two payloads and their order, including the source
  `fields_to_syn` key. Each activity/contact call has its own durable fence;
  unknown outcomes are retained. Awaiting their bounded attempts makes completion
  observable, while source fulfillment success remains separate from notification
  failure. A partial/unproven notification is never blindly repeated.
- Original payload/error logger arguments are discarded. Worker events contain
  resource/module, event ID/instance, original request ID (up to 128 chars), user
  ID and static outcome only. Unknown vendor message text is redacted in newly
  written source logs; classification/code and ordinary visible status/date stay
  intact. No contact, credential, raw HTTP/SQL error or request body is logged.

These are current operational command/status/authorization reads. Historical
order browsing remains on the separately qualified BigQuery path; warehouse
facts do not authorize an external status write.

## Root integration

The original return-failure producer is now connected through the additive durable
obligation integration in [rejected-return-repairs.md](rejected-return-repairs.md).
That document supersedes the earlier optional producer-hook guidance below and
defines the mandatory handover barrier and manager recovery.

Public registrar: `registerWholeOrderStatus(app, config, db, options?, dependencies?)`
from `src/modules/legacy-order-status/index.ts`. It returns the service; tests/demo
may inject a synthetic service through `dependencies.service`. Do not supply real
DB dependencies to demo routes.

- GET `/api/v1/stores/:storeId/orders/:orderId/fulfillment-status`
- POST `.../status-requests`: `{ operationId, platform, scopeHash }`
- GET `.../status-requests/:operationId`
- POST `.../status-repairs`: `{ operationId, returnOperationId }`

The trusted return workflow may call
`service.repository.enqueueRejectedReturn(tx, principal, storeId, orderId,
operationId, returnOperationId, requestId?)` **in the same transaction after the
definitive rejected state is persisted**. Ambiguous transport failures are not
eligible. Normal return outcomes must remain unchanged.

Private candidate: `registerQualifiedWholeOrderStatusReceiver` from
`receiver-plugin.ts`, explicitly opted in on a service receiver sharing the same
writer and migration. Its `/store-order/status` POST and operation GET use header
credentials plus a purpose HMAC before DB work; browser cookies grant no access.
`/store-order/status/capabilities` is a signed, no-effect readiness challenge.
Deploy at the exact base selected by `BACKEND_SYNC_API_BASE_URL`. Drain/exclude
unqualified legacy status workers for selected orders before enabling; otherwise
cross-writer exactly-once acceptance is not established.

Migration: `src/modules/legacy-order-status/migration.sql` (six rewrite-owned
tables). Register it through the shared deterministic migration runner. Copy this
SQL and `compatibility/upstream/whole-order-status/pinned-source.js` plus
`source-manifest.json` into the backend image at those relative paths. No original
repository or original dependency install is required by the runtime.

Frontend: `WholeOrderStatusActions({ user, storeId, orderId, online })` from
`frontend/src/pages/order-status/index.ts`. Root mounts it on the authoritative
order detail. It saves only immutable operation metadata, binds it to full
operator/store scope, restores by GET and blocks overlapping/unknown actions.
Retrying an unrecorded POST reuses the exact intent; it cannot repeat an already
claimed vendor dispatch. No additional payment/order/stock call is made.

Sender options: `WHOLE_ORDER_STATUS_CONTRACT=pos-whole-order-status-v1`,
`BACKEND_SYNC_API_BASE_URL`, `BACKEND_SYNC_REPO_API_KEY`, independent private
`WHOLE_ORDER_STATUS_RECEIPT_KEY` (at least 32 chars),
`WHOLE_ORDER_STATUS_WORKER_ENABLED=false`, HTTP timeout 10000ms and claim timeout
300000ms. Secrets belong in headers and must be redacted by host request logging.

Receiver options (disabled by default):
`WHOLE_ORDER_STATUS_RECEIVER_ENABLED`,
`WHOLE_ORDER_STATUS_RECEIVER_WORKER_ENABLED`,
`WHOLE_ORDER_STATUS_VENDOR_SHIPPED_URL`,
`WHOLE_ORDER_STATUS_VENDOR_DELIVERED_URL`,
`WHOLE_ORDER_STATUS_VENDOR_API_OWNER`, `WHOLE_ORDER_STATUS_VENDOR_API_KEY`,
`TSS_EVENTS_URL`, `TSS_EVENTS_APP_ID`, `TSS_EVENTS_APP_KEY`.
All configured service URLs require credential-free HTTPS (isolated localhost
HTTP is accepted only in test/development). Delay/rate keys are the pinned
`SQS_STORE_ORDER_*_INITIAL_DELAY_SECONDS`, `SQS_STORE_ORDER_*_RETRY_DELAY_SECONDS`,
`VINCULUM_*_RATE_LIMIT_MAX` and `VINCULUM_*_RATE_LIMIT_WINDOW_SECONDS`.
Optional verified-negative retries also require
`WHOLE_ORDER_STATUS_DEFINITE_REJECTION_CONTRACT`,
`WHOLE_ORDER_STATUS_RETRY_RESPONSE_CODES` (JSON integer array) and
`WHOLE_ORDER_STATUS_MAX_STAGE_ATTEMPTS`.

## Focused evidence

- Backend: `tools/legacy-order-status/vitest.config.ts` — 44 checks, including
  24 real isolated MySQL cases. Covers original POS/Django selection, full-width
  IDs, repeated SKUs/missing catalog/zero quantity, 20 concurrent intent/worker
  retries, all terminal/unknown outcomes, delayed bounded retries, source log
  upsert/timezone, Netcore, rejected-return repair and stale authority/session.
- Native opt-in:
  `WHOLE_ORDER_STATUS_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_whole_status_test`.
  The fixture creates/drops only a randomized `pos_rewrite_whole_status_*` schema.
  Set `WHOLE_ORDER_STATUS_ORACLE_PYTHON` to the existing Django/PyMySQL interpreter
  for the actual original ORM differential; the URL is never used for production.
- Strict backend: `tools/legacy-order-status/backend.tsconfig.json`.
- Frontend strict: `tests/legacy-order-status/tsconfig.json`; controlled Chromium
  harness `tests/legacy-order-status/browser-check.mjs` — 10 checks, ephemeral
  loopback port/private temporary cache, no shared dist/default ports. Restoring
  pending/lost responses, same UUID retry, current actor and offline blocking are
  included. This is a mocked transport check, not live provider acceptance.

No broad route-parity or live latency certificate is implied. Existing source
order/HP indexes and new queue/active-order/per-attempt indexes bound the reads;
no live index/DDL change was applied.
