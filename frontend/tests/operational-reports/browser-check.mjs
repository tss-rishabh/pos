// UI protocol fixtures only. Source calculations/authorization have separate MySQL tests.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const base = new URL(process.env.POS_REPORT_BROWSER_BASE_URL || 'http://127.0.0.1:4490');
if (!['127.0.0.1', 'localhost'].includes(base.hostname))
  throw new Error('Browser fixture requires a local app.');
const user = {
    id: '10',
    name: 'Fixture Operator',
    email: 'operator@example.test',
    role: 4,
    userType: 1,
    storeIds: ['1'],
  },
  store = {
    id: '1',
    name: 'Fixture Store',
    locationCode: 'FIXTURE-1',
    city: 'Fixture City',
    active: true,
  },
  archiveId = randomUUID(),
  jobs = [],
  requests = [],
  unexpected = [],
  pageErrors = [];
const archived = {
  id: archiveId,
  origin: 'current',
  kind: 'cash-balance',
  reportName: 'Archived fixture report',
  note: 'Archive fixture note',
  from: '2026-11-01',
  to: '2026-11-02',
  status: 'COMPLETED',
  message: 'Report file is ready.',
  requestedBy: '10',
  requestedByName: 'Fixture Operator',
  requestedAt: new Date(Date.now() - 48 * 3600000).toISOString(),
  completedAt: new Date(Date.now() - 48 * 3600000 + 60000).toISOString(),
  format: 'CSV',
  byteCount: 120,
  rowCount: 2,
  canDownload: true,
};
const archiveRows = Array.from({ length: 537 }, (_, index) =>
    index === 0
      ? archived
      : {
          ...archived,
          id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          reportName:
            index === 1 ? '\u200b=SUM(1,2)' : `Fixture archive ${String(index).padStart(3, '0')}`,
          canDownload: false,
        },
  ),
  legacyArchived = {
    ...archived,
    id: '42',
    origin: 'legacy',
    reportName: 'Legacy fixture report',
    period: '',
    note: null,
    from: null,
    to: null,
    canDownload: false,
  };
const closeFields = [
  ['store_name', 'Store'],
  ['close_date', 'Date'],
  ['version', 'Attempt'],
  ['status', 'Status'],
  ['stale_reason', 'Invalidated by'],
  ['cash_system', 'Cash (system)'],
  ['cash_refund_system', 'Cash refund'],
  ['cash_actual', 'Cash (actual)'],
  ['cash_manual_punched', 'Cash manual punched'],
  ['cash_manual_created', 'Cash manual created'],
  ['cash_difference', 'Cash difference'],
  ['cash_result', 'Cash result'],
  ['cash_reason', 'Cash reason'],
  ['cash_comment', 'Cash comment'],
  ['card_system', 'Online (system)'],
  ['card_actual', 'Online (actual)'],
  ['card_manual_punched', 'Online manual punched'],
  ['card_manual_created', 'Online manual created'],
  ['card_difference', 'Online difference'],
  ['card_result', 'Online result'],
  ['card_reason', 'Online reason'],
  ['card_comment', 'Online comment'],
  ['district_system', 'District'],
  ['banking_amount', 'Banking'],
  ['closed_by', 'Closed by'],
  ['closed_at', 'Closed at'],
  ['closed_late', 'Closed late'],
  ['last_verified_at', 'Last verified'],
];
const closeRows = Array.from({ length: 23 }, (_, index) => ({
  id: String(index + 1),
  store_id: '1',
  store_name: 'Fixture Store',
  close_date: '2026-11-16',
  version: index + 1,
  status: 'CLOSED',
  stale_reason: null,
  cash_system: '50.00',
  cash_refund_system: '0.00',
  cash_actual: '50.00',
  cash_manual_punched: '0.00',
  cash_manual_created: '0.00',
  cash_difference: '0.00',
  cash_result: 'TALLIED',
  cash_reason: '',
  cash_comment: index === 22 ? '\u200b=SUM(1,2)' : 'Fixture close note',
  card_system: '5.00',
  card_actual: '5.00',
  card_manual_punched: '0.00',
  card_manual_created: '0.00',
  card_difference: '0.00',
  card_result: 'TALLIED',
  card_reason: '',
  card_comment: '',
  district_system: '0.00',
  banking_amount: '0.00',
  closed_by: 'Fixture Operator',
  closed_at: '2026-11-17 10:00:00',
  closed_late: 'No',
  last_verified_at: null,
}));
const safeCsvCell = (value) => {
  let text = value === null ? '' : String(value);
  if (/^[\p{C}\p{Z}\s]*[=+\-@\t\r]/u.test(text) && !/^[-+]?\d+(?:\.\d+)?$/.test(text))
    text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
const ledgerTo = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()),
  ledgerStart = new Date(ledgerTo + 'T00:00:00Z');
