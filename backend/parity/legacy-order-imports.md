# Dormant CSV order imports

These are retained source-job surfaces, not active fast-checkout date fields. The pinned POS source is `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`; `helpers/task_helpers.py` SHA256 is `ee9053da7d0a90b145bdeb0c669e846014d7e664cae8939d76aa2db051351d60`.

`core/tasks.py:51,62` retains `parse_csv_offline_order_punchin` and `parse_csv_shopify_order_punchin`. The known offline upload/enqueue view and URLs are commented out. This does not waive either job from the full reconstruction inventory.

## Implemented boundary

The TypeScript CSV reader preserves the literal grouping and raw fields, including IDs above `2^53`, quoted multiline text and additional export columns. Offline imports start a new order on every nonempty `SerialNo`; that value is a delimiter, not a source idempotency key. Shopify repeats adjacent `Name` values; a blank name updates the previous-name variable, so a later identical nonempty name starts another group. The source's first order row supplies its details/address; subsequent rows supply line items only.

The source oracle executes only the selected original methods against synthetic, in-memory CSV and a transient `create_order` recorder. It does not import Django, open a database, obtain a customer token, charge, reduce stock, notify, upload or publish to Kinesis. CSV grouping is component evidence; it is not a completed order-import workflow.

Input corrections accept a UTF-8 BOM and reject duplicate/missing headers, malformed records, orphan leading lines and bounded-size/row violations before execution. Diagnostics never include CSV fragments, names, email, addresses, phone or order-message content. Raw fields remain server-side data and must not be logged or put into browser operation journals.

## Durable staging and recovery components

`preparation.ts` validates ordered groups, lossless identifiers, exact paise,
positive bounded quantities, store/counter selections and modern calendar dates
(1970 onward). It preserves the source tender branch and Shopify payload rather
than inventing a different tax calculation. Equal-priced duplicate products are
aggregated; conflicting product-wide prices and duplicate Shopify references
require review before dispatch. These checks do not approve a closed financial
period or establish stock/payment parity.

`repository.ts` stages one immutable operation UUID per order under a writer
transaction. Customer/address/message data is encrypted with AES-256-GCM, bound
to the job, operation, actor, store, counter, sequence and kind. Public results
exclude that payload and source references. Inserts are batched within a byte
limit. New dispatch requires current administrative/store/counter authority.
After the durable start checkpoint, lease recovery and uncertain responses use
only the original operation lookup. Cancelling affects only unsent orders;
completed results older than 24 hours refuse MySQL history fallback.

The focused backend suite now has69 checks across CSV/plans, pinned source methods,
native coordination, historical publication, and the actual job API/worker. Twenty
contenders, lost responses, missing remote records, lease takeover, revoked access,
tampered ciphertext, partial completion, pending-only cancellation, wrong operation/date
proofs and late local rollback are exercised. Native API checks also prove current
role/type/assignment/counter authority, session validation before and after work,
encrypted storage and allowlisted worker logs. Its financial port remains synthetic
in these component tests: these results do not prove a real financial import.

## Authenticated runtime and recovery UI

`registerLegacyOrderImports` exposes seven traced resources under
`/api/v1/admin/order-imports`: capabilities, exact source templates, previews,
creation, original job/results reads, and unsent cancellation. No customer payload
is returned in preview or public rows. Role1–3 internal authority and every active
store/counter are rechecked natively. Store/counter/assignment checks use bounded
batches independent of CSV row count. Historical completed results use the existing
qualified BigQuery reader with no old-MySQL fallback.

The React page keeps the file only in memory. Before POST it stores an owner-bound
opaque job UUID, exact-input digest and store/counter identifiers; it never persists
CSV, filenames, contact/address/message data or customer references. Reload reads
the original UUID with GET only. A404 cannot retire it or create another nonce.
An explicit retry requires the identical original file and scope. Storage failure
prevents dispatch; actor changes abort late reads. The operator can retire the
local reference only after reading a terminal job. The worker uses the existing
durable coordinator, a bounded batch, structured resource/request/actor events and
orderly shutdown. Production registration and its standalone entry depend on the
real financial adapter below; no synthetic adapter is registered in the app.

The native approval preflight runs under the job/row lock **before** `STARTING`.
A required or stale grant retains `PENDING` with `ORDER_IMPORT_APPROVAL_REQUIRED`
and a bounded retry lease. It does not burn the original nonce or dispatch from
GET. The private `financialContext` helper opens only an owned unsent plan for
the server approval service; HTTP resources never return that private payload.

## Remaining financial orchestration

The offline source resolves the customer by email, otherwise falls back to the operator's type8 customer; `UserName` and `IsExclusive` are read but not applied. It uses current GS1 lookup, server-built `custom_data.price`, API cart validation/processing/order creation with `custom_created_at`, ordinary confirmation, then historical cash or manual-other settlement. Its total is a repeated floating-point sum of supplied unit prices. Duplicate SKUs with different prices overwrite the shared custom-price dictionary while leaving the accumulated tender total unchanged; this must become a reviewable integrity failure or a separately proved correction, not a silently accepted mismatch.

The Shopify source requires an existing customer and converts the offset date to Asia/Kolkata. It supplies price, tax, shipping, currency, discount and address to the external `shopify` order path, then separately reduces stock and publishes Kinesis. It does not invoke the ordinary POS confirmation/cash settlement branch. The literal tax parser selects the first individual digit in `Tax 1 Name` (`18` becomes `1`); complete downstream monetary effects must be proved before selecting a correction. The source reads but does not enforce financial status, and does not deduplicate repeated Shopify references.

The remaining runtime adapter must bind private source-price/date privileges,
closed-period approval, current customer/contact state, coherent stock/projection,
and historical settlement or Shopify publication. Its contract is defined in
`financial-contracts.ts`; no synthetic adapter is registered in the application.
The job API, UI, worker loop and published-history repository composition are
implemented. Financial execution/approval adapters, production entry/registration
and actual downstream/shared-writer/warehouse acceptance remain unfinished.
No live source or data has been changed.
