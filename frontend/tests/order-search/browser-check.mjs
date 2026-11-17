import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
const root = fileURLToPath(new URL('../..', import.meta.url)),
  directory = fileURLToPath(new URL('.', import.meta.url)),
  snapshot = JSON.parse(readFileSync(directory + 'source-snapshot.json', 'utf8'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: directory + '.cache/vite',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
let browser,
  passed = 0;
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string')
    throw new Error('Isolated fixture address unavailable.');
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (process.platform === 'darwin' &&
    existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true }),
    requests = [];
  let unavailable = false;
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname === '/api/v1/stores/1/order-search-options')
      return route.fulfill({
        json: {
          stores: [
            { id: '1', name: 'Synthetic 1', locationCode: 'L1' },
            { id: '2', name: 'Synthetic 2', locationCode: 'L2' },
          ],
          methods: [
            { id: '14', name: 'Cash' },
            { id: '3', name: 'COD' },
          ],
          paymentStatuses: [
            { id: '4', name: 'Paid' },
            { id: '1', name: 'Pending' },
          ],
          orderStatuses: [
            { id: '3', name: 'Delivered' },
            { id: '1', name: 'Order Placed' },
          ],
          orderTypes: ['ST', 'HL', 'HE', 'N'],
          checkedInStoreId: '1',
        },
      });
    if (url.pathname === '/api/v1/stores/1/orders/searches') {
      if (request.method() !== 'POST' || url.search)
        throw new Error('Search transport leaked a query filter.');
      const body = request.postDataJSON();
      requests.push({ body, actor: request.headers()['x-operator-id'] });
      if (unavailable)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'ORDER_SEARCH_PUBLICATION_REQUIRED',
              message: 'A complete historical publication is required.',
            },
          },
        });
      const data = snapshot.response.data
        .slice(0, body.pageSize)
        .map((row, index) => ({ ...row, rowKey: row.id + ':' + index, actionStoreId: '1' }));
      return route.fulfill({
        json: {
          contract: 'pos-source-order-search-v1',
          draw: body.draw,
          recordsTotal: '51',
          recordsFiltered: '51',
          page: body.page,
          pageSize: body.pageSize,
          reader: body.inQueue ? 'mixed' : 'primary',
          data,
          fetchedAt: '2026-11-17T06:00:00Z',
          range: {
            from: body.from ?? '2026-11-17',
            to: body.to ?? '2026-11-17',
            timeZone: 'Asia/Kolkata',
            ignoredForQueue: body.inQueue || body.notPacked,
          },
          generationId: body.inQueue ? '4918d168-c62e-4ed7-b8ae-89b0a5e70019' : null,
        },
      });
    }
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'SYNTHETIC_UNAVAILABLE',
          message: 'Optional synthetic capability unavailable.',
        },
      },
    });
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/tests/order-search/fixture.html`);
  await page.getByRole('button', { name: 'View order 9007199254740993', exact: true }).waitFor();
  await expect(page.locator('tbody tr')).toHaveCount(11);
  if (
    requests.length > 2 ||
    !requests.length ||
    requests.some((request) => request.actor !== '1' || request.body.draw !== 1)
  )
    throw new Error('Initial query repeated beyond the StrictMode aborted mount or lost actor.');
  passed++;
  await expect(
    page.getByText('Cash: CASH + Online (Other) +UPI', { exact: true }).first(),
  ).toBeVisible();
  passed++;
  await page.getByLabel('Order mobile', { exact: true }).fill('555001');
  await page.getByLabel('Order email', { exact: true }).fill('synthetic@example.invalid');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.body.email).toBe('synthetic@example.invalid');
  if (page.url().includes('synthetic@example') || page.url().includes('555001'))
    throw new Error('Contact filter reached URL.');
  if (
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }).includes('synthetic@example.invalid'),
    )
  )
    throw new Error('Contact filter reached storage.');
  passed++;
  await page.getByLabel('Payment methods', { exact: true }).selectOption('14');
  await page.getByLabel('Payment statuses', { exact: true }).selectOption('4');
  await page.getByLabel('Order statuses', { exact: true }).selectOption('3');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.body.paymentMethodIds).toEqual(['14']);
  if (
    requests.at(-1).body.paymentStatusIds[0] !== '4' ||
    requests.at(-1).body.orderStatusIds[0] !== '3'
  )
    throw new Error('Status filter lost.');
  passed++;
  await page.getByRole('button', { name: 'Sort Order amount', exact: true }).click();
  await expect
    .poll(() => requests.at(-1)?.body.sort)
    .toEqual({ field: 'order_amt', direction: 'asc' });
  passed++;
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.body.page).toBe(2);
  await expect(page.getByText('Page 2 of 3', { exact: true })).toBeVisible();
  passed++;
  await page.getByLabel('Rows per page', { exact: true }).selectOption('5');
  await expect(page.locator('tbody tr')).toHaveCount(5);
  if (requests.at(-1).body.page !== 1) throw new Error('Page-size change did not reset offset.');
  passed++;
  await page.getByText('Visible columns', { exact: true }).click();
  await page.getByLabel('Customer', { exact: true }).uncheck();
  await expect(page.getByRole('columnheader', { name: 'Customer', exact: true })).toHaveCount(0);
  passed++;
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export page CSV', exact: true }).click();
  const download = await downloading;
  if (download.suggestedFilename() !== 'orders-page.csv')
    throw new Error('CSV page artifact missing.');
  passed++;
  await page.getByLabel('Order type', { exact: true }).selectOption('HE');
  await page.getByLabel('Order stores', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.body.orderType).toBe('HE');
  if (requests.at(-1).body.storeIds.join(',') !== '2')
    throw new Error('Express selected-store scope changed.');
  passed++;
  await page.getByLabel('In queue', { exact: true }).check();
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByText(/Live queue with historical details/)).toBeVisible();
  await expect(page.getByLabel('Order IDs', { exact: true })).toBeDisabled();
  passed++;
  unavailable = true;
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(
    page.getByText('A complete historical publication is required.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('No orders in this selection', { exact: true })).toHaveCount(0);
  passed++;
  await context.close();
  process.stdout.write(
    JSON.stringify({
      resource: 'source-order-search',
      passed,
      browser: 'chromium',
      isolated: true,
      sourceSnapshot: snapshot.sourcePin,
    }) + '\n',
  );
} finally {
  await browser?.close();
  await server.close();
}
