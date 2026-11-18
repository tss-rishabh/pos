import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// These API fixtures must own the request; offline shell behavior has separate real-worker tests.
test.use({ serviceWorkers: 'block' });

test('multiple-store daily reporting retains all source columns and full totals across pages and CSV', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore demo workspace' }).click();
  let requests = 0;
  const row = (index: number) => ({
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
    payment_correction_cash_out: index === 0 ? '25.49' : '0.00',
    cash_after_payment_corrections: index === 0 ? '24.51' : '50.00',
    total_online: 50,
    banking: 50,
    membership_revenue: 99.99,
  });
  await page.route('**/api/v1/reports/daily-store-sales?**', async (route) => {
    requests++;
    const query = new URL(route.request().url()).searchParams;
    expect(query.get('storeIds')).toBe('1,2');
    expect(query.get('from')).toBe('2026-11-16');
    expect(query.get('to')).toBe('2026-11-16');
    await route.fulfill({
      json: {
        reader: 'data',
        range: { start: '2026-11-15T18:30:00Z', end: '2026-11-16T18:30:00Z' },
        data: Array.from({ length: 61 }, (_, index) => row(index)),
        totals: {
          ...row(100),
          store_name: 'Total',
          date: '',
          total_revenue: 6100,
          total_orders: 122,
          total_qty: 183,
          cash: 3050,
          payment_correction_cash_out: '25.49',
          cash_after_payment_corrections: '3024.51',
        },
      },
    });
  });
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page.getByLabel('Report stores').selectOption(['1', '2']);
  await page.getByLabel('Report from date').fill('2026-11-16');
  await page.getByLabel('Report to date').fill('2026-11-16');
  await page.getByRole('button', { name: 'View report' }).click();
  const table = page.getByRole('table', { name: 'Daily store sales breakdown' });
  await expect(table.locator('tbody tr')).toHaveCount(50);
  await expect(table.locator('tfoot')).toContainText('6100');
  await page.getByText('Columns (18 of 33)', { exact: true }).click();
  await page.getByRole('button', { name: 'Show all columns' }).click();
  await expect(table.locator('thead th')).toHaveCount(33);
  for (const name of [
    'Target achieved %',
    'Online quantity',
    'Store quantity',
    'Member AOV',
    'TSS money used',
    'TSS points used',
    'Revenue per footfall',
    'PG discount',
    'Gift voucher',
    'Membership revenue',
    'Cash returned on corrections',
    'Cash after corrections',
  ])
    await expect(table.getByRole('columnheader', { name, exact: true })).toBeVisible();
  const headings = await table.locator('thead th').allTextContents(),
    firstRow = table.locator('tbody tr').first();
  await expect(
    firstRow.locator('td').nth(headings.indexOf('Cash returned on corrections')),
  ).toHaveText('25.49');
  await expect(firstRow.locator('td').nth(headings.indexOf('Cash after corrections'))).toHaveText(
    '24.51',
  );
  await expect(
    table.locator('tfoot td').nth(headings.indexOf('Cash after corrections')),
  ).toHaveText('3024.51');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(11);
  await expect(table.locator('tfoot')).toContainText('6100');
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await waiting,
    path = await download.path();
  if (!path) throw new Error('Expected a local report download.');
  const csv = await readFile(path, 'utf8');
  expect(csv.trim().split('\r\n')).toHaveLength(63);
  expect(csv).toContain('"Membership revenue"');
  expect(csv).toContain('"Cash returned on corrections"');
  expect(csv).toContain('"Cash after corrections"');
  expect(csv).toContain('"50","25.49","24.51"');
  expect(csv).toContain('"3050","25.49","3024.51"');
  expect(csv).toContain('"Fixture store 60"');
  expect(csv).toContain('"\'\u200b=SUM(1,2)"');
  expect(csv).toContain('"Total"');
  expect(requests).toBe(1);
  for (const title of ['Order transactions', 'Flash sales', 'Hyperlocal daily report'])
    await expect(
      page
        .getByRole('navigation', { name: 'Other reports' })
        .getByRole('link', { name: new RegExp(title) }),
    ).toBeVisible();
  expect(errors).toEqual([]);
});
