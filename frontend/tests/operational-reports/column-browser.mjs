// Actual report components and backend screen services; HTTP/warehouse are local fixtures.
// Checks the legacy DataTables "CSV" (visible columns of the loaded page, client-side) and the
// queued server "Export" (E1/E2/E4 only; performance and acceptance screens have no export).
import { chromium, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Temporal } from '../../../backend/node_modules/@js-temporal/polyfill/dist/index.esm.js';
import { readConfig } from '../../../backend/src/config.ts';
import { exportInputSchema } from '../../../backend/src/modules/operational-reports/export-domain.ts';
import { orderReportHeaders } from '../../../backend/src/modules/operational-reports/order-report-columns.ts';
import {
  performanceOptions,
  staffPerformanceService,
  salespersonInputSchema,
  cashierInputSchema,
} from '../../../backend/src/modules/operational-reports/performance.ts';
import {
  acceptanceOptions,
  acceptanceReportService,
  acceptanceInputSchema,
} from '../../../backend/src/modules/operational-reports/acceptance.ts';
import {
  returnedOrdersOptions,
  returnedOrdersReportService,
  returnedOrdersInputSchema,
} from '../../../backend/src/modules/operational-reports/returned-orders.ts';
import {
  flashSalesOptions,
  flashSalesReportService,
  flashSalesInputSchema,
} from '../../../backend/src/modules/operational-reports/flash-sales.ts';

const base = new URL(process.env.POS_REPORT_COLUMN_BROWSER_URL || 'http://127.0.0.1:4498');
if (base.hostname !== '127.0.0.1') throw new Error('Local fixture only');
const user = {
    id: '10',
    name: 'Fixture manager',
    email: 'fixture@example.test',
    role: 1,
    userType: 1,
    storeIds: ['1'],
  },
  config = readConfig({
    NODE_ENV: 'test',
    MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
    SESSION_SECRET: 'column-browser-fixture-'.repeat(3),
  }),
  clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z'),
  primary = {
    get() {
      return {
        select() {
          return {
            from() {
              return {
                async where() {
                  return [{ id: 10n, firstName: 'Fixture', lastName: 'Staff' }];
                },
              };
            },
          };
        },
      };
    },
    async close() {},
  },
  staff = Array.from({ length: 61 }, (_, i) => ({
    employeeId: String(i + 1),
    storeName: 'Fixture store',
    salespersonName: `Staff ${String(i).padStart(2, '0')}`,
    totalSales: 610 - i * 10,
  })),
  performance = staffPerformanceService(
    config,
    primary,
    performanceOptions({
      BQ_SALESPERSON_PERFORMANCE_VIEW: 'fixture-project.reports.salespeople',
      BQ_CASHIER_PERFORMANCE_VIEW: 'fixture-project.reports.cashiers',
    }),
    {
      async queryReport(sql) {
        if (sql.includes('performance_json'))
          return staff.map((row, i) => ({
            orderId: String(i + 1),
            cashierId: String(i + 1),
            cashierName: row.salespersonName,
            performanceJson: '{"overall_performance_time":"1000"}',
            quantity: 1,
          }));
        return sql.includes('totalSales asc') ? [...staff].reverse() : staff;
      },
    },
    clock,
  ),
  accepted = Array.from({ length: 61 }, (_, i) => ({
    id: String(i + 1),
    orderId: String(100 + i),
    staffId: '10',
    storeId: '1',
    storeName: 'Fixture store',
    createdAt: '2026-11-15 12:00:00',
    timeTaken: '0H 0M 5S',
  })),
  acceptance = acceptanceReportService(
    config,
    primary,
    acceptanceOptions({ BQ_HYPERLOCAL_ACCEPTANCE_VIEW: 'fixture-project.reports.acceptance' }),
    {
      async queryReport(sql, params) {
        if (sql.includes('COUNT(*)')) return [{ count: accepted.length }];
        const rows = sql.includes('order_id desc') ? [...accepted].reverse() : accepted;
        return rows.slice(params.offset, params.offset + params.limit);
      },
    },
    clock,
  ),
  returnsRows = Array.from({ length: 61 }, (_, i) => ({
    id: String(i + 1),
    return_id: String(i + 1),
    store_name: 'Fixture store',
    order_id: String(100 + i),
    prod_id: '20',
    qty: 1,
    pay_amount_refunded: '-5.00',
    pay_amount_refunded_mode: 'CASH',
    reason: 'Fit',
    sub_reason: null,
    comment: 'private fixture note',
    order_date: '2026-11-14 12:00:00',
    created_at: '2026-11-15 12:00:00',
    original_order_id: null,
  })),
  returnedOrders = returnedOrdersReportService(
    config,
    primary,
    returnedOrdersOptions({ BQ_RETURNED_ORDERS_VIEW: 'fixture-project.reports.returns' }),
    {
      async queryReport(sql, params) {
        if (sql.includes('COUNT(DISTINCT')) return [{ count: returnsRows.length }];
        const rows = sql.includes('order_id asc') ? returnsRows : [...returnsRows].reverse();
        return rows.slice(params.offset, params.offset + params.limit);
      },
    },
    clock,
  ),
  flashRows = Array.from({ length: 61 }, (_, i) => ({
    StoreName: `Store ${String(i).padStart(2, '0')}`,
    date: '2026-11-15',
    total_number_of_bills: 1,
    total_order_qty: 3,
    total_tss_money: 0,
    total_tss_points: 0,
    total_coupon: 0,
    total_gift_voucher: 0,
    total_pg_disc: 0,
    total_cash: 50,
    total_paytm_card_amount: 0,
    total_paytm_upi_amount: 0,
    total_online_other: 7,
    total_online: 0,
    district_transation_amt: 7,
    credit_pincode_amt: 0,
  })),
  flashOptions = Object.fromEntries(
    [
      'ORDERS',
      'ORDER_STORES',
      'LINES',
      'STORES',
      'PAYTM_TRANSACTIONS',
      'RETURN_ORDERS',
      'REFUND_LOGS',
      'AUTOMATED_REFUNDS',
    ].map((table) => [
      `BQ_FLASH_SALES_${table}_VIEW`,
      `fixture-project.reports.${table.toLowerCase()}`,
    ]),
  ),
  flashSales = flashSalesReportService(
    config,
    primary,
    flashSalesOptions(flashOptions),
    {
      async queryReport(sql) {
        return sql.includes('refunded_mode') ? [] : flashRows;
      },
    },
    clock,
  ),
  transactionRows = Array.from({ length: 61 }, (_, i) => ({
    ...Object.fromEntries(orderReportHeaders.map(([field]) => [field, `${field}-fixture`])),
    id: String(i + 1),
    order_id: String(100 + i),
    transaction_status: 'SALE',
  })),
  orderTransactions = {
    async read(_user, input, all = false) {
      return {
        reader: 'bigquery',
        data: all
          ? transactionRows
          : transactionRows.slice((input.page - 1) * input.pageSize, input.page * input.pageSize),
        total: 61,
        page: all ? 1 : input.page,
        totalPages: Math.ceil(61 / input.pageSize),
      };
    },
  },
  macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : process.platform === 'darwin' && existsSync(macChrome)
        ? { executablePath: macChrome }
        : {}),
  });
