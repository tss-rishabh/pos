# Read-only source preparation before CSV order dispatch

Implemented candidate, disabled by default. No live writer, provider, warehouse
publication or source deployment was changed by this work.

The source is API-v2 commit `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`.
`source_runtime.PINS` and the generated private-import manifest pin the actual
catalog, cart, checkout validator and order calculator. In particular,
`CatalogController.PosProductDetail` calls its imported `Cart` after every
auto-add (line 1912), `CartController.Cart` runs `AddFreeMembership.process`
(line 836), and `controllers/cart/Cart.py` makes the membership decision with
`cart_value > 2000`, ordinary-item count, current membership and three literal
delivered-order/HP queries. `ProcessingOrder` is a calculator, distinct from
`PosOrder`, and also calls an abandon-cart producer near line 397.

## Boundary and lifecycle

The new private POST is
`/internal/pos/legacy-order-imports/:operationId/preparation`. It has its own
`source-cart-preview` HMAC purpose and contains no order-stage nonce. The Node
core must commit ownership of a native `RUNNING` preparation attempt before
calling it, and must not call `journal.dispatch('order')` until preparation has
succeeded and the resulting document is retained. Durable attempt creation,
lease consumption, cancellation, closure and recovery are the separate
`FinancialOrderPreparationPort` coordinator's responsibility.

The source requires the same latest native attempt ID, scope, plan/request and
authority hashes, unexpired attempt, opaque owner hash, selected preparation
contract and current operation. There must be no source receipt, order binding
or financial stage. A queued attempt also requires its exact current job claim,
unexpired UTC lease and matching `STARTING` row. The Node secret and claim owner
token are never sent to Python; Node verifies its native HMAC, while Python
compares the current row with the source-authenticated capability.

Each preview owns a fresh read-committed transaction and rechecks current actor,
epoch, internal role 1–3, store/counter, customer/contact, selected approval and
period. It executes only the actual catalog → cart → checkout validation →
calculator path. SQL writes, native commits and direct historical Order/HP reads
are rejected in this purpose. Nested source `commit()` can flush only; even a
successful preview throws through the owned transaction to force rollback.
`PosOrder`, Go, payment confirmation, publication and source producers are not
called. Existing cache wrappers suppress cache mutations; ordinary captured
Celery effects are discarded. The known `push_process_order_event` and
`push_after_payment_event` functions additionally suppress their direct
abandon-cart Celery/control effects only in the invocation's read-only preview
context. That does not certify final-import abandon-cart delivery.

The signed response is a **preview result**, not an order receipt, paid proof or
source rejection/no-effect receipt. A failed/unknown preview cannot have a
financial nonce dispatched by this producer. Only the Node coordinator may
close/re-authorize its original attempt, using its own retained evidence.

## Lazy history and exact clock

An invocation-local `HistoryProbe` reaches `NeedHistory` only at the literal
history-dependent criteria branch. It uses a private `BaseException` control
flow so legacy `except Exception` fallbacks cannot swallow it and query native
history. At that point the exact source `datetime.now()` is sampled and checked
against the configured source zone and trusted clock. A host-zone disagreement
fails closed. No history clock is sampled for a skipped branch. The source wall
second and calendar `asOf - 45 days` remain separate from the CSV business date.

`sourceOrderPreparation()` first obtains this authenticated decision. A ready
result needs no warehouse views, history keys or SDK client. On `NeedHistory`,
it uses the existing bounded `csvMembershipBigQueryHistory` and
`prefetchCsvMembershipHistory` outside SQL, then repeats the preview once with
the same complete signed generation. There are at most two source previews and
one warehouse read, no internal retry, no empty-history fallback and no native
historical read. The source copies/validates the handoff before SQL and replays
only in-memory signed facts inside the transaction. Cancellation prevents later
preview/financial dispatch; the underlying read-only SDK operation retains its
existing byte/time/row bounds. Unknown provider errors become static errors.

Final selected order execution repeats literal current catalog/cart/validation
and controls. It does not trust preview prices, eligibility or a returned paid
flag. The retained handoff freezes only the membership-history execution point.

## Catalog population and imported aliases

In selected preparation and final order commands, only automatic
`AddFreeMembership.process` is deferred while the private catalog populates the
cart. Final `Cart.get` executes its complete literal process before validation
and calculation. Nothing returns false or fabricates missing history. This lets
a partially built ₹1,001 cart become a final ₹2,002 cart and reach the actual
`> 2000` short circuit without an irrelevant warehouse request.

Final batching is bound to the authenticated order capability's
`preparationContract` and must equal the native operation's selected contract.
An ambient environment flag cannot change old commands. Unselected commands
retain their per-add order. The catalog's imported `Cart` now resolves to the
same isolated cart in all modes. Both direct session calls and imported native
session aliases are fenced before the three exact literal membership-history
queries execute. Qualified `HistorySession` consumes those queries in memory;
unrelated current financial/order probes are not globally classified as old
history by this narrow fence.

