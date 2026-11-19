import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signIn } from '../e2e/support/login';
import { desktopControl, desktopWorkspace } from './ports';
import type { IpcChannel, OfflineSale, OfflineStatus } from '../src/offline/billing/contracts';

/**
 * Desktop offline billing in a real Electron process against the real backend stack
 * (backend/tools/e2e/offline-billing-stack.ts): seeded loopback MySQL, private Redis, the real
 * backend behind a TCP gate, and a stateful API-v2 order stand-in that writes real order rows.
 *
 * safeStorage: on macOS Chromium's standard `--use-mock-keychain` switch is passed so the test
 * never creates or reads an item in the developer's login keychain (the wrap/unwrap path is the
 * real Electron safeStorage API; only the keystore behind it is mocked). Windows has no mock
 * keystore: there the key is wrapped by real DPAPI for the runner's Windows user.
 *
 * Printing: the provisional receipt is rendered to PDF through Electron's print pipeline on every
 * platform. When E2E_PRINTER_NAME names a print-to-file queue (CI creates one with the built-in
 * "Microsoft Print to PDF" driver and E2E_PRINTER_OUTPUT as its file port), the receipt is also
 * spooled to that real Windows printer silently and the spooled PDF is checked.
 */
const CONTROL = desktopControl;
const WORKSPACE = desktopWorkspace;
const SALESPERSON = '810001';
const STORE = '1',
  COUNTER = '1';
const requireFromHere = createRequire(import.meta.url);

interface OfflineOrderRow {
  orderId: string;
  comment: string;
  orderRefNo: string;
  invoice: string | null;
  isOfflineOrder: boolean | number;
  storeId: string;
  counterId: string;
  paymentStatus: string | null;
  paymentMessage: string;
  transactionId: string;
  manuallyPaid: boolean | number;
  onlineOther: string;
}
interface ControlOrders {
  rows: OfflineOrderRow[];
  flags: { orderId: string; comment: string }[];
  orders: { id: string; orderRefNo: string; invoice: string | null }[];
}
async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(CONTROL + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`control ${path} failed with ${response.status}`);
  return (await response.json()) as T;
}
const network = (up: boolean, extra: Record<string, unknown> = {}) =>
  control<{ up: boolean; droppedSaleResponses: number }>('/network', { up, ...extra });
const posOrderCalls = async () =>
  (await control<{ calls: string[] }>('/calls')).calls.filter((path) => path === 'pos/order')
    .length;

let profile = '';
let app: ElectronApplication;
let page: Page;
/** The app the spec is deliberately closing; its window closing is then expected. */
let closingApp: ElectronApplication | null = null;