const requests = [],
  errors = [],
  unexpected = [];
const queuedMessage =
  'Records are being exported to CSV. The file will be available in the Export tab shortly. Click here to open the Export tab.';
async function loadedCsv(page) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  const file = await event,
    text = await readFile(await file.path(), 'utf8');
  await file.delete();
  return text.replace(/^﻿/, '').split('\r\n');
}
try {
  const context = await browser.newContext({ acceptDownloads: true }),
    page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== base.origin) {
      unexpected.push(url.origin);
      return route.abort();
    }
    if (request.resourceType() === 'document' && url.pathname.startsWith('/column-fixture/'))
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/tests/operational-reports/column-entry.tsx"></script></body></html>',
      });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    expect(request.headers()['x-operator-id']).toBe('10');
    if (url.pathname.endsWith('/store-cash-balances/stores'))
      return route.fulfill({ json: { data: [{ id: '1', name: 'Fixture store' }] } });
    if (url.pathname === '/api/v1/report-exports') {
      const body = z.object({ input: exportInputSchema }).strict().parse(request.postDataJSON());
      requests.push(body);
      return route.fulfill({ json: { message: queuedMessage } });
    }
    const input = request.postDataJSON();
    const result = url.pathname.includes('order-transactions')
      ? await orderTransactions.read(user, input)
      : url.pathname.includes('salesperson-performance')
        ? await performance.salespeople(user, salespersonInputSchema.parse(input))
        : url.pathname.includes('cashier-performance')
          ? await performance.cashiers(user, cashierInputSchema.parse(input))
          : url.pathname.includes('hyperlocal-acceptance')
            ? await acceptance.read(user, acceptanceInputSchema.parse(input))
            : url.pathname.includes('returned-orders')
              ? await returnedOrders.read(user, returnedOrdersInputSchema.parse(input))
              : url.pathname.includes('flash-sales')
                ? await flashSales.read(user, flashSalesInputSchema.parse(input))
                : null;
    if (result) return route.fulfill({ json: result });
    unexpected.push(url.pathname);
    return route.abort();
  });
  for (const [path, hidden, sort, direction, kind] of [
    ['salesperson', 'Store', 'total_sales', 'asc', null],
    ['cashier', 'Products sold', 'cashier_name', 'desc', null],
    ['acceptance', 'Staff', 'order_id', 'asc', null],
    ['returns', 'Comment', 'order_id', 'asc', 'returned-orders'],
    ['flash', 'Cash', 'store_date', 'desc', 'flash-sales'],
  ]) {
    await page.goto(new URL('/column-fixture/' + path, base).href);
    await page
      .getByLabel('From', { exact: true })
      .fill(path === 'flash' ? '2026-11-15' : '2026-11-15T00:00:00');
    await page
      .getByLabel('To', { exact: true })
      .fill(path === 'flash' ? '2026-11-15' : '2026-11-15T23:59:59');
    await page.getByLabel('Sort by', { exact: true }).selectOption(sort);
    await page.getByLabel('Direction', { exact: true }).selectOption(direction);
    await page.getByRole('button', { name: 'View report', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(25);
    const originalColumns = await page.locator('thead th').count();
    await page.getByText(/^Columns \(/).click();
    await page.getByRole('checkbox', { name: hidden, exact: true }).uncheck();
    await expect(page.locator('thead th')).toHaveCount(originalColumns - 1);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(11);
    const count = requests.length,
      lines = await loadedCsv(page);
    // Loaded page only: header plus the 11 rows on page 3, without the hidden column.
    expect(lines).toHaveLength(12);
    expect(lines[0].split(',')).toHaveLength(originalColumns - 1);
    expect(lines[0]).not.toContain(`"${hidden}"`);
    expect(requests).toHaveLength(count);
    if (path === 'returns') expect(lines.join('\n')).not.toContain('private fixture note');
    const shown = await page.locator('tbody tr').first().locator('td').allTextContents();
    expect(lines[1]).toBe(
      shown.map((text) => '"' + (text === '—' ? '' : text).replaceAll('"', '""') + '"').join(','),
    );
    if (kind) {
      await page.getByText('Export all matching records', { exact: true }).click();
      await page.getByLabel('Report name', { exact: true }).fill('Fixture export');
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: queuedMessage })).toBeVisible();
      const body = requests.at(-1);
      expect(body.input.kind).toBe(kind);
      expect(body.input.label).toBe('Fixture export');
      expect(body.input.storeIds).toEqual(['1']);
      for (const field of ['columns', 'sort', 'direction', 'search', 'note'])
        expect(body.input).not.toHaveProperty(field);
    } else
      await expect(page.getByText('Export all matching records', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show all columns', exact: true }).click();
    await expect(page.locator('thead th')).toHaveCount(originalColumns);
    for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.uncheck();
    await expect(page.getByRole('button', { name: 'CSV', exact: true })).toBeDisabled();
  }
  await page.goto(new URL('/column-fixture/transactions', base).href);
  await expect(page.locator('tbody tr')).toHaveCount(25);
  const transactionLines = await loadedCsv(page);
  expect(transactionLines).toHaveLength(26);
  expect(transactionLines[0].split(',')).toHaveLength(15);
  expect(transactionLines[0]).not.toContain('"CustomerID"');
  await page.getByText('Export all matching records', { exact: true }).click();
  await page.getByLabel('Report message', { exact: true }).fill('Fixture message');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: queuedMessage })).toBeVisible();
  const transactionRequest = requests.at(-1);
  expect(transactionRequest.input).toMatchObject({
    kind: 'order-transactions',
    source: 'store',
    dateType: 'order_date',
    note: 'Fixture message',
  });
  expect(transactionRequest.input).not.toHaveProperty('columns');
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  process.stdout.write(
    JSON.stringify({
      scope: 'actual-components-and-backend-screen-services',
      workflows: 6,
      loadedPageCsv: true,
      queuedExports: ['returned-orders', 'flash-sales', 'order-transactions'],
      csvOnly: ['salesperson-performance', 'cashier-performance', 'hyperlocal-acceptance'],
      sourceQueries: 'synthetic warehouse; native source checks separate',
      realServices: false,
    }) + '\n',
  );
  await context.close();
} finally {
  await browser.close();
}
