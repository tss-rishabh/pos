# Protected invoice documents

Source pins are POS `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a` and API-v2
`2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`. This slice adds online, SDD and
store-selected Express document resources, a writer-derived capability UI and
shared safe preview/printing. It reuses `invoice-security.md` for ordinary store
invoice protection. It is not whole-project, legal or physical-printer certification.

## Source map and implemented boundary

| Active source                                                                           | Rewrite                                                                                                                   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `order/urls.py:13` store invoice / `PosInvoiceShop` / `Invoicer/index-shop.html`        | Existing protected store service, shared actor-scoped iframe/print/download                                               |
| `order/urls.py:14` online invoice / `generate_invoice(skip_auth=True)`                  | Private read-only original renderer + authenticated BQ count publication                                                  |
| `order/urls.py:15` SDD invoice / `ShowOnlineSDDOrderInvoiceView`                        | Real bounded private provider adapter preserving `is_sdd_shipment=0`; external renderer qualification required            |
| `order/templates/order/hyperlocal/_order_cards.html:159` store-selected Express invoice | Native Express/store selection, selected scope proof and original shop renderer corrected before grouping                 |
| `order/templates/order/invoice.html:46` automatic popup print after one second          | Same-origin in-app preview, one branded paid-receipt print attempt after document readiness; explicit fresh print remains |

The API exports `registerInvoiceDocuments(app,config,db,options?,fetcher?)`.
`GET /api/v1/stores/:storeId/orders/:orderId/invoices/capabilities` derives only
currently scoped eligible actions; clients do not infer them from generic paid
flags. Document GETs are `invoices/online`, `invoices/same-day` and
`invoices/express`. Protected iframe navigations include the captured operator
path assertion and must match the current revocable cookie identity. No query
secret, bearer URL, HTML cache or new Electron navigation permission is added.
The actor path is an equality assertion, not a credential.

Full invoices require complete OrderStore/full Express/local ownership; one line
of a mixed-store order cannot authorize a full invoice. Selected Express invoices
permit only current HP rows mapped to the target store; ambiguous cross-store
mappings, dangling rows and unsupported platform bindings fail. Authorization,
active stores/operators, payment4, native financial header/line/association hashes
are captured on writer and rechecked after rendering. Transactions end before
BQ/HTTP; no SQL locks span a remote call. The private worker independently verifies
its READ ONLY/REPEATABLE READ snapshot against the purpose-HMAC binding. Native
IDs remain exact above 2^53. Current authoritative reads have no warehouse fallback.

## Original math, legal data and explicit corrections

The original online old/new calculation branches and full pinned Jinja templates
execute in the private worker. Code128 uses the original `10` + order-ID payload.
Store invoice GSTIN/ARN/franchise CIN and online fixed source GSTIN/PAN/CIN, HSN,
CGST/SGST/IGST groupings and original rounding remain source-defined. TypeScript
sanitizes presentation; it does not calculate taxes. The purpose-only feedback
QR is not an IRN or government-signed QR. No pinned controller/template establishes
an IRN/EWayBill renderer or active credit-note print route. Existing credit-note
number/report display is separate; no invented printable credit note is claimed.
The sanitizer uses inert print CSS and removes remote scripts/images/styles.
Source logos/signatures and layout/printer/scanner acceptance remain deployment
review items, not implicit legal approval.

Original Express grouping-before-selection aggregates two same-SKU rows from
different shipments, then accepts the entire aggregate when one HP is selected.
The executed fixture shows quantity3/price150 versus selected quantity1/price50.
The candidate filters raw HP rows before invoking the unchanged original grouping
and tax calculator. Target-store OrderStore/terminal selection and store legal
fields replace the original arbitrary first-store choice. Bought gift rows and
awarded-point totals are bound to the selected HP set. The split store-discount
label uses the selected HP amounts. The unsafe fixture's points100→1, bought-gift
rows1→0, discount55→5 and foreign GSTIN are explicit privacy/scope corrections.
Source-normal same-store duplicate and distinct-SKU split cases have identical
full HTML hashes. Source split tax/discount rounding is retained.

SDD source request evidence executes the pinned handler and proves the constant
zero selector. The repository lacks that external renderer implementation; the
Node adapter is implemented with strict private HTTPS, timeout/body bounds,
no redirects, base HTML proof plus scope proof, no query credentials and fresh
current scope checks. Activation requires the actual provider to implement and
qualify that contract; no success stub or guessed tax formula substitutes for it.

## Historical count and deployment gate

