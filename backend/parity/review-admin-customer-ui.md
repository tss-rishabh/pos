# Administration and customer UI action review

Reviewed 18 November 2026: original POS commit
`78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`, Root `fde67f5`.
The106-template inventory and active route declarations were used as the
starting set; a mapped React component was not counted as proof of its source
controls. This review changes neither the inventory nor release statuses.
No tests, provider calls, database queries or production changes were made.
Report performance/acceptance exports and column visibility remain Hyper's
scope; returns, payments and financial import workflows remain Payment's scope.

## Confirmed missing active user actions

### Selected-store detail and static QR download

The active `stores/urls.py` store-view route calls `ShowStoreView`
(`stores/views.py:166`). `stores/templates/stores/show.html:26-27` displays a
PNG QR of the selected store's `url_key`; lines138-139 attach those bytes to
the download link. `stores/models.py:143` constructs the static destination
`https://thesouledstore.com/?store_id=<id>`. The same detail screen presents
the store image, name, location, phone and both addresses.

Current `frontend/src/pages/administration/stores.tsx:355-420` renders only the
name/city, location code, ownership, status and Slack/Image/Edit/Archive actions.
There is no view/details/QR action or static store-QR download. The current
administration API does expose a store detail reader, but React uses it to edit;
that does not provide read-only details or QR download to an otherwise authorized
operator without edit permission.

The existing `pages/administration/application-links/index.tsx:202` QR flow is
different: it creates a capability for the _checked-in_ store and redirects
through `/application-links/customer`. It does not preserve downloading the
selected administrative store's static marketing QR without changing check-in.
Do not replace this missing action with staff installer QR or the one-use
customer handoff. A fix should retain current store scope and exact selected-store
identity without exposing source terminal secrets.

### Administration list controls and visible-column CSV

These active source screens explicitly expose `pageLength`, CSV with
`columns: ':visible'`, `colvis`, and DataTables sorting:

| Screen                   | Source controls, including archived variants                                    | Current UI                           |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------ |
| Operators                | `users/templates/auth/index.html:110,290`                                       | `pages/administration/people.tsx:90` |
| Salespeople              | `core/templates/salespersons/index.html:104,277`                                | `people.tsx:372`                     |
| Stores                   | `stores/templates/stores/index.html:116,224`                                    | `stores.tsx:176`                     |
| Counters                 | `stores/templates/counters/index.html:100-111`, active and archived table setup | `store-resources.tsx:18`             |
| Storage                  | `stores/templates/stores/storage/index.html:103,185`                            | `store-resources.tsx:18`             |
| Documentation management | `core/templates/documentation/documentation_lists.html:101,210`                 | `documentation.tsx:117`              |

Current tables/cards provide search/status filtering, CRUD actions and Load more,
but no CSV/column chooser/page-size/sort controls. The shared
`pages/administration/api.ts:179` collection reader fixes `limit:30` and has no
sort argument. Therefore this is a user-action gap, not just a rearranged layout
or missing test. Source DataTables are server-side: the original CSV operates on
the rows available to the client; an unbounded all-record export is not implied.
Any replacement must keep contacts/private values out of URLs/logs, apply CSV
formula protection and scope downloads to authorized rows and selected columns.
Do not infer that existing gift-card/permission-history/catalog CSV controls
cover these separate administration screens.

## Actions inspected with actual current runtime connections

Paths below are relative to the repository; source paths are relative to the
pinned POS. This table records implementation findings, not passing deployment
acceptance. Existing test references were inspected without rerunning them.

