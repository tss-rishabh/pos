# Review-only invoice deployment inputs

No SQL here has been applied. The supplied reports reader remains read-only.
The proposed prefixed tables are in the already authorized
`tssgcp2025.tss_mysql_raw_layer` dataset; they have not been observed there.
Using another dataset requires a separate reader grant and explicit configuration.
A different publisher identity owns creation, ingestion, reconciliation and the
publication manifest. The application performs bound SELECTs only.

The exact projection schema is in `history-publication.review.sql`. Orders need
only ID, customer ID, order status, payment status and source `updated_at`;
contacts, address, payment instruments and invoice HTML are excluded. IDs remain
canonical decimal strings through all boundaries. Source `updated_at` is a MySQL
wall-clock DATETIME with its real fractional precision, never an inferred UTC
conversion. Source snapshot/watermark/publication timestamps are explicit UTC
TIMESTAMPs. The manifest uses `pos-invoice-orders-publication-v1` / `orders`.

A publisher first establishes an authoritative consistent source snapshot and
its exact source log position. It applies every transaction and deletion through
that position before building a generation. Its canonical stream is canonical
UTF-8 JSON arrays of `[orderId,customerId,orderStatus,paymentStatus,updatedAt]`
without whitespace, one array plus LF per row, ordered by numeric order ID; the
DATETIME uses six fractional digits. `source_hash` / `warehouse_hash` are SHA-256
of that stream, independently computed per customer and globally. Counts use
exact integer arithmetic and the source status exclusion set in the SQL. Null or
unrepresentable source fields, duplicate IDs, incomplete CDC/tombstones, unknown
source time zone or different canonicalization prevent publication.

The publisher exposes only immutable generations. It publishes the complete
manifest last, after global and per-customer count/hash equality and source
checkpoint completeness have been established. Two latest manifests with the
same publish time are ambiguous and rejected. Partial generations must not
replace an older complete generation. A complete zero eligible count still has
nonzero source rows and a matching selected order; a missing customer or empty
manifest is never zero. The maximum accepted source-snapshot lag is explicit
(60–3600 seconds); newly paid orders can remain unavailable until that verified
generation includes their exact current status/payment/update tuple.

The direct raw single-table COUNT dry-run estimates 341,454,224 bytes under the
unchanged 1 GB cap, on the saved metadata check. This is not latency, completeness
or production load evidence. Raw CDC background-apply metadata does not prove all
source transactions for the customer arrived. Runtime raw mode is therefore
absent. Cluster the prepared projection by customer/order; dry-run the actual
published views with the existing byte guard before activation. The DDL is a
concrete simple schema, not an assertion that repeatedly copying all orders per
generation is an economical ingestion design. A publisher may expose equivalent
immutable generation views over a verified versioned CDC store, provided the
same snapshot, hash, conservation and pruning contracts hold. Retention, source
log/checkpoint lineage and publishing cadence require deployment qualification.

Online private worker deployment applies the existing `invoice-security` patch
then this additive reviewed patch to a private pinned image. Run
`pos_invoice_documents_factory:create_app()` with the existing closed Gunicorn
configuration and lockfile. The factory verifies all original/candidate/template
hashes, uses a TLS reader with READ ONLY + REPEATABLE READ transactions, and never
imports the API application's writer, Redis, auth bootstrap or token writer.
The source worker receives the purpose-HMAC count capability. Only the exact
pinned COUNT for that customer is replaced; unexpected historical SQL is refused.
The Node application reauthorizes before/after BQ and after rendering. Deploy the
same reviewed artifact/key versions on both sides before enabling the contract.

Express additionally uses `pos-scoped-invoice-v1`. Its private resource derives
HP IDs from the native current Express/store associations and checks their
canonical hash against the signed Node scope, then runs the pinned shop
calculator/template with selected raw rows before grouping. It never accepts
caller-selected HP IDs. Current target store, target-store OrderStore/terminal
queries, bought gifts, awarded points and split store-discount display are scoped.
The reviewed corrections are in the parity document; no tax formula is moved to
TypeScript. Run source/native/provider acceptance on the actual production reader
schema before enabling its private endpoint.

The SDD renderer is outside the supplied pinned API-v2 source. The implemented
Node adapter sends **order_id + is_sdd_shipment=0**, exactly matching the active
POS handler, to configured HTTPS `/internal/pos/invoices/same-day`. Credentials
are in private headers; redirects fail; HTML is size/time bounded. The receiver
must verify `pos-scoped-invoice-v1`, exact actor/store/order/customer/native
snapshot/expiry and source zero-shipment selector, execute only the approved
external renderer, return the existing base response HMAC plus scope-response
HMAC, and use the separate purpose-only NPS proof when present. There is no
invented SDD tax renderer in this repository. The Node transport is executable;
the external provider's implementation/credentials/TLS/source selection/legal
output are explicit activation and acceptance requirements. No provider call was
made by these tests.
