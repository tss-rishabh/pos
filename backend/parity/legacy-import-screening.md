# CSV screening-ticket candidate

This is an unselected candidate for screening SKU `390238` in the dormant offline and Shopify CSV import paths. [Node lifecycle composition](legacy-import-screening-lifecycle.md) implements atomic admission and retained-receipt outcomes; the [current-count contract](screening-count-locks.md) records the owned READ COMMITTED runner, opaque transaction witness and verified physical metadata. Source/Go/all-writer deployment qualifications below remain required. It adds no route, worker, active flag, upstream source edit or production DDL. This is focused source/native evidence, not certification of the complete CSV pipeline.

## Pinned source behavior

POS source is `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`; API-v2 source is `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`. The oracle verifies complete bytes for the following API-v2 files before extracting their functions:

| Source                                          | Behavior retained                                                                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/OrderHelper.py:171–217`                   | Maximum two; exact three denial messages; customer-wide `COUNT(*)` over screening markers joined to Orders and HP, current SKU, order status outside `0,17`.                                      |
| `libs/OrderHelper.py:508–714`                   | Unit mode creates one HP per unit; quantity mode creates one HP with the requested quantity.                                                                                                      |
| `controllers/OrderController.py:10921–10928`    | PosOrder applies the screening check to both offline and Shopify creation.                                                                                                                        |
| `controllers/OrderController.py:11039–11061`    | One screening marker per generated HP, referencing the original customer and source order.                                                                                                        |
| `controllers/CartController.py:259–266,554–557` | Add and quantity replacement have distinct resulting-quantity inputs to the same limit helper.                                                                                                    |
| `models/Order.py:632–640`                       | Screening marker ID is source-model INT; order, HP and customer IDs are BIGINT. Source model constructors supply creation timestamps; actual physical TIMESTAMP defaults are captured separately. |
| `helpers/task_helpers.py:438–610` in POS        | Offline CSV loops through ordinary cart/PosOrder and then original confirmation/complete-order. It defines no special screening counter or new customer identity.                                 |

There is **no distinct physical StoreCounter type or screening-only CSV column**. The original selected store/counter and connected or operator-guest customer remain authoritative. A false guest ID in the original count helper returns zero; this candidate never invents a customer ID and requires the existing native customer authority.

The marker count is deliberately not changed to `SUM(hp.qty)`. In quantity mode, a two-ticket order contributes one marker; a subsequent one-ticket purchase can therefore pass the original sequential two-marker rule. Cancelled/returned orders still count. No payment-status, source-store, `hp.order_id=o.id`, or `o.user_id=s.user_id` predicate is added to the original counter. Native fixtures retain duplicate-marker and malformed historical join multiplicity. New candidate-owned orders receive stricter structural verification instead of silently rewriting historical count semantics.

The source comments say “one row per unit,” but its executed branch iterates generated HP rows. Marker timestamps are not backdated by PosOrder's historical Order/HP timestamp update. The original source also marks screening products non-cancellable in its cancellation presentation (`OrderController.py:5482+`); this candidate adds no cancellation or quota-refund feature.

## Implemented code

`src/modules/legacy-order-imports/screening-profile.ts` exports:

- `screeningImportProfile(config, db, options)` with `reserve(tx,scope,lineItemsEnabled)`, `bind(tx,scope,orderId)`, `attachSourceReceipt(tx,scope)`, `complete(tx,scope)`, `releaseRejected(tx,scope)` and `read(tx,scope)`.
- Strict `screeningReservationSchema`, source pins, typed options, ORM mappings, and `screeningReservationDdl` as a review artifact. No function executes that DDL.
- `readScreeningTicketCount(tx,customerId)`: bound Drizzle statement with the exact source joins/filter/count. It requires an owned READ COMMITTED transaction plus the actual customer lock and performs a nonlocking indexed count. IDs/counts stay exact BigInt/string values; arbitrary/primed transactions fail closed.

`reserve` decrypts and verifies the existing immutable financial plan/request, checks current original actor/store/counter/contact authority, locks the native customer, and checks current product, unique active store-stock association, sufficient stock and a single GS1 mapping. It stores only scope/IDs, hashes, quantities and lifecycle evidence; it does not store customer contacts, CSV rows or tender values. Both offline and Shopify plans use this same path. Existing membership/benefit and tender qualifications remain independent.

Reservations have a purpose-separated HMAC using the retained source proof key. The state machine is:

```
RESERVED -> BOUND -> COUNTED
        -> REJECTED (verified original no-effects source rejection only)
