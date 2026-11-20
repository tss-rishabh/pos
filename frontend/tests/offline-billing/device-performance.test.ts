import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  offlineStore,
  openEncryptedDatabase,
  withStatementCache,
  type OfflineStore,
  type SqliteDatabase,
} from '../../electron/offline/database';
import { coalescedNotifier } from '../../electron/offline/notify';
import type { ServerApi, UploadOutcome } from '../../electron/offline/server';
import {
  SYNCED_SALE_RETENTION_MS,
  offlineBillingService,
  type OfflineBillingService,
  type OfflineLogEvent,
} from '../../electron/offline/service';

type CatalogPage = Awaited<ReturnType<ServerApi['catalogPage']>>;
const DEVICE = 'abcdef0123456789abcdef0123456789';
let directory: string, db: SqliteDatabase, store: OfflineStore;
let clock: { wall: number; mono: number }, net: boolean;
let pages: (after: string) => Promise<CatalogPage> | CatalogPage;
let respond: () => UploadOutcome, logs: OfflineLogEvent[];

const product = (id: string, stock = 5, price = '100') => ({
  id,
  name: `Product ${id}`,
  barcode: `B${id}`,
  price,
  stock,
});
function service(): OfflineBillingService {
  const server: ServerApi = {
    reachable: async () => net,
    session: async () => ({
      user: { id: '5', name: 'Manager', role: 4, userType: 2, storeIds: ['12'] },
      sessionExpiresAt: clock.wall + 8 * 3600_000,
    }),
    checkIn: async () => ({ storeId: '12', counterId: '3', expiresAt: clock.wall + 8 * 3600_000 }),
    settings: async () => ({ maxMinutes: 120, maxOrders: 10 }),
    stores: async () => [{ id: '12', name: 'Bandra' }],
    counters: async () => [{ id: '3', name: 'Counter 3' }],
    catalogPage: async (_trace, _store, after) => pages(after),
    salespeople: async () => [{ id: '4401', name: 'Riya' }],
    upload: async () => respond(),
  };
  return offlineBillingService({
    store,
    server,
    deviceId: DEVICE,
    now: () => clock.wall,
    mono: () => clock.mono,
    netOnline: () => net,
    hasSessionCookie: async () => true,
    log: (event) => void logs.push(event),
    changed: vi.fn(),
  });
}
const sale = (lines: { productId: string; quantity: number }[], reference?: string) => ({
  saleId: randomUUID(),
  storeId: '12',
  counterId: '3',
  lines,
  salespersonId: '4401',
  tender: reference
    ? { mode: 'card' as const, reference }
    : { mode: 'cash' as const, receivedPaise: 1_000_000 },
});
const changes = () => db.prepare('SELECT total_changes() AS n').get() as { n: number };
async function goOffline(billing: OfflineBillingService) {
  await billing.heartbeat(randomUUID());
  net = false;
  await billing.heartbeat(randomUUID());
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pos-offline-perf-'));
  db = openEncryptedDatabase(Database, join(directory, 'offline.db'), randomBytes(32));
  store = offlineStore(db);
  clock = { wall: Date.UTC(2026, 10, 20, 9), mono: 1000 };
  net = true;
  logs = [];
  pages = () => ({ data: [product('1001'), product('1002')], nextCursor: null });
  respond = () => ({ kind: 'synced', orderId: '9001', invoiceNumber: 'INV1' });
});
afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe('desktop offline billing performance', () => {
  it('reads the status without writing, while the limit window still advances', async () => {
    const billing = service();
    await goOffline(billing);
    const stored = store.window()!;
    clock.mono += 30 * 60_000;
    clock.wall += 30 * 60_000;
    const before = changes().n;
    for (let index = 0; index < 5; index++)
      expect((await billing.status()).limits.minutesUsed).toBe(30);
    expect(changes().n).toBe(before);
    expect(store.window()).toEqual(stored);
    // Only the minute tick (and a sale decision) persists the window.
    billing.tick();
    expect(store.window()!.elapsedMs).toBe(stored.elapsedMs + 30 * 60_000);
  });

  it('stages a catalogue refresh page by page and swaps it in at once', async () => {
    const billing = service();
    await billing.heartbeat(randomUUID());
    expect(store.catalogInfo()).toMatchObject({ products: 2, truncated: false });
    // Sell one 1001 offline: the local decrement survives the refresh.
    net = false;
    await billing.heartbeat(randomUUID());
    await billing.createSale(sale([{ productId: '1001', quantity: 2 }]), randomUUID());
    net = true;
    respond = () => ({ kind: 'retry', code: 'NETWORK_UNAVAILABLE' });
    await billing.heartbeat(randomUUID());

    let release!: () => void;
    const paused = new Promise<void>((resolve) => (release = resolve));
    let reachedSecondPage!: () => void;
    const secondPage = new Promise<void>((resolve) => (reachedSecondPage = resolve));
    pages = async (after) => {
      if (after === '0') return { data: [product('1001', 9, '120')], nextCursor: '1001' };
      reachedSecondPage();
      await paused;
      return { data: [product('1003', 4)], nextCursor: null };
    };
    const refresh = billing.refreshCatalog(randomUUID());
    await secondPage;
    // Mid-refresh, readers still see the whole old catalogue (1002 included, old price).
    expect(store.product('12', '1002')).not.toBeNull();
    expect(store.product('12', '1001')).toMatchObject({ unitPricePaise: 10000, stock: 3 });
    expect(store.product('12', '1003')).toBeNull();
    expect(store.catalogInfo()?.products).toBe(2);
    release();
    expect(await refresh).toBe(2);
    expect(store.product('12', '1002')).toBeNull();
    expect(store.product('12', '1001')).toMatchObject({ unitPricePaise: 12000, stock: 7 });
    expect(store.byBarcode('12', 'B1003')).toMatchObject({ productId: '1003' });
    expect(store.catalogInfo()).toMatchObject({ products: 2, truncated: false });
    // The stage is released after the swap.
    expect(
      db.prepare("SELECT count(*) AS n FROM temp.sqlite_master WHERE name = 'catalog_stage'").get(),
    ).toEqual({ n: 0 });
  });

  it('keeps the old catalogue when a refresh fails part-way', async () => {
    const billing = service();
    await billing.heartbeat(randomUUID());
    pages = (after) => {
      if (after === '0') return { data: [product('1009')], nextCursor: '1009' };
      throw new Error('network');
    };
    await expect(billing.refreshCatalog(randomUUID())).rejects.toThrow('network');
    expect(store.product('12', '1001')).not.toBeNull();
    expect(store.product('12', '1009')).toBeNull();
    // A later refresh starts from an empty stage.
    pages = () => ({ data: [product('1004')], nextCursor: null });
    expect(await billing.refreshCatalog(randomUUID())).toBe(1);
    expect(store.product('12', '1009')).toBeNull();
  });

  it('flags and logs a catalogue cut off at the page cap', async () => {
    const billing = service();
    await billing.heartbeat(randomUUID());
    pages = (after) => {
      const next = String(Number(after) + 1);
      return { data: [product(next)], nextCursor: next };
    };
    expect(await billing.refreshCatalog(randomUUID())).toBe(2000);
    expect(logs).toContainEqual(
      expect.objectContaining({
        eventId: 'offline.catalog.truncated',
        errorCode: 'CATALOG_PAGE_CAP',
      }),
    );
    expect((await billing.status()).catalog).toMatchObject({ products: 2000, truncated: true });
  });

  it('lists sales with their lines and conflicts in batched reads', async () => {
    const billing = service();
    await goOffline(billing);
    await billing.createSale(
      sale([
        { productId: '1001', quantity: 1 },
        { productId: '1002', quantity: 2 },
      ]),
      randomUUID(),
    );
    await billing.createSale(sale([{ productId: '1002', quantity: 1 }], 'RRN12345'), randomUUID());
    respond = () => ({ kind: 'conflict', code: 'PRICE_CHANGED', message: 'Price changed.' });
    net = true;
    await billing.heartbeat(randomUUID());
    const listed = billing.list({ limit: 10 });
    expect(listed).toHaveLength(2);
    for (const entry of listed) {
      const { nextAttemptAt: _next, ...single } = store.sale(entry.saleId)!;
      expect(entry).toEqual(single);
    }
    expect(listed[1]!.lines.map((line) => line.productId)).toEqual(['1001', '1002']);
    expect(listed.every((entry) => entry.conflict?.code === 'PRICE_CHANGED')).toBe(true);
  });

  it('prunes only old synced sales, with their card/UPI references', async () => {
    const billing = service();
    await goOffline(billing);
    const old = await billing.createSale(sale([{ productId: '1001', quantity: 1 }], 'RRNOLD1'), '');
    net = true;
    await billing.heartbeat(randomUUID());
    expect(billing.reprint(old.sale.saleId).status).toBe('synced');
    // An old sale that still needs a manager is never pruned.
    net = false;
    await billing.heartbeat(randomUUID());
    const held = await billing.createSale(
      sale([{ productId: '1002', quantity: 1 }], 'RRNHELD'),
      '',
    );
    respond = () => ({ kind: 'conflict', code: 'STOCK_SHORTFALL', message: 'Short.' });
    net = true;
    await billing.heartbeat(randomUUID());
    clock.wall += SYNCED_SALE_RETENTION_MS - 1000;
    expect(billing.pruneSynced()).toBe(0);
    clock.wall += 2000;
    expect(billing.pruneSynced()).toBe(1);
    expect(store.sale(old.sale.saleId)).toBeNull();
    const references = db.prepare('SELECT reference FROM payments').all();
    expect(references).toEqual([{ reference: 'RRNHELD' }]);
    expect(
      db.prepare('SELECT count(*) AS n FROM sale_lines WHERE sale_id = ?').get(old.sale.saleId),
    ).toEqual({ n: 0 });
    expect(store.sale(held.sale.saleId)?.status).toBe('needs_manager');
    expect(logs).toContainEqual(
      expect.objectContaining({ eventId: 'offline.sales.pruned', count: 1 }),
    );
  });

  it('compiles each statement once per connection', () => {
    const cached = withStatementCache(db);
    const first = cached.prepare('SELECT 1 AS one');
    expect(cached.prepare('SELECT 1 AS one')).toBe(first);
    expect(cached.prepare('SELECT 2 AS two')).not.toBe(first);
    // Other members still work against the real connection.
    expect(cached.transaction(() => cached.prepare('SELECT 1 AS one').get())()).toEqual({ one: 1 });
    expect(cached.open).toBe(true);
  });
});

describe('status push coalescing', () => {
  it('turns a burst of changes into one push', () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const pushes = coalescedNotifier(send, 150);
      for (let index = 0; index < 10; index++) pushes.notify();
      expect(send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(150);
      expect(send).toHaveBeenCalledTimes(1);
      pushes.notify();
      pushes.cancel();
      vi.advanceTimersByTime(1000);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
