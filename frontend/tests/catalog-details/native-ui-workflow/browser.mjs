import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

function csvRows(text) {
  const rows = [],
    row = [];
  let cell = '',
    quoted = false;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index++) {
    const value = text[index];
    if (value === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (value === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if (value === '\n' && !quoted) {
      row.push(cell.replace(/\r$/, ''));
      rows.push([...row]);
      row.length = 0;
      cell = '';
    } else cell += value;
  }
  assert.equal(quoted, false);
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

export async function exerciseCatalogUi(fixture) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  fixture.onBrowser?.(browser);
  const results = fixture.results;
  assert(Array.isArray(results));
  let context;
  const open = async (account) => {
    await context?.close();
    context = await browser.newContext({ acceptDownloads: true });
    if (account) await context.addCookies([account.cookie]);
    return context.newPage();
  };
  const observe = async (page, kind, action) => {
    const path =
      kind === 'catalog' ? '/api/v1/catalog/products/search' : '/api/v1/catalog/inventory/search';
    const response = page.waitForResponse(
      (reply) => new URL(reply.url()).pathname === path && reply.request().method() === 'POST',
    );
    await action();
    const received = await response;
    assert.equal(received.status(), 200);
    const value = await received.json(),
      input = received.request().postDataJSON();
    await fixture.compare(kind, input, value);
    await expect(page.locator('.catalog-results tbody tr')).toHaveCount(value.data.length);
    if (value.data.length)
      await expect(
        page.locator('.catalog-results tbody tr').first().locator('td').first(),
      ).toHaveText(value.data[0].id);
    return { input, value };
  };
  const submit = (page, kind) =>
    observe(page, kind, () =>
      page
        .getByRole('button', { name: kind === 'catalog' ? 'View catalog' : 'View inventory' })
        .click(),
    );
  try {
    let page = await open();
    fixture.progress('anonymous-navigation');
    await page.goto(fixture.origin + '/catalog');
    fixture.progress('anonymous-login-heading');
    await expect(page.getByRole('heading', { name: 'Let’s open the store.' })).toBeVisible();
    assert.equal(await page.locator('.catalog-results').count(), 0);
    results.push('anonymous-routed-App-denied');

    page = await open(fixture.accounts.admin);
    fixture.progress('admin-navigation');
    await page.goto(fixture.origin + '/catalog');
    fixture.progress('admin-catalog-heading');
    await expect(page.getByRole('heading', { name: 'Product catalog' })).toBeVisible();
    fixture.progress('admin-store-select');
    await page.locator('form.catalog-filters select[multiple]').selectOption(['2']);
    fixture.progress('admin-initial-submit');
    let current = await submit(page, 'catalog');
    assert(current.value.data.length > 0);
    for (let index = 0; index < current.value.data.length; index++) {
      const row = current.value.data[index];
      const expected = [
        'id',
        'product',
        'erp_product',
        'prod_type',
        'categories',
        'price',
        'exclusive_price',
        'store_names',
      ].map((field) => String(row[field] ?? '—'));
      await expect(
        page
          .locator('.catalog-results tbody tr')
          .nth(index)
          .locator('td')
          .filter({ hasNot: page.locator('a') }),
      ).toHaveText(expected.slice(1));
    }
    const headings = await page.locator('.catalog-results thead th').allTextContents();
    assert.equal(headings.length, fixture.contracts.catalog.columns.length);
    assert.deepEqual(
      await page
        .getByLabel('Rows')
        .locator('option')
        .evaluateAll((options) => options.map((option) => Number(option.value))),
      fixture.contracts.catalog.lengthOptions,
    );
    current = await observe(page, 'catalog', () => page.getByLabel('Rows').selectOption('10'));
    current = await observe(page, 'catalog', () =>
      page.getByRole('button', { name: 'Next', exact: true }).click(),
    );
    assert.equal(current.input.start, 10);
    await page.locator('form.catalog-filters select[multiple]').selectOption(['1']);
    current = await submit(page, 'catalog');
    assert.equal(current.input.start, 0);
    results.push('catalog-native-rows-counts-store-submit-pagination');

    // Single exact long-ID rows avoid source-undefined aggregate sort ties.
    // Multirow ordering/search equality is covered independently below.
    await page.locator('form.catalog-filters select[multiple]').selectOption(['1']);
    await page.getByLabel('Search SKU, product, URL or type').fill('9007199254740993');
    const sorts = await page
      .getByLabel('Sort by')
      .locator('option')
      .evaluateAll((options) => options.map((option) => option.value));
    assert.equal(sorts.length, 9);
    for (const sort of sorts) {
      await page.getByLabel('Sort by').selectOption(sort);
      await page.getByLabel('Direction').selectOption('desc');
      current = await submit(page, 'catalog');
      assert.equal(current.value.data.length, 1);
      assert.equal(current.value.data[0].id, '9007199254740993');
    }
    results.push('catalog-all-nine-sort-bindings-exact-high-id');
    await page.getByLabel('Sort by').selectOption('id');
    await page.getByLabel('Direction').selectOption('asc');
    await page.getByLabel('Search SKU, product, URL or type').fill('Priced ');
    current = await submit(page, 'catalog');
    assert(current.value.data.length > 1);
    await page.getByText('Columns', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'Categories', exact: true }).uncheck();
    await expect(page.locator('.catalog-results thead')).not.toContainText('Categories');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export visible rows CSV' }).click();
    const artifact = await download;
    const rows = csvRows(await readFile(await artifact.path(), 'utf8'));
    assert.equal(rows.length, current.value.data.length + 1);
    assert(!rows[0].includes('Categories'));
    assert.deepEqual(
      rows.slice(1).map((row) => row[0]),
      current.value.data.map((row) => row.id),
    );
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Product catalog' })).toBeVisible();
    await expect(page.locator('.catalog-results thead')).not.toContainText('Categories');
    results.push('catalog-visible-page-CSV-column-selection-reload');

    // These links are checked as navigation only; destination source families
    // and stock-writer activation are explicitly outside this certificate.
    await page.getByLabel('Search SKU, product, URL or type').fill('9007199254740993');
    await submit(page, 'catalog');
    await expect(page.getByRole('link', { name: 'Inventory logs', exact: true })).toHaveAttribute(
      'href',
      '/catalog/products/9007199254740993/audit',
    );
    const detail = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/catalog/products/9007199254740993',
    );
    await page.getByRole('link', { name: 'View', exact: true }).click();
    assert.equal((await detail).status(), 200);
    await expect(page).toHaveURL(fixture.origin + '/catalog/products/9007199254740993');
    results.push('catalog-real-detail-navigation-high-id-audit-link');

    await page.goto(fixture.origin + '/catalog/inventory');
    await expect(page.getByRole('heading', { name: 'Inventory matrix' })).toBeVisible();
    await page
      .locator('form.catalog-filters select[multiple]')
      .selectOption(['1', '2', '3', '4', '5', '6', '7', '8']);
    current = await submit(page, 'matrix');
    assert(current.value.data.length > 0);
    assert.equal(await page.getByRole('button', { name: 'Export visible rows CSV' }).count(), 0);
    assert.deepEqual(
      await page
        .getByLabel('Rows')
        .locator('option')
        .evaluateAll((options) => options.map((option) => Number(option.value))),
      fixture.contracts.matrix.lengthOptions,
    );
    current = await observe(page, 'matrix', () => page.getByLabel('Rows').selectOption('50'));
    current = await observe(page, 'matrix', () =>
      page.getByRole('button', { name: 'Next', exact: true }).click(),
    );
    assert.equal(current.input.start, 50);
    await page.getByLabel('Search SKU or product').fill('%_');
    current = await submit(page, 'matrix');
    assert.equal(current.input.start, 0);
    assert(current.value.data.some((row) => row.product.includes('%_')));
    await page.getByText('Columns', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'ERP product', exact: true }).uncheck();
    await expect(page.locator('.catalog-results thead')).not.toContainText('ERP product');
    results.push('matrix-native-dictionaries-literal-wildcards-pagination-colvis-no-CSV');

    page = await open(fixture.accounts.restricted);
    await page.goto(fixture.origin + '/catalog/inventory');
    await expect(page.getByRole('heading', { name: 'Inventory matrix' })).toBeVisible();
    await expect(
      page.locator('form.catalog-filters select[multiple]').locator('option'),
    ).toHaveCount(1);
    await expect(
      page.locator('form.catalog-filters select[multiple]').locator('option'),
    ).toHaveAttribute('value', '1');
    await expect(page.locator('.catalog-results')).not.toContainText('Fixture store 02');
    results.push('matrix-current-native-assignment-scope');

    page = await open(fixture.accounts.franchise);
    await page.goto(fixture.origin + '/catalog/inventory');
    await expect(
      page.getByText('Stock administration is restricted for this user type.'),
    ).toBeVisible();
    await page.goto(fixture.origin + '/catalog');
    await expect(page.getByRole('heading', { name: 'Product catalog' })).toBeVisible();
    await expect(
      page.locator('form.catalog-filters select[multiple]').locator('option'),
    ).toHaveCount(1);
    results.push('franchise-native-catalog-scope-and-matrix-denial');
    assert.equal(
      fixture.calls.filter(
        (call) =>
          call.method !== 'GET' &&
          !['/api/v1/catalog/products/search', '/api/v1/catalog/inventory/search'].includes(
            call.path,
          ),
      ).length,
      0,
    );
    return results;
  } finally {
    if (context) {
      const page = context.pages().at(-1);
      if (page && !page.isClosed())
        fixture.diagnostics?.({
          catalogForms: await page.locator('form.catalog-filters').count(),
          catalogStoreControls: await page.locator('form.catalog-filters select[multiple]').count(),
          catalogStoreOptions: await page
            .locator('form.catalog-filters select[multiple] option')
            .count(),
          catalogRows: await page.locator('.catalog-results tbody tr').count(),
          catalogButtons: await page
            .getByRole('button', { name: 'View catalog', exact: true })
            .count(),
          matrixButtons: await page
            .getByRole('button', { name: 'View inventory', exact: true })
            .count(),
        });
    }
    await context?.close();
    await browser.close();
    fixture.onBrowser?.(null);
  }
}