async function launch() {
  app = await _electron.launch({
    args: [...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []), '.'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      POS_DESKTOP_URL: WORKSPACE,
      POS_DESKTOP_PROFILE_DIR: profile,
    },
  });
  page = await app.firstWindow();
  const launched = app,
    child = launched.process();
  // Diagnostics for a lost DevTools connection: Playwright then reports the page as closed
  // although the Electron process (and its window) is still running.
  page.once('close', () => {
    if (child.exitCode === null && child.signalCode === null && closingApp !== launched)
      console.warn('[desktop-e2e] Playwright lost the window while the app process is running.');
  });
}
const settled = (done: Promise<void>, ms: number) =>
  Promise.race([
    done.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
/**
 * Quit the app and wait until its process has exited. `ElectronApplication.close()` asks the app
 * to quit over Playwright's DevTools connection; if that connection was lost, Playwright treats
 * the app as already closed and returns while Electron keeps running (and keeps syncing), and
 * the worker teardown then waits for an exit that never comes. SIGTERM runs Electron's normal
 * quit path (before-quit closes the encrypted offline database), so teardown never depends on
 * the DevTools connection. SIGKILL is a last resort and fails the caller.
 */
async function closeApp(target: ElectronApplication) {
  const child = target.process();
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once('exit', () => resolve()));
  closingApp = target;
  // Not awaited on its own: if the app never quits, Playwright's close() never settles either.
  const closing = target.close().catch(() => undefined);
  if (await settled(exited, 15000)) return await closing;
  console.warn('[desktop-e2e] The app did not exit after quit; sending SIGTERM.');
  child.kill('SIGTERM');
  if (await settled(exited, 15000)) return;
  child.kill('SIGKILL');
  await exited;
  throw new Error('The desktop app ignored quit and SIGTERM and had to be killed.');
}
type Reply<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
async function bridge<T>(channel: IpcChannel, payload: unknown): Promise<Reply<T>> {
  return page.evaluate(
    async ([name, value]) => {
      const api = (
        window as unknown as {
          souledOfflineBilling?: { invoke: (c: string, p: unknown) => Promise<unknown> };
        }
      ).souledOfflineBilling;
      if (!api) throw new Error('The desktop offline billing bridge is missing.');
      return api.invoke(name, value);
    },
    [channel, payload] as const,
  ) as Promise<Reply<T>>;
}
async function status(): Promise<OfflineStatus> {
  const reply = await bridge<OfflineStatus>('offline:status', {});
  if (!reply.ok) throw new Error(reply.error.code);
  return reply.data;
}
async function waitForStatus(check: (value: OfflineStatus) => boolean, timeout = 60000) {
  let last: OfflineStatus | null = null;
  await expect
    .poll(
      async () => {
        last = await status();
        return check(last);
      },
      { timeout, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  return last as unknown as OfflineStatus;
}
async function sales(): Promise<OfflineSale[]> {
  const reply = await bridge<{ sales: OfflineSale[] }>('offline:sale:list', { limit: 200 });
  if (!reply.ok) throw new Error(reply.error.code);
  return reply.data.sales;
}
async function billViaBridge(productId = '1001') {
  return bridge<{ sale: OfflineSale }>('offline:sale:create', {
    saleId: crypto.randomUUID(),
    storeId: STORE,
    counterId: COUNTER,
    lines: [{ productId, quantity: 1 }],
    salespersonId: SALESPERSON,
    tender: { mode: 'cash', receivedPaise: 300000 },
  });
}
/** Page objects in a PDF (Chromium/Skia and Microsoft Print to PDF write them uncompressed). */
const pdfPages = (pdf: Buffer) => pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length ?? 0;
/**
 * Print the open receipt through Electron's print pipeline (the cashier's Print button calls
 * window.print(), which adds only the OS print dialog). Every platform renders it to PDF; with a
 * print-to-file queue configured (Windows CI), it is also spooled to that real printer silently.
 */
async function printReceipt() {
  const pdf = Buffer.from(
    await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      return (await contents.printToPDF({ printBackground: false })).toString('base64');
    }),
    'base64',
  );
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  // The receipt prints exactly once: one page, not a copy per page of the hidden screen.
  const pages = pdfPages(pdf);
  expect(pages).toBe(1);
  await test
    .info()
    .attach('receipt-print-to-pdf.pdf', { body: pdf, contentType: 'application/pdf' });
  console.log(`[desktop-e2e] receipt printToPDF: ${pdf.length} bytes, ${pages} page(s)`);
  const printer = process.env.E2E_PRINTER_NAME,
    output = process.env.E2E_PRINTER_OUTPUT;
  if (!printer || !output) return;
  const printers = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0]!.webContents.getPrintersAsync()).map(
      (item) => item.name,
    ),
  );
  expect(printers).toContain(printer);
  expect(printers).toContain('Microsoft Print to PDF');
  await rm(output, { force: true });
  const printed = await app.evaluate(
    ({ BrowserWindow }, deviceName) =>
      new Promise<{ success: boolean; reason: string }>((resolve) =>
        BrowserWindow.getAllWindows()[0]!.webContents.print(
          { silent: true, deviceName, printBackground: false },
          (success, reason) => resolve({ success, reason }),
        ),
      ),
    printer,
  );
  expect(printed.success, printed.reason).toBe(true);
  let size = -1;
  await expect
    .poll(
      async () => {
        const current = (await stat(output).catch(() => null))?.size ?? 0;
        const settledSize = current > 0 && current === size;
        size = current;
        return settledSize;
      },
      { timeout: 60000, intervals: [1000] },
    )
    .toBe(true);
  const spooled = await readFile(output);
  expect(spooled.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const spooledPages = pdfPages(spooled);
  expect(spooledPages).toBe(1);
  await test
    .info()
    .attach('receipt-spooled-windows.pdf', { body: spooled, contentType: 'application/pdf' });
  console.log(
    `[desktop-e2e] receipt spooled to "${printer}": ${spooled.length} bytes, ${spooledPages} page(s)`,
  );
}
async function goOffline() {
  await network(false);
  await waitForStatus((value) => !value.online, 45000);
}
async function goOnlineAndSync(extra: Record<string, unknown> = {}) {
  await network(true, extra);
  await waitForStatus(
    (value) => value.online && value.queue.queued + value.queue.syncing === 0 && !value.syncing,
    90000,
  );
}

