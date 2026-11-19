import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Request } from '@playwright/test';
import {
  applyFixtures,
  enter,
  harnessOperatorId,
  isSearch,
  pageErrors,
  type HarnessManifest,
} from '../harness/support';

/**
 * Order search (legacy `AjaxOrderListView` / `orders_datatable.py`) on the real stack: the routed
 * App after a real sign-in, the real `/orders/searches` route (zod, auth before validation, primary
 * MySQL reads) and the e2e seed plus harness rows (backend/tools/e2e/harness-fixtures.ts).
 * Every expectation below is derived from the seeded rows, never from the response under test.
 *
 * Seed (store 1, inside the default five-day window): 6001-6008; 6001/6002 are unpaid counter
 * orders (method 14 "POS Counter", Pending, PROCESSING), 6003-6007 paid Delivered, 6008 paid
 * PROCESSING; customer 700001 (phone 9000000110) owns 6008, 6005 and 6002.
 * Harness rows: 6101 Online, 6102 local delivery in store 1's queue, 6103 Express at store 2,
 * 6104 split cash/Online (Other)/UPI, 6105 with order_store rows in stores 1 and 2, 6106 outside
 * the window.
 */
let fixtures: HarnessManifest;
test.beforeAll(() => {
  fixtures = applyFixtures('orders');
});

const amounts: Record<string, number> = {
  '6001': 1899,
  '6002': 999,
  '6003': 799,
  '6004': 1899,
  '6005': 999,
  '6006': 799,
  '6007': 1899,
  '6008': 999,
  '6104': 999,
  '6105': 1899,
};

function rowIds(page: Page) {
  return page
    .locator('.order-search-workspace tbody tr')
    .evaluateAll((rows) =>
      rows.map((row) => row.querySelector('td button')?.textContent?.trim() ?? ''),
    );
}
async function apply(page: Page) {
  const searched = page.waitForResponse(isSearch);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  const response = await searched;
  expect(response.status()).toBe(200);
  return response;
}
const body = (request: Request) => request.postDataJSON() as Record<string, unknown>;
/**
 * Sets a W27 searchable multi-select (trigger button named by its field label, one checkbox per
 * option) to exactly the named options, then closes it.
 */
async function choose(page: Page, label: string, names: readonly RegExp[]) {
  await page.getByRole('button', { name: label, exact: true }).click();
  const panel = page.getByRole('group', { name: label, exact: true });
  for (const box of await panel.getByRole('checkbox').all()) {
    const name = (await box.evaluate((input) => input.closest('label')?.textContent ?? '')).trim();
    await box.setChecked(names.some((pattern) => pattern.test(name)));
  }
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
}
const method = { counter: /^POS Counter$/ },
  paymentStatus = { pending: /^Pending$/i, paid: /^Paid$/i },
  orderStatus = { processing: /^Processing$/i, delivered: /^Delivered$/i },
  store = { bandra: /^Bandra Flagship$/, indiranagar: /^Indiranagar$/ };
const columnText = async (page: Page, header: string, id: string) => {
  const headers = await page.locator('.order-search-workspace thead th').allTextContents(),
    index = headers.findIndex((value) => value.replace(/[↑↓]/g, '').trim() === header);
  expect(index).toBeGreaterThanOrEqual(0);
  return page
    .locator('.order-search-workspace tbody tr')
    .filter({ has: page.getByRole('button', { name: id, exact: true }) })
    .first()
    .locator('td')
    .nth(index)
    .textContent();
};

