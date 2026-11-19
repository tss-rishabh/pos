import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Response } from '@playwright/test';
import {
  applyFixtures,
  enter,
  harnessOperatorId,
  pageErrors,
  type HarnessManifest,
} from '../harness/support';

/**
 * Daily store sales (legacy `AjaxDailyStoreReportView`) on the real stack: same-day reports run
 * the bound legacy store/online SQL on the MySQL data reader; multi-day reports route to the
 * warehouse, which the stack does not have. The stack uses the production day-close rollout
 * (COCO) so the checked-in in-house store may report. Rows: harness-fixtures.ts `reports`
 * (today's India orders 6201-6204; 6205 yesterday and 6206 cancelled must be excluded, as must
 * every seeded non-India order). Expected figures are derived by hand from those rows:
 * store revenue = ROUND(line price / 1.05, 2); online revenue likewise; cash = order_store
 * offline payment; Card / UPI = pay amount - cash - District.
 *
 * daily-report.spec.ts (Playwright suite) covers 61-row paging, all 33 columns and CSV formula
 * protection with a fixture response; this harness covers the real request, SQL and figures.
 */
let fixtures: HarnessManifest;
test.beforeAll(() => {
  fixtures = applyFixtures('reports');
});

const isReport = (response: Response) =>
  new URL(response.url()).pathname === '/api/v1/reports/daily-store-sales';
async function records(page: Page) {
  const table = page.getByRole('table', { name: 'Daily store sales breakdown' });
  const headers = (await table.locator('thead th').allTextContents()).map((value) => value.trim());
  const read = async (selector: string) =>
    (
      await table
        .locator(selector)
        .evaluateAll((rows) =>
          rows.map((row) =>
            Array.from(row.querySelectorAll('td'), (cell) => cell.textContent ?? ''),
          ),
        )
    ).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index]])));
  return { rows: await read('tbody tr'), totals: (await read('tfoot tr'))[0] ?? {} };
}
async function run(page: Page, from: string, to: string) {
  await page.getByLabel('Report from date').fill(from);
  await page.getByLabel('Report to date').fill(to);
  const response = page.waitForResponse(isReport);
  await page.getByRole('button', { name: 'View report' }).click();
  return response;
}