ledgerStart.setUTCDate(ledgerStart.getUTCDate() - 59);
const ledgerFrom = ledgerStart.toISOString().slice(0, 10),
  ledgerRows = Array.from({ length: 60 }, (_, index) => {
    const day = new Date(ledgerStart);
    day.setUTCDate(day.getUTCDate() + index);
    return {
      store_id: '1',
      store_name: 'Fixture Store',
      date: day.toISOString().slice(0, 10),
      opening_cash: 100 + index + '.00',
      sales_cash: '10.00',
      running_total: 110 + index + '.00',
      actual_cash: '10.00',
      difference: '0.00',
      banking_amount: '0.00',
      closing_balance: 110 + index + '.00',
      status: 'CLOSED',
      note: index === 0 ? 'Needle ledger note' : 'Fixture ledger note',
    };
  });
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (process.platform === 'darwin' && existsSync(macChrome) ? macChrome : undefined);
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
try {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
      acceptDownloads: true,
    }),
    page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.name));
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    requests.push({ method, path });
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/v1/auth/sessions/current')
      return json({ user, sessionExpiresAt: Date.now() + 3600000 });
    if (path === '/api/v1/auth/capabilities')
      return json({ demo: true, password: true, sso: false });
    if (path === '/api/v1/stores') return json({ data: [store] });
    if (path === '/api/v1/stores/1/counters')
      return json({ data: [{ id: '1', storeId: '1', name: 'Fixture counter' }] });
    if (path === '/api/v1/reports/store-cash-balances/stores')
      return json({ data: [{ id: '1', name: 'Fixture Store' }] });
    if (path === '/api/v1/reports/store-cash-balances')
      return json({
        reader: 'bigquery',
        range: { from: ledgerFrom, to: ledgerTo, today: ledgerTo },
        data: ledgerRows,
      });
    if (path === '/api/v1/report-exports/search') {
      const input = request.postDataJSON();
      expect(['current', 'legacy']).toContain(input.origin);
      expect([10, 25, 50, 100, 500]).toContain(input.pageSize);
      const source =
          input.origin === 'legacy'
            ? [legacyArchived]
            : input.period === 'archive'
              ? archiveRows
              : jobs,
        matching = source.filter(
          (row) =>
            !input.search || row.reportName.toLowerCase().includes(input.search.toLowerCase()),
        ),
        data = matching.slice((input.page - 1) * input.pageSize, input.page * input.pageSize);
      return json({ data, total: matching.length, page: input.page, pageSize: input.pageSize });
    }
    if (path === '/api/v1/reports/day-close-history') {
      const query = new URL(request.url()).searchParams,
        page = Number(query.get('page') || 1),
        pageSize = Number(query.get('pageSize') || 25);
      expect([10, 25, 50, 100, 500]).toContain(pageSize);
      return json({
        reader: 'bigquery',
        data: closeRows.slice((page - 1) * pageSize, page * pageSize),
        total: closeRows.length,
        page,
        totalPages: Math.ceil(closeRows.length / pageSize),
      });
    }
    if (path === '/api/v1/reports/day-close-history/export')
      return route.fulfill({
        contentType: 'text/csv; charset=utf-8',
        body:
          '\uFEFF' +
          [
            closeFields.map(([, label]) => label),
            ...closeRows.map((row) => closeFields.map(([key]) => row[key])),
          ]
            .map((row) => row.map(safeCsvCell).join(','))
            .join('\r\n'),
      });
    if (path === '/api/v1/report-exports' && method === 'POST') {
      const body = request.postDataJSON();
      expect(request.headers()['x-operator-id']).toBe(user.id);
      if (body.input.kind === 'cash-balance') {
        expect(body.input.label).toBe('Fixture ledger export');
        expect(body.input.note).toBe('Fixture ledger full export note');
        expect(body.input.from).toBe(ledgerFrom);
        expect(body.input.to).toBe(ledgerTo);
      } else {
        expect(body.input.kind).toBe('day-close-history');
        expect(body.input.label).toBe('Fixture queued export');
        expect(body.input.note).toBe('Fixture export note');
      }
      expect(body.input.storeIds).toEqual(['1']);
      const job = {
        ...archived,
        id: randomUUID(),
        kind: body.input.kind,
        from: body.input.from,
        to: body.input.to,
        reportName: body.input.label,
        note: body.input.note,
        status: 'QUEUED',
        message: 'Waiting to prepare the report.',
        requestedAt: new Date().toISOString(),
        completedAt: null,
        byteCount: null,
        rowCount: null,
        canDownload: false,
      };
      jobs.unshift(job);
      return json(job, 202);
    }
    if (path === `/api/v1/report-exports/${archiveId}/file`)
      return route.fulfill({
        status: 200,
        contentType: 'text/csv; charset=utf-8',
        headers: { 'Cache-Control': 'private, no-store' },
        body: '"Store","Amount"\r\n"Fixture","-5.00"',
      });
    unexpected.push({ method, path });
    return route.abort('blockedbyclient');
  });
  await page.goto(new URL('/reports/exports', base).href);
  await expect(page.getByRole('heading', { name: /^Report exports/ })).toBeVisible();
  await page.getByRole('listbox', { name: /^Stores/ }).selectOption('1');
  await page.getByLabel('Export name', { exact: true }).fill('Fixture queued export');
  await page.getByLabel('Notes', { exact: true }).fill('Fixture export note');
  await page.getByRole('button', { name: 'Request export', exact: true }).click();
  await expect(page.getByRole('cell', { name: /^Fixture queued export/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /QUEUED/ })).toBeVisible();
  const history = page.locator('form.export-history-filters');
  await history.getByRole('combobox', { name: /^Activity/ }).selectOption('archive');
  await history
    .getByLabel('Completed or failed from', { exact: true })
    .fill(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  await history.getByLabel('To', { exact: true }).fill(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()),
  );
  await history.getByLabel('Search', { exact: true }).fill('Archived fixture');
  await history.getByRole('combobox', { name: /^Sort/ }).selectOption('report_name');
  await history.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('cell', { name: /^Archived fixture report/ })).toBeVisible();
  await expect(page.getByText('Fixture Operator', { exact: true }).last()).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Archived fixture report', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('cash-balance-2026-11-01-2026-11-02.csv');
  await download.delete();
  await history.getByLabel('Search', { exact: true }).fill('');
  await history.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(10);
  await page.getByLabel('Export history rows per page', { exact: true }).selectOption('500');
  await expect(page.locator('tbody tr')).toHaveCount(500);
  await page.locator('summary').filter({ hasText: 'Metadata columns' }).click();
  await page.getByRole('checkbox', { name: 'Message', exact: true }).uncheck();
  await expect(page.locator('thead th')).toHaveCount(12);
  await expect(page.getByRole('columnheader', { name: 'File', exact: true })).toBeVisible();
  const beforeMetadataCsv = requests.length,
    metadataDownloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download visible metadata CSV', exact: true }).click();
  const metadataDownload = await metadataDownloadEvent,
    metadataText = await readFile(await metadataDownload.path(), 'utf8');
  expect(metadataText.split('\r\n')).toHaveLength(501);
  expect(metadataText.split('\r\n')[0]).not.toContain('"Message"');
  expect(metadataText.split('\r\n')[0]).not.toContain('"File"');
  expect(metadataText).toContain("'\u200b=SUM(1,2)");
  expect(requests).toHaveLength(beforeMetadataCsv);
  await metadataDownload.delete();
  for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.uncheck();
  await expect(page.locator('thead th')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Download visible metadata CSV', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Download Archived fixture report', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Show all metadata columns', exact: true }).click();
  await expect(page.locator('thead th')).toHaveCount(13);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(37);
  await page.getByLabel('Export history rows per page', { exact: true }).selectOption('10');
  await expect(page.locator('tbody tr')).toHaveCount(10);
  await page.getByRole('combobox', { name: 'History', exact: true }).selectOption('legacy');
  await expect(
    page.getByRole('cell', { name: 'Legacy fixture report', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download Legacy fixture report', exact: true }),
  ).toBeDisabled();
  const legacyDownloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download visible metadata CSV', exact: true }).click();
  const legacyDownload = await legacyDownloadEvent,
    legacyText = await readFile(await legacyDownload.path(), 'utf8');
  expect(legacyText.split('\r\n')[1].split(',')[3]).toBe('""');
  expect(legacyText).not.toContain('Legacy report');
  await legacyDownload.delete();
  await page.getByRole('combobox', { name: 'History', exact: true }).selectOption('current');
  await history.getByLabel('Search', { exact: true }).fill('Archived fixture');
  await history.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('cell', { name: /^Archived fixture report/ })).toBeVisible();
  expect(unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);
  const evidence = new URL(
    '../../../backend/parity/evidence/operational-reports/',
    import.meta.url,
  );
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: fileURLToPath(new URL('export-archive.png', evidence)),
    fullPage: true,
  });
  await page.goto(new URL('/cash-ledger', base).href);
  await expect(page.getByRole('heading', { name: /^Cash balance ledger/ })).toBeVisible();
  await page.locator('form.ledger-filters').getByLabel(/^From/).fill(ledgerFrom);
  await page.locator('form.ledger-filters').getByLabel(/^To/).fill(ledgerTo);
  await page.getByRole('button', { name: 'View ledger', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(31);
  const ledgerSize = page.getByRole('combobox', { name: /^Rows/ });
  expect(await ledgerSize.locator('option').allTextContents()).toEqual(['31', '62', '100', '500']);
  for (const size of ['62', '100', '500']) {
    await ledgerSize.selectOption(size);
    await expect(page.locator('tbody tr')).toHaveCount(60);
  }
  await ledgerSize.selectOption('31');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(29);
  await page.getByLabel('Search ledger', { exact: true }).fill('Needle');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  const filteredDownloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download filtered CSV', exact: true }).click();
  const filteredDownload = await filteredDownloadEvent,
    path = await filteredDownload.path();
  if (!path) throw new Error('Fixture CSV unavailable.');
  const filteredCsv = await readFile(path, 'utf8');
  expect(filteredCsv.split('\r\n')).toHaveLength(2);
  expect(filteredCsv).toContain('Needle ledger note');
  await filteredDownload.delete();
  await page.getByText('Request a full export', { exact: true }).click();
  await page.getByLabel('Report name', { exact: true }).fill('Fixture ledger export');
  await page.getByLabel('Report notes', { exact: true }).fill('Fixture ledger full export note');
  await page.getByRole('button', { name: 'Request export', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Export requested.' })).toBeVisible();
  expect(unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);
  await page.screenshot({
    path: fileURLToPath(new URL('cash-ledger-controls.png', evidence)),
    fullPage: true,
  });
  await page.goto(new URL('/reports/day-close-history', base).href);
  await expect(page.getByRole('heading', { name: 'Day-close history.', exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(10);
  const closeSize = page.getByRole('combobox', { name: /^Rows/ });
  expect(await closeSize.locator('option').allTextContents()).toEqual([
    '10',
    '25',
    '50',
    '100',
    '500',
  ]);
  await closeSize.selectOption('500');
  await expect(page.locator('tbody tr')).toHaveCount(23);
  await closeSize.selectOption('10');
  await expect(page.locator('tbody tr')).toHaveCount(10);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  const beforeClosePage = requests.length,
    closePageEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download current page CSV', exact: true }).click();
  const closePage = await closePageEvent,
    closePageText = await readFile(await closePage.path(), 'utf8');
  expect(closePageText.split('\r\n')).toHaveLength(4);
  expect(closePageText.split('\r\n')[0].split(',')).toHaveLength(28);
  expect(closePageText).toContain("'\u200b=SUM(1,2)");
  expect(requests).toHaveLength(beforeClosePage);
  await closePage.delete();
  const closeFullEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export filtered CSV', exact: true }).click();
  const closeFull = await closeFullEvent,
    closeFullText = await readFile(await closeFull.path(), 'utf8');
  expect(closeFullText.split('\r\n')).toHaveLength(24);
  expect(closeFullText.split('\r\n')[0].split(',')).toHaveLength(28);
  await closeFull.delete();
  const blockedDownloads = [];
  page.on('download', (file) => blockedDownloads.push(file));
  await page.evaluate(async () => {
    const client = await import('/src/api/client.ts');
    client.setRequestOperator('11');
  });
  await page.getByRole('button', { name: 'Download current page CSV', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(blockedDownloads).toEqual([]);
  await page.evaluate(async () => {
    const client = await import('/src/api/client.ts');
    client.setRequestOperator('10');
  });
  expect(unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);
  const result = {
    scenario: 'queued-export-archive-and-cash-ledger',
    browser: browser.version(),
    checks: [
      'operator-header',
      'named-export',
      'queued-status',
      'archive-period',
      'private-search',
      'sort',
      'actor-label',
      'authenticated-download',
      'ledger-pagination',
      'ledger-smart-search',
      'ledger-filtered-csv',
      'ledger-named-full-export',
      'metadata-source-columns-and-500row-paging',
      'visible-loaded-page-metadata-csv-and-formula-safety',
      'metadata-hidden-columns-retain-file-action',
      'legacy-empty-period-and-protected-file-action',
      'cash-source31-62-100-500-menu',
      'close-source10-25-50-100-500-menu',
      'close-page-csv-distinct-from-complete-filtered-file',
      'loaded-csv-refuses-changed-actor',
      'no-page-errors',
    ],
    apiRequests: requests.length,
    unexpectedApiRequests: unexpected.length,
    realServiceCalls: false,
  };
  await writeFile(new URL('export-archive.json', evidence), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result) + '\n');
  await context.close();
} finally {
  await browser.close();
}
