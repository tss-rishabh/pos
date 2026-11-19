# Catalog, product detail and inventory audit

Source baseline: `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a` in `backend-pos-web`.

Implemented by `src/modules/catalog-details/`, `frontend/src/pages/catalog/` and fourteen registered resource route definitions. This is an implementation and bounded differential checkpoint, not production parity certification.

| Source                                                               | Replacement                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProductsView`, `AjaxProductsListView`                               | Product/store filters, every returned catalog field, all nine supported sort fields, source search normalization/wildcards, count behavior, reset-to-first pagination, visible-page CSV and column visibility               |
| `ShowProductView`                                                    | Description/material, male/female galleries, live-variant predicate, source barcode zip, checked-in store first, active stock grid and franchise check-in restrictions                                                      |
| `ProductsStockView`, `AjaxProductsStockListView`                     | Full eligible-SKU matrix including missing associations; inherited ERP display with original own-ERP sorting; literal Django `icontains` search; scoped stock/availability/deletion dictionaries; page size/column controls |
| `ShowProductInventoryView`, `AjaxProductInventoryListView`           | All eleven displayed fields, customer/operator name selection, original JSON delta, searches, sorts, counts and visible-page CSV                                                                                            |
| `ShowHoldStockInventoryView`, `AjaxHoldStockInventoryListView`       | Held-stock audit and detail link. The source held audit page is active but its AJAX URL is commented out; the rewrite supplies a working resource endpoint                                                                  |
| `ShowStorageStockInventoryView`, `AjaxStorageStockInventoryListView` | Storage audit, original stock-row-ID storage join and page-local sequence numbering; all original fields and export controls                                                                                                |
| `CatalogueView`, `AjaxCatalogueView`                                 | Distinct seven-column all-store snapshot; inherited parent prices, last GS1 by primary key, zero-price and missing-barcode fallbacks, all-match CSV/Excel, 10-minute refresh and offline copy                               |
| `AssignProductStockView`, `AjaxProductStatusChangeView`              | Shared administration mutation APIs, now accessible from product detail and stock matrix editors; no duplicate mutation authority                                                                                           |
| `InventorySyncView`, `download_demo_file`                            | Manual forty-SKU input, CSV `sku` import, exact four-byte `sku\n` sample download, simple-product selection and distinct source manual/CSV bodies, posted synchronously in the request with the source messages             |
| `AjaxTroubleshootProductView`                                        | Parent visibility, empty image initialization and duplicate-GTIN suffix repair committed first, then `is_troubleshoot` product sync; constant 200 message, errors logged and swallowed                                      |

Catalog source `recordsTotal` becomes the filtered count when searching. That compatibility behavior is retained alongside `recordsFiltered`; the new `unfilteredCount` reports the true pre-search size. Invalid fractional/out-of-range source pages still reset to the first page. IDs and GTINs are strings to preserve values above JavaScript's safe integer range.

The parent catalog uses its original per-store deleted-product/live-child condition. The stock matrix instead uses the source global live-stock condition and excludes configurable parents. Snapshot sellability has a third distinct condition and includes zero-stock records. These profiles are deliberately separate. Matrix ERP sorting uses the product's own ERP field even when the displayed ERP name is inherited from its parent.

Current catalog/detail/matrix/snapshot reads use the primary reader. Audit ranges wholly within the current business day use the data reader; mixed/historical ranges use BigQuery for the entire report with no MySQL fallback. The shared 62-calendar-day range bound applies. Historical views and the source-compatible LIKE UDF are explicit configuration contracts in `tools/catalog-details/warehouse-manifest.json`; no project/dataset is guessed. Text ordering uses imported source `WEIGHT_STRING` keys, rather than BigQuery code-point ordering. The UDF receives a static per-source-column tag and a bound pattern because the verified source uses multiple collations. Missing contracts fail before any warehouse call.

Internal operators retain source catalog visibility. Franchise accounts always remain assignment scoped, including role 1. Product detail for a franchise account requires an active check-in to an assigned store. Storage audit additionally restricts all non-role-1 operators to assigned `STORE` stores. Audit views exclude inactive store choices. Matrix reads require internal type 1 and only return selected/assigned store dictionaries; legacy JSON exposed other stores' dictionaries. Editors require internal roles 1–3, online operation, current server capabilities and writer-current administration authorization. Stock changes remain disabled until the stock procedure and synchronization adapter are verified; optimistic `expectedStock` prevents a stale overwrite. Family visibility and per-SKU stock changes are labeled separately.

Offline snapshots contain product/store stock data, never customer contacts or operator names. They bind the full owner/role/type/assignment fingerprint, expire at the earlier of cached-session expiry and 24 hours, retain at most ten owner snapshots, and clear on logout/revocation. A 401/403 never falls back to an offline copy. Offline status/expiry are visible and stock is informational. IndexedDB quota failure preserves the live view and marks the offline copy unavailable. Searches stay in POST bodies; only non-sensitive column preferences persist in local storage.

Source corrections are explicit:

- Search/sort/IDs are validated and bound. SQL injection and arbitrary SQL ordering are removed.
- Product search: conflicting location membership prices, including NULL versus a value, fail with `CATALOG_PRICE_RECONCILIATION_REQUIRED`. The catalogue snapshot (C10) instead follows `AjaxCatalogueView`: the last pricelist-2 row in primary-key order (highest `location_id`) wins, NULL/0 prints 0.
- A matrix variant with no parent fails with `CATALOG_PARENT_RECONCILIATION_REQUIRED`; the source ERP helper raises an attribute error.
- Stored description HTML is rendered as inert readable text. Image URLs remain on the fixed source CDN with encoded paths. CSV cells cannot execute spreadsheet formulas; XLSX cells are inline strings so long IDs and formula-like text remain literal.
- Duplicate-GS1 detail behavior retains the source zip instead of repairing its missing-barcode quirk. Explicit primary-key ordering stabilizes otherwise unordered source querysets. Production duplicate/interleaved GS1 cases still require source runtime reconciliation before certification; the snapshot uses the distinct last-GS1 profile.
- Stable ID tie breakers replace unspecified source sort ties. Store headings use readable name order while preserving the checked-in store first. Wide matrix requests are bounded to 10,000 cells rather than creating an unbounded DOM/response.

Evidence: `tests/catalog-details/` executes the pinned source datatable bodies against verified-schema local MySQL rows, including 24 parent-catalog cases, 30 audit cases, 18 stock-matrix cases and the pinned detail body/helpers. Additional cases cover source dictionary insertion order/duplicate keys, long IDs, missing associations, scope denial, malformed input, explicit route traces and historical named bindings. `frontend/tests/catalog/` tests the actual shipped DataTables smart-search function, owner/session cache boundaries and independently decodes the XLSX with Python ZIP/XML readers. Browser fixtures cover paging, export visibility, safe descriptions, optimistic stock/visibility, zero-stock association creation, all audit kinds and offline restoration. These fixtures use synthetic data and no live provider calls. See `parity/evidence/catalog-details/` for query plans and browser artifacts.

## Maintenance (W8d, schema freeze)

Inventory pull and troubleshooting run synchronously in the request, as legacy does; the command ledger, deliveries,
reconciliations, in-process worker and the `pos_rewrite_catalog_*` tables are no longer used.

- Access: any signed-in operator (legacy `LoginRequiredMixin` only, `core/views.py:1558,2987`). The rewrite's internal
  role-1 restriction is removed.
- Inventory pull (`core/views.py:1564-1620`): manual input keeps the forty-entry check before deduplication and sends
  `{"productIds":[…],"priority":1}`; CSV sends `{"productIds":[…]}`. Only `prod_type=1` ids are sent, ascending.
  Legacy ignores the upstream status; the rewrite logs a non-2xx status and still answers with the source message. CSV
  validation adds a 500 KB/10,000-row limit and requires the literal `sku` header.
- Troubleshoot (`core/views.py:2996-3030`): in one writer transaction, under the Redis lock
  `pos:lock:catalog:barcode-mutations` (shared with barcode assignment), every `product_store` row of the parent becomes
  `is_avail=1,is_del=0`, empty `images_new` becomes `{"unisex":[],"male":[],"female":[]}`, and every other
  `products_gs1` row sharing the product's first barcode becomes `<gtin>0123`. After commit, `sync_pos_product([id],
is_troubleshoot=True)` runs. Any error (including a busy lock or a suffix beyond signed BIGINT) is logged and
  swallowed; the response is always 200 "Troubleshooting started for the Product, Just wait for a few seconds".
  Removed rewrite-only pieces: preview/plan hash, collision/orphan/size refusals, syncing the other changed SKUs.

| Case                       | Legacy message                                                           | Rewrite                                                    |
| -------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Manual success             | "Sku(s) registered successfully. Please check inventory after sometime." | 200, same                                                  |
| CSV processed              | "All SKUs processed successfully.Data may take some time to reflect."    | 200, same                                                  |
| No simple SKUs (manual)    | "No Sku(s) found for inventory pull."                                    | 422 `INVENTORY_SKUS_NOT_FOUND`, same text                  |
| More than 40               | "Please enter only 40 Sku(s)."                                           | 400 `INVENTORY_MANUAL_LIMIT` "Enter at most 40 SKU IDs."   |
| Empty input                | "Please enter correct input."                                            | 400 `INVENTORY_SKUS_REQUIRED` "Enter at least one SKU ID." |
| No file / not `.csv`       | "No file uploaded" / "Invalid file format Please import csv file only"   | page message, same text                                    |
| Upstream unreachable       | manual: HTTP 500; CSV: warning with the exception text                   | 503 `INVENTORY_PULL_UNAVAILABLE`                           |
| Not configured             | request error                                                            | 503 `INVENTORY_PULL_UNAVAILABLE`                           |
| Troubleshoot (any outcome) | 200 constant message                                                     | 200 constant message                                       |

Configuration: `INVENTORY_SYNC_URL`, `INVENTORY_SYNC_API_KEY`, `INVENTORY_SYNC_HTTP_TIMEOUT_MS` (default 90000);
troubleshooting reuses the administration `PRODUCT_SYNC_*` adapter. Evidence: `tests/catalog-details/
maintenance.mysql.integration.test.ts` (source oracle for the repair effects, payload modes, swallowed failures, busy
lock) and `maintenance-domain.test.ts`.

## Counter product list (C1)

`catalogService.products` now returns `holdedStock` (first `hold_stock_store` row by id for the product and store, else 0) and `storageStock` (one `"<storage_name> : <stock>\n"` line per `stock_storages` row in id order, else "Not available
in any storage"), as `store_products_datatable.py:276-312`. The counter UI (`frontend/src/pages/counter.tsx`, W4) does
not show them yet.