test('daily store sales run the legacy SQL for today and route history to the warehouse', async ({
  page,
}) => {
  const errors = pageErrors(page);
  const today = fixtures.today;
  if (!today) throw new Error('The report fixtures carry no business date.');
  await enter(page, '/');
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  // Report store options come from the operator's real store scope.
  await page.getByRole('button', { name: 'Stores', exact: true }).click();
  await expect(
    page.getByRole('group', { name: 'Stores', exact: true }).locator('li label'),
  ).toHaveText(['Bandra Flagship', 'Indiranagar']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Select all stores', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Stores', exact: true }),
  ).toHaveAccessibleDescription('Bandra Flagship, Indiranagar');

  // 1. Today: one bound request for the selected stores, served by the MySQL data reader.
  const response = await run(page, today, today);
  expect(response.status()).toBe(200);
  const query = new URL(response.url()).searchParams;
  expect(Object.fromEntries(query)).toEqual({ storeIds: '1,2', from: today, to: today });
  expect(response.request().headers()['x-operator-id']).toBe(harnessOperatorId);
  expect(await response.json()).toMatchObject({ reader: 'data' });
  await expect(page.getByText(/^Data updated through/)).toHaveCount(0);

  // 2. Every column, with figures derived from the fixture rows.
  await page.getByText(/^Columns \(\d+ of 33\)$/).click();
  await page.getByRole('button', { name: 'Show all columns' }).click();
  await expect(page.getByText('Columns (33 of 33)', { exact: true })).toBeVisible();
  const all = await records(page);
  expect(all.rows).toHaveLength(2);
  const shared = {
    Date: today,
    Target: '—',
    'Target achieved %': '—',
    Footfall: '—',
    'Conversion %': '—',
    'Revenue per footfall': '—',
    District: '0',
    Banking: '0',
    'PG discount': '0',
    'Gift voucher': '0',
    'TSS money used': '0',
    'TSS points used': '0',
    'New membership orders': '0',
    'Membership orders (old + new)': '0',
    'Membership revenue': '0',
  };
  expect(all.rows[0]).toMatchObject({
    ...shared,
    Store: 'Bandra Flagship',
    'Store revenue': '3000',
    'Online revenue': '0',
    'Total revenue': '3000',
    'Store orders': '2',
    'Online orders': '0',
    Orders: '2',
    AOV: '1500',
    'Store quantity': '3',
    'Online quantity': '0',
    Units: '3',
    'Basket size': '1.5',
    Cash: '2100',
    'Card / UPI': '1050',
  });
  expect(all.rows[1]).toMatchObject({
    ...shared,
    Store: 'Indiranagar',
    'Store revenue': '500',
    'Online revenue': '800',
    'Total revenue': '1300',
    'Store orders': '1',
    'Online orders': '1',
    Orders: '2',
    AOV: '650',
    'Store quantity': '1',
    'Online quantity': '1',
    Units: '2',
    'Basket size': '1',
    Cash: '525',
    'Card / UPI': '0',
  });
  expect(all.totals).toMatchObject({
    'Store revenue': '3500',
    'Online revenue': '800',
    'Total revenue': '4300',
    'Store orders': '3',
    'Online orders': '1',
    Orders: '4',
    Units: '5',
    Cash: '2625',
    'Card / UPI': '1050',
  });
  await expect(page.getByText('₹4,300.00', { exact: true })).toBeVisible();

  // 3. Search, sort and page size act on the loaded rows without another request; totals stay
  // the full report's.
  let requests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/reports/daily-store-sales') requests++;
  });
  await page.getByLabel('Search report', { exact: true }).fill('"Indira"');
  expect((await records(page)).rows.map((row) => row.Store)).toEqual(['Indiranagar']);
  expect((await records(page)).totals['Total revenue']).toBe('4300');
  await page.getByLabel('Search report', { exact: true }).fill('');
  await page.getByLabel('Sort report', { exact: true }).selectOption('total_revenue');
  await page.getByLabel('Sort direction', { exact: true }).selectOption('asc');
  await page.getByLabel('Rows', { exact: true }).selectOption('10');
  expect((await records(page)).rows.map((row) => row.Store)).toEqual([
    'Indiranagar',
    'Bandra Flagship',
  ]);
  await page.getByLabel('Sort direction', { exact: true }).selectOption('desc');
  expect((await records(page)).rows.map((row) => row.Store)).toEqual([
    'Bandra Flagship',
    'Indiranagar',
  ]);

  // 4. Visible-column CSV follows the table; the complete CSV has every column and row.
  await page.getByRole('checkbox', { name: 'Online quantity', exact: true }).uncheck();
  await page.getByLabel('Search report', { exact: true }).fill('Bandra');
  const visibleDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export visible columns CSV', exact: true }).click();
  const visible = await visibleDownload;
  expect(visible.suggestedFilename()).toBe(`daily-store-sales-${today}-${today}-visible.csv`);
  const visibleLines = (await readFile((await visible.path()) ?? '', 'utf8'))
    .replace(/^﻿/, '')
    .split('\r\n');
  expect(visibleLines).toHaveLength(3);
  expect(visibleLines[0]).not.toContain('"Online quantity"');
  expect(visibleLines[0]?.split(',')).toHaveLength(32);
  expect(visibleLines[1]).toContain('"Bandra Flagship"');
  expect(visibleLines[2]).toContain('"4300"');
  const fullDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const full = await fullDownload;
  expect(full.suggestedFilename()).toBe(`daily-store-sales-${today}-${today}.csv`);
  const fullLines = (await readFile((await full.path()) ?? '', 'utf8'))
    .replace(/^﻿/, '')
    .split('\r\n');
  expect(fullLines).toHaveLength(4);
  expect(fullLines[0]?.split(',')).toHaveLength(33);
  expect(fullLines[0]).toContain('"Online quantity"');
  expect(fullLines[1]).toMatch(/^"Bandra Flagship",/);
  expect(fullLines[2]).toMatch(/^"Indiranagar",/);
  expect(fullLines[3]).toContain('"4300"');
  expect(requests).toBe(0);

  // 5. The column choice persists for this operator across a reload.
  await page.reload();
  await expect(page.getByText('Columns (32 of 33)', { exact: true })).toBeVisible();

  // 6. A range beyond today routes to the warehouse; without one the server refuses with a
  // clear message and request reference instead of answering from another source.
  await page.getByRole('button', { name: 'Select all stores', exact: true }).click();
  const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const historical = await run(page, yesterday, today);
  expect(historical.status()).toBe(503);
  const refusal = (await historical.json()) as { error: { code: string; message: string } };
  const alert = page.getByRole('alert').filter({ hasText: refusal.error.message });
  await expect(alert).toBeVisible();
  await expect(alert.locator('code')).toHaveText(historical.headers()['x-request-id'] ?? '');
  await expect(page.getByRole('table', { name: 'Daily store sales breakdown' })).toHaveCount(0);
  errors.assertNone();
});
