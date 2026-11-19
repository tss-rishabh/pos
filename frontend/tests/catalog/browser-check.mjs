import { inflateRawSync } from 'node:zlib';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/** Row and first-row cell counts of the first worksheet's sheetData. */
function worksheetShape(workbook) {
  const end = workbook.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('Workbook is not a ZIP archive.');
  const entries = workbook.readUInt16LE(end + 10);
  let offset = workbook.readUInt32LE(end + 16),
    sheet;
  for (let index = 0; index < entries && !sheet; index++) {
    const method = workbook.readUInt16LE(offset + 10),
      size = workbook.readUInt32LE(offset + 20),
      nameLength = workbook.readUInt16LE(offset + 28),
      extraLength = workbook.readUInt16LE(offset + 30),
      commentLength = workbook.readUInt16LE(offset + 32),
      local = workbook.readUInt32LE(offset + 42),
      name = workbook.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === 'xl/worksheets/sheet1.xml') {
      const start =
        local + 30 + workbook.readUInt16LE(local + 26) + workbook.readUInt16LE(local + 28);
      const data = workbook.subarray(start, start + size);
      sheet = (method === 0 ? data : inflateRawSync(data)).toString('utf8');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!sheet) throw new Error('Workbook sheet is missing.');
  const data = /<(?:\w+:)?sheetData\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/.exec(sheet)?.[1] ?? '';
  const rows = data.match(/<(?:\w+:)?row\b[\s\S]*?<\/(?:\w+:)?row>|<(?:\w+:)?row\b[^>]*\/>/g) ?? [];
  return {
    rows: rows.length,
    columns: rows[0] ? (rows[0].match(/<(?:\w+:)?c\b/g) ?? []).length : 0,
  };
}
const base = 'http://127.0.0.1:4490';
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (process.platform === 'darwin' && existsSync(macChrome) ? macChrome : undefined);
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const context = await browser.newContext({
    viewport: { width: 1512, height: 1100 },
    acceptDownloads: true,
    serviceWorkers: 'block',
  }),
  page = await context.newPage();
const checks = [],
  requests = [],
  errors = [],
  unexpected = [];
let offline = false,
  matrixCreated = false,
  stock = 3,
  available = true;
