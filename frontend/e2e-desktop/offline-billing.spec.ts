import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signIn } from '../e2e/support/login';
import type { IpcChannel, OfflineSale, OfflineStatus } from '../src/offline/billing/contracts';

/**
 * Desktop offline billing in a real Electron process against the real backend stack
 * (backend/tools/e2e/offline-billing-stack.ts): seeded loopback MySQL, private Redis, the real
 * backend behind a TCP gate, and a stateful API-v2 order stand-in that writes real order rows.
 *
 * safeStorage: Chromium's standard `--use-mock-keychain` switch is passed so the test never
 * creates or reads an item in the developer's login keychain. The wrap/unwrap path is the real
 * Electron safeStorage API; only the OS keystore behind it is Chromium's mock keychain.
 */
const CONTROL = 'http://127.0.0.1:4499';
const WORKSPACE = 'http://localhost:4173';
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
}
interface ControlOrders {
  rows: OfflineOrderRow[];
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

async function launch() {
  app = await _electron.launch({
    args: ['--use-mock-keychain', '.'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      POS_DESKTOP_URL: WORKSPACE,
      POS_DESKTOP_PROFILE_DIR: profile,
    },
  });
  page = await app.firstWindow();
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
    await app?.close().catch(() => undefined);
    await network(true).catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  });

  test('signs in, checks in to the store and caches the catalogue online', async () => {
    await launch();
    // Login verifies the OTP and checks in to the store (legacy check-ins carry no counter).
    await signIn(page, STORE);
    await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
    await expect(page.getByText('Checked in at Bandra Flagship').first()).toBeVisible();
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
    await expect(
      page.getByRole('heading', { name: 'Connected — bill from the counter' }),
    ).toBeVisible();
  });

  test('bills a cash sale and a card-reference sale with the backend blocked', async () => {
    await goOffline();
    await page.goto(WORKSPACE + '/offline-billing');
    await expect(page.getByRole('heading', { name: 'Working offline' })).toBeVisible();
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
    expect(await posOrderCalls()).toBe(0);
  });

  test('keeps the queued sales across an app restart', async () => {
    const before = (await sales()).map((sale) => sale.provisionalRef);
    await app.close();
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
    // The standalone terminal's card transaction is known to the store service.
    await control('/terminal-transaction', {
      storeId: STORE,
      reference: 'RRN-SYN-0001',
      amount: '1899.00',
    });
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
