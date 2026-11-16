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
