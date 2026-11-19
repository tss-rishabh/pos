import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  offlineStore,
  openEncryptedDatabase,
  type SqliteDatabase,
} from '../../electron/offline/database';
import type { ServerApi, UploadOutcome } from '../../electron/offline/server';
import { offlineBillingService, type OfflineBillingService } from '../../electron/offline/service';
import type { OfflineSaleUpload } from '../../src/offline/billing/sync-contract';

const DEVICE = 'abcdef0123456789abcdef0123456789';
let directory: string, db: SqliteDatabase, clock: { wall: number; mono: number }, net: boolean;
let uploads: OfflineSaleUpload[], respond: (sale: OfflineSaleUpload) => UploadOutcome;
let operator: { id: string; role: number };

function fakeServer(): ServerApi {
  return {
    reachable: async () => net,
    session: async () => ({
      user: {
        id: operator.id,
        name: 'Cashier',
        role: operator.role,
        userType: 2,
        storeIds: ['12'],
      },
      sessionExpiresAt: clock.wall + 8 * 3600_000,
    }),
    checkIn: async () => ({ storeId: '12', counterId: '3', expiresAt: clock.wall + 8 * 3600_000 }),
    settings: async () => ({ maxMinutes: 120, maxOrders: 3 }),
    stores: async () => [{ id: '12', name: 'Bandra Flagship' }],
    counters: async () => [{ id: '3', name: 'Counter 3' }],
    catalogPage: async () => ({
      data: [
        { id: '1001', name: 'Tee', barcode: '8901', price: '499.50', stock: 5 },
        { id: '1002', name: 'Cap', barcode: '8902', price: '299', stock: 1 },
      ],
      nextCursor: null,
    }),
    salespeople: async () => [{ id: '4401', name: 'Riya' }],
    upload: async (_trace, _operator, _store, _counter, sale) => {
      uploads.push(sale);
      return respond(sale);
    },
  };
}
function service(): OfflineBillingService {
  return offlineBillingService({
    store: offlineStore(db),
    server: fakeServer(),
    deviceId: DEVICE,
    now: () => clock.wall,
    mono: () => clock.mono,
    netOnline: () => net,
    hasSessionCookie: async () => true,
    log: vi.fn(),
    changed: vi.fn(),
  });
}
const sale = (lines = [{ productId: '1001', quantity: 2 }]) => ({
  saleId: randomUUID(),
  storeId: '12',
  counterId: '3',
  lines,
  salespersonId: '4401',
  tender: { mode: 'cash' as const, receivedPaise: 100000 },
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pos-offline-sync-'));
  db = openEncryptedDatabase(Database, join(directory, 'offline.db'), randomBytes(32));
  clock = { wall: Date.UTC(2026, 10, 19, 9), mono: 1000 };
  net = true;
  uploads = [];
  operator = { id: '77', role: 5 };
  respond = (upload) => ({
    kind: 'synced',
    orderId: String(9000 + uploads.length),
    invoiceNumber: `INV${upload.saleId.slice(0, 4)}`,
  });
});
afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe('device offline billing and sync', () => {
  it('bills offline from the cached catalogue, then syncs oldest-first with provisional references', async () => {
    const billing = service();
    await billing.heartbeat(randomUUID());
    net = false;
    await billing.heartbeat(randomUUID());
    const first = await billing.createSale(sale(), randomUUID());
    expect(first.sale.provisionalRef).toBe('OFF-12-3-ABCDEF01-1');
    expect(first.sale).toMatchObject({
      grossPaise: 99900,
      roundingPaise: 0,
      payablePaise: 99900,
      status: 'queued',
    });
    expect(first.receipt.provisionalNotice).toBe('Provisional — final invoice issued on sync');
    expect(first.receipt).toMatchObject({ storeName: 'Bandra Flagship', counterName: 'Counter 3' });
    const second = await billing.createSale(
      sale([{ productId: '1002', quantity: 1 }]),
      randomUUID(),
    );
    expect(second.sale.provisionalRef).toBe('OFF-12-3-ABCDEF01-2');
    // Cached stock was decremented locally.
    await expect(
      billing.createSale(sale([{ productId: '1002', quantity: 1 }]), randomUUID()),
    ).rejects.toMatchObject({ code: 'STOCK_UNAVAILABLE' });
    // Retrying the same saleId is idempotent on the device.
    const replay = await billing.createSale({ ...sale(), saleId: first.sale.saleId }, randomUUID());
    expect(replay.sale.provisionalRef).toBe(first.sale.provisionalRef);

    net = true;
    await billing.heartbeat(randomUUID());
    expect(uploads.map((upload) => upload.provisionalRef)).toEqual([
      'OFF-12-3-ABCDEF01-1',
      'OFF-12-3-ABCDEF01-2',
    ]);
    expect(uploads[0]).toMatchObject({
      billedBy: '77',
      payable: '999.00',
      lines: [{ productId: '1001', quantity: 2, unitPrice: '499.50' }],
      tender: { mode: 'cash', received: '1000.00' },
      resolution: null,
    });
    const reprint = billing.reprint(first.sale.saleId);
    expect(reprint).toMatchObject({
      status: 'synced',
      orderId: '9001',
      invoiceNumber: expect.any(String),
    });
    expect(reprint.heading).toContain('Invoice');
    expect((await billing.status()).queue).toMatchObject({ queued: 0, synced: 2 });
  });

  it('enforces the configured order limit until every queued sale has synced', async () => {
    const billing = service();
    await billing.heartbeat(randomUUID());
    net = false;
    await billing.heartbeat(randomUUID());
    for (let index = 0; index < 3; index++)
      await billing.createSale(sale([{ productId: '1001', quantity: 1 }]), randomUUID());
    await expect(
      billing.createSale(sale([{ productId: '1001', quantity: 1 }]), randomUUID()),
    ).rejects.toMatchObject({
      code: 'ORDER_LIMIT',
    });
    expect(billing.list({ limit: 50 })).toHaveLength(3);
    net = true;
    await billing.heartbeat(randomUUID());
    expect((await billing.status()).limits).toMatchObject({ allowed: true, ordersUsed: 0 });
  });

  it('refuses offline billing while the store service is reachable', async () => {
    const billing = service();
    await billing.heartbeat(randomUUID());
    await expect(billing.createSale(sale(), randomUUID())).rejects.toMatchObject({
      code: 'ONLINE_BILLING_REQUIRED',
    });
  });

  it('keeps conflicts on the device for a manager, then resyncs the resolution', async () => {
    const billing = service();
    await billing.heartbeat(randomUUID());
    net = false;
    await billing.heartbeat(randomUUID());
    const created = await billing.createSale(
      { ...sale(), tender: { mode: 'card', reference: 'RRN12345' } },
      randomUUID(),
    );
    respond = () => ({
      kind: 'conflict',
      code: 'TENDER_REFERENCE_NOT_FOUND',
      message: 'Reference not found.',
    });
    net = true;
    await billing.heartbeat(randomUUID());
    const conflicted = billing.list({ limit: 10 })[0]!;
    expect(conflicted).toMatchObject({
      status: 'needs_manager',
      conflict: { code: 'TENDER_REFERENCE_NOT_FOUND' },
    });
    // Conflicted sales still count against the offline limit.
    expect((await billing.status()).limits.ordersUsed).toBe(1);

    const resolution = {
      saleId: created.sale.saleId,
      action: 'correct-tender' as const,
      reason: 'Slip shows a different RRN',
      tender: { mode: 'card' as const, reference: 'RRN99999' },
    };
    await expect(billing.resolve(resolution, randomUUID())).rejects.toMatchObject({
      code: 'MANAGER_REQUIRED',
    });
    operator = { id: '5', role: 4 };
    await billing.heartbeat(randomUUID());
    respond = (upload) => ({
      kind: 'synced',
      orderId: '9100',
      invoiceNumber: upload.resolution ? 'INV9100' : null,
    });
    const resolved = await billing.resolve(resolution, randomUUID());
    expect(resolved.resolution).toMatchObject({ action: 'correct-tender', managerId: '5' });
    await vi.waitFor(() => expect(billing.reprint(created.sale.saleId).status).toBe('synced'));
    expect(uploads.at(-1)).toMatchObject({
      tender: { mode: 'card', reference: 'RRN99999' },
      resolution: { action: 'correct-tender', managerId: '5' },
    });
  });

  it('never resends a sale whose server outcome is unknown', async () => {
    const billing = service();
    await billing.heartbeat(randomUUID());
    net = false;
    await billing.heartbeat(randomUUID());
    await billing.createSale(sale(), randomUUID());
    respond = () => ({ kind: 'conflict', code: 'OUTCOME_UNKNOWN', message: 'Check Orders.' });
    net = true;
    await billing.heartbeat(randomUUID());
    clock.wall += 600_000;
    await billing.heartbeat(randomUUID());
    expect(uploads).toHaveLength(1);
    expect(billing.list({ limit: 10 })[0]).toMatchObject({
      status: 'needs_manager',
      conflict: { code: 'OUTCOME_UNKNOWN' },
    });
  });

  it('retries transient failures and never drops a sale', async () => {
    const billing = service();
    await billing.heartbeat(randomUUID());
    net = false;
    await billing.heartbeat(randomUUID());
    await billing.createSale(sale(), randomUUID());
    respond = () => ({ kind: 'retry', code: 'NETWORK_UNAVAILABLE' });
    net = true;
    await billing.heartbeat(randomUUID());
    expect(billing.list({ limit: 10 })[0]).toMatchObject({ status: 'queued', attempts: 1 });
    respond = () => ({ kind: 'synced', orderId: '9200', invoiceNumber: 'INV1' });
    clock.wall += 60_000;
    await billing.heartbeat(randomUUID());
    expect(billing.list({ limit: 10 })[0]).toMatchObject({ status: 'synced', orderId: '9200' });
  });

  it('expires the window when the clock is set back', async () => {
    const billing = service();
    await billing.heartbeat(randomUUID());
    net = false;
    await billing.heartbeat(randomUUID());
    clock.mono += 10 * 60_000;
    clock.wall -= 60 * 60_000;
    await expect(billing.createSale(sale(), randomUUID())).rejects.toMatchObject({
      code: 'CLOCK_INCONSISTENT',
    });
  });
});
