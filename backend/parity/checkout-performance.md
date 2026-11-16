# Independent postpaid checkout timing metadata

Baseline: `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.
`order/views.py:AjaxFastCheckoutView` parses `performance_json`, appends the
posted `overall_performance_time` string, serializes with Python `json.dumps`,
and writes `OrderStore.performance_json` only after successful payment. That
write is in a swallowed-exception block: timing failure does not undo payment.
The API-v2 ordinary order writer does not own this POS timing field.

## API and source fields

`registerCheckoutPerformance(app,config,db)` adds:

- `POST /api/v1/stores/:storeId/checkout-sessions/:checkoutId/performance`
  with `{operationId,orderId,performance}`.
- `GET` at that path with `?orderId=...`, returning
  `{checkoutId,orderId,receipt:Receipt|null}`.
- `GET .../performance/submissions/:operationId` for lost-response recovery.
  An absent receipt returns HTTP 404, code `CHECKOUT_PERFORMANCE_NOT_FOUND`.

The receipt is
`{operationId,checkoutId,orderId,status:'recorded',performance,recordedAt}`.
All routes are private/no-store and declare static module/resource/action
traces. The authenticated actor header must match before DB work. Order IDs are
lossless signed-BIGINT-compatible strings; operation/checkout IDs are UUIDs.

The strict performance object has these exact source keys:

| Field                      | Source behavior                                                                    | Accepted new values                                  |
| -------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `product_main_list`        | Last product-list RPC duration, template line 1754                                 | Empty or nonnegative two-decimal millisecond string  |
| `user_behaviour`           | Last behavior RPC duration, line 1167                                              | Same                                                 |
| `add_to_cart`              | Last add-cart RPC duration, lines 1699/2288                                        | Same                                                 |
| `proceed_to_payment`       | Initialized empty at 1016; never assigned in the pinned template                   | Same lexical format; normal client preserves empty   |
| `fast_payment`             | Added after the AJAX response at 6165, normally absent from the first posted JSON  | Optional, same lexical format; no fabricated default |
| `overall_performance_time` | Wall-clock elapsed since successful cart/customer connection, lines 3016/5647/6389 | Empty, `NaN`, or nonnegative safe integer string     |

The client freezes values before the financial request and uploads only after
paid proof. They are last measurements, not cumulative phase totals. Only a
successful sync-cart/customer connection establishes the overall timer; missing
or unproved state retains `NaN`. The backend does not synthesize zeroes or compute
new elapsed time from receipt time. Empty overall and `NaN` are different source
states: the former contributes zero before phase deductions; the latter enters
the cashier report's average-imputation branch.

The serializer uses the source field order and `json.dumps` comma/colon spacing.
Optional `fast_payment` precedes the appended overall field. Strict ASCII
formats and an explicit serialized 255-byte bound match the verified legacy
VARCHAR(255). No arbitrary keys, comments, contacts, cart data or financial
amounts are accepted. The maximal accepted object is exactly 255 ASCII bytes,
verified against the isolated MySQL column. Browser timings are observational
data, not financial authorization or trusted employee-performance evidence.

## Payment independence and proof

This is a separate postpaid transaction. It never calls an order/payment/stock
gateway and never changes order status, payment amounts, allocation/stock rows
or the checkout state/version. Root-owned frontend delivery is a separate durable
metadata operation; its failure cannot fail or repeat cash completion.

The server checks current owned checkout/store access and check-in using the
shared writer helpers. It binds the original succeeded order-submission result,
including original actor, counter, checkout version and effective customer.
Anonymous checkout uses original `customerId ?? operatorCustomerId`; it does not
invoke the customer-profile helper that requires an attached real customer.
The ordinary submitted backend checkout remains retained after local next-sale
cleanup.

A first write independently requires native delivered/paid state, the original
customer and order-store actor, exact single store/counter mapping and the shared
native header/line/refund/consent/gift-issuance projection proof. Ordinary method
14 additionally requires the scoped recorded paid payment attempt; method 3
requires proved zero-total prepaid completion. No caller-declared paid flag is
trusted. Before taking checkout/check-in/order locks, a nonlocking paid preflight
refuses premature metadata. A native test holds an unpaid financial order lock
and proves that metadata refuses without waiting for it.

The original checkout row serializes same-checkout metadata commands. Missing
receipt/unique-key lookups do not take shared gap locks. An operation UUID binds
the immutable actor/scope/order/input hash. A second intent for the same order or
changed payload under the same UUID returns a conflict. Different preexisting
legacy timing text is retained; an exact existing value can be adopted without
rewriting it. Only the exact proved OrderStore primary row is updated, and that
update and its receipt commit or roll back together.

Recorded receipts bind the original header, customer, actor, checkout operation
and row identity. Replays recover the accepted receipt after later returns,
contact changes or order-header changes; they do not reinterpret those mutable
facts as a new metadata write. Current owner/store/check-in authority still
applies. A **first** upload delayed until a return/header change/customer block
may fail the conservative current paid/projection gate. Supporting those first
late uploads would require a dedicated immutable paid reader. This limitation is
explicit; the module does not weaken financial helpers or claim historical
backfill authority. Financial success stays intact if optional metadata fails.

## Source crash correction

The literal source writer accepts overall `-100`, but its cashier reducer does
`float('0' + overall)`, yielding `float('0-100')` and `ValueError`. New writes
reject negative overall to prevent poisoning the existing report. Root's client
maps a backward-clock result to the source's existing `NaN` fallback. This is an
explicit nonfinancial input correction; valid source fields/output remain
unchanged. The legacy negative is retained as diagnostic evidence, not an
accepted new payload. No existing negative database value was changed.

## Migration and evidence

Register `src/modules/checkout-performance/migration.sql` in the deterministic
runner and deployment image. It creates only
`pos_rewrite_checkout_performance`, with a unique order binding, immutable UUID
receipt and VARCHAR(128) request ID. It does not change a legacy schema. No new
worker, credential or environment variable is required. Timing is a current
operational resource: no warehouse or historical MySQL fallback is used.

`tools/checkout-performance/tsconfig.tests.json` covers the owned source/tests.
Twenty focused checks pass: six source/contract checks, thirteen isolated native
MySQL checks and one HTTP boundary check. The pinned writer AST executes its
actual JSON-building and update call; the actual pinned cashier reducer then
consumes that JSON. This does not emulate the entire payment view.
The generated output and negative-case failure are recorded atomically in
`parity/evidence/checkout-performance/source-oracle.json`.

Native checks cover 20 concurrent exact retries, long IDs, anonymous cash,
attached original customer, zero-total prepaid, paid/projection/actor guards,
the 255-byte boundary, legacy conflict, a full 128-character real HTTP trace,
transactional receipt failure preserving the paid sale, and receipt recovery
after later changes. Primary/data reader paths are not used for authorization.
HTTP tests reject absent/stale actors, scope/input overrides and source-report
poison before DB work. Tests use only fresh
`pos_rewrite_checkout_performance_test_*` databases under the guarded local
`MYSQL_INTEGRATION_URL`; no live provider, source DB write, SMS or external
fulfillment action occurred. These are bounded source/native checks, not a whole
production payment or browser certification.

## Frontend collection and recovery

The web/Electron client now records completed product query/cache reads and local
SKU additions, successful customer connection, and completed customer-history
reads. Timings contain only IDs and numeric strings. A connection starts the
source wall-clock timer and resets the four phase values, matching the original
form reload. Checkout versions prevent a delayed previous customer's response
from replacing the current phase. Missing/unproved clocks use the source `NaN`
branch; a backwards wall clock also uses that branch because the original
negative string crashes the source cashier reducer.

Before the first fast-cash dispatch, IndexedDB freezes one snapshot per original
cash intent. Subsequent order/payment recovery never recomputes it. Only the
retained exact paid or prepaid receipt binds that snapshot to its order. Optional
metadata failure does not change financial commands, cash receipts or payment
outcomes. A bounded background runner posts metadata and uses receipt GET before
an exact retry after an unknown result. A crash between the paid checkpoint and
metadata binding is repaired by reading that exact retained local cash command;
the runner cannot create an order or charge. Active-state/due compound indexes
exclude terminal history from each pass. Cached expiry is runtime-validated,
including rejection of NaN, and scope changes abort pending work.

The SHA-pinned source JavaScript VM oracle proves the exact serialization
boundary: fresh positive fast cash omits `fast_payment`, fresh PayProceed
serializes its inner order request before assigning that measurement, zero total
delegates to PayProceed, and an earlier failed legacy PayProceed can leave a
measurement in the shared global. The new normal fast-cash snapshot does not
invent a fifth stage or carry a stale measurement from another intent.

Thirty-one focused collection/storage/scheduler/review checks pass, alongside the
sixteen existing fast-cash checks. Two production-browser cases prove normal
metadata recording and lost-reply GET recovery with exactly one checkout, order
and payment request. Anonymous overall time remains `NaN`; original timing
strings and operation IDs stay unchanged. These controlled flows add browser
coverage to the backend checks above, without live provider certification.
