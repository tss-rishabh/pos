# Local delivery lifecycle and durable jobs

Source: `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.
Upstream API-v2 inspection: `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`.
Stock source: `backend-sync-api@70b80159016db39a73572f80bfa87c47201c0a9f`.
This extends `legacy-fulfillment.md`; ExpressLineItem remains a separate family.

## Implemented source surfaces

| Source                                                     | Rewrite behavior                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AjaxHlOrderView.create`                                   | Actual durable courier creation, split-safe HP status changes, current store handoff, reservation settlement, source audit, producer and Slack effects. A definitive side-effect-free rejection may enter conversion; a timeout cannot. |
| `AjaxPassOrderView` / `auto_hl_order_transfer`             | Atomic original-store unhold and aligned-backup holds, attributed notifications, source transfer timestamp/comment, cutoff/buffer conversion scheduling and timeout alert.                                                              |
| `AutoHlOrderView` / `check_advance_order`                  | Independently authenticated inbound arrival, actual per-HP holds, weekday/first-slot selection, source advance-success timestamp, delayed notification and transfer jobs.                                                               |
| `AJaxConvertOnlineView` / `auto_hl_order_to_online`        | Durable online creation, exact selected child-SKU/quantity proof, split charge-refund verification or unsplit wallet/history arithmetic, parent HP status changes, conversion log, source comment, email and CRM effects.               |
| Manual cancellation / `WebhookCancelledOrderView`          | Independent observer credentials, exact affected-HP cancellation proof, source flags/audits, current-store restoration, notification and shared cancellation/RTO movement proof.                                                        |
| `advance_order_notification` / delayed transfer/conversion | Durable leased jobs, stable child command IDs, replay-safe local transactions, current recipients and terminal-order skips.                                                                                                             |
| `auto_hl_order_create`                                     | Creation behavior is available through the explicit courier-request command/worker. Its only source scheduling call is commented out; no new timer is invented.                                                                         |

The source outbound payloads and endpoint suffixes are preserved, including
form-origin order/store strings and numeric customer/SKU/new-email-order IDs.
Contacts needed by a CRM command remain private business data in its SQL
descriptor. They never enter API URLs, receipts, tracing or error logs.

## Command and movement authority

Every browser command binds a UUID, request hash, captured operator, store,
order, action and source snapshot. Writer-current active identity, assignment,
store and SQL check-in are checked before staging and again before financial
dispatch/finalization. Customer status/block and token mode are reread before
token issuance. Manager recovery requires current checked-in roles 1–4 and an
expected receipt version; the original actor is retained separately from the
recovery actor.

An order-scoped active-command fence serializes delivery transitions and the
existing pack/RTO path. The original `pos_rewrite_legacy_rto_receipts` authority
now accepts a strictly validated cancellation movement proof as well as an RTO
proof. Physical stock is restored once regardless of whether cancellation or
parcel receipt arrives first. Financial cancellation has its own immutable
command proof, so RTO stock receipt alone cannot suppress a legitimate refund.
Later observer IDs cannot repeat the same cancellation. Old unaudited movements,
raw cancellation audit/refund flags and incoherent source state require review.

Each stock transaction includes held-stock rows, per-HP audits, the native
verified stock projection, command/movement state and product-sync outbox. A
late failure rolls all of them back. Ordinary staff projection accepts only
positive identities. Independently authorized durable jobs use the separate
literal actor-0 system capability and trusted synchronization wrapper; a body
flag or a fabricated account cannot grant it. Existing visibility flags are
preserved. Multiple HPs for one SKU retain sequential audit multiplicity.

## External outcome handling

Provider calls are durable descriptors with unique IDs and a canonical validated
request hash. Workers lease them using row locks/SKIP LOCKED, then send outside
the SQL transaction. A sending lease that expires becomes uncertain. HTTP
errors, timeout, malformed responses and unknown partial commits never trigger
a blind retry, fallback conversion or refund. A separate approved read-only
reconciliation adapter must bind operation, kind, scope and request hash, and
prove either the completed result or that no send occurred before requeue.
Result kinds must match the requested operation. Attempt fences reject stale
acknowledgments after another lease/reconciliation changes the call.

Local finalization verifies actual source child orders or cancellation rows and
selected HP multiplicity before stock changes. Split charge refund additionally
checks the source addon and its exact wallet ledger. Unsplit refunds retain the
source binary-float wallet arithmetic and Python ties-to-even history rounding;
the implementation does not substitute decimal arithmetic that changes output.

Financial calls and auxiliary communications have separate sequencing. A failed
Slack/email/CRM delivery remains visible but cannot change a completed financial
phase or clear an uncertain refund/conversion. Per-store Slack destinations and
optional common copies are separate durable calls; only the destination hash is
stored, and a changed URL requires review. Accepted auxiliary effects retain
their captured order/HP/store scope after a later legitimate store transfer;
the original staff member need not remain checked in to deliver the already
accepted notification. CRM acknowledgment queues the source ticket-summary
alert using the resulting ticket ID. No external sends were exercised live.

## Explicit source corrections and rollout limits

- The source split cancellation loops once per HP, while its upstream SKU
  endpoint sweeps every matching HP. One call per distinct SKU is used only
  after proving its whole affected set equals the selected local-delivery HPs.
  Mixed-platform/store effects and implicit Bamboo/welcome-note SKU effects
  require a per-HP upstream extension or reconciliation; selection is never
  widened. Both special SKU IDs must be configured for a mixed split.
- `main_location_id` is the initial landing store, not current stock authority.
  A backup acceptance changes `Order.location_id`; RTO uses that current store.
