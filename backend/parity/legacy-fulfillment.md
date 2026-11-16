# Local delivery status, packing and return receipts

Source baseline: `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.
Implementation lineage uses `legacy-fulfillment`; the product page is **Local
deliveries**, separate from the ExpressLineItem workflow.

## Source boundaries

| Source                                            | Implemented behavior                                                      | Evidence boundary                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `AjaxCheckOrderStatusView.post`                   | First-log status branches, exact successful message and failure summaries | Eleven source-oracle inputs; raw creation-provider errors are intentionally withheld                |
| `AjaxOrderPackView.txn_logger`                    | All matching log `is_pack` flags and exact attributed transaction comment | Eight combined packing/RTO comment inputs plus native concurrent packing                            |
| `AjaxRtoRecievedView.txn_logger/inventory_inward` | RTO flags, normal per-HP inventory steps and source attribution           | Native stock projection, source oracle and approved repeat/split corrections below                  |
| `AjaxHlOrderView.cancel(platform='webhook')`      | Original ambiguity oracle plus shared cancellation/RTO movement authority | Actual lifecycle execution and its separate evidence are described in `local-delivery-lifecycle.md` |

The source return path selects `HasProduct.prod_id`; it does not select a child
from `sub_prod_id`. This slice preserves that specific source profile, including
the physical `prod_id` binding when `sub_prod_id` is nonzero. The shared stock
projection still rejects unsupported stock families. No generic legacy
effective-SKU substitution is invented.

## Explicit corrections

1. **A repeated RTO must not add inventory twice.** The source sets its flag but
   unconditionally adds quantities on subsequent calls. A unique order-scoped
   movement receipt now accompanies the first writer transaction. Different
   command IDs, lost responses and a later cleared source flag cannot trigger
   another restock. Existing source received flags are recorded as unverified
   legacy evidence with zero newly restored units; they are not claimed as
   verified prior stock movements.
2. **A split return must affect the local delivery lines at its own store.** The
   source RTO loop includes every HP. Only platform 4 HPs enter a split return;
   ordinary unsplit returns retain every original HP step. The response shows
   excluded online lines. Another store's stock is never selected.
3. **Cancellation evidence cannot prove remaining inward stock.** The old
   webhook cancellation emits `Hyperlocal Order Cancelled : Amount Refunded`,
   restores stock and leaves an accepted log. Before a new RTO movement, either
   that audit or a refund flag requires reconciliation. A refund flag alone is
   not interpreted as proof that stock moved. An existing rewrite movement
   receipt can be replayed without changing stock, including after subsequent
   refunds/status changes. No guessed residual quantity is posted.
4. **Database effects must commit together.** The source updates flags before
   external/stock work and can leave partial state. The command, comment,
   source flags, inventory projection/audits, immutable movement receipt and
   durable synchronization outbox now commit or roll back together. The
   transaction performs no provider HTTP request.

Per-HP arithmetic and audit multiplicity are retained: two HPs for the same SKU
produce two successive stock/audit steps, rather than one merged audit.
Quantities and database identities stay exact strings/BigInts; a native fixture
uses order, HP, courier and audit IDs above JavaScript's safe-number limit.
The source's `updated_at` is not changed by the flag-only updates.

## Authority, validation and privacy

Normal authenticated browser routes require the captured operator header,
strict runtime parameters/body, current writer operator/store assignment and an
active store. Mutations also require the SQL-authoritative current check-in and
lock the order/store. An order belongs to the selected SW store; an existing
ExpressLineItem pair rejects this workflow. Incoherent courier/log records,
unsafe quantities, missing/duplicate inventory associations and integer
overflow fail before commit. Packing has no stock or financial mutation.

Current operational order/log/line display reads use the primary reader; fresh
authorization, stock decisions and command receipts use the writer. Order age
does not route operational financial authorization into the warehouse. Primary
log/line reads share a read-only repeatable-read transaction. All queries use
ORM-bound values, bounded result sets and existing order indexes; product/store
lock lookups are batched. The required per-HP stock projection/audits remain
sequential. No live index or schema change was executed.

Comments preserve the source's business-audit attribution, including the exact
`RTO Package Recieved By` spelling. Final attributed comments are limited to the
verified physical 255-character column. Native MySQL round-trip validation
checks the actual `latin1` encoding, accepting supported Euro characters and
rejecting lossy text before a stock write. Comment text, contacts, raw provider
payloads, tokens and raw database errors are never sent to observability logs.
Every route supplies a static module/resource/action trace identifier for root
request/user/event correlation.

The client retains only an opaque command UUID and request hash per captured
operator/store/order/action. It does not persist the note. Unknown outcomes use
GET reconciliation and, only on explicit retry, the same command UUID and
original input hash. Actor changes abort pending continuations; they cannot
adopt another user's identity or clear the original user's marker. Offline
mode disables mutations. Tracking links require HTTPS without embedded
credentials, and all displayed product text remains escaped.

Archived operators/stores retain records and receipts. Inactive operators
cannot access receipts or start work; inactive stores reject new operations.
An active assigned operator can read their own earlier immutable command
receipt for an archived store. Ordinary reactivation restores normal authority;
there is no permanent retirement/tombstone mechanism.

## Integration

- Backend export: `registerLegacyFulfillment(app, config, db, options?)` in
  `src/modules/legacy-fulfillment/index.ts`.
- Migration: `src/modules/legacy-fulfillment/migration.sql`, creating only
  `pos_rewrite_legacy_fulfillment_commands` and
  `pos_rewrite_legacy_rto_receipts`. Root registers/checksums this migration and
  copies it into the image.
- Frontend exports: `LegacyFulfillmentPage({user,storeId})` and
  `LegacyFulfillmentPanel({user,storeId,orderId})`. Root owns `/local-deliveries`
  navigation and the link from Express fulfillment.
- Endpoints: scoped order GET, packing PUT, RTO-receipts POST and actor-owned
  command receipt GET under `/api/v1/.../legacy-fulfillment/...`. They return
  private/no-store responses and have four resource trace entries.
- RTO readiness requires the existing configured stock projection contract and
  the approved product synchronization adapter. No legacy stored-procedure
  fallback is enabled. Product synchronization uses the existing administration
  durable worker with reason `legacy-rto`, preserving request/operator/store
  context. Pending synchronization is shown explicitly; the receipt never
  claims delivery until the outbox confirms it.

## Focused verification

- **19 backend checks:** five source/domain checks, one HTTP validation/scope
  check and thirteen actual isolated MySQL checks. The source runner processes
  22 inputs across status, attributed comments, normal/repeated inward and the
  cancellation hazard. It executes only pinned method ASTs with inert
  dependencies; it is not a full Django endpoint/template run.
- **Five frontend command tests:** uncertain committed response, exact explicit
  retry, mismatched receipt scope, captured-actor changes during hashing and
  GET-only recovery without creating an operation.
- **Nine browser workflows:** local delivery presentation, split exclusions,
  inert product text, lost packing response recovery, RTO receipt/audit steps,
  explicit retry, readiness/check-in/reconciliation guards, logout interruption
  and offline action blocking. HTTP is mocked; the independent native suite
  proves actual SQL/stock behavior. Evidence is
  `parity/evidence/legacy-fulfillment/browser.json` and `rto-receipt.png`.
- Native contention cases send 20 simultaneous identical packing commands and
  20 different return command IDs, producing one physical mutation/audit and
  one synchronization event. A late failure after actual projection calls
  rolls back all stock/audits/flags/receipts/outbox state.
- Strict owned backend/frontend test typechecks and lint pass. No live
  fulfillment, refund, notification, product-sync or production write ran.

Reproduce from each package with Node 24.22.3, using its local Vitest, TypeScript
and ESLint binaries. Set only the guarded localhost integration database for the
native suite; it creates and drops a fresh randomized schema. The browser
harness uses a separately controlled loopback Vite server on port 4490 and
supports `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, a verified macOS Chrome fallback or
bundled Playwright Chromium.

## Remaining release and implementation limits

Old create/accept/Borzo creation, pass/transfer, conversion/cancellation/refund,
authenticated observer execution, delayed/advance-slot work and held inventory
now have a separate implementation and evidence map in
`local-delivery-lifecycle.md`. They share the order movement authority and
preserve uncertain external outcomes. Existing Express coverage is not used as
evidence for those behaviors.

The ambiguity guard detects existing source evidence. Concurrent legacy
cancellation writers do not share the new receipt authority and remain an
uncertified mixed-runtime race: they must be migrated to the same movement
contract or quiesced before enabling this financial inward workflow. The
global release gate remains closed for such unresolved source/runtime/provider
coverage. This slice makes no whole-route, live-provider or production parity
certification claim.