test.describe.serial('desktop offline billing on the real stack', () => {
  test.beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), 'souled-pos-offline-'));
  });
  test.afterAll(async () => {
    if (app) await closeApp(app);
    await network(true).catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  });

  test('signs in, checks in to the store and caches the catalogue online', async () => {
    await launch();
    // Login verifies the OTP and checks in to the store (legacy check-ins carry no counter).
    await signIn(page, STORE);
    await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
    // W27: check-in status, the log-out toggle and no bell, sound toggle or connection card.
    const header = page.getByRole('banner');
    await expect(header.getByLabel('Store check-in: Checked in', { exact: true })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Check out', exact: true })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
    await expect(header.getByRole('button', { name: /^Notifications/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /sound/i })).toHaveCount(0);
    await expect(header.getByRole('link', { name: /^Offline\./ })).toHaveCount(0);
    // No check-in prompt: login already checked in to the store.
    await expect(page.getByRole('dialog', { name: 'Check in to your store' })).toHaveCount(0);
    await page.goto(WORKSPACE + '/offline-billing');
    const ready = await waitForStatus(
      (value) =>
        value.available &&
        value.online &&
        value.catalog.products > 0 &&
        value.counters.some((counter) => counter.id === COUNTER) &&
        value.operator?.storeId === STORE &&
        value.operator.eligible === true,
    );
    expect(ready.limits).toMatchObject({ maxMinutes: 120, maxOrders: 10 });
    // The offline app shell is cached by the service worker before the network goes away.
    expect(await page.evaluate(async () => Boolean(await navigator.serviceWorker.ready))).toBe(
      true,
    );
    // W27: online with nothing waiting, the page shows no status card at all.
    await expect(page.getByRole('heading', { name: 'Offline billing.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Connected|Working offline/ })).toHaveCount(0);
  });

  test('bills a cash sale and a card-reference sale with the backend blocked', async () => {
    await goOffline();
    await page.goto(WORKSPACE + '/offline-billing');
    await expect(page.getByRole('heading', { name: 'Working offline' })).toBeVisible();
    // The compact header indicator replaces the offline banner.
    await expect(page.getByRole('banner').getByRole('link', { name: /^Offline\./ })).toBeVisible();
    const search = page.getByLabel('Scan a barcode or search products');

    await search.fill('Classic');
    await page.getByRole('button', { name: 'Find' }).click();
    await page
      .getByRole('listitem')
      .filter({ hasText: 'Classic: Oversized T-shirt' })
      .getByRole('button', { name: 'Add' })
      .click();
    await page.getByLabel('Salesperson').selectOption(SALESPERSON);
    await page.getByLabel('Cash received').fill('1000');
    await page.getByRole('button', { name: 'Complete offline sale' }).click();
    const receipt = page.getByRole('dialog');
    await expect(
      receipt.getByRole('heading', { name: /^Provisional receipt OFF-1-1-[A-Z0-9]{8}-1$/ }),
    ).toBeVisible();
    await expect(receipt).toContainText('Provisional — final invoice issued on sync');
    await expect(receipt).toContainText('Change Rs. 1.00');
    await printReceipt();
    await receipt.getByRole('button', { name: 'Close receipt' }).click();

    await search.fill('Urban');
    await page.getByRole('button', { name: 'Find' }).click();
    await page
      .getByRole('listitem')
      .filter({ hasText: 'Urban: Utility Cargo' })
      .getByRole('button', { name: 'Add' })
      .click();
    await page.getByLabel('Salesperson').selectOption(SALESPERSON);
    await page.getByRole('radio', { name: 'Card' }).click();
    await page.getByLabel('Card reference from the standalone terminal').fill('RRN-SYN-0001');
    await page.getByRole('button', { name: 'Complete offline sale' }).click();
    await expect(
      receipt.getByRole('heading', { name: /^Provisional receipt OFF-1-1-[A-Z0-9]{8}-2$/ }),
    ).toBeVisible();
    await expect(receipt).toContainText('CARD reference RRN-SYN-0001');
    await receipt.getByRole('button', { name: 'Close receipt' }).click();

    const queued = await sales();
    expect(queued.map((sale) => [sale.status, sale.tender.mode, sale.payablePaise])).toEqual([
      ['queued', 'card', 189900],
      ['queued', 'cash', 99900],
    ]);
    await expect(
      page.getByRole('banner').getByRole('link', { name: '2 sales waiting to sync' }),
    ).toBeVisible();
    expect(await posOrderCalls()).toBe(0);
  });

  test('keeps the queued sales across an app restart', async () => {
    const before = (await sales()).map((sale) => sale.provisionalRef);
    await closeApp(app);
    await launch();
    // Still offline: the shell loads from the service worker and the counter switches to
    // offline billing by itself.
    await page.waitForURL(WORKSPACE + '/offline-billing', { timeout: 45000 });
    await waitForStatus((value) => value.available && !value.online, 45000);
    const after = await sales();
    expect(after.map((sale) => sale.provisionalRef)).toEqual(before);
    expect(after.every((sale) => sale.status === 'queued')).toBe(true);
    await expect(page.getByRole('cell', { name: before[0]! })).toBeVisible();
  });

  test('a reload while only the store service is down opens offline billing, not login', async () => {
    // The web server answers again; the store service behind it does not (nginx 502 shape).
    await network(true, { backend: false });
    await page.goto(WORKSPACE + '/');
    await page.waitForURL(WORKSPACE + '/offline-billing', { timeout: 45000 });
    await expect(page.getByRole('heading', { name: 'Working offline' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Scan a barcode or search products')).toBeVisible();
    await network(false);
  });

  test('stores the sales in a file that cannot be read without the device key', async () => {
    const filename = join(profile, 'offline-billing.db');
    const header = (await readFile(filename)).subarray(0, 16).toString('latin1');
    expect(header).not.toBe('SQLite format 3\0');
    const wrapped = await readFile(join(profile, 'offline-billing.key'));
    expect(/^[a-f0-9]{64}$/.test(wrapped.toString('latin1'))).toBe(false);
    type Plain = new (
      file: string,
      options?: { readonly?: boolean; fileMustExist?: boolean },
    ) => {
      prepare(sql: string): { get(): unknown };
      close(): void;
    };
    const Database = requireFromHere('better-sqlite3-multiple-ciphers') as Plain;
    const plain = new Database(filename, { readonly: true, fileMustExist: true });
    try {
      expect(() => plain.prepare('SELECT count(*) FROM sales').get()).toThrow(
        /not a database|encrypted/i,
      );
    } finally {
      plain.close();
    }
  });

  test('syncs automatically on reconnect into real orders with invoice numbers', async () => {
    // The card sale came from a standalone terminal: no terminal-table row exists for it.
    await goOnlineAndSync();
    const synced = await sales();
    expect(synced.map((sale) => [sale.status, sale.conflict?.message ?? null])).toEqual([
      ['synced', null],
      ['synced', null],
    ]);
    for (const sale of synced) expect(sale.invoiceNumber).toMatch(/INV\d{5}$/);
    await page.goto(WORKSPACE + '/offline-billing');
    for (const sale of synced)
      await expect(page.getByRole('cell', { name: sale.invoiceNumber! })).toBeVisible();

    const { rows } = await control<ControlOrders>('/offline-orders');
    expect(rows).toHaveLength(2);
    for (const sale of synced) {
      const row = rows.find((item) => item.orderId === sale.orderId)!;
      expect(row.comment.startsWith(`Offline bill ${sale.provisionalRef} billed at `)).toBe(true);
      expect(Number(row.isOfflineOrder)).toBe(1);
      expect(row.invoice).toBe(sale.invoiceNumber);
      // API-v2 owns order_ref_no; sync never writes it.
      expect(row.orderRefNo).toBe(`API2-${row.orderId}`);
      expect([row.storeId, row.counterId]).toEqual([STORE, COUNTER]);
    }
    // Card reference: a legacy "Others" settlement with the typed reference as the payment
    // message, and one finance reconciliation flag because no terminal row matched.
    const card = synced.find((sale) => sale.tender.mode === 'card')!;
    const cardRow = rows.find((item) => item.orderId === card.orderId)!;
    expect(cardRow.paymentMessage).toBe('RRN-SYN-0001');
    expect(Number(cardRow.manuallyPaid)).toBe(1);
    expect(Number(cardRow.onlineOther)).toBe(1899);
    expect(cardRow.transactionId).not.toBe('RRN-SYN-0001');
    expect(Number(cardRow.paymentStatus)).toBe(4);
    const { flags } = await control<ControlOrders>('/offline-orders');
    expect(flags).toEqual([
      {
        orderId: card.orderId,
        comment: `Offline bill ${card.provisionalRef} reconciliation: CARD reference RRN-SYN-0001 has no matching terminal transaction. Finance to reconcile.`,
      },
    ]);
    expect(await posOrderCalls()).toBe(2);
  });

  test('a replayed upload after a lost response creates no duplicate order', async () => {
    await goOffline();
    const billed = await billViaBridge('1003');
    expect(billed.ok).toBe(true);
    const calls = await posOrderCalls();
    await network(true, { dropSaleResponses: 1 });
    await waitForStatus(
      (value) => value.online && value.queue.synced === 3 && !value.syncing,
      90000,
    );
    const sale = (await sales()).find(
      (item) => billed.ok && item.saleId === billed.data.sale.saleId,
    )!;
    expect(sale.status).toBe('synced');
    expect(
      (await control<{ droppedSaleResponses: number }>('/network', { up: true }))
        .droppedSaleResponses,
    ).toBe(1);
    const { rows } = await control<ControlOrders>('/offline-orders');
    expect(rows.filter((row) => row.comment.includes(`${sale.provisionalRef} `))).toHaveLength(1);
    expect(await posOrderCalls()).toBe(calls + 1);
  });

  test('an uncertain outcome goes to the manager, is never resent, and the manager links the order', async () => {
    await goOffline();
    const billed = await billViaBridge('1006');
    expect(billed.ok).toBe(true);
    const saleId = billed.ok ? billed.data.sale.saleId : '';
    const calls = await posOrderCalls();
    await control('/order-mode', { order: 'uncertain' });
    await network(true);
    await waitForStatus((value) => value.online && value.queue.needsManager === 1, 90000);
    let sale = (await sales()).find((item) => item.saleId === saleId)!;
    expect(sale.status).toBe('needs_manager');
    expect(sale.conflict?.code).toBe('OUTCOME_UNKNOWN');
    expect(await posOrderCalls()).toBe(calls + 1);
    // Two more heartbeat cycles: nothing is resent automatically.
    await page.waitForTimeout(35000);
    await app.evaluate(() => undefined);
    expect(await posOrderCalls()).toBe(calls + 1);
    expect((await sales()).find((item) => item.saleId === saleId)!.status).toBe('needs_manager');

    // The manager finds the order in Orders and links it.
    const { orders } = await control<ControlOrders>('/offline-orders');
    const created = orders[orders.length - 1]!;
    await page.goto(WORKSPACE + '/offline-billing');
    await page
      .getByRole('row')
      .filter({ hasText: sale.provisionalRef })
      .getByRole('button', { name: 'Resolve' })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('A manager must check Orders');
    await dialog.getByLabel('Decision').selectOption('link-order');
    await dialog.getByLabel('Order ID from Orders').fill(created.id);
    await dialog.getByLabel('Reason').fill('Found the order in Orders');
    await dialog.getByRole('button', { name: 'Save decision' }).click();
    await waitForStatus((value) => value.queue.needsManager === 0 && !value.syncing, 60000);
    sale = (await sales()).find((item) => item.saleId === saleId)!;
    expect(sale.status).toBe('synced');
    expect(sale.orderId).toBe(created.id);
    expect(sale.resolution).toMatchObject({ action: 'link-order', orderId: created.id });
    expect(await posOrderCalls()).toBe(calls + 1);
    const { rows } = await control<ControlOrders>('/offline-orders');
    const row = rows.find((item) => item.orderId === created.id)!;
    // The linked order never reached the finalizer through its lost reply; it now has its
    // real invoice number, shown on the device.
    expect(sale.invoiceNumber).toMatch(/INV\d{5}$/);
    expect(row.invoice).toBe(sale.invoiceNumber);
    await page.goto(WORKSPACE + '/offline-billing');
    await expect(page.getByRole('cell', { name: sale.invoiceNumber! })).toBeVisible();
    expect(row.comment.startsWith(`Offline bill ${sale.provisionalRef} billed at `)).toBe(true);
    expect(Number(row.isOfflineOrder)).toBe(1);
    expect(row.orderRefNo).toBe(`API2-${created.id}`);
  });

  test('blocks the 11th offline order', async () => {
    await goOffline();
    for (let index = 0; index < 10; index++) expect((await billViaBridge()).ok).toBe(true);
    const eleventh = await billViaBridge();
    expect(eleventh).toMatchObject({ ok: false, error: { code: 'ORDER_LIMIT' } });
    await page.goto(WORKSPACE + '/offline-billing');
    await expect(
      page.getByText(/Offline order limit reached: .* 10 of 10 orders used/),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Complete offline sale' })).toHaveCount(0);
    await goOnlineAndSync();
    expect((await sales()).filter((sale) => sale.status === 'synced')).toHaveLength(14);
  });

  test('smaller backend limits apply after the next online contact', async () => {
    await goOffline();
    await control('/backend/restart', { maxOrders: 3, maxMinutes: 120 });
    expect((await status()).limits.maxOrders).toBe(10);
    await network(true);
    await waitForStatus((value) => value.online && value.limits.maxOrders === 3, 60000);
    await goOffline();
    for (let index = 0; index < 3; index++) expect((await billViaBridge()).ok).toBe(true);
    expect(await billViaBridge()).toMatchObject({ ok: false, error: { code: 'ORDER_LIMIT' } });
    await goOnlineAndSync();
  });

  test('blocks billing after the offline time window', async () => {
    await control('/backend/restart', { maxOrders: 10, maxMinutes: 1 });
    await waitForStatus((value) => value.online && value.limits.maxMinutes === 1, 60000);
    await goOffline();
    expect((await billViaBridge()).ok).toBe(true);
    await page.waitForTimeout(62000);
    expect(await billViaBridge()).toMatchObject({ ok: false, error: { code: 'TIME_LIMIT' } });
    expect((await status()).limits.reason).toBe('TIME_LIMIT');
    await goOnlineAndSync();
  });

  test('setting the device clock back expires the window', async () => {
    await control('/backend/restart', { maxOrders: 10, maxMinutes: 120 });
    await waitForStatus((value) => value.online && value.limits.maxMinutes === 120, 60000);
    await goOffline();
    expect((await status()).limits.allowed).toBe(true);
    // Move the main-process wall clock back 10 minutes; the monotonic clock keeps running.
    await app.evaluate(() => {
      const real = Date.now.bind(Date);
      Date.now = () => real() - 10 * 60000;
    });
    const blocked = await status();
    expect(blocked.limits).toMatchObject({ allowed: false, reason: 'CLOCK_INCONSISTENT' });
    expect(await billViaBridge()).toMatchObject({
      ok: false,
      error: { code: 'CLOCK_INCONSISTENT' },
    });
  });
});
