# Isolated workbook verification

Run from `backend/`. Source sibling `../backend-pos-web` must contain commit `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`; the oracle reads pinned bytes with `git show` and checks their hashes. It never imports/runs the source application or sends network/storage work.

Set up the test-only Python environment once:

```sh
uv venv --python 3.10.22 tools/inventory-workbooks/.venv
uv pip install --python tools/inventory-workbooks/.venv/bin/python -r tools/inventory-workbooks/requirements-oracle.txt
```

Alternatively set `INVENTORY_WORKBOOK_ORACLE_PYTHON` to an isolated Python executable with exact openpyxl3.1.2 and et-xmlfile1.1.0. The default is the above virtual environment. No new production Python dependency is introduced.

```sh
INVENTORY_WORKBOOK_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_integration npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/inventory-workbooks
npx -y node@24.22.3 node_modules/typescript/bin/tsc --noEmit -p tools/inventory-workbooks/tsconfig.tests.json
INVENTORY_WORKBOOK_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_integration npx -y node@24.22.3 --import tsx tools/inventory-workbooks/explain.ts
```

The native fixture requires localhost, creates a randomized `pos_rewrite_workbook_*` schema, uses only synthetic rows and drops it afterward. It never uses the database name in the provided URL for mutations. Query plans are written to `parity/inventory-workbooks-query-plans.json`; no production performance claim follows from them.

From `frontend/`:

```sh
ADMINISTRATION_BROWSER_TESTS=true npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/inventory-workbooks/browser.test.ts tests/inventory-workbooks/commands.test.ts
npx -y node@24.22.3 node_modules/typescript/bin/tsc --noEmit -p tests/inventory-workbooks/tsconfig.tests.json
```

Chromium uses a random local Vite port and its own cache; no shared dist/default server port is touched. All API/file responses are controlled fixtures.

Runtime integration is automatic through the existing report export builder/worker. New input: `{kind:'current-inventory-workbook',storeIds:['2','1'],label?,note?}`. `inventoryWorkbookBuilder(config,db,options?)`, `readInventoryWorkbookOptions(env?)` and `pruneInventoryWorkbookStaging(options,now?,maxEntries?)` are exported from `src/modules/inventory-workbooks/index.ts`. The existing report service adds an optional final workbook-options argument for dependency injection; ordinary registrar calls remain compatible. The worker’s stop hook aborts active builds; no migration or extra runner is required.

Options/defaults: `INVENTORY_WORKBOOK_PAGE_SIZE=250`, `INVENTORY_WORKBOOK_STAGING_DIRECTORY=<OS temp>/pos-report-workbooks`, `INVENTORY_WORKBOOK_MAX_BUILD_MS=900000`, `INVENTORY_WORKBOOK_MAX_XML_BYTES=536870912`, `INVENTORY_WORKBOOK_MAX_SHEET_XML_BYTES=268435456`, `INVENTORY_WORKBOOK_STAGING_TTL_MS=86400000`, `INVENTORY_WORKBOOK_LEGACY_MAX_ENTRIES=1024`, `INVENTORY_WORKBOOK_LEGACY_MAX_XML_BYTES=536870912`, `INVENTORY_WORKBOOK_LEGACY_MAX_ENTRY_BYTES=268435456`. Existing `REPORT_EXPORT_MAX_BYTES` remains the compressed file cap (default67108864, hardmax268435456). The staging directory must be private to the process owner; shared public directories/symlinks are refused.