| Source controls/variants                                                                                                                                     | Current connected behavior                                                                                                                                                                                                                                                                                                           | Evidence boundary                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store create/edit form, franchise details versus existing franchise, postal location, image and Slack                                                        | `frontend/src/pages/administration/stores.tsx` conditionally constructs the actual input; `locations.ts`, `store-images.tsx`, `slack.tsx` perform separate private operations. `administration/index.tsx` mounts them in the real admin workspace.                                                                                   | Chromium `frontend/tests/administration/workflows.test.ts:1714,1745,1943,1978,2012` inspects upload/retry, hidden franchise fields, removal and OAuth return with intercepted HTTP. Full original deployed provider and role matrix remains separate. Missing read-only/QR action is recorded above.                                                          |
| Employee ID/contact/ownership edits; archive/reactivate; multiple salesperson assignments plus one active store                                              | `people.tsx:372` has employee/contact/ownership fields, status controls and `AssignmentEditor`; `assignments.tsx` submits selected IDs and a selected active store only if included. Real routes call `administration/service.ts` for create/update/status/assignment, preserving hidden store assignments.                          | Native administration cases cover scoped assignment replacement, current actor/type checks, active-store choice and duplicate identity. No additional missing employee form field was established. List controls are separately missing above.                                                                                                                |
| Counters and storage create/archive/reactivate; storage edit/move; reject nonempty storage removal                                                           | `store-resources.tsx` mounts real list/status/create/edit endpoints, includes destination store on storage edits and delegates terminal configuration separately. Description/type/name are shown in the list, so the old storage read-only screen is substantially represented without requiring identical navigation.              | Existing native cases in `tests/administration/mysql.integration.test.ts:569,586,665` exercise counter naming, stock-containing storage refusal and empty storage moves. This is not proof of every original browser flow.                                                                                                                                    |
| Product list/search/store filter; product images and variant/barcode matrix; descriptions/material; product and hold-log links                               | `pages/catalog/index.tsx`, `product.tsx` and `audit.tsx` mount actual catalog/search/detail and kind-specific audit endpoints. Product thumbnails change the main image; separate Description/Material controls and held-log links exist.                                                                                            | React catalog tables implement their own visible-column exports. Historical product/hold/storage audit facts still require qualified warehouse publication; unrelated inventory logs cannot substitute. Plain safe rendering deliberately avoids executing original stored HTML.                                                                              |
| Active stock matrix quantity, availability and disabled/listing controls; stock CSV and failure download                                                     | `catalog/matrix.tsx` uses real inventory search and `StockEditor` quantity/visibility endpoints. `administration/imports.tsx` provides six-column template/preview/submit, pending cancellation, blocked resume, failed-record CSV and history.                                                                                      | Mutation controls explicitly depend on approved stock projection/product synchronization capabilities. Those external qualification gates are not a missing UI callback; enabling a flag alone does not qualify the routine. CSV/component/native evidence is bounded, not whole stock cutover certification.                                                 |
| Manual40-SKU or CSV inventory pull, demo file and product troubleshooting                                                                                    | `catalog/maintenance.tsx` has separate manual/CSV forms and sample download; maintenance receipts retain original command IDs and expose active status/recovery. `ProductTroubleshooting` is mounted in product detail.                                                                                                              | No live Vinculum/Redis/Mongo/Akamai effect was attempted. Replay-safe source/provider acceptance remains required.                                                                                                                                                                                                                                            |
| Parent/store three-column CSV, reset/remove behavior, failed records and pending job controls                                                                | `administration/parent-store-imports.tsx` mounts the shared import workspace with distinct parent profile, exact headers and explicit destructive reset warnings; route is mounted in `frontend/src/app.tsx:495`. It does not silently submit six-column stock defaults.                                                             | Seven `frontend/tests/administration/parent-store-imports/browser.test.ts:274-427` cases cover scope, template, lost enqueue recovery, resume/cancel, failures/history and six-column separation using intercepted HTTP. Native/source task checks remain separate.                                                                                           |
| Global missing-barcode scan/product ID assignment                                                                                                            | `administration/barcodes/index.tsx` handles real form submit/scanner Enter, strict IDs, durable original-operation recovery and source conflict receipts. App route mounts `BarcodeAssignmentsPage`.                                                                                                                                 | Eight browser cases cover Enter, dropped reply/reload, exact UUID retry, actor switch, conflicts, failed local persistence and role gating. No arbitrary GTIN reassignment is inferred from the source Add Barcode control.                                                                                                                                   |
| Global Money/Points add/subtract with platform/reason/expiry/order/product; voucher issue; activity history                                                  | `checkout/benefit-adjustments/index.tsx` passes every source field through durable review/dispatch/recovery; `global-vouchers/index.tsx` and `conversion.tsx` provide issue/check/convert with receipts; `administration/permission-history.tsx` exposes separate source activity filters/export.                                    | Existing source wallet calendar-date decision remains pending; this audit neither activates a candidate nor certifies expiry parity. Shared external wallet writer/cutover qualification and immutable history remain external gates.                                                                                                                         |
| Gift-card batch size/message generation; printed marker; block/unblock; encrypted artifact/password; history reload/CSV                                      | `administration/gift-card-batches/index.tsx` connects generation, print/block and retry confirmations, protected artifact download/password reveal; `history.tsx` has current-page visible-column CSV. The source Print action only marks printed; current Mark as printed preserves that business action.                           | Seven `frontend/tests/administration/gift-card-batches.browser.test.ts:268-443` cases exercise uncertain responses, stale revisions, resend review, private bytes/password retention and actor/offline fences. Inbox delivery, approved archive renderer and external generation acceptance remain separate.                                                  |
| Documentation create/edit title/summary/rich description/keywords/order; append/replace images/video/PDF; active/archive; read/play/download                 | `documentation-editor.tsx` submits `retainAssetIds` plus new uploads, so retaining existing attachments appends and unchecking them replaces/removes them. All three source attachment kinds are supported. `documentation.tsx` reads sanitized description in a sandbox, displays images/video and downloads each private asset.    | Workflow test `:1501` covers an actual editor/reader/download against intercepted routes; native media tests cover attachment and cleanup. A leaf media route alone does not qualify deployed private object-store/migration behavior. Management list export controls are still missing above.                                                               |
| Customer lookup/connect, missing mobile/email, registration, B2B/GSTIN edits, gender/dates, verification, membership/wallet/app display and history/insights | `CheckoutReview.tsx:800,1042,1061` actually mounts profile/benefits/history; customer profile edits invalidate quote and recover original update; `CustomerRegistration.tsx` has name/mobile/optional email/DOB/type/GSTIN, code/resend/create/recovery; separate contact/OTP/handoff modules are mounted in the same checkout flow. | Source `AjaxUserUpdateView` reads name/email/telephone from the payload but only writes `customer_type` and `gstin`; no missing arbitrary-name/contact-edit workflow is inferred. Historical behavior/publications, insight receiver and contact delivery adapter acceptance remain required. Source self-registration bypass difference is called out below. |

