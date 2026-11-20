import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  offlineStore,
  openEncryptedDatabase,
  type SqliteDatabase,
} from '../../electron/offline/database';
import type { ServerApi, UploadOutcome } from '../../electron/offline/server';
import { offlineBillingService, type OfflineLogEvent } from '../../electron/offline/service';
import { callRequestId } from '../../electron/offline/request-id';

/** Workstream D: sync failures are logged (codes only) under per-call request IDs. */
let directory: string, db: SqliteDatabase, net: boolean, wall: number;
let calls: { step: string; requestId: string }[], logs: OfflineLogEvent[];
let respond: () => UploadOutcome, failCheckIn: boolean;

function server(): ServerApi {
  const record = (step: string, requestId: string) => void calls.push({ step, requestId });
  return {
    reachable: async (id) => (record('reachable', id), net),
    session: async (id) => (
      record('session', id),
      {
        user: { id: '77', name: 'Cashier 9876543210', role: 5, userType: 2, storeIds: ['12'] },
        sessionExpiresAt: wall + 8 * 3600_000,
      }
    ),
    checkIn: async (id) => {
      record('check-in', id);
      if (failCheckIn) throw new TypeError('customer 9876543210 leaked');
      return { storeId: '12', counterId: '3', expiresAt: wall + 8 * 3600_000 };
    },
    settings: async (id) => (record('settings', id), { maxMinutes: 120, maxOrders: 3 }),
    stores: async (id) => (record('stores', id), [{ id: '12', name: 'Store' }]),
    counters: async (id) => (record('counters', id), [{ id: '3', name: 'Counter 3' }]),
    catalogPage: async (id) => (
      record('catalog', id),
      {
        data: [{ id: '1001', name: 'Tee', barcode: '8901', price: '499', stock: 5 }],
        nextCursor: null,
      }
    ),
    salespeople: async (id) => (record('salespeople', id), [{ id: '4401', name: 'Riya' }]),
    upload: async (id) => (record('upload', id), respond()),
  };
}
function billing() {
  return offlineBillingService({
    store: offlineStore(db),
    server: server(),
    deviceId: 'abcdef0123456789abcdef0123456789',
    now: () => wall,
    mono: () => wall,
    netOnline: () => net,
    hasSessionCookie: async () => true,
    log: (event) => void logs.push(event),
    changed: () => undefined,
  });
}
async function queueOneSale(service: ReturnType<typeof billing>) {
  await service.heartbeat(randomUUID());
  net = false;
  await service.heartbeat(randomUUID());
  const saleId = randomUUID();
  await service.createSale(
    {
      saleId,
      storeId: '12',
      counterId: '3',
      lines: [{ productId: '1001', quantity: 1 }],
      salespersonId: '4401',
      tender: { mode: 'cash', receivedPaise: 49900 },
    },
    randomUUID(),
  );
  net = true;
  calls = [];
  logs = [];
  return saleId;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pos-sync-logging-'));
  db = openEncryptedDatabase(Database, join(directory, 'offline.db'), randomBytes(32));
  net = true;
  wall = Date.UTC(2026, 10, 20, 9);
  calls = [];
  logs = [];
  failCheckIn = false;
  respond = () => ({ kind: 'synced', orderId: '9001', invoiceNumber: 'INV1' });
});
afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe('offline sync logging and request IDs', () => {
  it('sends a distinct request ID per HTTP call, derived from the heartbeat trace', async () => {
    const service = billing();
    const saleId = await queueOneSale(service);
    const trace = randomUUID();
    await service.heartbeat(trace);
    const ids = calls.map((call) => call.requestId);
    expect(ids).not.toContain(trace);
    expect(new Set(ids).size).toBe(ids.length);
    const upload = calls.find((call) => call.step === 'upload')!;
    expect(upload.requestId).toBe(callRequestId(trace, `upload:${saleId}`));
    expect(logs).toContainEqual(
      expect.objectContaining({
        eventId: 'offline.sale.synced',
        traceId: trace,
        requestId: upload.requestId,
      }),
    );
  });
  it('logs conflicts and deferred uploads with their code', async () => {
    const service = billing();
    await queueOneSale(service);
    respond = () => ({ kind: 'retry', code: 'NETWORK_UNAVAILABLE' });
    await service.heartbeat(randomUUID());
    expect(logs).toContainEqual(
      expect.objectContaining({
        eventId: 'offline.sale.retry-scheduled',
        errorCode: 'NETWORK_UNAVAILABLE',
      }),
    );
    respond = () => ({ kind: 'conflict', code: 'OUTCOME_UNKNOWN', message: 'Check Orders.' });
    wall += 600_000;
    await service.heartbeat(randomUUID());
    expect(logs).toContainEqual(
      expect.objectContaining({ eventId: 'offline.sale.conflict', errorCode: 'OUTCOME_UNKNOWN' }),
    );
  });
  it('logs a failed heartbeat step by error class name, never its message', async () => {
    const service = billing();
    failCheckIn = true;
    const trace = randomUUID();
    await service.heartbeat(trace);
    expect(logs).toContainEqual(
      expect.objectContaining({
        eventId: 'offline.check-in.read-failed',
        traceId: trace,
        requestId: callRequestId(trace, 'check-in'),
        errorName: 'TypeError',
      }),
    );
    expect(JSON.stringify(logs)).not.toContain('9876543210');
  });
});
