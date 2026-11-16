import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const root = fileURLToPath(new URL('../..', import.meta.url)),
  directory = fileURLToPath(new URL('.', import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: directory + '/.cache/vite',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
let browser;
let passed = 0;
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string')
    throw new Error('Isolated fixture port unavailable.');
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
  const context = await browser.newContext({ serviceWorkers: 'block' }),
    requests = [];
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    requests.push({
      path: url.pathname,
      query: url.searchParams,
      actor: request.headers()['x-operator-id'],
    });
    if (request.method() !== 'GET')
      throw new Error('The browsing fixture must not send financial mutations.');
    if (url.pathname === '/api/v1/stores/1/orders') {
      const from = url.searchParams.get('from'),
        to = url.searchParams.get('to');
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const reader = from === today && to === today ? 'primary' : 'bigquery';
      const order = {
        id: '501',
        reference: 'SYNTHETIC-01',
        storeId: '1',
        customer: 'Synthetic customer',
        amount: '1234.5',
        status: 'Delivered',
        paymentStatus: 'Paid',
        createdAt: from + ' 12:00:00',
      };
      return route.fulfill({
        json: {
          data: [
            { ...order, rowId: '11' },
            { ...order, rowId: '10' },
          ],
          nextCursor: null,
          reader,
          range: { from, to, timeZone: 'Asia/Kolkata', reader },
        },
      });
    }
    if (url.pathname === '/api/v1/stores/1/orders/501')
      return route.fulfill({
        json: {
          reference: 'SYNTHETIC-01',
          amount: 1234.5,
          isPaid: false,
          status: 'Delivered',
          createdAt: '2026-01-01 12:00:00',
          reader: 'bigquery',
          lines: [
            {
              id: '9007199254741001',
              productId: '999',
              name: null,
              quantity: '0',
              amount: 0,
              gst: 0,
              status: 'CANCELLED',
            },
          ],
        },
      });
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'SYNTHETIC_UNAVAILABLE',
          message: 'Synthetic optional capability unavailable.',
        },
      },
    });
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/tests/order-history/fixture.html`);
  await page
    .getByRole('button', { name: 'SYNTHETIC-01', exact: true })
    .first()
    .waitFor({ timeout: 10000 });
  const current = requests.find((request) => request.path === '/api/v1/stores/1/orders');
  if (
    !current?.query.get('from') ||
    current.query.get('from') !== current.query.get('to') ||
    current.actor !== '1'
  )
    throw new Error('Default order dates/operator were not explicit.');
  passed++;
  if ((await page.locator('tbody tr').count()) !== 2)
    throw new Error('Store-row multiplicity changed.');
  passed++;
  const historical = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  await page.getByLabel('Orders from').fill(historical);
  await page.getByLabel('Orders to').fill(historical);
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  await page.getByText(/Historical snapshot; later source changes/).waitFor();
  passed++;
  await page.getByRole('button', { name: 'SYNTHETIC-01', exact: true }).first().click();
  await page
    .getByText(
      'Historical snapshot. Payment, cancellation and invoice actions independently verify current records.',
    )
    .waitFor();
  const selected = requests
    .filter((request) => request.path === '/api/v1/stores/1/orders/501')
    .at(-1);
  if (selected.query.get('from') !== historical || selected.query.get('to') !== historical)
    throw new Error('Selected detail lost its date scope.');
  passed++;
  await context.close();
  const direct = await browser.newContext({ serviceWorkers: 'block' });
  let directQuery;
  await direct.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/stores/1/orders/501') {
      directQuery = url.search;
      return route.fulfill({
        json: {
          reference: 'SYNTHETIC-DIRECT',
          amount: 1,
          isPaid: false,
          status: null,
          createdAt: '2020-01-01 00:00:00',
          reader: 'bigquery',
          lines: [],
        },
      });
    }
    if (url.pathname === '/api/v1/stores/1/orders')
      return route.fulfill({ json: { data: [], nextCursor: null } });
    return route.fulfill({
      status: 503,
      json: { error: { code: 'SYNTHETIC_UNAVAILABLE', message: 'Synthetic unavailable' } },
    });
  });
  const linked = await direct.newPage();
  await linked.goto(
    `http://127.0.0.1:${address.port}/tests/order-history/fixture.html?entry=` +
      encodeURIComponent('/orders?orderId=501'),
  );
  await linked.getByRole('heading', { name: 'SYNTHETIC-DIRECT', exact: true }).waitFor();
  if (directQuery !== '')
    throw new Error('Unknown-age link was incorrectly classified by an explicit today filter.');
  passed++;
  await direct.close();
  process.stdout.write(
    JSON.stringify({
      resource: 'public-order-history',
      browser: 'chromium',
      passed,
      isolated: true,
    }) + '\n',
  );
} finally {
  await browser?.close();
  await server.close();
}