## Intentional differences and reachability boundaries

The source registration modal exposes **Self Verify (Without OTP)** after OTP
dispatch (`order/templates/order/create_order.html:4856,4998`). Current
`CustomerRegistration.tsx:153` requires verified mobile before creation;
`backend/parity/checkout.md:114` explicitly records rejecting the source bypass.
This is a documented security change, not exact variant parity. Preserve the
decision record; do not add an unauthenticated bypass to satisfy a template.

The apparent source direct parent/store checkbox posts `/assign-product-store/`,
whose route is commented in `core/urls.py:14`. Dedicated hold/unhold and
storage-stock writers/list routes are commented at lines22-25 and114-117;
the stock-page Hold modal also posts that inactive hold endpoint. Their presence
in a template does not establish a working active mutation workflow. Active CSV
hold/unhold and active product/hold/storage audit routes keep their own scope.
These observations do not delete those templates from the106-entry inventory or
create additional exclusion statuses.

The three existing explicit inactive exclusions remain unchanged: diagnostic
`stores/tasks.py:11` with commented account insertion, and the two commented
business-metrics prototype templates. Generic physical deletion of Store/PosUser
is not introduced in place of source archive/reactivation.

## Required next work and limits

Implement the selected-store read-only/static QR workflow and the missing
administration list actions before certifying those source screens. Add focused
workflow evidence for each actual action/role/active-and-archived variant, rather
than promoting a template because its CRUD leaf is mapped. For the remaining
connected flows, retain current failed-closed provider/publication/media gates
and obtain the corresponding full deployed acceptance evidence. This review
does not claim that the remaining original source scope is gap-free.