```

`RESERVED` contributes the source's expected marker count to pending admission. `BOUND` contributes pending credit while its order remains excluded by the original status predicate; when the native marker already counts, it is not counted twice. `COUNTED` requires the existing sealed complete financial import proof and exact native ownership/HP/marker structure. `REJECTED` requires the original signed no-effects rejection and absence of any import order binding. Time, expiry, a missing reply, a generic error or a provider success flag cannot release quota. A replay retains the original UUID/state; it cannot reactivate a rejected operation or choose another order.

Admission locks use the shared actor/epoch prefix, Store, original operation and customer authority before native Order/reservation rows. All retained customer reservations are verified, bounded to 1,000 rows; an oversized or inconsistent set explicitly requires reconciliation. Nonlocking counter/range projections under witnessed READ COMMITTED avoid unrelated Order and empty-range locks. The underlying current mutable eligibility counter is writer-authoritative, including old orders. This is an authorization constraint for a new write, not a historical reporting fallback.

`compatibility/upstream/legacy-order-imports/screening_profile.py` exports:

```python
ScreeningSourceRuntime(
    qualified_source_runtime, auth_key, proof_key, clock,
    contracts={
        'profile': 'pos-csv-screening-2960-v1',
        'schema': 'pos-screening-schema-v1',
        'writers': 'pos-screening-all-writers-v1',
    },
)
```

It delegates the existing private runtime/publisher, authenticates the original purpose capability and requires the Receiver-owned READ COMMITTED/customer-lock witness before verifying the reservation and rechecking the real counter/pending reservations. A ContextVar selects a qualified base profile only during that call. The overlay removes **exactly one screening-specific rejection AST node** from that base; it fails closed if the expected seam is absent or changed. Every other membership, benefit, quantity and original-tender check stays delegated. Outside the screening call, the original base remains in effect.

The literal source creates the Order/HP/marker rows. The wrapper verifies those rows and records `BOUND` inside the same private outer transaction that retains the source order receipt, deferred effects and import hold. Source inner commits remain flushes. A late source exception rolls back all those writes together; only the original negative-receipt path can subsequently authorize `REJECTED`. There is no new financial formula, stock operation, external screening request or message sender in this module.

## Explicit corrections and limits

The original helper catches a database exception, logs customer/error text and returns zero. The candidate returns static `ORDER_IMPORT_SCREENING_COUNT_UNAVAILABLE` and performs no source creation on that failure. Its own code logs no payload, error object, customer, credentials or SQL. The native fixtures demonstrate the original zero fallback separately; they do not claim error-response parity for this deliberate fail-closed correction.

Durable pending admission closes the original count-before-payment/concurrent-writer race. It preserves normal sequential source decisions and marker multiplicity. An unavailable catalog, ambiguous GS1 mapping, altered proof, unsupported schema or missing qualification is refused before the source call. There is no permissive fallback to the old screening rejection bypass.

## Caller boundaries

The linked lifecycle document records the completed Node hooks. Source/Go and deployment boundaries below remain independently owned; no production contracts are selected.

1. **Financial journal admission:** implemented by the internal profile lifecycle after the operation insert in the first reservation transaction. Root must construct the selected port with a qualified source line mode. External `journal.reserve` followed by `adapter.start` remains incorrect: an existing reservation deliberately prevents redispatch.
2. **Private source runtime composition:** install `ScreeningSourceRuntime` around the independently qualified original-tender/membership runtime. Preserve its `order_pipeline` global base-profile seam or explicitly adapt/test that seam. The production source manifest and packaging must include this new file. No new HTTP bypass or public profile selection is permitted. The existing signed scope/authority/request capability remains mandatory.
3. **Source receipt attachment:** implemented in the adapter before ordinary native Order proof locks. The Python wrapper performs the initial bind itself; Node `bind` remains for another explicitly qualified same-transaction source implementation, never a guessed result after an unknown call.
4. **Financial completion/rejection recovery:** implemented using the original verified completion/no-effects receipts. GET never replaces the UUID or retries an unknown effect. Separately signed Node-local admission denials prevent quota/catalog refusals from being stranded in uncertainty. A failed completion-marker update remains recoverable from the original seal.
5. **Lock and stage ordering:** retain shared actor/epoch → Store → original operation → global customer → Order locks for every collaborating screening transition. Use the owned current transaction/witness; a fresh RR snapshot alone does not remove absent receipt/proof gap locks. Do not invoke a late customer-lock helper after an existing Order lock. Any later hook added to Go/payment/whole-order writers needs native concurrency evidence before its writer contract is selected. No SQL lock may cross an HTTP/provider call.
6. **Shared customer-wide writer participation:** API-v2 PosOrder, ordinary online order creation, carts, Go confirmation and every writer changing an order between excluded `0/17` and counted statuses must participate in the same customer/SKU reservation admission or explicitly exclude the screening SKU while unqualified. Confirmation must retain the original operation/customer/Order/HP/marker receipt, account for existing pending credit and avoid double consuming it. It must not infer membership or benefit provenance. The overlay cannot qualify those unrelated deployed writers by itself.
7. **Schema/retention qualification:** actual `spiderman_screening_orders` columns/defaults/indexes are now verified in `evidence/mysql-screening-schema.json`; this is not a claim that historical marker anomalies are absent. Register a reviewed forward-only migration for the new reservation table and readiness checksum through root. Keep archived customer/store/actor identities and accepted reservations; do not automatically purge unresolved quota.

Concrete Go seams in the `6f9eb69` base are `compatibility/upstream/go/internal/poscheckout/confirmation.go::Confirm`, and `compatibility/upstream/legacy-order-imports/legacy_import.go::{lockLegacyImport,recordLegacyImportConfirmation,verifyCompletedLegacyImport}`. `prepare.py::outputs` currently inserts `lockLegacyImport` immediately before the HP query, after Confirm has already locked the Order. That placement does **not** qualify the new global customer lock order. The collaborating Go owner must add early native scope/customer admission before Order/Apply, validate the retained screening proof/markers at confirmation, and seal the original exact confirmation without consuming pending quota twice. Existing ordinary confirmation semantics must remain protected; this module does not silently reorder or activate that independently owned path.

The three explicit options are `contract`, `schemaContract`, `writerContract`, with the literal values in the example. Keys come from the existing retained source-proof key and financial master secret; no third credential or plaintext secret column is introduced. All three options are absent by default. `qualified` describes selected local contracts, not demonstrated deployed all-writer acceptance. Root must leave production selection disabled until the above evidence exists.

## Verified query/index contract

The captured physical table already has `idx_user_id`, `idx_order_id` and `idx_has_product_id`, in addition to its INT primary key. The candidate forces marker-first `idx_user_id` followed by Order/HP primary lookups, with identical response/count semantics. A native fixture EXPLAIN verifies that plan using the actual captured types/indexes. No additional production screening index or DDL is required by this candidate; the earlier speculative covering-index proposal is superseded. No live latency, row-count or performance claim is made. Reservation DDL retains its customer/SKU index and unique order binding.

## Focused validation

The source oracle executes pinned helper functions, the original HP builder, the exact PosOrder marker branch and the current base-profile callable with synthetic data. Native tests use only randomly named disposable localhost databases. The source fixture extends the existing isolated literal PosOrder runner; source catalog/delivery/cache inputs and queue acknowledgments remain synthetic. It never imports the original app bootstrap, sends a real message, contacts a provider or modifies source repositories.

Coverage includes all 12 helper decisions/messages; both line modes; unchanged independent profile gates; cross-runtime HMAC/schema/pins; exact counter joins/statuses/SKU/duplicates/orphans; stale RR/current reads; twenty same-command and twenty cross-store competing reservations; catalog/actor/proof refusals; offline/Shopify literal creation and replay; flushed-row visibility; late rollback and sealed release; unknown/forged rejection retention; full-width Order/HP IDs; marker mismatch refusal; and verified Shopify financial completion/replay after later cancelled status/price changes. Shopify completion uses the existing native financial adapter plus synthetic queue acceptance, not a claim of deployed Go/provider acceptance. Offline source creation is covered; its unchanged Go confirmation remains separately qualified by the financial slice.

From `backend/`, using the project's Node 24 runtime:

```sh
node node_modules/typescript/bin/tsc --noEmit -p tests/legacy-import-screening/tsconfig.json
node node_modules/eslint/bin/eslint.js src/modules/legacy-order-imports/screening-profile.ts tests/legacy-import-screening
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
  node node_modules/vitest/vitest.mjs run --config tests/legacy-import-screening/vitest.config.ts
```

The MySQL URL is intentionally accepted only as a localhost fixture template; the helper creates/drops its own `pos_rewrite_import_runtime_<random>` schema. `SCREENING_SOURCE_ROOT` optionally points to the pinned API-v2 checkout; the default sibling checkout is source-verified before execution. Existing private source Python environment is reused, with bytecode writes disabled and no dependency installation. The linked lifecycle document records the extended test coverage. These results do not activate a profile or certify every source task.
