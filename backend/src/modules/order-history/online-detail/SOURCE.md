# Original online/local/express detail surface

Pinned source: `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`, `order/views.py:504` and `order/templates/order/online/show.html`.

Read groups to preserve:

- Order ID/reference, order amount, payment amount/method/status, order status/date, global/split markers and parent/child links.
- Order-bound customer ID/name/email/telephone, current Money/Points, Exclusive membership/expiry/message; customer read popup is an additional action boundary.
- Product-line ID, exact SKU/product/parent IDs and name, price, status, quantity, GST, platform and Express line state. Links open product detail.
- Delivery start/end slot, courier ID and source/destination tracking, support ticket ID/status/message, transfer/eligible-store state, parent/child references.
- Original placement payment breakdown and subsequent transaction timeline, comments, timestamps and payment entries.
- Read/document controls: standard/SDD invoice, shipping label and product links.

Action groups need their existing appropriate authority rather than store-sale action reuse:

- Line return/exchange, override and extended applicability; eligibility/provider decision reads.
- Local delivery acceptance/pass/decline/convert/cancel/pack/RTO and explicit store selection.
- Express line acceptance/rejection/cancellation/shipping actions.
- Payment/order status actions and customer editing.

The initial new detail model/read implementation does not certify these financial or provider actions merely by displaying order facts. Existing local/Express workspaces remain available, and each missing binding must stay explicit in the review map. A read projection must never fake an OrderStore association for N, expose unrestricted customer lookups, or fetch old order facts from MySQL when a historical publication is unavailable.

Historical detail requires a complete qualified rich-detail fact. Existing search/public-order v1 facts do not contain the delivery/timeline/profile groups above. The dedicated read-only contract, validated options and SDK reader are implemented. They require deployment-owned complete publication views; absent configuration or missing qualification refuses the request. The adjacent SQL is a review artifact only. No live dataset or publication is created here.

## Current dimensions versus historical line facts

The actual source `get_exchange_context` (views.py:306–348) reads current `hp.product.parent_prod_id`/`id` and adds eligibility/display attributes; it does not rewrite `hp.price` or `hp.gst`. The template at online/show.html:312–320 reads the current Product ID/name and parent link, then displays HP price, quantity, status and GST directly. There is no catalog-price/GST fallback. The verified physical HP price and GST columns are NOT NULL; malformed financial nulls are refused rather than invented from today's catalog.

Accordingly the historical detail JSON contains the immutable HP product reference and financial values but **no** frozen product name or parent SKU. After order/customer/type authority and publication validation, one bounded PRIMARY query obtains only the current bound product IDs, names, parent IDs and product types. The response marks these dimensions current, as it does the current customer/wallet. It does not fetch historical HP/order financial fields from MySQL. Missing current product dimensions make the complete detail unavailable, matching the source's required product relation rather than silently manufacturing a SKU/name.

A historical contract-bound service regression renames/reparents the current Product and changes its catalog price/GST. It verifies that names/links update while both current HP values and historical published financial values remain unchanged. That regression names its history-port boundary explicitly; actual BigQuery transport/publication acceptance belongs to the separate joined workflow.

## Focused implementation evidence — 2026-11-18

Authored against merge `a01f0552c7217dffc16cde28263bca9766659880` (Root `451e0d3` plus separately identifiable HE form hardening and safe-identifier integration). Frozen r9 `caba871` does not include this later feature.

- Backend/frontend TypeScript strict and changed-file ESLint passed. Production Vite build used explicit `NODE_ENV=production`.
- Seven value/publication qualification tests and two frontend link-validation cases passed.
- Nine native/source/routed-App cases passed in 8.36s with Node 24.22.3, CPython 3.10.22, Django 4.2.5 and an owned pinned MySQL fixture. The actual routed App uses a fresh browser, native cookie/session and real HTTP/SQL, including reload/new tab, wide IDs and denial after authority changes.
- Twenty-four component request-contract groups passed, including applied Express store and effective queue type links. This component carrier intentionally intercepts API responses and is not promoted as native/provider evidence.
- Retained canonical native log: `/tmp/pos-online-detail-native-ui-310-20261118.log`; production build: `/tmp/pos-online-detail-build-310-20261118.log`; component log: `/tmp/pos-online-detail-component-final-20261118.log`. Digests are recorded in the adjacent receipt.