## Evidence and limits

`tools/legacy-import-preparation/test_source.py` runs the pinned cart,
`AddFreeMembership`, validator and calculator. Its 84 differential vectors cover
seven cart/user shapes, two complete history outcomes and six pricing modes:
plain, 5% app discount, 10% birthday, 100% birthday, 5% GST and GST plus birthday.
Both original per-add and selected batched flows produce matching normalized
products and full metadata. The actual HP constructor and approved per-HP
refund calculation also match in both line-item modes (168 comparisons).
Catalog/pricelist hydration, coupon eligibility and external I/O are explicitly
synthetic fixture inputs. Free membership can occupy a different transient cart
position; HP/audit comparison retains product ownership and compares new IDs by
their product binding, rather than claiming equal auto-generated IDs.

The vector `test_actual_low_value_source_process_can_replace_paid_member_with_free_and_removes_original`
also proves that a paid member plus ordinary products below ₹2,000 can still
need history: the original process may remove the paid SKU and add the free
SKU. This slice preserves that branch and does not relax final substitution
ownership/stock/receipt guards. The separate replacement profile is required.

Native isolated-MySQL tests cover current attempt/queue/actor/contact/stage
fences, always-rollback execution, write/commit/HTTP/history rejection and the
Node → source NeedHistory → bounded BQ fixture → source memory replay. The BQ
fixture is a synthetic signed complete publication; it does not establish that
the missing production publication has been deployed.

Custom text/combo and every production pricelist/cache combination are not
certified by this fixture matrix. Separate benefit history providers, qualified
coupon/complementary admission and final Go benefit consumption remain their
own integration scope. No raw CDC watermark is accepted as complete history.

## Root integration

Exports:

- `sourceOrderPreparation(config, financialOptions, options, dependencies?)`
  from `source-order-preparation.ts`, structurally implementing
  `FinancialOrderPreparationPort`.
- `readSourceOrderPreparationOptions(environment)` from
  `source-order-preparation-options.ts`.
- `legacyImportPreparationTransport()` alongside the existing financial
  transport; financial transport defaults are preserved.

Set only after candidate acceptance:

- Node `UPSTREAM_POS_LEGACY_IMPORT_PREPARATION_CONTRACT=pos-import-order-preparation-v1`.
- Python `POS_LEGACY_IMPORT_PREPARATION_CONTRACT=pos-import-order-preparation-v1`.
- Existing private source URL/auth/proof keys; original writer/authority and
  current queue schema. No new migration is introduced here; use the
  coordinator-owned preparation migration first.
- Only for a reached history branch: distinct `CSV_MEMBERSHIP_HISTORY_KEY`,
  `CSV_MEMBERSHIP_PUBLICATION_KEY`, existing `POS_MEMBERSHIP_PROOF_KEY` and
  `POS_MEMBERSHIP_PRODUCT_IDS`; existing `CSV_MEMBERSHIP_*` BigQuery options and
  complete qualified publication views. The source history key must match its
  existing `POS_LEGACY_IMPORT_MEMBERSHIP_HISTORY_KEY`. All proof/auth/history/
  publication/member/master keys must remain distinct. Source worker `TZ`,
  `BUSINESS_TIMEZONE` and accepted `CSV_MEMBERSHIP_SOURCE_TIMEZONE` must agree
  with the original source's naive wall-clock semantics.

Inject this port as the coordinator's optional sixth argument. Do not invoke it
from within a Node SQL transaction or after committing an order dispatch.
Register `tools/legacy-import-preparation/tsconfig.json` and
`tests/legacy-import-preparation/**`; native tests reuse the isolated
`CHECKOUT_MYSQL_TEST_URL`. The Python source root may be supplied via
`POS_LEGACY_IMPORT_SOURCE_ROOT`; tests can read verified immutable Git blobs into
a disposable folder if a clean sibling has advanced. Production never uses
that test-only fallback.

Focused verification from `backend/`:

```sh
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1:3306/pos_rewrite_checkout_test \
  npx --offline node@24.22.3 node_modules/vitest/vitest.mjs run \
  tests/legacy-import-preparation tests/legacy-order-imports/membership-bridge.test.ts --maxWorkers=2
npx --offline node@24.22.3 node_modules/typescript/bin/tsc \
  -p tools/legacy-import-preparation/tsconfig.json --pretty false
```

Results: 69 Node checks passed (39 new, including 17 native); the Python runner
contains 15 cases, including the 84-vector/168-comparison matrix. The matrix is
split into six fixed pricing groups in Vitest to retain the unchanged five-second
per-test budget. Existing pinned Python protocol/startup checks also passed
(14 cases). Scoped ESLint, manifest verification and `git diff --check` passed.
These results qualify the stated fixture scope, not a live provider rollout.
