# CSV automatic coupon and POS complementary candidates

These are separate, executable candidates for the pinned offline/Shopify import
source. They are not selected by the application, do not loosen `native_order`
or `assert_plain_profile`, and are not a production parity certificate. No live
DDL, source edits, provider sends or production data writes were performed.

## Source paths and actual reachability

API-v2 is pinned to `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`;
Django is pinned to `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.
`compatibility/upstream/legacy-order-imports/benefit-profile/source-manifest.json`
records the exact file hashes. Files are compiled into isolated namespaces;
the source repositories and existing runtime/profile manager are unchanged.

| Source | Behavior retained |
| --- | --- |
| `helpers/task_helpers.py:500–615,800–930`; `order/views.py:1657,1864` | Both CSV importers send `is_pos=true`; quantities add the original selected SKU repeatedly. |
| `CatalogController.py:1767,1906,1920`; `CartController.py:253–284,539–545` | `pos/product` prepares a cart add. Ordinary additions can trigger the configured automatic birthday coupon. An explicitly selected `prod_type=4` becomes `META.pos_freebies[sku]=1`, including repeated CSV units. |
| `cart/Cart.py:440–463` | A successful POS wrapper pass skips `ComplementaryProductWrapper` and `FreebieProductWrapper`; web artist/MOV/freebie-sale offers are not silently enabled for CSV. A wrapper exception falls into a different broad source fallback; qualification errors mark the existing private transaction as violated so that fallback cannot turn refusal into success. |
| `PosFreebieWrapper.py:9–86` | POS selections use current type4 rows without web `is_avail/is_del/stock` filters, qty1, valid=true. These are plan-backed selections, not fabricated automatically added gifts. |
| `OrderHelper.py:1150–1213`; `helper.py:489–555` | Birthday month is the source execution month, not the CSV date. The auto setting, birthday configuration, source global usage, current-day usage and the `birthday_coupon_{customer}` TTL guard all apply. |
| `MetaInitializers.py:19–234`; `CouponValidation.py:1–264`; `CouponWrapper.py:1–94` | Original exclusive/employee, first-order, platform, user allowance, monthly/lot, country/category/product, discounted-product, minimum and percentage/fixed/BOGO logic executes from pinned source functions. Source rounding and per-item cap behavior is retained. |
| `OrderHelper.py:294–420,509–715,1988–2056`; `PosOrder:10868–11157` | Actual order/HP constructor, per-unit allocation, selected complementary line and `POS_MANUAL` grant semantics; approved per-HP refund allocation. |
| Go `sourcefixture/source_allocations.go:561–571` and Python `OrderController.py:1557–1584` | Offline confirmation increments every matching `coupons_users` row and appends one active `order_coupon_log`. The Python function is a literal native fixture equivalent, never a second production deduction alongside Go. |

Offline writes the applied coupon ID/amount. Shopify deliberately writes no
coupon ID. Its `coupon_amt_used=None` becomes the pinned ORM default `0` when
`discount_amount` is absent; when present it uses the source calculated coupon
discount. Thus Shopify can have a cart coupon calculation and no coupon usage
counter/log. Its HP constructor sees the persisted coupon ID `0` and does not
allocate an ordinary coupon discount to HPs. No coupon consumption is invented.

No Money, Points, reward-points, gift-voucher or payment/store discount spend is
allowed by these profiles. A shared/unbound cart is not evidence of consent.
The original CSV adds no manual coupon field or implicit wallet selection.

## A source freebie discrepancy that remains visible

The source `is_free=True` constructor forces qty1 and sets `product_price=0`.
With `IS_LINE_ITEM_ENABLED=true`, it writes that zero. With the flag false, its
other constructor writes `(base_price+extra_price)*qty`, ignoring the zero.
The descriptor records `source-zero-per-unit` or `source-base-aggregate` and
the current catalog base price. It does not silently change refund entitlement.

Executed example: ordinary `25.49×2`, 10% birthday coupon, selected gift catalog
price `17.83`, source payable `45.00`. In aggregate mode, HP/refund values are
`50.98/33.34` for the ordinary line and `17.83/11.66` for the gift. In per-unit
mode they are `25.49/22.50`, `25.49/22.50`, `0/0`. The approved per-HP refund
patch keeps the sum `45.00` and each native audit aligned. A 100% coupon permits
source payable/refunds `0.00`; it does not invent cash, change or a tender.

Changing aggregate gifts to zero would change per-line refunds and needs a
separate business decision. This candidate preserves the observed branch.

## Technical corrections and physical prerequisites

The source writes HP type `FREEBIE`, while its `LineItemType` and verified
physical enum contain only `REGULAR,JIT,PRE_ORDER,MTO`. Original strict MySQL
storage fails with native code1265. `complementary-schema.review.sql` proposes
adding only `FREEBIE`, preserving NULL/default and existing labels.
`benefit_codec.py` verifies that exact qualified physical definition before
extending only the private source model. The proposal was executed only in a
disposable fixture; it is **not** an automatic rewrite migration or a claim
that the operational writer/other consumers have been updated.

The source catches and logs grant audit failures. A qualified import cannot
commit an unowned free HP: `strict_pos_grants` converts that one catch to a
transaction refusal. The original fields remain `POS_MANUAL`, `pos_manual:0`,
zero MOV/qualified value/trigger IDs, ACTIVE, no triggers. Native grant IDs and
HP IDs are captured after actual flush; IDs are never inferred consecutively.
`mysql-import-benefit-profile-schema.json` verifies the three physical grant/
coupon-log tables; `mysql-customer-contact-schema.json` verifies coupon users.

Current control reads are bounded, same-writer locking reads. Unknown current
queries, duplicate user-specific allowance rows and ambiguous coupon records
are refused. The source's interpolated code query is bound as literal text.
Historical query mismatches cannot fall through to the writer.
The candidate reads coupon and allowance controls itself; it does not trust a
caller array. `configurationHash` signs `{cache,settings,couponInputHash}`, using
the current native coupon digest. Changing a coupon between prefetch and source
execution is a refusal before a claim/HP is created. Non-user-specific duplicate
assignments are retained; original confirmation increments every matching row.

## Historical fact contract

`preloadCouponHistory` requires `CsvCouponHistoryPort` **outside SQL and before
`journal.dispatch('order')`**. Missing, stale, oversized, incomplete or wrongly
bound history is a local no-effect preparation error, not a dispatched unknown
source stage. `CouponHistoryReplay` performs no HTTP/BigQuery call under SQL.
Current configuration/coupon/user controls remain source-writer reads.

The HMAC document binds operation, request, plan, customer, coupon, configuration,
literal source `asOf` wall second/timezone, immutable generation, capture hash,
control-head seal and complete/fresh result set. Missing publication is an
error, including for an allegedly empty history. Maximum age is60seconds,
document size262144bytes, lot groups1000. Source/history/legacy-guard keys must
be independent. New purpose hashes use code-point canonical ordering matching
Python; host ICU collation is not a signing protocol.

The provider must publish results of these *literal* SELECTs, not reinterpret
the counts:

| Fact | Exact source predicate/join |
| --- | --- |
| `globalUsage` | All orders for coupon, status NOT IN `(0,4,7,15,17,22,31,33)`. Auto birthday enforces the limit even when `no_times_allowed>=1000`; the general initializer alone skips its cap SELECT at that threshold. |
| `birthdayTodayUsage` | DATE(created_at)=source today, customer+coupon, status NOT IN `(0,17)`. |
| `customerOrderCount` | Customer orders, status NOT IN `(0,17)`; first-user eligibility. |
| `monthlyJoinedUsage` | Active coupon logs in source month/year, joined to qualifying orders on **user+coupon**, not order_id. Multiplication is preserved. |
| `lotCounts` | Same user+coupon join, active logs, current lot and per-coupon groups, exact source same-code comparison/unique allowance. |

Native fixture: three active logs and three qualifying orders produce count9
even when their order IDs differ. Status4 counts in monthly/new-user history
but not global usage. The replay matches both original monthly and lot refusals.
Global/first-user queries have no created_at upper bound: future-dated records
already present in the captured snapshot cannot be discarded because of asOf.
Today/month predicates use source execution time, never `plan.createdAt`.

This slice implements the strict port, signed document verifier, prefetch seam
and actual in-memory source SQL replay. A complete source/current-head producer
and bounded BigQuery coupon-history provider/publication are still integration
code work; the nested publication seal is not magically verified by a flag.
The trusted reader must verify it before signing the replay document. Existing
raw CDC watermarks are not evidence of a complete participating-writer head.
There is no runtime historical MySQL fallback in this candidate.

## Durable guard, receipts and composition

`migration.sql` adds only two rewrite birthday-guard/immutable-claim tables.
The key has the source customer-wide scope (not one key per coupon). Current
writer row locks serialize contenders. Exact operation replay returns the same
claim/expiry; it does not extend expiry. A pre-dispatch trusted legacy Redis
EXISTS observation is purpose-HMACed; unknown/tampered observations fail closed.
The source TTL is retained. The candidate does not pretend an unbound cache
miss establishes concurrency safety across old Redis writers.

Production needs the cooperative guard contract, migration/retention of live
Redis guards, and all competing birthday writers sharing the same authority.
Observation alone cannot exclude a later legacy writer. Until actual cutover
acceptance, `pos-csv-birthday-cooperative-guard-v1` must remain unselected.

`store_descriptor` persists immutable `coupon-benefit`, `pos-complement` and
`coupon-consume` kinds in the existing source receipt table, under the existing
original command lock. Conflict is an error. Lost-response recovery reads that
original receipt; it does not rerun constructors, hand out another claim, add
another log or mint another source nonce.

Every line is owned exactly once by `original-plan`, independently sealed
`membership`, or `pos-complementary`. An extra membership row needs the existing
membership descriptor/provenance; arbitrary extraRows are rejected. POS gifts
must correspond to original selected plan SKUs, and retain declared CSV qty/
price/row provenance as well as actual qty/price/HP ID/grant ID. The narrow
membership admission view removes only separately proved POS selections while
preserving the full authenticated plan/header/line hashes.

Shopify stock remains exactly the original plan product quantities (including
a selected gift with CSV qty3 and actual HP qty1). Offline stock is all actual
HPs, including qualified membership/freebie rows. No generic stock/profile
allowance is exposed. The existing configured projection and hold barriers
remain mandatory.

## Root integration still required

1. Prefetch qualified history and legacy-guard observation before source order
   dispatch; bind the immutable document to capability/request. Never query BQ
   or publish a native history snapshot from inside the source transaction.
2. Construct `CouponCandidate` only in the isolated source instance. Inject its
   `automatic`, `get_valid_coupon`, `apply_coupon` and `calculate_discount`
   methods into the matching **isolated** source namespaces; keep original
   callbacks for unselected profiles. Use the separate POS wrapper/strict grant
   compiler only for original selected type4 rows. Do not patch shared modules.
3. Compose `admit_benefit_cart` with existing qualified membership context;
   extend core source/native guards only for the authenticated manifest. Do
   not replace blanket refusal with blanket allowance.
   `benefit_scope(plan,coupon=...,complementary=...)` is invocation-scoped;
   `assert_benefit_profile(cart,types,settings,plan,calculations)` has the original
   base admission ABI. It retains the exact screening rejection (the existing
   reviewed screening wrapper can remove only that node), binds original
   plan identity, rejects unproved membership/wallet effects, and raises the
   existing `CalculatedImportReview` before source order creation when tender
   differs. It cannot turn such a mismatch into a completed import.
4. Persist the staged descriptors in the same transaction as source order/HP/
   grants/refunds. Invoke `csvBenefitProfileHooks().assertStaged` under existing
   actor/session/check-in/Store→Order→MUser/other-order-hold locks.
5. Around the **existing Go coupon deduction**, verify staged current controls,
   capture exact before/after counts and actual log ID/native hash, and emit
   `pos-csv-coupon-consumption-v1` in that confirmation transaction. The Python
   equivalent/native fixture is provided, but a production Go emitter and real
   full importer→Go profile roundtrip remain code integration work. Never run
   the Python deduction in addition to Go. `assertSettled` requires this receipt
   and the exact existing source confirmation proof hash; paid status is not proof.
6. Seal the returned completion snapshot into the common completed financial
   document/publication before rendering historical results. Use
   `validateCsvBenefitCompletion` only after authenticating its outer seal;
   historical display never rechecks today's coupon/contact/catalog or Redis.

These hooks add no public routes/UI, worker, app/config edits, dependency or
automatic production selection. Existing manager correction/approval remains
mandatory whenever source payable differs from declared tender. No discount,
freebie or line is silently removed to force equality.

## Focused evidence

Run from backend with the locked Python pricing venv and pinned source bytes:

```sh
POS_LEGACY_IMPORT_SOURCE_ROOT=/path/to/api-v2-2960 \
  sh compatibility/upstream/legacy-order-imports/benefit-profile/run-native-tests.sh