The source comparison executes pinned real helper/native ORM bodies, not the whole inherited ShowOnline dispatch/template. Historical tests use a named contract-bound history port for boundary/authority/current-dimension cases; actual Google SDK dry-run/query/publication and full App→warehouse joining remain separate pending work. No whole source route/template certification follows from these counts. N invoice access and contextual returns/other mutations are separate implementation bindings; read entry does not certify those financial/provider effects.

## Contextual returns navigation follow-up

After merging `1947373`, the detail page provides return/exchange navigation only when an explicit, valid counter belongs to the current selected detail store. Links bind operator/store/counter/order/mode through `returnOrderLink`; they do not preselect a product, issue an OTP or start a mutation. The returns entry wrapper validates reload/new-tab context, and the existing workflow retains current check-in, verification and uncertain recovery requirements. Frontend strict, changed-file ESLint and production build passed for this follow-up. The earlier nine-case read receipt is retained unchanged and does not claim execution of this later action navigation or its financial effects.

## Reachable action inventory

| Original control | Reachable behavior | Rewrite implementation / remaining boundary |
| --- | --- | --- |
| `online/show.html:71` `.user-data` anchor | No matching handler exists anywhere in pinned HTML/JS, including inherited shell; no actual edit or popup request | Current order-bound profile shown; do not invent customer editing from this inert anchor |
| Payment/order status cells `:215–217` | Display only; the money icon `:223–227` invokes local-delivery acceptance | Current statuses displayed; real local acceptance/lifecycle panels, no invented generic payment/status editor |
| Full/SDD invoice `:233–243` | Paid-only documents, SDD from source split/platform predicate | Owned HL/HE document workflow; genuine global N adapter separately in implementation |
| Shipping label `:249` | Local warehouse order after ACCEPTED | Existing authorized label control; no N owner invented |
| Product SKU/name `:312–316` | Open current parent/Product | Current dimension-bound catalog link |
| Parent/child `:19–34` | Navigate related order | Operator/store-bound typed detail URLs |
| `_return_exchange_cells.html` normal/merged cells | Exact HP-line return or exchange, provider eligibility and date | Exact-line navigation now carries only validated line ID; selection happens only from verified server-returned matching line, never from raw URL values |
| Manager Extend Date | Roles 1/2/3, closed return period, explicit date and acknowledgement | Existing scoped `ReturnWindowExtension` after verified line selection; keeps revision/read-after-uncertain guards |
| Super-admin override | Role 1, source helper policy; not arbitrary status bypass | Explicit role1-only checkbox wired to existing server `overrideEligibility`; provider date/native/refund/check-in/customer proofs remain required |
| Failed exchange | Same receiving store, stored replacement/reason/comment, fresh salesperson; no duplicate return leg | Current verified-line discovery/explicit claim and exact-evidence legacy-log adoption are implemented; no inbound/restoration replay. Complete duplicate-SKU group proof is a remaining follow-up; provider/full-App joining is not certified by component evidence |
| Local accept/pass/convert/decline/pack/cancel/RTO | Source target store/status/time authority | Existing real local fulfillment/lifecycle panels embedded; provider effects have separate proof |
| Express handling | Source inline body has no Express mutation JS | Existing Express queue entry preserved; no claimed full queue/provider certification |

Line-selection follow-up retains existing local recovery as the first authority, never sends an OTP or mutation automatically, and refuses duplicate/unknown/prototype-name query fields. A link for an absent, duplicate, returned or non-replaceable verified line does not select it. N/HL/HE line buttons open eligibility review rather than promising approval.