test('order search drives the real list, filters, paging, exports and order types', async ({
  page,
}) => {
  expect(fixtures.orders.map((order) => order.id)).toEqual([
    '6101',
    '6102',
    '6103',
    '6104',
    '6105',
    '6106',
  ]);
  const errors = pageErrors(page),
    searches: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/v1/stores/1/orders/searches'))
      searches.push(request);
  });
  const initial = page.waitForResponse(isSearch);
  await enter(page, '/orders');
  const first = await initial;
  expect(first.status()).toBe(200);
  await expect(page.getByRole('button', { name: 'View order 6008', exact: true })).toBeVisible();

  // 1. One default selection, owned by the signed-in operator, store 1, Store type, server window.
  expect(searches).toHaveLength(1);
  expect(first.request().headers()['x-operator-id']).toBe(harnessOperatorId);
  expect(first.request().headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  expect(new URL(first.url()).search).toBe('');
  expect(body(first.request())).toMatchObject({
    orderType: 'ST',
    storeIds: ['1'],
    orderIds: [],
    draw: 1,
    page: 1,
    pageSize: 25,
    sort: { field: 'id', direction: 'desc' },
  });
  expect(body(first.request()).placedFrom).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/);
  const payload = (await first.json()) as {
    contract: string;
    reader: string;
    recordsFiltered: string;
  };
  expect(payload).toMatchObject({
    contract: 'pos-source-order-search-v1',
    reader: 'primary',
    recordsFiltered: '11',
  });
  // Legacy double reverse join: 6105 (order_store in stores 1 and 2) appears twice; 6106 is
  // outside the window; non-store orders never appear in the Store type.
  expect(await rowIds(page)).toEqual([
    '6105',
    '6105',
    '6104',
    '6008',
    '6007',
    '6006',
    '6005',
    '6004',
    '6003',
    '6002',
    '6001',
  ]);

  // 2. Legacy payment-method label composition from order_store and terminal rows.
  expect(await columnText(page, 'Payment method', '6104')).toBe(
    'POS Counter: CASH + Online (Other) +UPI',
  );
  expect(await columnText(page, 'Payment method', '6001')).toBe('POS Counter (Pending)');
  expect(await columnText(page, 'Payment method', '6008')).toBe(': CASH  ');
  expect(await columnText(page, 'Store', '6104')).toBe('Bandra Flagship (Counter 01)');

  // 3. Contact filters reach the server in the POST body only, never URL or storage.
  await page.getByLabel('Order mobile', { exact: true }).fill('9000000110');
  await page.getByLabel('Order email', { exact: true }).fill('customer1@example.test');
  const contact = await apply(page);
  expect(body(contact.request())).toMatchObject({
    mobile: '9000000110',
    email: 'customer1@example.test',
    draw: 2,
  });
  expect(await rowIds(page)).toEqual(['6008', '6005', '6002']);
  expect(page.url()).not.toContain('9000000110');
  expect(page.url()).not.toContain('customer1');
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toMatch(/9000000110|customer1@example/);
  await page.getByLabel('Order mobile', { exact: true }).fill('');
  await page.getByLabel('Order email', { exact: true }).fill('');

  // 4. Method, payment-status and order-status filters.
  await choose(page, 'Payment method', [method.counter]);
  await choose(page, 'Payment status', [paymentStatus.pending]);
  await choose(page, 'Order status', [orderStatus.processing]);
  const pending = await apply(page);
  expect(body(pending.request())).toMatchObject({
    paymentMethodIds: ['14'],
    paymentStatusIds: ['1'],
    orderStatusIds: ['1'],
  });
  expect(await rowIds(page)).toEqual(['6002', '6001']);
  await choose(page, 'Payment status', [paymentStatus.paid]);
  await choose(page, 'Order status', [orderStatus.delivered]);
  await apply(page);
  expect(await rowIds(page)).toEqual(['6104']);
  for (const label of ['Payment method', 'Payment status', 'Order status'])
    await choose(page, label, []);
  await apply(page);
  await expect(page.locator('.order-search-workspace tbody tr')).toHaveCount(11);

  // 5. Server-side sort by amount.
  const sorted = page.waitForResponse(isSearch);
  await page.getByRole('button', { name: 'Sort Order amount', exact: true }).click();
  expect(body((await sorted).request()).sort).toEqual({ field: 'order_amt', direction: 'asc' });
  await expect(page.locator('.order-search-workspace tbody tr')).toHaveCount(11);
  const byAmount = (await rowIds(page)).map((id) => amounts[id]);
  expect(byAmount).toEqual([...byAmount].sort((a = 0, b = 0) => a - b));
  expect(byAmount.every((value) => value !== undefined)).toBe(true);

  // 6. Page size and paging: 11 rows in pages of 5.
  const resized = page.waitForResponse(isSearch);
  await page.getByLabel('Rows per page', { exact: true }).selectOption('5');
  expect(body((await resized).request())).toMatchObject({ page: 1, pageSize: 5 });
  await expect(page.locator('.order-search-workspace tbody tr')).toHaveCount(5);
  await expect(page.getByText('Page 1 of 3', { exact: true })).toBeVisible();
  const next = page.waitForResponse(isSearch);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  expect(body((await next).request()).page).toBe(2);
  await expect(page.getByText('Page 2 of 3', { exact: true })).toBeVisible();
  await expect(page.locator('.order-search-workspace tbody tr')).toHaveCount(5);
  const last = page.waitForResponse(isSearch);
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  expect(body((await last).request()).page).toBe(3);
  await expect(page.locator('.order-search-workspace tbody tr')).toHaveCount(1);

  // 7. Column visibility and the page CSV of exactly the visible columns and rows.
  await page.getByText('Visible columns', { exact: true }).click();
  await page.getByLabel('Customer', { exact: true }).uncheck();
  await expect(page.getByRole('columnheader', { name: 'Customer', exact: true })).toHaveCount(0);
  const [lastRow] = await rowIds(page);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export page CSV', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('orders-page.csv');
  const csv = (await readFile((await download.path()) ?? '', 'utf8')).split('\r\n');
  expect(csv).toHaveLength(2);
  expect(csv[0]?.split(',')).not.toContain('user__firstname');
  expect(csv[0]?.split(',')[0]).toBe('id');
  expect(csv[1]?.startsWith(`"${lastRow}",`)).toBe(true);
  await page.getByLabel('Customer', { exact: true }).check();

  // 8. Online (N): orders with neither order_store nor location.
  await page.getByLabel('Order type', { exact: true }).selectOption('N');
  const online = await apply(page);
  expect(body(online.request())).toMatchObject({ orderType: 'N', page: 1 });
  expect(await rowIds(page)).toEqual(['6101']);
  await expect(page.getByRole('link', { name: 'View order 6101', exact: true })).toHaveAttribute(
    'href',
    `/orders/details/N/6101?operatorId=${harnessOperatorId}&storeId=1`,
  );

  // 9. Local delivery (HL) for the checked-in store.
  await page.getByLabel('Order type', { exact: true }).selectOption('HL');
  await apply(page);
  expect(await rowIds(page)).toEqual(['6102']);
  await expect(page.getByRole('link', { name: 'View order 6102', exact: true })).toHaveAttribute(
    'href',
    `/orders/details/HL/6102?operatorId=${harnessOperatorId}&storeId=1`,
  );

  // 10. Express (HE) needs exactly one store; the link carries the selected store.
  await page.getByLabel('Order type', { exact: true }).selectOption('HE');
  for (const stores of [[], [store.bandra, store.indiranagar]]) {
    await choose(page, 'Stores', stores);
    const before = searches.length;
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'Select exactly one store for Express orders.',
    );
    expect(searches).toHaveLength(before);
  }
  await choose(page, 'Stores', [store.indiranagar]);
  const express = await apply(page);
  expect(body(express.request())).toMatchObject({ orderType: 'HE', storeIds: ['2'] });
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await rowIds(page)).toEqual(['6103']);
  await expect(page.getByRole('link', { name: 'View order 6103', exact: true })).toHaveAttribute(
    'href',
    `/orders/details/HE/6103?operatorId=${harnessOperatorId}&storeId=2`,
  );
  await page.getByLabel('Order IDs', { exact: true }).fill('6103');
  const explicit = await apply(page);
  expect(body(explicit.request())).toMatchObject({
    orderType: 'HE',
    storeIds: ['2'],
    orderIds: ['6103'],
  });
  expect(await rowIds(page)).toEqual(['6103']);
  await page.getByLabel('Order IDs', { exact: true }).fill('');

  // 11. In-queue ignores dates, IDs and the store selection; it lists the checked-in store's
  // live local-delivery queue and links as local delivery.
  await choose(page, 'Stores', []);
  await page.getByLabel('In queue', { exact: true }).check();
  await expect(page.getByLabel('Order IDs', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Placed from', { exact: true })).toBeDisabled();
  const queued = await apply(page);
  expect(body(queued.request())).toMatchObject({ orderType: 'HE', storeIds: [], inQueue: true });
  expect(body(queued.request())).not.toHaveProperty('placedFrom');
  expect(await rowIds(page)).toEqual(['6102']);
  await expect(page.getByRole('link', { name: 'View order 6102', exact: true })).toHaveAttribute(
    'href',
    `/orders/details/HL/6102?operatorId=${harnessOperatorId}&storeId=1`,
  );
  await page.getByLabel('In queue', { exact: true }).uncheck();

  // 12. Server validation (zod after authentication) shows its message and request reference.
  await page.getByLabel('Order type', { exact: true }).selectOption('ST');
  await choose(page, 'Stores', [store.bandra]);
  await page.getByLabel('Order mobile', { exact: true }).fill('not-a-phone');
  const rejected = page.waitForResponse(isSearch);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  const refusal = await rejected;
  expect(refusal.status()).toBe(400);
  const reference = refusal.headers()['x-request-id'];
  expect(reference).toMatch(/^[0-9a-f-]{36}$/);
  const alert = page.getByRole('alert').filter({ hasText: 'Reference' });
  await expect(alert.locator('code')).toHaveText(reference ?? '');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  expect(page.url()).not.toContain('not-a-phone');
  errors.assertNone();
});
