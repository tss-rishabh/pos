# Focused remaining-source audit

Baseline: `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.
This audit compares active source declarations and named background tasks with
the fulfillment, finance, operational-report, scheduled-report and catalog
component maps. It does not certify source HTTP/template parity or production
authorization, data or external delivery.

## Older fulfillment family: implemented bounded lifecycle

The older Borzo lifecycle is separate from the implemented ExpressLineItem
progress, per-line operations and expiry worker. Checkout confirms it has not
implemented the older lifecycle either. The subsequent `legacy-fulfillment`
slice implements status, packing and receiving with explicit stock corrections.
The later lifecycle slice now executes the following transitions and jobs;
external activation and unsupported source anomalies remain explicit gates.

| Active source surface      | Source location                                                                                  | Implemented behavior / boundary                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `ajax-hl-order/`           | `order/views.py:AjaxHlOrderView`                                                                 | Actual durable Borzo creation, split status changes and cancellation/refund commands            |
| `auto-hl-order/`           | `order/views.py:AutoHlOrderView`                                                                 | Independent service authentication, arrival holds, advance-slot notification and timed transfer |
| `ajax-convert-online/`     | `order/views.py:AJaxConvertOnlineView`                                                           | Durable online conversion, source child/charge proof and frozen uncertain outcomes              |
| `ajax-pass-order/`         | `order/views.py:AjaxPassOrderView`                                                               | Atomic reservation handoff to aligned backup stores or online conversion                        |
| `webhook-cancelled-order/` | `order/views.py:WebhookCancelledOrderView`                                                       | Separate observer credentials, exact cancellation effects, shared stock proof and notifications |
| Named tasks                | `order/views.py:auto_hl_order_transfer`, `auto_hl_order_to_online`, `advance_order_notification` | Durable leased delayed jobs and auxiliary delivery; no reliance on Express coverage             |

These rows are implemented in `legacy-fulfillment/lifecycle`, with actual
isolated MySQL and pinned source-method evidence in `local-delivery-lifecycle.md`.
The source's missing scope checks, repeated RTO increments, non-atomic
provider/local effects and raw exception logging are not copied. Activation
requires coordinated cancellation writers, approved provider/outcome adapters,
verified stock capabilities and tested deployment configuration. CORE warehouse
mapping and implicit extra-SKU cancellation remain fail-closed anomalies.

Implemented bounded surfaces are `AjaxCheckOrderStatusView`,
`AjaxOrderPackView.txn_logger`, and `AjaxRtoRecievedView` receipt/inventory
handling. The product calls them **Local deliveries** at `/local-deliveries`.
The implementation preserves source status branches, packing comments and
normal per-HP RTO stock/audit steps. It corrects repeated restoration and the
source's wrong split-order target. Prior cancellation/refund evidence requires
reconciliation because the old webhook can already restore stock while leaving
the log accepted. Source-derived, native SQL and browser evidence plus the exact
remaining runtime limitations are recorded in `legacy-fulfillment.md` and
`local-delivery-lifecycle.md`. This is not full provider/HTTP-template or
production certification.

`auto_hl_order_create` is defined as a task but its only scheduling call is
commented out. It belongs in the complete task inventory; this focused scan does
not establish a live caller.

## Bounded shipping-label slice implemented

`order/urls.py:68` registers `ShowOnlineOrderShippingView`, whose implementation
at `order/views.py:4153` uses **ExpressLineItem order/store pairs**, despite living
beside the older Borzo routes. The source packed-card template exposes the label
when an AWB exists. Neither checkout invoices nor the existing fulfillment
component implements this label.

New shipping-label files own the store-scoped projection, exact address
formatting, deduplicated HP quantity, first nonempty AWB, fixed source parcel
fields, machine-readable barcodes and private print UI. Root registered the
plugin and packed/shipped-card action after the stable hook handoff. Focused
evidence is recorded in `fulfillment-shipping.md`. No legacy stock,
refund or courier mutation is needed for this read-only slice.

## Reporting, catalog and latent jobs

All 37 active `report/urls.py` declarations have component mappings in
`operational-reports.md`, `finance.md`, `daily-report-offline.md` and their linked
specialized maps. This count includes page/AJAX/service declarations, not 37
certified features. This scan found no additional active report family missing
from those mappings. The seven scheduled report groups have separate builders
and durable delivery; missing real datasets/transports remain activation and
acceptance gates.

The catalog map covers the active product list/detail/audit, store snapshot,
inventory matrix, pull/troubleshooting and exact sample-download surfaces.
Repeated catalogue declarations are aliases, not extra independent features.
Administrative stock/import/location/check-in surfaces remain with the
administration component map.

The `report/tasks.py` inventory workbook pipeline (`process_export_master`,
`generate_store_excel_chunk`, `merge_store_chunks`, `merge_all_stores_and_upload`)
is not reconstructed by the seven-column catalogue snapshot. Its source workbook
has nine columns and a per-store/chunk merge pipeline. The only static caller
outside the task stack is `AjaxInventoryReportView`; both associated inventory
report URL declarations are commented out in the pinned source. This is a latent
unimplemented task stack with no active registered HTTP entry established by
this scan. External Celery scheduling cannot be inferred from repository text.
The debug-only task remains an inventory item, rather than a customer feature.

The dormant custom-date CSV pipeline is also a named source job surface:
`core/tasks.py:parse_csv_offline_order_punchin` calls
`OfflineOrderPunchInParseCSV.offline_order_punchin_bulk_csv_import`; its
corresponding view body (`core/views.py:974–1055`) and URL declarations
(`core/urls.py:73–75`) are commented out. The latent CSV caller supplies
`custom_date` at its order-punching calls. This is not an active HTTP gap and is
not waived from the all-features task inventory. Root subsequently owns the
`legacy-order-imports` implementation; administrative inventory workbook work
is separately owned by administration. Their eventual implementation evidence
must replace the audit-time unported status, rather than treating dormant jobs
as absent features. Workbook chunk names use the source's increasing third task
argument (50000/100000/...), so normal chunks within one master differ. The
collision boundary is concurrent jobs for the same store, duplicate selected
store IDs/direct default-argument calls, and the shared merged-store filename.

### Static recheck on 2026-11-16

The recheck used the pinned AST declarations in `report/urls.py`, `core/urls.py`
and `stores/urls.py`, the named tasks in `report/tasks.py`/`core/tasks.py`, and
literal pinned-revision callers of the workbook pipeline. It compared those
entry points with the owned component maps; it did not re-run or recertify their
existing test groups.

The 37 active report declarations resolve to these mapped families:

| Family                                             | Active declarations | Component map                                   |
| -------------------------------------------------- | ------------------: | ----------------------------------------------- |
| Glassbox orders feed                               |                   1 | `finance.md`                                    |
| Returned orders and combined order transactions    |                   4 | `returned-orders.md`, `order-transactions.md`   |
| Inventory parent repair                            |                   1 | `operational-reports.md`                        |
| NPS feedback                                       |                   1 | `feedback-history.md`, `operational-reports.md` |
| Hyperlocal acceptance                              |                   2 | `operational-reports.md`                        |
| Scheduled hyperlocal/CRM groups                    |                   7 | `scheduled-reports.md`                          |
| Salesperson/cashier performance                    |                   4 | `staff-performance.md`                          |
| Flash sales                                        |                   2 | `flash-sales.md`                                |
| Daily store report                                 |                   2 | `daily-report-offline.md`                       |
| Day close, pending alerts, history and cash ledger |                   9 | `finance.md`                                    |
| Hyperlocal daily export                            |                   2 | `hyperlocal-daily.md`                           |
| Legacy export log page/AJAX                        |                   2 | `export-history.md`, `report-exports.md`        |

This recheck found **no additional unmapped active report/catalog/finance
workflow** within those entry points. It does not equate mapped routes with
certified original-template behavior or deployed readiness. The catalog's
repeated catalogue URLs are the same page/AJAX handlers, and its current stock
editor, pulls, troubleshooting, sample download and three audit profiles have
separate mappings. Administrative CSV/order-punching, operator/store lifecycle,
payment/OTP and documentation remain the other components' scope; this audit
does not certify them. The finance dispatch table contains only `orders`, so no
second implemented source feed type is inferred from its generic URL parameter.

The concrete unimplemented code stack remains the **latent nine-column
inventory workbook pipeline** above: four task bodies plus its debug task are
not reconstructed by the seven-column snapshot/export. Literal callers at the
pinned revision are internal task chaining and
`report/datatables/inventory_datatable.py:257`; the latter's page/AJAX URLs are
commented out. No active registered HTTP caller or external scheduler binding
was established. It must stay visible in the full jobs/release inventory rather
than being counted as catalogue parity or silently called a deployed feature.

Historical NPS no longer depends on copying the missing questions dimension to
BigQuery: its implemented adapter uses raw historical facts plus bounded current
question/customer/store lookups and native email collation. Customer behavior
history has its own implemented, budget-gated BQ adapter/projection proposal in
`customer-history.md`; adjacent product feedback is a separate current
operational resource under `product-feedback`. Financial generation/CDC inputs,
catalog audit tables/collation contracts and real transports remain deployment
or data-acceptance requirements, not newly discovered absent workflow code.

An adjacent checkout producer was subsequently identified: the fast-checkout
`performance_json` write. A mapped cashier report alone did not establish this
capture/write path. It is now implemented as independently receipted postpaid
metadata in `checkout-performance.md`, preserving source strings and the
existing `NaN` fallback without coupling optional telemetry failure to payment.

## Preview boundary

The reviewed real-MySQL preview was a temporary loopback tool on ports 4610/4273
and has been closed. UI review is evidence about presentation. It does not
establish production authentication, authorization, deployment readiness or
whole-source parity. This audit makes no production-authentication inference
from that preview and preserves the reviewed design.
