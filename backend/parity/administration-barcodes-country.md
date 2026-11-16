# Missing barcode assignment and secondary countries

This slice implements the active source `AjaxAddBarcodeView` (`core/views.py:1245–1281`, route `core/urls.py:67`) and `GetCountryNameView` (`core/views.py:807–821`, route `core/urls.py:31`) at commit `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. The executable oracle hash-checks the source against `parity/legacy-inventory.json` and executes its actual methods using pinned Django4.2.5/PyMySQL1.1.1 against freshly created localhost schemas. Source repositories remain read-only. The source activity helper is `helpers/helpers.py:740–756`.

## Barcode contract

Source “Add Missing Barcode” is a global administrative create operation, distinct from duplicate-GTIN suffix troubleshooting. Its form (`core/templates/special_permission/index.html:17–43,457–519`) accepts a product ID and scanned/typed barcode, submits on Enter, shows the returned message and clears the barcode. Both source masks contain13 positions, but the handler imposes neither13-digit length nor a GS1 checksum. The rewrite retains that flexible positive-integer behavior, underscore removal, surrounding whitespace, optional positive sign and leading-zero normalization; values remain exact strings/BigInts within the physical signed BIGINT range. Invalid, zero-sentinel, negative, fractional, exponent and out-of-range values receive validation errors before writes. This corrects malformed/sentinel source writes rather than creating unusable GTIN0 entries.

The source check order and messages are retained:

| Predicate, in order | Result |
| --- | --- |
| Product does not exist | `fail`: `Invalid Product` |
| Any barcode row already belongs to the product, including GTIN0 | `fail`: `Product already belongs to another Barcode` |
| GTIN already belongs to another product, first matching PK | `fail`: `Barcode already belongs to another product, Product ID : {id}` |
| Otherwise | `success`: `Barcode {gtin} has been added for product Id {productId}` |

Product type, availability, deletion, stock and store association do not restrict this source operation. The rewrite does not add those restrictions or invent downstream synchronization. An orphan existing GTIN reference remains a conflict; the rewrite refuses to steal it instead of following the source’s missing-relation exception.

The successful source audit has `platform='barcode'`, the same success message, the initiating PosUser ID and recipient`''` (`email=False`). New code commits barcode, mandatory activity and immutable operation receipt in **one writer transaction**. Source helpers swallowed audit failures after the barcode had already committed; the rewrite rolls the entire transaction back. No real mail or synchronization is added.

The source SpecialPermission page is internal type1/roles1–3; its bare barcode AJAX method omitted the page’s user-type guard. Both write and recovery now check current active writer identity, role1–3 and type1 while holding its shared operator lock. Source cached/browser claims cannot expand authority. No cashier check-in or fabricated store scope is required for a global SKU operation.

POST takes `{operationId:UUID,productId:string,barcode:string}`. Canonical actor/input-bound receipts retain success **and source failure** outcomes. Repeating the original UUID does not insert another barcode or activity; a different input/actor cannot reuse it. `GET .../:operationId` recovers only the current authorized owner’s original result and performs no mutation. A lost reply is resolved by GET; a proved404 permits only an explicit retry of the same UUID/input. Receipt data describes the committed action, not a new assertion that an independent external writer has never changed the product afterward.

## Coordination and actual release boundary

Verified `mysql-extra-schema.json` and `mysql-inventory-workbooks-schema.json` show `products_gs1` has a signed BIGINT auto-ID and **nonunique** `product_id`/`gtin` indexes. Existing duplicate rows and source temporary-suffix behavior prevent a blind unique-index migration.

Assignment and actual catalog troubleshooting share `lockBarcodeMutation()` on existing rewrite `pos_rewrite_catalog_locks`, key`barcode-mutations`, **before** any Product/GS1 locks. The only other current Node ProductBarcode writer is `catalog-details/maintenance-repair.ts`; its calling writer now takes this same lock. Order is current operator→catalog operator command lock where applicable→shared barcode lock→receipt→Product→GS1. DB-only deadlocks can use the existing bounded retry helper. Native tests race distinct-product/same-GTIN, same-product/different-GTIN and the actual suffix-repair service against a new temporary-GTIN claim. They prove serialization among these participating rewrite writers, not a global unique constraint.

**Production qualification:** all remaining legacy/API/ecommerce/import GS1 writers must be cut over, stopped, or adopt this same writer coordination protocol, with duplicate-data reconciliation where required. This slice has not established that external cutover and does not claim global uniqueness while independent nonparticipating writers remain active. No live DDL, source-table unique constraint, source mutation or provider call was performed.

## Country profile

The active source endpoint has LoginRequired only. For absent/empty`q`, it returns `{"status":"success","message":"Country name","data":{}}`. For any nonempty string—including whitespace—it returns `data.country:[{id,text}]` from `name__icontains=q AND sec_status=1`, independent of standard `status`. `%`, `_` and backslash are literal characters under Django’s LIKE escaping. The rewrite uses bound Drizzle queries on PRIMARY and the verified `utf8mb3_general_ci` column collation. IDs are exact decimal strings; the ordinary existing `status=1` country directory remains unchanged.

The source Select2 country controls in both store-create and store-edit templates are inside Django comment blocks; they are not evidence that active postal autofill should use the secondary predicate. A separate authenticated secondary-country lookup page and POST body API expose this source profile without changing standard store selection or leaking pasted search text into URLs. Responses use stable primary-key ordering; more than1000 matches require a more specific search rather than silent truncation. Country reference data is current, with no historical SQL fallback or invented warehouse use. All active operator roles/types retain the source reference-read access.

## Main store picker security fix

`catalogService.stores()` supplies `/api/v1/stores`. Its global bypass is now **internal role1 only**. Every franchise role, including role1, sees only assigned active FRANCHISE stores; no assignments returns an empty list. Internal non-role1 assignment behavior, sort order and nullable display fields are retained. The native role1–5/type1–2 matrix includes assigned IN_HOUSE, unassigned FRANCHISE and archived FRANCHISE rows. This closes the same concrete enumeration leak previously fixed in administration stores.

## Integration

- `registerBarcodeAssignments(app,config,db)` from `src/modules/administration/barcodes/index.ts` registers `POST /api/v1/admin/barcode-assignments` and `GET /api/v1/admin/barcode-assignments/:operationId`.
- `registerSecondaryCountrySearch(app,db)` from `src/modules/administration/country-search.ts` registers `POST /api/v1/countries/secondary/search`, body`{search?:string}`. No legacy GET/query-string alias.
- All routes declare administration module/resource/action tracing, private/no-store caching, strict runtime input and captured actor enforcement through the parent API client. Receipts include parent request correlation. Module code logs no body, query, user contact, token, SQL row or raw error.
- Apply rewrite-only `src/modules/administration/barcodes/migration.sql`: the same existing catalog-lock table definition (IF NOT EXISTS) plus `pos_rewrite_barcode_assignments`. No worker, provider, environment setting or legacy ALTER.
- Frontend default/named `BarcodeAssignmentsPage({user})` from `src/pages/administration/barcodes/index.tsx`; internal roles1–3. Default/named `SecondaryCountrySearchPage({user})` from `src/pages/administration/secondary-countries.tsx`; all authenticated source-allowed roles/types. Root owns app/navigation wiring.
- Barcode pending metadata uses per-owner/per-UUID local keys, survives reload/restart, does not overwrite another tab’s operation, and is removed only after an exact matching receipt. Storage failure prevents dispatch. It contains product/GTIN/action IDs only and is separate from offline cash, payments and financial outboxes. Offline users may retain the form and pending action; globally coordinated assignment/recovery requires connectivity. No barcode mutation is silently queued or resent.
- A successful receipt cancels/marks only the original owner’s product-query cache stale, without a background financial call. Optional cache work cannot change the committed receipt or repeat its mutation.

## Executable evidence and limits

Owned backend suite:17 checks (15 native +2 validation cases), including actual pinned source response/audit/country oracles;20 concurrent original-UUID replays; transaction rollback on audit failure; same-product/GTIN races and actual suffix-service contention; fresh role/type/status authorization; immutable failures; GTIN neighbors above2^53 and near signed BIGINT maximum; generated IDs above2^53; literal/accent/empty/whitespace country semantics; standard-vs-secondary flags; main picker matrix; strict traced private HTTP DTOs. Seven existing catalog-maintenance native regressions also pass with the shared-lock change.

Frontend:four journal/receipt-evidence units and eight actual Chromium component workflows cover scanner Enter/exact IDs, source conflicts, lost committed reply→reload→GET-only recovery, missing action→same-UUID retry, actor change, storage fail-before-send, safe country rendering/body searches and source administrative UI denial. These are scoped controlled tests; they do not certify external GS1 writer cutover or a full configured production deployment.

```sh
# backend, Node24; all mutated schemas are freshly-created localhost fixtures
BARCODE_ASSIGNMENTS_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_barcodes_test \
  node node_modules/vitest/vitest.mjs run tests/administration/barcodes --maxWorkers=1
MYSQL_INTEGRATION_URL=mysql://root@127.0.0.1/pos_rewrite_barcode_catalog_test \
  node node_modules/vitest/vitest.mjs run tests/catalog-details/maintenance.mysql.integration.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc --noEmit -p tools/administration/barcodes/tsconfig.tests.json

# frontend, isolated random Vite port and OS-temp optimizer cache
ADMINISTRATION_BROWSER_TESTS=true node node_modules/vitest/vitest.mjs run tests/administration/barcodes --maxWorkers=1
node node_modules/typescript/bin/tsc --noEmit -p tests/administration/barcodes/tsconfig.tests.json
```

The source oracle needs `uv` with Django4.2.5/PyMySQL1.1.1. Synthetic database URL travels only via stdin; there are no live metadata probes, uploads or messages. Scoped strict TypeScript and ESLint are required before the local handoff commit; no release-coverage verified status is promoted.