The online source runs a lifetime customer-order COUNT. It is intercepted only
for the exact pinned SQL/customer and supplied as a signed, immutable request
value. Unexpected historical SQL fails closed. BQ alone supplies the historical
count. `history.ts` requires a complete immutable generation, independent global
and per-customer source/warehouse counts and hashes, a true completeness
attestation, explicit lag, and exact selected order/customer/current status/payment
/update. Missing/duplicate/incomplete/stale results do not become zero. An attested
legitimate zero is preserved. BQ dry-run enforces the unchanged configured byte
cap before execution. A raw single-table estimate 341,454,224 bytes is below the
1 GB limit but lacks source completeness, so raw COUNT execution is not enabled.
CDC apply time alone is insufficient. This is one-table completeness, not a
multi-table financial snapshot claim.

Review-only schemas and publisher requirements are in
`compatibility/upstream/invoice-documents/deployment/`. No DDL, source/provider
write or credential/key file read was performed. The required normalized views
were not observed in the authorized raw dataset. A separate publisher must
establish source checkpoint/tombstone/canonical-hash conservation and immutable
publication before runtime activation. Initial auto preview may be unavailable
until a newly paid order reaches a verified generation; payment is already
complete and optional preview failure cannot charge or change it.

## Automatic and explicit UI evidence

`createAutomaticInvoiceRequest(user,storeId,ConfirmedPayment)` returns a branded,
short-lived in-memory request only for an exact paid/prepaid receipt. The caller
mounts it after a new local completion or first unacknowledged paid recovery;
restored/reloaded completed receipts remain explicit. A SHA-256 opaque session
marker is claimed before printing, survives remounts and stores no HTML/customer/
receipt data. Twenty concurrent claims yield one attempt. Cache expiry, actor/
role/type/store changes, scope mismatch and unavailable marker storage prevent
printing. Current source/paid authorization is mandatory on every document load.
Manual Print fetches a new protected document; a denied refresh removes the old
frame. Initial/manual preview each makes one renderer GET; download makes its
own authenticated GET. CSP is served on a direct same-origin document, preserving
the parent app's stricter CSP. This fixes the real inherited-CSP srcDoc styling
failure without weakening the parent or using a popup.

The prior coherent root run passed the protected-preview production invoice
spec plus five fast-cash automatic/recovery/reload scenarios, including real CSP
12px print styling, denied fresh print and one order/one charge conservation.
Current additional tests execute the selected Express source oracle, native
scoped proof, SDD source handler and mocked bounded provider path. They do not
claim deployed provider or arbitrary physical printer acceptance. Exact commands:

- `MYSQL_INTEGRATION_URL=mysql://root@127.0.0.1/pos_rewrite_integration ... vitest run tests/invoice-documents`
- `... tsc --noEmit -p tools/invoice-documents/tsconfig.tests.json`
- Frontend `... tsc --noEmit -p tests/invoice-documents/tsconfig.json`
- `tools/invoice-documents/bigquery-fixtures.ts`: literal-only BQ positive/zero/incomplete/empty publication SELECTs plus a metadata-only raw dry-run; no source rows returned

Evidence JSON contains only synthetic outputs, hashes, totals and metadata.
Full original SQL joins/templates/provider deployments beyond those executed
vectors remain acceptance boundaries. All route events use static resource
traces; no invoice/customer/body/token/raw exception is logged.

The resolved `has_addresses` row is included in the native header digest and a
positive address reference must belong to the order's original customer. Pinned
`OrderHelper.build_address_model:2045` constructs/deduplicates using that user ID.
Its intentionally inactive POS address remains valid for display; this guard does
not require an active shipping address. Zero/null references retain the original
copied-order fallback. A native test rejects a different customer owner before
render and refuses address content changed during the remote render. The same
SQL expression executes in the isolated Python snapshot, so the proof includes
resolved contact content without returning or logging that content to the app.

Current focused checkpoint: 30 backend test cases including 14 guarded native
MySQL cases, 9 frontend unit cases, 8 controlled Chromium checks and 4 executed
BigQuery generated-literal cases pass. Native selected Express also executes the
actual corrected source gift/awarded-point SELECTs against verified local schema
metadata, retaining selected gift 10 / points 1 while excluding foreign gift 20 /
points 99. Source-normal tax/HTML comparison and the privacy-anomaly vector
are separate from native scope qualification. Browser port 4496 was closed after
the focused run; these checks used no shared production dist or default ports.

Exchange completion uses a separate
`createAutomaticExchangeInvoiceRequest(user,storeId,{source:'exchange',exchangeId,orderId})`
capability bound to the real completed operation and its new child order. It does
not fabricate a payment attempt, checkout operation or paid amount. The opaque
one-attempt domain is separate from counter/prepaid receipts; cloned/restored
JSON, wrong store, malformed UUID/ID and repeated concurrent claims are refused.
The same current backend paid/store gate remains mandatory for printing. An
unpaid exchange child can show an optional preview error, without altering the
completed exchange or its money. Checkout owns the source-action-only mount;
restored GETs and saved command replays do not create an automatic request.
