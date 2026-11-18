# Staff product feedback

Baseline: backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a,
`users/views.py:GetOrderFeedbackFormView.get_order` and
`order/views.py:AjaxAddFeedback.post`, with `order/templates/order/add_order_feedback.html`.
This is staff-entered product feedback, separate from the customer NPS survey.

The new scoped page opens from delivered customer-history orders. Its API base
is `/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customers/:customerId/orders/:orderId/product-feedback`:
GET reads a keyset page of up to 50 HP occurrences, POST saves one product's four
ratings atomically, and GET `/submissions/:operationId` recovers a saved result.
Every route has a static resource trace and `private, no-store`; payloads,
comments and source SQL diagnostics never enter application logs.

## Preserved source values

Each HP occurrence is retained, including repeated SKUs. Feedback remains
aggregated by order+product, irrespective of its stored user/platform/HP fields,
matching the staff source view. Existing partial ratings, repeated options,
nulls and mobile/bot/per-line rows are read-only. The source option sort and
first-row-to-last rotation are retained; equal-option ties use ascending IDs.
Product display uses the current name, with the source ID fallback for an empty
name. Paging never deduplicates repeated SKUs.

New rows use the checkout's customer ID, exact source order/product IDs,
options 0 (overall), 1 (fit), 2 (size), 3 (quality), WEB platform, default flag 1
only for overall, and a comment only on the overall row. Optional ratings default
to 0; overall is required. Ratings retain 0–5 in 0.1 steps and native FLOAT
storage. Comments are bounded to 255 characters and checked against the verified
source MySQL latin1/CP1252
repertoire. Source parent_prod_id/is_bot defaults and nullable has_product_id are
left unchanged; the staff writer must not fabricate API-v2 per-HP attribution.

## Authority and intentional corrections

The operator must currently own the checkout, store access and counter check-in.
The supplied customer must equal the attached customer. Writer-current indexed
point reads verify active/unblocked/enabled customer and order ownership before
and after primary-reader presentation reads. New writes additionally require an
editable checkout at the supplied version and a delivered order, matching the
source's delivered-history entry point. A guessed order/product/customer cannot
cross that scope. There is no historical MySQL report scan or warehouse fallback.

The source's four independent AJAX inserts can leave a partial set. The rewrite
uses one transaction for all four inserts and an additive POS UUID receipt.
Retry payloads are HMAC-bound to actor, store, checkout, customer, order and
product. Exact retries return the receipt; changed reuse fails. The UI retains
unknown submissions in memory, checks their receipt first and permits only an
explicit exact retry after 404. Comments are not saved to IndexedDB/localStorage.
Duplicate-SKU forms become read-only together after a confirmed save.

Order locks serialize concurrent rewrite checkouts. No legacy business-key
unique index is added: API-v2 `ProductRatingUser` also writes legitimate separate
platform/has_product_id rows, while Haptik has a separate aggregate writer. Those
independent applications do not share the POS order-lock protocol. Mixed-runtime
concurrent inserts/updates are not certified as globally serialized. Existing
rows are never overwritten or merged by this rewrite, and no global once-only
rating guarantee is claimed. A deployment that needs such a guarantee must
coordinate those writers; the source model cannot safely gain a generic
unique(order,product,option) key.

The pinned Drizzle generated-ID helper uses a numeric increment loop that can
stall above 2^53. This writer instead takes each exact mysql2 insertId, validates
its signed BIGINT range and records it without Number coercion or synthesized
contiguous IDs. All four writes still use the ORM. No live source row/schema was
modified for this fix.

## Verification

The source AST oracle executes the actual read/write method bodies with isolated
ORM doubles, including duplicate occurrences, partial/null/unknown options and
four native input mappings. Twelve backend tests pass, including nine native
MySQL cases generated from saved physical metadata: 20 concurrent exact retries,
two-checkout serialization, IDs above 2^53, final-insert failure rollback, source
values, current customer/operator/store restrictions, full 128-character request
IDs and immutable retry receipts.
Seven isolated Chromium cases pass for rendering, validation, default values,
lost-result recovery, exact retries, response binding, offline hiding and comment
privacy. A production-browser test verifies the mounted route, exact order IDs,
escaped comments, store transitions and malformed ID rejection before requests.
Dedicated strict TypeScript checks cover both test sets. These proofs
do not certify all source HTTP routes or production mixed-writer deployment.

## Joined native source, API and built-page workflow