npx --offline node@24.22.3 node_modules/typescript/bin/tsc \
  -p tools/legacy-import-benefits/tsconfig.json --pretty false
npx --offline node@24.22.3 node_modules/eslint/bin/eslint.js \
  src/modules/legacy-order-imports/benefit-profile tests/legacy-import-benefits
```

The runner uses an already installed, digest-pinned disposable MySQL8.4 image,
random localhost port and random `pos_import_benefit_*` schema, with native
timezone tables initialized. It never changes the host MySQL timezone tables.
Fixture-only schema qualification substitutes `tss.coupons` with the same table
inside the random schema for its one source control SELECT. Production source
writer/schema identity remains an explicit prerequisite.

Evidence covers original eligibility and arithmetic, native original enum
failure versus review-only correction, actual HP/grant IDs above2^53, literal
history joins, Shopify defaults/no-consumption, counter/log/provenance changes,
rollbacks, immutable replay and competing guard claims. It does not certify
external publication/cutover, deployed source consumers, complete financial
import workflow or current production Go activation.

Focused checkpoint: **71 passing cases** (49 domain/source,22 native MySQL),
strict TypeScript and ESLint passing. The native runner created and removed its
own digest-pinned fixture container; the manual debugging fixture was also
removed after this checkpoint. No shared application build/ports were used.
