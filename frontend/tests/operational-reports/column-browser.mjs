// Actual report components and backend builder; HTTP/warehouse/storage are local fixtures.
import { chromium, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { Temporal } from '../../../backend/node_modules/@js-temporal/polyfill/dist/index.esm.js';
import { readConfig } from '../../../backend/src/config.ts';
import { normalizedExportInput } from '../../../backend/src/modules/operational-reports/export-domain.ts';
import { reportExportBuilder } from '../../../backend/src/modules/operational-reports/export-service.ts';
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
    DEMO_MODE: 'true',
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
  builder = reportExportBuilder(config, primary, {
    performance,
    acceptance,
    returnedOrders,
    flashSales,
    orderTransactions,
  }),
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
  jobs = new Map(),
  errors = [],
  unexpected = [];
let loseReply = false;
try {
  const context = await browser.newContext(),
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
      const body = request.postDataJSON(),
        input = normalizedExportInput(body.input);
      requests.push(body);
      if (!jobs.has(body.commandId)) jobs.set(body.commandId, await builder(user, input));
      if (loseReply) {
        loseReply = false;
        return route.abort('failed');
      }
      return route.fulfill({
        json: {
          id: body.commandId,
          origin: 'current',
          kind: input.kind,
          reportName: input.kind,
          from: input.from,
          to: input.to,
          status: 'COMPLETED',
          message: 'Ready',
          requestedBy: '10',
          requestedAt: '2026-11-16T08:00:00Z',
          completedAt: '2026-11-16T08:00:00Z',
          format: 'CSV',
          byteCount: jobs.get(body.commandId).bytes.length,
          rowCount: jobs.get(body.commandId).rowCount,
          canDownload: true,
        },
      });
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
  for (const [path, hidden, sort, direction, expected] of [
    ['salesperson', 'Store', 'total_sales', 'asc', 'Staff 00'],
    ['cashier', 'Products sold', 'cashier_name', 'desc', 'Staff 00'],
    ['acceptance', 'Staff', 'order_id', 'asc', '160'],
    ['returns', 'Comment', 'order_id', 'asc', '160'],
    ['flash', 'Cash', 'store_date', 'desc', 'Store 00'],
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
    const count = requests.length;
    if (path === 'salesperson') loseReply = true;
    await page.getByRole('button', { name: 'Export visible columns CSV', exact: true }).click();
    if (path === 'salesperson') {
      await expect(page.getByText(/Could not connect to the store service/)).toBeVisible();
      await page.getByRole('button', { name: 'Export visible columns CSV', exact: true }).click();
      await expect.poll(() => requests.length).toBe(count + 2);
      expect(requests[count].commandId).toBe(requests[count + 1].commandId);
    }
    await expect(page.getByRole('status').filter({ hasText: 'Export requested.' })).toBeVisible();
    const command = requests.at(-1),
      artifact = jobs.get(command.commandId),
      csv = artifact.bytes.toString();
    expect(artifact.rowCount).toBe(61);
    expect(csv.split('\r\n')).toHaveLength(62);
    expect(csv).toContain(expected);
    expect(command.input.sort).toBe(sort);
    expect(command.input.direction).toBe(direction);
    expect(command.input.columns).toHaveLength(originalColumns - 1);
    if (path === 'salesperson') expect(csv).not.toContain('Fixture store');
    if (path === 'returns') expect(csv).not.toContain('private fixture note');
    if (path === 'flash') expect(csv).toContain('"Total District Amount (da)"');
    await page.getByRole('button', { name: 'Show all columns', exact: true }).click();
    await expect(page.locator('thead th')).toHaveCount(originalColumns);
    for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.uncheck();
    await expect(
      page.getByRole('button', { name: 'Export visible columns CSV', exact: true }),
    ).toBeDisabled();
  }
  await page.goto(new URL('/column-fixture/transactions', base).href);
  await expect(page.locator('tbody tr')).toHaveCount(25);
  await page.getByRole('button', { name: 'Export visible columns CSV', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.input.kind).toBe('order-transactions');
  const selectedRequest = requests.at(-1),
    selectedArtifact = jobs.get(selectedRequest.commandId);
  expect(selectedRequest.input.sort).toBe('transaction_date');
  expect(selectedRequest.input.direction).toBe('desc');
  expect(selectedRequest.input.columns).toHaveLength(15);
  expect(selectedArtifact.rowCount).toBe(61);
  expect(selectedArtifact.bytes.toString().split('\r\n')[0].split(',')).toHaveLength(15);
  expect(selectedArtifact.bytes.toString()).not.toContain('"CustomerID"');
  await page.getByRole('button', { name: 'Export complete CSV', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.commandId).not.toBe(selectedRequest.commandId);
  const completeRequest = requests.at(-1),
    completeArtifact = jobs.get(completeRequest.commandId);
  expect(completeRequest.input).not.toHaveProperty('columns');
  expect(completeRequest.input).not.toHaveProperty('sort');
  expect(completeArtifact.rowCount).toBe(61);
  expect(completeArtifact.bytes.toString().split('\r\n')[0].split(',')).toHaveLength(75);
  expect(completeArtifact.bytes.toString()).toContain('"CustomerID"');
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  process.stdout.write(
    JSON.stringify({
      scope: 'actual-components-and-backend-builder',
      workflows: 6,
      rowsPerExport: 61,
      lostReplySameCommand: true,
      sourceQueries: 'synthetic warehouse; native source checks separate',
      realServices: false,
    }) + '\n',
  );
  await context.close();
} finally {
  await browser.close();
}
