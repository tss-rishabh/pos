import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlineCashFixture } from '../../backend/tests/checkout/offline-cash-fixtures';
import { setRequestOperator } from '../src/api/client';
import type { Principal } from '../src/api/types';
import { PosDatabase } from '../src/offline/database';
import { createCashDeviceKeys, signCashReceipt } from '../src/offline/cash/crypto';
import {
  cashReceiptAcceptanceSchema,
  type CashReceiptAcceptance,
} from '../src/offline/cash/contracts';
import type { CashOrderImportRequest } from '../src/offline/cash/client';
import type { LocalCashReceipt } from '../src/offline/cash/storage-types';
import { refreshOfflineCash, refreshOfflineCashReceipt } from '../src/offline/cash/sync';
import {
  retryOfflineCashOrderImport,
  startOfflineCashOrderImport,
  startOfflineCashOrderImports,
} from '../src/offline/cash/order-import';

describe('owner offline cash order import and exact-intent recovery', () => {
  const fixture = offlineCashFixture(),
    owner: Principal = {
      id: '44',
      role: 5,
      userType: 1,
      name: 'Fixture cashier',
      email: 'cashier@example.test',
      storeIds: ['1'],
    },
    storage = new Map<string, string>();
  let database: PosDatabase,
    peer: PosDatabase | undefined,
    controller: AbortController,
    receipt: LocalCashReceipt,
    server: CashReceiptAcceptance,
    now: number,
    reads: number,
    requests: CashOrderImportRequest[];

  const detail = () => ({
    ...server,
    envelope: receipt.envelope,
    authorizationWindow: {
      issuedAt: fixture.authorization.issuedAt,
      expiresAt: fixture.authorization.expiresAt,
      businessDate: fixture.authorization.businessDate,
      timeZone: 'Asia/Kolkata',
    },
    auditEvents: [],
    activeApproval: null,
  });
  const read = async () => {
    reads++;
    return detail();
  };
  const imported = (): CashReceiptAcceptance => ({
    ...server,
    status: 'imported',
    conflicts: [],
    orderId: '9007199254740993',
    importedAt: now + 1000,
    version: server.version + 1,
  });
  const options = () => ({ database, signal: controller.signal, clock: () => now, read });
  async function restart() {
    peer?.close();
    peer = undefined;
    const name = database.name;
    database.close();
    database = new PosDatabase(name);
  }
  const start = (send: NonNullable<Parameters<typeof startOfflineCashOrderImport>[3]>['send']) =>
    startOfflineCashOrderImport(owner, '1', receipt.receiptId, { ...options(), send });

  beforeEach(async () => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    setRequestOperator(owner.id);
    controller = new AbortController();
    reads = 0;
    requests = [];
    now = fixture.receipt.completedAt + 1000;
    database = new PosDatabase('offline-cash-import-' + crypto.randomUUID());
    await database.sessions.add({ id: 'current', user: owner, expiresAt: now + 7200000 });
    const keys = await createCashDeviceKeys();
    receipt = {
      ownerId: owner.id,
      receiptId: fixture.receipt.id,
      draftId: fixture.receipt.draftId,
      storeId: '1',
      counterId: '2',
      authorizationId: fixture.authorization.id,
      sequence: fixture.receipt.sequence,
      completedAt: fixture.receipt.completedAt,
      envelope: await signCashReceipt(fixture.receipt, keys.privateKey),
      acceptance: null,
      syncState: 'accepted',
      importedAt: null,
      preservedDraftId: null,
      replacementDraftId: crypto.randomUUID(),
    };
    server = cashReceiptAcceptanceSchema.parse({
      receiptId: receipt.receiptId,
      receiptNumber: fixture.receipt.receiptNumber,
      operatorId: owner.id,
      storeId: '1',
      counterId: '2',
      businessDate: fixture.receipt.businessDate,
      completedAt: fixture.receipt.completedAt,
      acceptedAt: now,
      importedAt: null,
      payableCents: fixture.receipt.payableCents,
      cashReceivedCents: fixture.receipt.cashReceivedCents,
      changeCents: fixture.receipt.changeCents,
      status: 'accepted',
      conflicts: [],
      orderId: null,
      version: 1,
    });
    receipt.acceptance = server;
    await database.offlineCashReceipts.add(receipt);
    // A V5 row from an older build deliberately has no optional import metadata.
    await database.offlineCashSync.add({
      receiptId: receipt.receiptId,
      ownerId: owner.id,
      storeId: '1',
      state: 'accepted',
      attempts: 1,
      nextAttemptAt: now,
      claimId: null,
      claimedAt: null,
      errorCode: null,
    });
  });
  afterEach(async () => {
    peer?.close();
    peer = undefined;
    database.close();
    await database.delete();
    setRequestOperator(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('claims20 concurrent tabs once, saves the intent before POST, and preserves immutable cash after restart', async () => {
    peer = new PosDatabase(database.name);
    const send = async (
      actor: string,
      store: string,
      id: string,
      input: CashOrderImportRequest,
    ) => {
      requests.push(input);
      expect([actor, store, id]).toEqual([owner.id, '1', receipt.receiptId]);
      expect((await peer!.offlineCashSync.get(id))?.orderImport).toMatchObject({
        operationId: input.operationId,
        expectedVersion: 1,
        actorId: owner.id,
        state: 'dispatching',
        attempts: 1,
      });
      server = imported();
      return server;
    };
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        startOfflineCashOrderImports(owner, '1', {
          ...options(),
          database: index % 2 ? peer : database,
          send,
        }),
      ),
    );
    expect(requests).toHaveLength(1);
    await restart();
    expect((await database.offlineCashSync.get(receipt.receiptId))?.orderImport).toMatchObject({
      operationId: requests[0]!.operationId,
      expectedVersion: 1,
      state: 'confirmed',
      attempts: 1,
      attemptId: null,
    });
    expect((await database.offlineCashReceipts.toArray())[0]).toMatchObject({
      envelope: receipt.envelope,
      syncState: 'imported',
      acceptance: { payableCents: fixture.receipt.payableCents, orderId: '9007199254740993' },
    });
    expect(await database.offlineCashReceipts.count()).toBe(1);
    expect(await database.completedSales.count()).toBe(0);
    expect(await database.drafts.count()).toBe(0);
  });

  it('proves a lost committed response using GET after restart and never repeats its import', async () => {
    const send = async (
      _actor: string,
      _store: string,
      _id: string,
      input: CashOrderImportRequest,
    ) => {
      requests.push(input);
      server = imported();
      throw new Error('Fixture response lost after its atomic import committed');
    };
    await expect(start(send)).rejects.toThrow('response lost');
    expect((await database.offlineCashSync.get(receipt.receiptId))?.orderImport?.state).toBe(
      'uncertain',
    );
    await restart();
    await startOfflineCashOrderImports(owner, '1', { ...options(), send });
    await refreshOfflineCash(owner, '1', options());
    await retryOfflineCashOrderImport(owner, '1', receipt.receiptId, { ...options(), send });
    expect(requests).toHaveLength(1);
    expect(
      (await database.offlineCashReceipts.get([owner.id, receipt.receiptId]))?.envelope,
    ).toEqual(receipt.envelope);
    expect((await database.offlineCashSync.get(receipt.receiptId))?.orderImport?.state).toBe(
      'confirmed',
    );
  });

  it('keeps an uncommitted result uncertain across30 syncs and retries exactly the saved intent only on explicit action', async () => {
    const send = async (
      _actor: string,
      _store: string,
      _id: string,
      input: CashOrderImportRequest,
    ) => {
      requests.push(input);
      if (requests.length === 1) throw new Error('Fixture connection interrupted before import');
      server = imported();
      return server;
    };
    await expect(start(send)).rejects.toThrow('interrupted');
    await restart();
    for (let tick = 0; tick < 30; tick++) {
      now += 30000;
      await refreshOfflineCash(owner, '1', options());
      await startOfflineCashOrderImports(owner, '1', { ...options(), send });
    }
    expect(requests).toHaveLength(1);
    expect((await database.offlineCashReceipts.get([owner.id, receipt.receiptId]))?.syncState).toBe(
      'accepted',
    );
    const readsBeforeRetry = reads;
    await retryOfflineCashOrderImport(owner, '1', receipt.receiptId, { ...options(), send });
    expect(reads).toBeGreaterThan(readsBeforeRetry);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect((await database.offlineCashSync.get(receipt.receiptId))?.orderImport).toMatchObject({
      state: 'confirmed',
      attempts: 2,
    });
  });

  it('retains an interrupted dispatch claim and fences simultaneous exact retries across tabs', async () => {
    const send = async (
      _actor: string,
      _store: string,
      _id: string,
      input: CashOrderImportRequest,
    ) => {
      requests.push(input);
      if (requests.length === 1) {
        controller.abort();
        throw new DOMException('Fixture tab closed during its request', 'AbortError');
      }
      server = imported();
      return server;
    };
    await start(send);
    await restart();
    controller = new AbortController();
    await startOfflineCashOrderImports(owner, '1', { ...options(), send });
    await expect(
      retryOfflineCashOrderImport(owner, '1', receipt.receiptId, { ...options(), send }),
    ).rejects.toThrow('still in progress');
    expect(requests).toHaveLength(1);
    now += 31000;
    peer = new PosDatabase(database.name);
    await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        retryOfflineCashOrderImport(owner, '1', receipt.receiptId, {
          ...options(),
          database: index % 2 ? peer : database,
          send,
        }),
      ),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect((await database.offlineCashSync.get(receipt.receiptId))?.orderImport?.state).toBe(
      'confirmed',
    );
  });

  it('does not send an import if storage cannot durably record its intent', async () => {
    const failClaim = (changes: object) => {
      if ('orderImport' in changes) throw new Error('Fixture full storage during intent commit');
    };
    database.offlineCashSync.hook('updating', failClaim);
    const send = async (
      _actor: string,
      _store: string,
      _id: string,
      input: CashOrderImportRequest,
    ) => {
      requests.push(input);
      server = imported();
      return server;
    };
    await expect(start(send)).rejects.toThrow('full storage');
    expect(requests).toEqual([]);
    expect((await database.offlineCashSync.get(receipt.receiptId))?.orderImport).toBeUndefined();
    expect(
      (await database.offlineCashReceipts.get([owner.id, receipt.receiptId]))?.envelope,
    ).toEqual(receipt.envelope);
    database.offlineCashSync.hook('updating').unsubscribe(failClaim);
    await start(send);
    expect(requests).toHaveLength(1);
  });

  it('does not automatically import another cashier receipt after manager handoff', async () => {
    const manager = { ...owner, id: '46', role: 4 as const };
    await database.sessions.put({ id: 'current', user: manager, expiresAt: now + 60000 });
    const send = vi.fn();
    await startOfflineCashOrderImports(manager, '1', { ...options(), send });
    await startOfflineCashOrderImport(manager, '1', receipt.receiptId, { ...options(), send });
    expect(reads).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await database.offlineCashSync.get(receipt.receiptId))?.orderImport).toBeUndefined();
  });

  it('keeps initial and newly discovered conflicts manager-only without creating a replacement attempt', async () => {
    const send = async (
      _actor: string,
      _store: string,
      _id: string,
      input: CashOrderImportRequest,
    ) => {
      requests.push(input);
      throw new Error('Fixture request outcome unconfirmed');
    };
    await expect(start(send)).rejects.toThrow('unconfirmed');
    const original = (await database.offlineCashSync.get(receipt.receiptId))!.orderImport!;
    server = { ...server, status: 'conflicted', conflicts: ['stock-shortage'], version: 2 };
    await expect(
      retryOfflineCashOrderImport(owner, '1', receipt.receiptId, { ...options(), send }),
    ).rejects.toThrow('manager review');
    expect((await database.offlineCashSync.get(receipt.receiptId))?.orderImport).toMatchObject({
      state: 'blocked',
      operationId: original.operationId,
      expectedVersion: 1,
    });
    // A later review/version change cannot silently grant this cashier a new intent.
    server = { ...server, status: 'accepted', conflicts: [], version: 3 };
    await startOfflineCashOrderImports(owner, '1', { ...options(), send });
    await expect(
      retryOfflineCashOrderImport(owner, '1', receipt.receiptId, { ...options(), send }),
    ).rejects.toThrow('manager review');
    expect(requests).toHaveLength(1);
    expect(
      (await database.offlineCashReceipts.get([owner.id, receipt.receiptId]))?.envelope,
    ).toEqual(receipt.envelope);
  });

  it('retains a new stock conflict as recorded cash and never posts any automatic import for it', async () => {
    server = { ...server, status: 'conflicted', conflicts: ['stock-shortage'], version: 2 };
    const send = vi.fn();
    await startOfflineCashOrderImports(owner, '1', { ...options(), send });
    await startOfflineCashOrderImports(owner, '1', { ...options(), send });
    expect(send).not.toHaveBeenCalled();
    expect((await database.offlineCashSync.get(receipt.receiptId))?.autoImportEligible).toBe(false);
    expect((await database.offlineCashSync.get(receipt.receiptId))?.orderImport).toBeUndefined();
    expect((await database.offlineCashReceipts.get([owner.id, receipt.receiptId]))?.syncState).toBe(
      'conflicted',
    );
  });

  it('stops before claim on cached role, user type, full store scope, expiry or logout changes', async () => {
    const send = vi.fn();
    for (const changed of [
      { ...owner, role: 4 as const },
      { ...owner, userType: 2 as const },
      { ...owner, storeIds: ['1', '2'] },
      { ...owner, id: '45' },
    ]) {
      await database.sessions.put({ id: 'current', user: changed, expiresAt: now + 60000 });
      await start(send);
    }
    await database.sessions.put({ id: 'current', user: owner, expiresAt: now });
    await start(send);
    await database.sessions.put({ id: 'current', user: owner, expiresAt: now + 60000 });
    storage.set('pos-pending-logout', '1');
    await start(send);
    expect(reads).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await database.offlineCashSync.get(receipt.receiptId))?.orderImport).toBeUndefined();
  });

  it('keeps a committed import recoverable if the current actor changes during its response', async () => {
    const send = async (
      _actor: string,
      _store: string,
      _id: string,
      input: CashOrderImportRequest,
    ) => {
      requests.push(input);
      server = imported();
      setRequestOperator('45');
      return server;
    };
    await startOfflineCashOrderImport(owner, '1', receipt.receiptId, {
      database,
      clock: () => now,
      read,
      send,
    });
    expect((await database.offlineCashReceipts.get([owner.id, receipt.receiptId]))?.syncState).toBe(
      'accepted',
    );
    expect((await database.offlineCashSync.get(receipt.receiptId))?.orderImport?.state).toBe(
      'dispatching',
    );
    setRequestOperator(owner.id);
    await refreshOfflineCashReceipt(owner, '1', receipt.receiptId, options());
    expect((await database.offlineCashReceipts.get([owner.id, receipt.receiptId]))?.syncState).toBe(
      'imported',
    );
    expect(requests).toHaveLength(1);
    expect(await database.completedSales.count()).toBe(0);
  });

  it('rejects a response with changed cash without confirming its order or overwriting the receipt', async () => {
    await expect(
      start(async () => ({ ...imported(), payableCents: 1, changeCents: 49999 })),
    ).rejects.toThrow('immutable device receipt');
    expect((await database.offlineCashSync.get(receipt.receiptId))?.orderImport?.state).toBe(
      'uncertain',
    );
    expect(await database.offlineCashReceipts.get([owner.id, receipt.receiptId])).toMatchObject({
      envelope: receipt.envelope,
      importedAt: null,
      syncState: 'accepted',
    });
  });
});
