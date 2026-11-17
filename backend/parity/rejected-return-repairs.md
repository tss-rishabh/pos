# Durable repair after a rejected warehouse return

This closes the producer/dispatcher integration for POS source
`push_vinc_order_for_all` after a definite failed inbound return. It extends the
whole-order feature from `71148f3`; it does not certify a live provider or replace
the original return, refund, cash, inventory or exchange outcome.

`returnRepository.failure` records an obligation in the **same writer transaction**
after saving `rejected / RETURN_INBOUND_REJECTED`. Only `stage=inbound`,
`uncertain=false` and that exact source-qualified error qualify. Refund,
replacement and uncertain outcomes cannot arm a repair. A retained negative
acknowledgement can be persisted after the original operator becomes inactive;
it creates a blocked obligation and grants no new handover permission.

The operation UUID remains the original return UUID in the separate command
namespace. The obligation binds original actor/auth version, role/type,
store/counter/order and a rejection descriptor hash including original
customer/line/quantity. It contains no contact, token, free-text return comment or
financial replacement payload. Producer retries cannot change its identity or
create a second PACK command.

Disabled selection records `BLOCKED / RETURN_REPAIR_DISPATCHER_DISABLED`
immediately. No background classification sweep or DB access starts in disabled
or demo mode. Unsupported whole-order scope, changed original authority/customer/
line, missing handover fence and other safe gates never replace the saved
`RETURN_INBOUND_REJECTED` outcome.

## Executable dispatch and recovery

With an explicitly selected, configured operational writer/worker,
`service.repairs.runOnce()` locks the retained return then its obligation and
uses a nested savepoint to call `repository.enqueueRejectedReturn`. Successful
enqueue and `LINKED` commit atomically. An eligibility/configuration gate rolls
back only the savepoint and records `BLOCKED`; no phantom command survives.
There is no HTTP, stock procedure or provider call in this linkage transaction.

The registered whole-order worker executes linkage followed by the existing
qualified sender. Native tests exercise this actual `app.ready()` worker path
through one sender call. The sender/private STORE receiver retain their durable
attempt fences and signed receipts. Unknown outbound outcomes are reconciled
with GET only; manager recovery never creates a replacement command or repeats
the provider request.

Current assigned managers (roles 1–4) can list/read obligations. Recovery also
requires current check-in and an immutable UUID/version audit receipt. Processing
rechecks the recovery manager's current epoch, assignment and check-in, plus the
original operator's frozen authority. A manager does not impersonate a revoked
original operator. Manager receipt refresh rechecks authorization around the
external GET, with no SQL locks held over transport.

Routes under `/api/v1/stores/:storeId/orders/:orderId`:

- GET `/status-repair-obligations`
- GET `/status-repair-obligations/:returnId`
- POST `/status-repair-obligations/:returnId/recoveries` with
  `{ operationId, expectedVersion }` (a metadata recovery operation).

Each receipt identifies the original return/repair UUID, original operator ID,
scope, state, version, static error code and optional command state. No original
return internals are reconstructed by the client. The list explicitly refuses an
unbounded scope above 100 obligations; specific return receipt access remains
available.

The manager panel is mounted inside `WholeOrderStatusActions`, under
`pages/order-status`. Saved status/recovery markers auto-expand the resource and
refresh by GET. A lost metadata reply retains the exact recovery UUID/version.
Strictly invalid storage blocks new status actions and never exposes the raw
stored value. The markers contain identifiers/version/stage/digests only.

## Handover barrier composition

`handover.ts` exports:

```ts
type AssertHandoverAvailable = (
  tx: AdministrationTransaction,
  orderIds: readonly string[],
) => Promise<void>;
assertNoActiveWholeOrderHandover(tx, orderIds): Promise<void>;
```

Pass the mandatory `assertHandoverAvailable` dependency to the public
`wholeOrderStatusService`/registrar and private `wholeOrderStatusReceiver`/plugin.
Absence fails closed, including signed receiver readiness. Authority locks
**Store → Order**, then invokes the composed guard. Prepare, claim and private
every-stage dispatch reach this path. Locks are released before HTTP.

Root composes its cash-return and imported-order guards inside this seam. The
inverse cash-return guard calls `assertNoActiveWholeOrderHandover` under the same
Store → Order locks. It uses current locking reads, validates bounded states and
retains active/uncertain command, stage and vendor-call fences. A terminal command
flag alone cannot clear a missing exact-scope receipt. It cannot use an old RR
snapshot to hide a new handover. Native concurrent prepare/dispatch fixtures allow
only one side to arm. Do not substitute a permissive callback in production.

## Root entry wiring

Register the **additive** `src/modules/legacy-order-status/repair-migration.sql`
through the shared migration runner and copy it into Docker. Existing
`migration.sql` is unchanged. Two new rewrite-owned tables retain obligations and
recovery audit receipts; no live DDL was applied.

In root checkout registration, select the producer with:

```ts
rejectedInboundRepairDispatcherEnabled: !config.DEMO_MODE &&
  wholeOrderOptions.WHOLE_ORDER_STATUS_WORKER_ENABLED;
```

`CheckoutRegistrationOptions` forwards this narrow option into `registerReturns`.
The original failure producer is already connected; do **not** attach a second
best-effort callback that can roll back or replace the warehouse error. The
default is false and remains an explicit blocked receipt.

Register `registerWholeOrderStatus` with the same selected options and mandatory
composed barrier. Its existing bounded worker loop now runs repair linkage and
command dispatch. `registerQualifiedWholeOrderStatusReceiver` remains a separate,
explicit opt-in; it receives the same barrier. Existing provider/receiver flags
remain unselected until deployment acceptance. No new environment secret is
introduced by this obligation layer.

Worker failures identify the actual resource in `eventId`, use one per-run UUID
for request/event-instance correlation and use `userId:null` for an actorless
loop. Credential-bearing thrown objects are not serialized.

## Focused checks

- `tools/legacy-order-status/vitest.config.ts`: 68 backend checks, including 43
  isolated native MySQL cases and actual pinned POS/Django selection. The new
  cases cover atomic producer/linkage, 20-way producer/processor retries,
  disabled/ineligible scope, archived actors, changed customer/quantity,
  manager recovery, lost responses, Store → Order race, private stage guard,
  terminal-state mutation, real registered worker entry and HTTP scope.
- Native opt-in remains `WHOLE_ORDER_STATUS_MYSQL_TEST_URL` with the guarded
  `mysql://root@127.0.0.1/pos_rewrite_whole_status_test` template. Set
  `WHOLE_ORDER_STATUS_ORACLE_PYTHON` for the actual original Django differential.
- Backend strict: `tools/legacy-order-status/backend.tsconfig.json`.
- Frontend strict: `tests/legacy-order-status/tsconfig.json`.
- Isolated Chromium: existing `browser-check.mjs` (10 checks) plus
  `repair-browser-check.mjs` (8 checks), both under `tests/legacy-order-status`,
  ephemeral loopback ports/private temporary caches, no shared dist/default ports.

These are focused local/source/mocked-transport results, not deployment or broad
parity certification. No production writes, providers, messages or package
installation were used.
