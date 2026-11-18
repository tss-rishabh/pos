# Exact checkout barcode resolution

The source `order/templates/order/create_order.html:1363` sends the captured
scanner input to AjaxCart independently of inventory search. At
`order/views.py:1716`, input-mask underscores are removed and integer equality
selects a GS1 record. Zero falls back to product_id zero for scanner requests.

CounterPage previously used a deferred search's single result on Enter, so a
new scan could select the previous query's SKU. The dedicated read route is
`GET /api/v1/stores/:storeId/catalog/products/by-barcode/:barcode`. It returns
the canonical `matchedBarcode` and existing product DTO; it retains that DTO's
primary display barcode when an alternate GS1 record matched.

The ORM query shares the existing POS catalog eligibility and projections,
using exact GS1 EXISTS rather than a fuzzy name/ID/GTIN match. It preserves
integer precision, includes alternate GTIN records, avoids same-SKU row
multiplication, and refuses multiple eligible SKUs with409. The source selects
the first duplicate GS1 record; the rewrite explicitly refuses ambiguous
assignments to prevent a wrong-product sale. No result is404, including zero.
No fuzzy SKU fallback follows an unsuccessful scan. The frontend integration
must capture operator/store/counter/draft context and deduplicate in-flight
scans; this backend change alone does not close that UI race.

The read uses PRIMARY for catalog facts and checks current writer actor/store
authority and store activity before/after. HTTP operator/session checks also
surround it. It has a resource/action trace and private no-store response.
The synthetic demo resolves its own exact barcode without any database access.

Eleven input/selection/actual demo-App checks pass. One focused native MySQL
case covers alternate wide-integer GTIN, first-barcode preservation, exact
substring refusal, wrong-store exclusion, inactive store, repeated same-SKU
records and ambiguous cross-SKU assignment. Five unrelated cases in that file
were deliberately unselected. Main/scoped strict and changed ESLint pass.
The native fixture recreates/drops the saved physical uq_product_store index;
the generic fixture omits secondary indexes, causing the retained initial
setup failure with the existing FORCE INDEX. No live DDL, stock/cart mutation
or source provider invocation occurred. The exact owned container is absent
and its data was tmpfs, with no anonymous volume. The bounded receipt is
`evidence/catalog-details/barcode-native.json`; it is not full checkout parity.
