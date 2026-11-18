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
