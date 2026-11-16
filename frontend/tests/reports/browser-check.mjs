import { chromium, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (process.platform === 'darwin' && existsSync(macChrome) ? macChrome : undefined),
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
const context = await browser.newContext({
    viewport: { width: 1512, height: 1100 },
    acceptDownloads: true,
    serviceWorkers: 'block',
  }),
  page = await context.newPage(),
  errors = [],
  unexpected = [],
  requests = [];
page.on('pageerror', (error) => errors.push(error.message));
const html =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/tests/reports/browser-entry.tsx"></script></body></html>';
const row = (index) => ({
  store_name: index === 0 ? '\u200b=SUM(1,2)' : `Fixture store ${String(index).padStart(2, '0')}`,
  date: '2026-11-16',
  target: 100,
  store_revenue: 99.99,
  online_revenue: 0.01,
  total_revenue: 100,
  target_achieved_pct: 100,
  store_orders: 1,
  online_orders: 1,
  total_orders: 2,
  aov: 50,
  online_qty: 1,
  store_qty: 2,
  total_qty: 3,
  basket_size: 1.5,
  footfall: 4,
  conversion_pct: 50,
  membership_purchase_orders: 1,
  membership_orders_total: 1,
  membership_conversion_pct: 50,
  membership_aov: 99.99,
  tss_money_used: 0.01,
  tss_points_used: 0.02,
  revenue_per_footfall: 25,
  pg_discount: 0.03,
  gift_voucher: 0.04,
  district: 0.05,
  cash: 50,
  total_online: 50,
  banking: 50,
  membership_revenue: 99.99,
  pending_offline_orders: index === 0 ? 1 : 0,
});
await page.route('**/*', async (route) => {
  const request = route.request(),
    url = new URL(request.url());
  if (request.resourceType() === 'document' && url.pathname === '/reports')
    return route.fulfill({ contentType: 'text/html', body: html });
  if (url.hostname !== '127.0.0.1') {
    unexpected.push(url.hostname);
    return route.abort();
  }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  requests.push({ method: request.method(), path: url.pathname });
  if (url.pathname === '/api/v1/stores')
    return route.fulfill({
      json: {
        data: [1, 2].map((id) => ({
          id: String(id),
          name: 'Fixture ' + id,
          locationCode: 'FIX' + id,
          city: 'Fixture city',
          active: true,
        })),
      },
    });
  if (url.pathname === '/api/v1/reports/daily-store-sales') {
    expect(request.headers()['x-operator-id']).toBe('1');
    expect(url.searchParams.get('storeIds')).toBe('1,2');
    return route.fulfill({
      json: {
        reader: 'bigquery',
        range: { start: '2026-11-15T18:30:00Z', end: '2026-11-16T18:30:00Z' },
        data: Array.from({ length: 61 }, (_, index) => row(index)),
        totals: {
          ...row(100),
          store_name: 'Total',
          date: '',
          total_revenue: 6100,
          total_orders: 122,
          total_qty: 183,
          pending_offline_orders: 1,
        },
        pendingOrderCount: 1,
        publication: {
          generationId: 'fixture_generation',
          publishedAt: '2026-11-16T07:59:50Z',
          cdcWatermark: '2026-11-16T07:59:30Z',
        },
      },
    });
  }
  unexpected.push(request.method() + ' ' + url.pathname);
  return route.fulfill({
    status: 500,
    json: { error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unexpected fixture request.' } },
  });
});
try {
  await page.goto('http://127.0.0.1:4490/reports');
  await page.getByLabel('Report stores').selectOption(['1', '2']);
  await page.getByLabel('Report from date').fill('2026-11-16');
  await page.getByLabel('Report to date').fill('2026-11-16');
  await page.getByRole('button', { name: 'View report', exact: true }).click();
  const table = page.getByRole('table', { name: 'Daily store sales breakdown' });
  await expect(table.locator('tbody tr')).toHaveCount(50);
  await expect(
    page.getByRole('status').filter({ hasText: 'offline cash receipt is awaiting order import' }),
  ).toBeVisible();
  await expect(page.getByText(/^Data updated through/)).toBeVisible();
  await page.getByText('Columns (16 of 32)', { exact: true }).click();
  await page.getByRole('button', { name: 'Show all columns' }).click();
  await expect(table.locator('thead th')).toHaveCount(32);
  await expect(
    table.getByRole('columnheader', { name: 'Offline orders awaiting import' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(11);
  await expect(table.locator('tfoot')).toContainText('6100');
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const file = await waiting,
    csv = await readFile(await file.path(), 'utf8');
  expect(csv.trim().split('\r\n')).toHaveLength(63);
  expect(csv).toContain('"Offline orders awaiting import"');
  expect(csv).toContain('"Fixture store 60"');
  expect(csv).toContain('"\'\u200b=SUM(1,2)"');
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  await mkdir('../backend/parity/evidence/reports', { recursive: true });
  await page.screenshot({
    path: '../backend/parity/evidence/reports/daily-offline.png',
    fullPage: true,
  });
  const evidence = {
    scope: 'isolated-browser-fixtures',
    checks: [
      'captured operator and multi-store request',
      'pending cash and warehouse freshness notices',
      'all32 source/additive columns',
      '50row paging and full totals',
      'all-results CSV and formula protection',
    ],
    passed: 5,
    requests: requests.length,
    pageErrors: errors,
    unexpectedRequests: unexpected,
    externalMessages: false,
    sourceDatabaseReads: false,
  };
  await writeFile(
    '../backend/parity/evidence/reports/browser.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  await context.close();
  await browser.close();
}