`tools/product-feedback/run-native-workflow.sh` runs thirteen joined workflows on an
owned disposable MySQL 8.0.39 container. It checks both selected dependency
artifacts before tool execution, restricts database access to localhost and its
explicit fixture schema, and removes the container and temporary environment
afterward. Node 24, Docker with the pinned image cached, `uv`/Python 3.12 and
the two projects' mitigated npm installs are prerequisites. From the repository
root, run:

```sh
PRODUCT_FEEDBACK_SOURCE_ROOT=/path/to/backend-pos-web sh backend/tools/product-feedback/run-native-workflow.sh
```

An optional `PRODUCT_FEEDBACK_SOURCE_PYTHON` may select an already provisioned
isolated interpreter with the exact `native-workflow-requirements.txt` packages.
Otherwise the runner provisions a private temporary environment and cache. It
never changes the original source environment or a shared npm installation.

The source oracle now also executes the immutable handler bodies on genuine
Django QuerySets against the same physical fixtures used by the rewrite.
Unused Order/User/Product/HP model fields are projected away; used field and
relationship declarations, Meta, display methods and the complete rating model
come from the pinned source AST. Original URL bindings are checked. The complete
source view classes now also run through Django dispatch and LoginRequiredMixin,
including the original GET renderer and POST exception handling. Their fixture
identity seam reads the native operator's active state; it does not certify the
shared password/session/SSO provider or global CSRF/ASGI middleware.

The exact feedback main block and custom inline script render through Django.
Pinned local jQuery executes the source serializer in a real browser. Only its
HTTP transport is adapted to the actual original Django view/native ORM; no
candidate response is substituted. Captured business fields and wire encoding
are compared in memory; CSRF token values, cookies and payloads are never logged
or retained in the receipt. Legacy console calls are counted through a sink
without preserving their payload values. Unused CDN plugins, the surrounding
application shell and the unused mathfilters import remain outside this feature.

The browser loads a production-built `ProductFeedbackPage` at its real route
shape and talks to `buildApp` through an HTTP proxy. Normal response bodies come
from the real server; no API data is fabricated. Native session credentials are
created by the fixture; production cookie validation, identity reload, current authority,
request validation, routes and ORM writes run normally. This proves current
session use, not password/MFA/Google sign-in. One fault-injection case delivers
the committed POST headers and truncates its JSON body; the UI recovers through
the actual receipt GET with one POST and four rows.

The joined checks compare all frontend-visible source order/product/rating
values, duplicate SKU occurrences and known form constraints; four actual source
script-generated AJAX inserts match the rewrite's native business fields and
defaults for empty and nonempty optional fields/comments. Generated
rating IDs/timestamps are not compared for equality across separate writes;
they are not source feedback display values. Partial/null/unknown-option/mobile
data remains readonly, all five numeric roles are exercised, and wrong
store/customer/order/product/version and archived-session requests are refused.
The built page keeps comments out of console and durable browser state and
renders HTML-like source text safely.

The source-browser execution establishes explicit nonfinancial corrections:

- Duplicate-SKU source forms reuse element IDs. Invoking the second form's exact
  handler reads the first form's values; the rewrite saves the selected line's
  values while retaining product-level feedback aggregation.
- An order ID above `2^53` is emitted as an unquoted source JavaScript literal.
  Rounding changes its DOM lookup, which throws before any AJAX or insert. The
  rewrite preserves the exact string ID and saves to the intended order.
- Repeated source handler invocations can insert eight rows. An ordinary native
  source button also follows default form navigation without waiting for its
  independent AJAX deliveries. The proof exercises handlers separately to
  compare complete four-request values, then observes unmodified native button
  navigation and whichever requests reach the source. The rewrite completes
  explicitly in-page and disables both duplicate forms after one confirmed save.
- Source missing input returns HTTP 200 with string status `400`; a nonnumeric
  option raises a native-dispatch ValueError/HTTP 500. The typed replacement
  rejects malformed requests before writes. Anonymous source dispatch redirects;
  the replacement API returns 401, leaving sign-in to the application.
- A native CHECK fault on the fourth option leaves three successful source
  inserts and an HTTP-200/string-400 result for the last request. The same fault
  rolls back the replacement's entire command; receipt lookup finds no result,
  and an explicit exact retry succeeds once the fixture fault is removed.

Transport envelopes, stronger current checkout/customer/store authority,
atomic four-row writes and UUID receipt recovery are intentional adaptations
already described above. These tests do not assert identical legacy behavior
for every invalid, partially committed or competing independent-writer request.
They do not certify the shared application shell, source ASGI/auth middleware,
NPS, financial checkout, other rating writers, production deployment or complete
project parity. The scoped checksum-bound receipt is
`evidence/product-feedback-native-workflow.json`; no release ledger entry is
promoted automatically.