- An initial HLO row is optional in the source arrival/pass path. The rewrite
  accepts proven platform-4 deliveries without fabricating a log; confirmed
  create/manual cancel/conversion inserts source defaults, while observer
  cancellation retains update-only behavior. Ordinary POS orders remain denied.
  Missing-log inserts require the reviewed nullable unset-exception-date
  correction in `legacy-fulfillment-query-proposals.md`, verified before staging
  and dispatch. The physical NOT NULL/no-default column cannot be bypassed by
  an environment assertion or an invented exception timestamp.
- The source timed-transfer positional argument puts a reason category into
  `staff_user`. Typed jobs retain real staff attribution and category separately.
- The deployed Product schema has no legacy `stock`/warehouse stock columns.
  Online eligibility uses verified `product_stocks.stock > 0` for every selected
  SKU. CORE_WAREHOUSE holds remain unavailable: bounded read-only evidence
  (`mysql-core-warehouse-associations.json`) finds no active Store→HL mapping.
  Warehouse IDs are not guessed from Store IDs.
- Source partial SQL/provider effects, unscoped mutations, raw-error/PII logging,
  repeated stock increments and unsafe-number IDs are corrected. Source 32-bit
  administrator/location columns are range checked before external dispatch.
- Existing legacy cancellation writers must share this command/movement
  authority or be quiesced before activation. A new caller contract cannot prove
  that external old writers are coordinated. Provider observations, verified
  stock configuration and real transport acceptance remain release gates.

## Integration and configuration

`registerLegacyFulfillment` invokes `registerLegacyLifecycle`; no second root
registration is needed. Its optional `lifecycle:false` is a bounded test seam.
The existing `/local-deliveries` page now includes `DeliveryLifecyclePanel`.
There are ten additional resource-traced routes: capabilities/history, four
commands, current command/evidence review and two service-event resources.
Every response is private/no-store. Reasons are POST-body data.

Apply additive `src/modules/legacy-fulfillment/lifecycle/migration.sql` after the
original legacy migration. Standalone fixtures also apply root's additive
`fulfillment/trace-migration.sql`, preserving full 128-character request IDs.
The four new tables hold order state, commands, provider calls and due jobs.
The original migration checksum is unchanged.

Activation requires `LEGACY_DELIVERY_MOVEMENT_CONTRACT=pos-local-delivery-movement-v1`,
`LEGACY_DELIVERY_WORKER_ENABLED=true`, the ordinary stock projection contract,
`POS_SYSTEM_STOCK_PROJECTION_CONTRACT=pos-system-stock-projection-70b801-v1`
and the approved replay-safe product synchronization adapter. The in-process
distributed worker defaults to disabled; interval/batch/HTTP limits are validated
by `lifecycle/options.ts`. Root owns environment/deployment wiring.

Source configuration names are reused: `APP_ID/APP_KEY` for arrivals,
`TSS_OBERVER_APP_ID/TSS_OBERVER_APP_KEY` for observer events (headers only),
`TSS_OBERVER_URL`, `MAIN_API_V2_URL`, `ORDER_PRODUCER_*`, `MJML_HOST`,
`SLACK_URL`, `COMMON_GROUP_ALERT_ON`, `BAMBOO_TOOTHBRUSH_EM`,
`WELCOME_NOTE_PRODUCT_ID`, `HYPERLOCAL_CUT_OFF_SWITCH/TIME`, and checkout's
existing JWT keys. The optional outcome adapter uses
`LEGACY_DELIVERY_RECONCILIATION_URL/KEY`. Nonlocal endpoints require HTTPS;
Slack destinations require the approved Slack host; demo mode blocks external
destinations. No credentials are copied into example evidence.

## Verification boundary

Twenty-six actual isolated MySQL cases cover concurrent arrival idempotency,
per-HP holds, backup acceptance, distinct-SKU cancellation and mixed-scope
denials, lost committed cancellation/courier outcomes, actual delayed
conversion, exact split/unsplit ledgers, writer revocation/customer blocking,
both cancellation/RTO arrival orders, all-or-nothing late stock failure,
advance-slot recipient freshness, independent alerts during financial
uncertainty, late-attempt fences, exact HP-link attribution and missing-log
arrival/pass/create/cancel/conversion/observer behavior. The exact source-column
correction is exercised only in the guarded local schema; existing dates/rows
are preserved and original strict insert failure is proven. The fixture uses IDs above JavaScript's safe-number limit and the
actual native stock projection, never a live provider or production database.

Pinned source ASTs run only with inert ORM/HTTP/task doubles: nine payload
profiles, eight arrival scheduling vectors, seven transfer-task vectors,
hold/release/consume arithmetic, Python rounding vectors and the exact source
nullable exception-date formatter. This is method
evidence, not a full Django HTTP/template run. Separate HTTP tests prove missing
or invalid service credentials cannot use an authenticated browser cookie or
touch the DB, plus strict input/captured-actor/resource traces. Twelve frontend
journal tests include the earlier packing/RTO cases and the new command flow.
Nine additional browser workflows pass with 63 mocked HTTP requests, zero page
errors and zero unexpected requests. They cover courier-response recovery,
transfer reason/category, online replacement, immutable cancellation retry,
manager evidence review and check-in/readiness/offline/logout boundaries.
Evidence is `parity/evidence/legacy-fulfillment/lifecycle-browser.json` and
`lifecycle.png`. The earlier nine packing/RTO browser workflows also pass after
integration; their current harness makes 53 mocked requests. Both use a
controlled loopback Vite4490 server, which is closed after verification.

These checks establish the stated bounded behavior. They do not certify all
legacy providers, mixed-runtime writers, warehouse schemas, external delivery
or production readiness.
