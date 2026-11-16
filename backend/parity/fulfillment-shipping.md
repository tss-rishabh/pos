# Express shipping-label reconstruction

Source baseline: `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`,
`order/views.py:ShowOnlineOrderShippingView` and
`order/templates/order/shipping.html`. This is a bounded feature implementation,
not whole-source route, deployed-authentication or production printer certification.

`registerShippingLabels(app, db)` in
`src/modules/fulfillment/shipping-label/index.ts` registers two GET resources:

- `/api/v1/stores/:storeId/fulfillment/orders/:orderId/shipping-label` returns
  a strict label DTO.
- The same resource's `/preview` returns a standalone inert HTML document.

Both require the current authenticated captured operator header, validate the
scope and reject unexpected query fields. They declare static fulfillment /
shipping-label / read-or-preview traces and private `no-store` responses. Preview
uses a hash-bound stylesheet, no scripts/network resources, same-origin frame
policy and no referrer. Customer address/telephone fields never enter logs.

## Source behavior

The source label belongs to an **ExpressLineItem order/store pair**. It does not
implement or authorize the older Borzo lifecycle documented in
`remaining-owned-source-audit.md`.

The projection retains the source unique-HP selection despite duplicate express
rows, full quantity sum, first qualifying AWB by HP primary key, missing-address
fallback, address/flat/landmark/city formatting and Python whitespace stripping.
Native MySQL blank-AWB comparison preserves the physical PAD SPACE collation;
spaces-only AWBs do not replace a later usable AWB. Null HP references are ignored
by the same source `id IN` semantics. Quantity summation remains exact with BigInt
and a string DTO, including values above JavaScript's safe integer range.

Source fixed fields remain `Prepaid`, `Cloths`, NIL, 30.000 × 30.000 × 2.000 cm,
0.384 kg, return-to-store text, order reference/date, both barcodes and the tax
footer. English date formatting follows the pinned en-us source setting. The
standalone print stylesheet retains 100 × 150 mm paper with 3 mm margins.

Before private data is read, writer shared locks recheck active role/user type,
current store assignment and franchise category, the active Store, existing Order
and current express pair. The writer address-FK selection must agree with the
primary snapshot. Label projection runs in one read-only repeatable-read primary
transaction while authority locks are retained. Historical order age does not
route a current operational shipping decision into the warehouse. This is a live
operational document, rather than a historical reporting endpoint.

Missing primary product/header evidence fails as not-ready rather than printing
a partial or lagging label. Cross-order HP links fail reconciliation instead of
including another order's product data. A source group above 10,000 express rows
and unsupported barcode/date data fail explicitly. These source anomaly bounds
are not silent changes to normal label totals. Actual replicated-data latency
and existing anomalous source rows remain acceptance checks.

## Barcode implementation

The source template pins JsBarcode 3.11.5. Its fixed Code128 symbol patterns and
MIT notice are retained locally. A bounded minimum-symbol A/B/C planner produces
the same scanned ASCII/control/FNC1 values with no CDN, runtime script or eval in
production. Test-only pinned encoder artifacts and hashes live in
`tools/fulfillment/shipping-label-source/`; their upstream URLs and MIT license
are recorded there. Seventy-three source-encoder vectors are independently
decoded with the captured source symbol table, including checksum, code-set
switches, numeric runs, control characters and long identifiers. The resulting
symbol count is no larger than the source encoder on those vectors. This does
not certify a physical scanner/printer combination.

## Frontend and evidence

`frontend/src/pages/fulfillment/shipping-label.tsx` exports
`ShippingLabelAction({ user, storeId, orderId, online })` and the corresponding
`ShippingLabelDialog` with `onClose`. Root displays the action on packed/shipped
cards with `hasAwb`, preserving the current design.

The preview is fetched with a captured operator and bounded HTML reader, then
shown in a script-free sandboxed frame. It checks the document's exact scope
marker, uses no persistent address cache and removes private content on cached
session expiry or actor change. Printing re-fetches the authorized current
document; offline state or a denied refresh cannot print an earlier preview.

Focused checks comprise 11 backend tests across five files, including twelve
actual source-handler/native-MySQL vectors, source address helpers, barcode
decoding, document escaping/CSP, stale-role/store/type checks and HTTP traces.
The local native fixtures create and drop only random `pos_rewrite_shipping_*`
schemas behind the explicit localhost integration guard. The has_addresses
projection is checked against `evidence/mysql-admin-shipping-schema.json`; other
tables use the captured core/extra physical metadata. No live address rows or
provider operations are used.

Two frontend transport tests check exact document scope and bounded streaming.
The isolated Chromium fixture uses the real backend renderer and mocked HTTP,
passing six workflows with five requests, zero page/console errors and no
unexpected requests. It checks escaped private text, SVG barcodes, current
authorization before printing, denied print refresh, session expiry, operator
change during a pending response and offline controls. The fixture disables
only Vite's unrelated development hot-reload websocket; document CSP remains
the actual production renderer policy. Evidence and screenshot are in
`parity/evidence/fulfillment-shipping/`.

Strict checks: backend `tools/fulfillment/tsconfig.shipping-tests.json` and frontend
`tests/shipping-label/tsconfig.json`. The portable browser harness is
`frontend/tests/shipping-label/browser-check.mjs`, using the shared isolated Vite
fixture server on port 4490 and `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when configured.
No new deployment option, legacy DDL, migration or provider transport is required.
