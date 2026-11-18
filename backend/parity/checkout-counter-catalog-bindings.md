# Counter scanner and catalog entry bindings

Bounded implementation correction on top of exact barcode API commit `23c3c52`.
This does not certify the entire checkout template, payment execution, or catalog repair workflow.

## Source contracts

Pinned POS source: `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.

- `order/templates/order/create_order.html:1363–1392`: Enter captures the barcode input and invokes the dedicated AjaxCart POST; the input is disabled while lookup runs. It does not select an earlier fuzzy inventory result.
- `order/views.py:1692–1732`, `order/urls.py:24`: active `AjaxCartView.post` strips input-mask underscores, converts barcode with `int`, and selects exact `ProductBarcode.gtin`. Zero takes the product-ID fallback; a barcode scan sends product ID zero, so GTIN zero is not selected. The rewrite parses zero but its resolver refuses it.
- Template lines 156/196 and the reachable inventory column renderer at 1800: product-name links open product detail, ordinarily using the parent product ID. Complementary lines use their actual SKU.
- Inventory action renderer at 1818 and click handler 1867: positive-stock rows with a barcode expose troubleshooting for their actual SKU. The existing rewrite's approved administrator repair authority is preserved; the counter now links to its inspect/confirm workflow rather than dispatching a repair from the sale.

`frontend/tests/counter-catalog/source-barcode.py` executes the actual pinned `post` AST through five dispatch cases with a recording model sentinel. This proves exact GTIN/underscore/high-ID/zero/product-ID dispatch, not Django session, database, Redis, or downstream cart-provider behavior.

## Resulting behavior

Numeric/masked Enter uses the exact authenticated barcode API with the entered value, verifies the echoed match, and preserves the product's primary display barcode. A synchronous pending guard prevents duplicate requests/adds. The captured operator/store/counter/draft identity and abort signal are checked before and throughout the atomic IndexedDB commit. Switching sale/workspace/operator cancels late results. Text-search Enter requires a settled current query and one result.

The additive IndexedDB version 10 migration introduces only an operator/store-scoped alias table. Product, verified alternate alias, and cart addition commit atomically. Known alternates survive database reopen; an unseen alternate requires reconnecting. Offline selection combines aliases and exact primary matches and refuses contradictory/missing/multiple/out-of-stock candidates. Zero is refused. HTTP denials are never converted to cached success. Logout clears the actor's alias and product cache and aborts pending work; eraseOperator also removes aliases. Existing financial/cart/command tables remain intact.

Product tiles expose parent-detail links without nested interactive elements. Cart names resolve known cached parent metadata in one batched local indexed read; a missing cache entry still has a valid actual-SKU detail route. Links open separately so the active sale remains available. Eligible administrators get the actual-SKU troubleshooting anchor; stock/barcode/role conditions remain enforced, and the existing backend repair authority is unchanged.

## Scoped verification

From `frontend`, under Node 24:

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p tests/counter-catalog/tsconfig.json
node node_modules/eslint/bin/eslint.js src/pages/counter.tsx src/pages/counter-catalog src/pages/catalog/maintenance.tsx src/offline/database.ts src/offline/clear-identity.ts tests/counter-catalog
COUNTER_BARCODE_BROWSER_TESTS=true node node_modules/vitest/vitest.mjs run tests/counter-catalog
```

From the repository root:

```sh
python3 -B frontend/tests/counter-catalog/source-barcode.py "$POS_SOURCE_ROOT"
```

The source runner checks the actual pinned commit and unchanged source bytes. The 12 unit cases exercise exact parsing/echo/authorization failures, offline ambiguity, late actor/sale invalidation, transaction rollback, alias persistence/replacement/logout, and version9→10 preservation of a pending cash receipt plus draft. Four controlled Chromium cases mount the production CounterPage and exercise stale fuzzy results, repeated Enter, not-found, switching sale during lookup, links, and repair entry eligibility. Synthetic API responses are deliberate transport seams for race control; these browser tests are not a joined native/API/source parity certificate. Native resolver proof is separately retained in `checkout-barcode-resolution.md`.

During authoring, the first browser attempt passed UI actions but failed its test-only dynamic-import inspection; another invocation from the repository root could not load the frontend-only fixture. The final runner uses a typed fixture reader and runs from `frontend`; expectations and deadlines were preserved.