page.on('pageerror', (error) => errors.push(error.message));
const html =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/tests/catalog/browser-entry.tsx"></script></body></html>';
const stores = [
  { id: '1', name: 'Fixture Alpha', type: 'STORE' },
  { id: '2', name: 'Fixture Beta', type: 'STORE' },
];
const products = Array.from({ length: 60 }, (_, index) => ({
  id: String(20 + index),
  DT_RowId: String(20 + index),
  product: `Fixture product ${index + 1}`,
  erp_product: `Fixture ERP ${index + 1}`,
  prod_type: 'Simple',
  categories: 'Cotton,Blue',
  price: '100.00',
  spl_price: '90.00',
  exclusive_price: 80,
  store_names: 'Fixture Alpha,Fixture Beta',
}));
await page.route('**/*', async (route) => {
  const request = route.request(),
    url = new URL(request.url());
  if (request.resourceType() === 'document' && url.pathname.startsWith('/catalog'))
    return route.fulfill({ contentType: 'text/html', body: html });
  if (url.hostname !== '127.0.0.1') {
    unexpected.push(url.hostname);
    return route.abort();
  }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  requests.push({ method: request.method(), path: url.pathname });
  if (offline) return route.abort('internetdisconnected');
  const json = (value) => route.fulfill({ json: value });
  if (url.pathname === '/api/v1/catalog/maintenance/capabilities')
    return json({ inventoryPullEnabled: true, troubleshootingEnabled: true });
  if (url.pathname === '/api/v1/catalog/inventory-pulls/sample')
    return route.fulfill({
      contentType: 'text/csv; charset=utf-8',
      body: 'sku\n',
      headers: { 'Content-Disposition': 'attachment; filename="inventory-pull-sample.csv"' },
    });
  if (url.pathname === '/api/v1/catalog/inventory-pulls') {
    expect(request.headers()['x-operator-id']).toBe('1');
    const { input } = request.postDataJSON();
    if (input.mode === 'manual') expect(input.skus).toBe('20, 21, 20');
    else expect(input).toEqual({ mode: 'csv', filename: 'fixture-skus.csv', csv: 'sku\n20\n21\n' });
    return json({
      status: 'success',
      message:
        input.mode === 'manual'
          ? 'Sku(s) registered successfully. Please check inventory after sometime.'
          : 'All SKUs processed successfully.Data may take some time to reflect.',
      productIds: ['20', '21'],
    });
  }
  if (url.pathname.endsWith('/troubleshooting')) {
    expect(request.headers()['x-operator-id']).toBe('1');
    expect(request.postDataJSON()).toEqual({});
    return json({
      status: 200,
      message: 'Troubleshooting started for the Product, Just wait for a few seconds',
    });
  }

  if (url.pathname === '/api/v1/catalog/stores')
    return json({ data: stores, selectedStoreIds: ['1'], stockManagementPath: '/inventory' });
  if (url.pathname === '/api/v1/catalog/inventory/stores')
    return json({ data: stores.map(({ id, name }) => ({ id, name })) });
  if (url.pathname === '/api/v1/catalog/products/search') {
    const body = request.postDataJSON(),
      rows = products.filter((row) =>
        row.product.toLowerCase().includes(body.search.toLowerCase()),
      );
    return json({
      reader: 'primary',
      draw: body.draw || 0,
      recordsTotal: rows.length,
      recordsFiltered: rows.length,
      unfilteredCount: 60,
      start: body.start,
      data: rows.slice(body.start, body.start + body.length),
    });
  }
  if (url.pathname === '/api/v1/catalog/inventory/search')
    return json({
      reader: 'primary',
      draw: 0,
      recordsTotal: 1,
      recordsFiltered: 1,
      unfilteredCount: 1,
      start: 0,
      stores: [stores[0]],
      data: [
        {
          id: '90',
          DT_RowId: '90',
          product: 'Fixture unassigned SKU',
          erp_product: 'Fixture ERP',
          ParentProductId: '0',
          productType: '1',
          stores: matrixCreated ? ['1'] : [],
          product_store_stock: matrixCreated ? { 1: 0 } : [],
          product_store_stock_is_avail: matrixCreated ? { 1: true } : [],
          product_store_stock_is_del: matrixCreated ? { 1: false } : [],
        },
      ],
    });
  if (url.pathname === '/api/v1/admin/inventory-imports/capabilities')
    return json({ visibilityEnabled: true, stockEnabled: true });
  if (request.method() === 'PUT' && url.pathname.endsWith('/stock')) {
    const body = request.postDataJSON();
    expect(request.headers()['x-operator-id']).toBe('1');
    if (url.pathname.includes('/inventory/90/')) {
      expect(body.expectedStock).toBe(0);
      expect(body.stock).toBe(0);
      matrixCreated = true;
      return json({ status: 'success', message: 'Fixture association created.' });
    }
    expect(body.expectedStock).toBe(stock);
    stock = body.stock;
    return json({ status: 'success', message: 'Fixture stock saved.' });
  }
  if (request.method() === 'PATCH' && url.pathname.endsWith('/visibility')) {
    const body = request.postDataJSON();
    expect(body.parentProductId).toBeNull();
    available = body.checked;
    return json({ status: 'success', message: 'Fixture visibility saved.' });
  }
  if (/^\/api\/v1\/catalog\/products\/\d+$/.test(url.pathname))
    return json({
      reader: 'primary',
      product: {
        id: '20',
        name: 'Fixture product detail',
        erpName: 'Fixture ERP',
        shortDescription:
          '<p>Readable fixture description</p><img src=x onerror="window.fixtureUnsafe=true"><script>window.fixtureUnsafe=true</script>',
        price: '100.00',
        specialPrice: '90.00',
        parentId: '0',
        type: '1',
        exclusivePrice: 80,
        male: [],
        female: [],
        description: {
          name: 'Fixture heading',
          description: '<b>Fixture content</b>',
          material: 'Fixture cotton',
        },
      },
      variants: [{ id: '20', name: 'Fixture SKU', barcode: '9007199254740993' }],
      stores,
      stock: stores.map((store) => ({
        productId: '20',
        storeId: store.id,
        stock,
        available,
        listed: true,
      })),
      checkInRequired: false,
      stockManagementPath: '/inventory',
    });
  if (url.pathname.includes('/audits/')) {
    const body = request.postDataJSON(),
      kind = url.pathname.split('/audits/')[1].split('/')[0];
    return json({
      reader: body.from.startsWith('2026-11-15') ? 'bigquery' : 'data',
      draw: 0,
      recordsTotal: 2,
      recordsFiltered: 2,
      unfilteredCount: 2,
      start: 0,
      data: [1, 2].map((index) => ({
        id: kind === 'storage' ? String(index) : String(100 + index),
        DT_RowId: String(100 + index),
        store_id: '1',
        store_name: 'Fixture Alpha',
        storage_name: kind === 'storage' ? 'Fixture bin' : null,
        product_id: '20',
        product: 'Fixture product',
        erp_product: 'Fixture ERP',
        stock_before: '3',
        stock_after: index === 1 ? '9' : '1',
        added_reduced: index === 1 ? 6 : -2,
        user: 'Fixture operator',
        comment: 'Fixture audit comment',
        created_at: '2026-11-16 12:00:00',
      })),
    });
  }
  if (url.pathname === '/api/v1/catalog/stores/1/snapshot')
    return json({
      reader: 'primary',
      store: { id: '1', name: 'Fixture Alpha' },
      syncedAt: new Date().toISOString(),
      data: products.map((row) => [
        row.id,
        row.product,
        row.id === '20' ? '9007199254740993' : '123456' + row.id,
        row.price,
        row.spl_price,
        80,
        stock,
      ]),
    });
  unexpected.push(request.method() + ' ' + url.pathname);
  return route.fulfill({
    status: 500,
    json: { error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unexpected fixture request.' } },
  });
});
async function check(name, run) {
  await run();
  checks.push(name);
}
try {
  await page.goto(base + '/catalog');
  await expect(page.getByRole('heading', { name: /^Product catalog/ })).toBeVisible();
  await check('all catalog columns, server paging and filtered source count', async () => {
    await expect(page.locator('tbody tr')).toHaveCount(25);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('26–50 of 60', { exact: true })).toBeVisible();
    await page.getByRole('textbox').fill('product 60');
    await page.getByRole('button', { name: 'View catalog', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByText('1 matching products · 60 before search')).toBeVisible();
  });
  await check('current-page visible CSV', async () => {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export visible rows CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('product-catalog.csv');
  });
  await page.goto(base + '/catalog/products/20');
  await expect(page.getByRole('heading', { name: /^Fixture product detail \[20\]/ })).toBeVisible();
  await check('safe detail markup and source description/material tabs', async () => {
    await expect(page.getByText('Readable fixture description', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.fixtureUnsafe === true)).toBe(false);
    await page.getByRole('button', { name: 'Material', exact: true }).click();
    await expect(page.getByText('Fixture cotton', { exact: true })).toBeVisible();
  });
  await check('optimistic stock and family visibility API editor', async () => {
    await page.getByRole('checkbox', { name: 'Edit stock and visibility' }).check();
    await page.getByRole('spinbutton', { name: 'Stock 20 at 1' }).fill('7');
    await page.getByRole('button', { name: 'Save stock', exact: true }).first().click();
    await expect(page.getByRole('spinbutton', { name: 'Stock 20 at 1' })).toHaveValue('7');
    await page.getByRole('checkbox', { name: 'Available', exact: true }).first().uncheck();
    await expect(
      page.getByRole('checkbox', { name: 'Available', exact: true }).first(),
    ).not.toBeChecked();
  });
  await check('legacy troubleshoot answers with the constant source message', async () => {
    await page.getByRole('button', { name: 'Troubleshoot product', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Troubleshooting started for the Product' }),
    ).toBeVisible();
    expect(stock).toBe(7);
  });
  await mkdir('../backend/parity/evidence/catalog-details', { recursive: true });
  await page.screenshot({
    path: '../backend/parity/evidence/catalog-details/product-detail.png',
    fullPage: true,
  });
  await page.goto(base + '/catalog/inventory-pulls');
  await check('exact source sku-only CSV sample', async () => {
    const waiting = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download sku sample' }).click();
    const file = await waiting;
    expect(file.suggestedFilename()).toBe('inventory-pull-sample.csv');
    expect(await readFile(await file.path(), 'utf8')).toBe('sku\n');
  });
  await check('manual pull shows the source success message', async () => {
    await page.getByRole('textbox', { name: /Sku Ids/ }).fill('20, 21, 20');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Sku(s) registered successfully.' }),
    ).toBeVisible();
  });
  await check('SKU CSV upload uses the source CSV mode', async () => {
    await page.getByRole('button', { name: 'Inventory Sync in Bulk' }).click();
    await page.getByLabel('File', { exact: false }).setInputFiles({
      name: 'fixture-skus.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('sku\n20\n21\n'),
    });
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'All SKUs processed successfully.' }),
    ).toBeVisible();
  });
  await page.screenshot({
    path: '../backend/parity/evidence/catalog-details/inventory-pull.png',
    fullPage: true,
  });
  await page.goto(base + '/catalog/inventory');
  await check(
    'all-SKU matrix discovers missing associations and can create zero stock through the gated editor',
    async () => {
      await expect(page.getByRole('heading', { name: /^Inventory matrix/ })).toBeVisible();
      await expect(page.getByText('No stock association', { exact: true })).toBeVisible();
      await page.getByRole('checkbox', { name: 'Edit stock and visibility' }).check();
      await expect(page.getByRole('button', { name: 'Save stock', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Save stock', exact: true }).click();
      await expect(page.getByRole('checkbox', { name: 'Available', exact: true })).toBeEnabled();
      await page.getByRole('checkbox', { name: 'Edit stock and visibility' }).uncheck();
      await expect(page.getByText('0 · Available · Listed', { exact: true })).toBeVisible();
    },
  );
  await page.goto(base + '/catalog/products/20/audit?kind=held');
  await check(
    'held audit deep link, all audit fields, storage and historical controls',
    async () => {
      await expect(page.getByRole('combobox', { name: 'Inventory', exact: true })).toHaveValue(
        'held',
      );
      await expect(page.locator('tbody tr')).toHaveCount(2);
      await page.getByRole('combobox', { name: 'Inventory', exact: true }).selectOption('storage');
      await page.getByRole('button', { name: 'View inventory logs' }).click();
      await expect(page.getByRole('columnheader', { name: 'Storage', exact: true })).toBeVisible();
      await page.getByLabel('From', { exact: true }).fill('2026-11-15T00:00:00');
      await page.getByLabel('To', { exact: true }).fill('2026-11-16T23:59:59');
      await page.getByRole('button', { name: 'View inventory logs' }).click();
      await expect(page.getByText(/Historical warehouse/)).toBeVisible();
    },
  );
  await page.goto(base + '/catalog/stores/1/snapshot');
  await check(
    'snapshot search, visible-column all-match CSV and standards Excel export',
    async () => {
      await expect(page.getByRole('heading', { name: 'Fixture Alpha catalog' })).toBeVisible();
      await expect(page.locator('tbody tr')).toHaveCount(25);
      await page.getByRole('textbox').fill('"product 60"');
      await expect(page.locator('tbody tr')).toHaveCount(1);
      await page.getByRole('textbox').fill('');
      await page.getByText('Columns', { exact: true }).click();
      await page.getByRole('checkbox', { name: 'Special price', exact: true }).uncheck();
      await page.getByText('Columns', { exact: true }).click();
      await expect(
        page.getByRole('columnheader', { name: 'Special price', exact: true }),
      ).toHaveCount(0);
      let download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export all matches Excel' }).click();
      let file = await download;
      expect(file.suggestedFilename()).toBe('store-1-catalog.xlsx');
      const workbook = await readFile(await file.path());
      const shape = worksheetShape(workbook);
      expect(shape).toEqual({ rows: 61, columns: 6 });
      download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export all matches CSV' }).click();
      file = await download;
      const csv = await readFile(await file.path(), 'utf8');
      expect(csv.split('\r\n')).toHaveLength(61);
      expect(csv.split('\r\n')[0]).not.toContain('Special price');
    },
  );
  await check(
    'saved snapshot and column preferences survive a fresh query client while API is offline',
    async () => {
      offline = true;
      await context.setOffline(true);
      await page.evaluate(() => window.remountCatalogFixture());
      await expect(page.getByText(/Saved snapshot/)).toBeVisible();
      await expect(page.locator('tbody tr')).toHaveCount(25);
      await expect(
        page.getByRole('columnheader', { name: 'Special price', exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Refresh catalog' })).toBeDisabled();
      await expect(
        page.getByText('Saved stock is informational. Refresh before adjusting inventory.'),
      ).toBeVisible();
    },
  );
  await page.screenshot({
    path: '../backend/parity/evidence/catalog-details/offline-catalog.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  const evidence = {
    scope: 'isolated-browser-fixtures',
    checks,
    passed: checks.length,
    requests: requests.length,
    unexpectedRequests: unexpected,
    pageErrors: errors,
    sourceDatabaseReads: false,
    externalMessages: false,
  };
  await writeFile(
    '../backend/parity/evidence/catalog-details/browser.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  await context.close();
  await browser.close();
}
