import 'fake-indexeddb/auto';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlineCashFixture } from '../../backend/tests/checkout/offline-cash-fixtures';
import {
  offlineCashSigner,
  verifyDeviceCashReceipt,
} from '../../backend/src/modules/checkout/offline-cash/crypto';
import { PosDatabase, type LocalDraft } from '../src/offline/database';
import { activateCashAuthorization, completeOfflineCash } from '../src/offline/cash/complete';
import { cashDigest, createCashDeviceKeys } from '../src/offline/cash/crypto';
import { prepareReview, bindReviewedCheckout } from '../src/offline/review-snapshot';
import { queueDraft } from '../src/offline/sync';
import { replayOfflineCash, refreshOfflineCashReceipt } from '../src/offline/cash/sync';
import { cashReceiptAcceptanceSchema } from '../src/offline/cash/contracts';
import type { LocalCashReceipt } from '../src/offline/cash/storage-types';

describe('durable offline cash completion', () => {
  let database: PosDatabase, candidate: LocalDraft, controller: AbortController;
  let fixture = offlineCashFixture(),
    now = 0;
  const storage = new Map<string, string>();
  const accepted = (value: LocalCashReceipt) =>
    cashReceiptAcceptanceSchema.parse({
      receiptId: value.receiptId,
      receiptNumber: value.envelope.receipt.receiptNumber,
      operatorId: '44',
      storeId: '1',
      counterId: '2',
      businessDate: value.envelope.receipt.businessDate,
      completedAt: value.completedAt,
      acceptedAt: now + 1000,
      importedAt: null,
      payableCents: value.envelope.receipt.payableCents,
      cashReceivedCents: value.envelope.receipt.cashReceivedCents,
      changeCents: value.envelope.receipt.changeCents,
      status: 'conflicted',
      conflicts: ['stock-shortage'],
      orderId: null,
      version: 1,
    });
  beforeEach(async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    storage.clear();
    controller = new AbortController();
    fixture = offlineCashFixture();
    now = fixture.snapshot.issuedAt + 1000;
    database = new PosDatabase('offline-cash-test-' + crypto.randomUUID());
    await database.sessions.put({
      id: 'current',
      user: {
        userType: 1,
        id: '44',
        name: 'Fixture operator',
        email: 'operator@example.com',
        role: 5,
        storeIds: ['1'],
      },
      expiresAt: fixture.authorization.expiresAt,
    });
    const device = await createCashDeviceKeys();
    fixture.authorization.deviceKeyHash = await cashDigest(device.publicKey);
    await database.offlineCashDevices.put({
      ownerId: '44',
      deviceId: fixture.authorization.deviceId,
      storeId: '1',
      counterId: '2',
      createdAt: fixture.authorization.issuedAt,
      ...device,
    });
    const server = generateKeyPairSync('ed25519'),
      signer = offlineCashSigner(
        server.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      );
    await activateCashAuthorization(
      '44',
      signer.authorize(fixture.authorization),
      fixture.snapshot,
      signer.publicKey,
      controller.signal,
      database,
      now,
    );
    candidate = {
      id: crypto.randomUUID(),
      ownerId: '44',
      storeId: '1',
      counterId: '2',
      customerId: null,
      lines: [
        {
          productId: '9007199254740993',
          name: 'Untrusted cached display name',
          barcode: 'DISPLAY',
          unitPrice: '1.00',
          quantity: 2,
        },
      ],
      version: 0,
      createdAt: fixture.authorization.issuedAt,
      updatedAt: fixture.authorization.issuedAt + 100,
    };
    await database.drafts.add(candidate);
    await prepareReview(candidate, null, database);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (database) {
      database.close();
      await database.delete();
    }
  });

  it('commits20 simultaneous callbacks once, persists its protected key across restart, and never fabricates an online paid receipt', async () => {
    const name = database.name;
    database.close();
    database = new PosDatabase(name);
    const device = (await database.offlineCashDevices.toArray())[0]!;
    expect(device.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', device.privateKey)).rejects.toThrow();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        completeOfflineCash(
          candidate,
          fixture.authorization.id,
          50000,
          controller.signal,
          database,
          now,
        ),
      ),
    );
    expect(results.filter((result) => !result.alreadyCompleted)).toHaveLength(1);
    const saved = (await database.offlineCashReceipts.toArray())[0]!;
    expect(saved.envelope.receipt).toMatchObject({
      payableCents: 39900,
      cashReceivedCents: 50000,
      changeCents: 10100,
      taxCents: 1905,
      sequence: 1,
      receiptNumber: fixture.authorization.receiptPrefix + '-0001',
      lines: [
        expect.objectContaining({
          productId: '9007199254740993',
          name: 'Source-priced product',
          quantity: 2,
        }),
      ],
    });
    expect(verifyDeviceCashReceipt(device.publicKey, saved.envelope)).toBe(true);
    expect(await database.offlineCashSync.count()).toBe(1);
    expect(await database.completedSales.count()).toBe(0);
    expect(await database.reviewSnapshots.count()).toBe(0);
    expect((await database.drafts.toArray())[0]).toMatchObject({
      id: saved.replacementDraftId,
      version: 0,
      lines: [],
    });
    expect(await database.offlineCashAuthorizations.get(fixture.authorization.id)).toMatchObject({
      nextSequence: 2,
      usedCents: 39900,
    });
  });
  it('completes the saved original quantity and preserves actual later edits under a new UUID', async () => {
    await database.drafts.put({
      ...candidate,
      updatedAt: now,
      lines: [{ ...candidate.lines[0]!, quantity: 3 }],
    });
    const result = await completeOfflineCash(
      candidate,
      fixture.authorization.id,
      50000,
      controller.signal,
      database,
      now,
    );
    expect(result.value.envelope.receipt.lines[0]!.quantity).toBe(2);
    expect(result.value.preservedDraftId).toBe(result.value.replacementDraftId);
    expect((await database.drafts.toArray())[0]).toMatchObject({
      id: result.value.preservedDraftId,
      version: 0,
      lines: [expect.objectContaining({ quantity: 3 })],
    });
    expect(await database.drafts.get(['44', candidate.id])).toBeUndefined();
  });
  it('rejects logout, stale actor, mismatched or expired cached session before recording cash', async () => {
    storage.set('pos-pending-logout', '1');
    await expect(
      completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      ),
    ).rejects.toThrow('Sign in again');
    storage.clear();
    controller.abort();
    await expect(
      completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      ),
    ).rejects.toThrow();
    controller = new AbortController();
    const session = (await database.sessions.get('current'))!;
    await database.sessions.put({ ...session, user: { ...session.user, id: '45' } });
    await expect(
      completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      ),
    ).rejects.toThrow('cached operator');
    await database.sessions.put({ ...session, expiresAt: now });
    await expect(
      completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      ),
    ).rejects.toThrow('cached operator');
    expect(await database.offlineCashReceipts.count()).toBe(0);
  });
  it('rolls back all writes if actor ownership aborts during protected-key signing', async () => {
    const original = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'sign').mockImplementationOnce(async (...arguments_) => {
      controller.abort();
      return original(...arguments_);
    });
    await expect(
      completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      ),
    ).rejects.toThrow();
    expect(await database.offlineCashReceipts.count()).toBe(0);
    expect(await database.offlineCashSync.count()).toBe(0);
    expect(await database.drafts.get(['44', candidate.id])).toEqual(candidate);
    expect(await database.offlineCashAuthorizations.get(fixture.authorization.id)).toMatchObject({
      nextSequence: 1,
      usedCents: 0,
    });
  });
  it('rolls back a partial receipt/sync write failure and safely completes once on retry', async () => {
    vi.spyOn(database.offlineCashSync, 'add').mockRejectedValueOnce(
      new Error('Isolated full-storage failure'),
    );
    await expect(
      completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      ),
    ).rejects.toThrow('storage');
    expect(await database.offlineCashReceipts.count()).toBe(0);
    expect(await database.drafts.count()).toBe(1);
    expect(await database.reviewSnapshots.count()).toBe(1);
    expect(
      (
        await completeOfflineCash(
          candidate,
          fixture.authorization.id,
          50000,
          controller.signal,
          database,
          now,
        )
      ).alreadyCompleted,
    ).toBe(false);
    controller.abort();
    expect(await database.offlineCashReceipts.count()).toBe(1);
    expect(await database.offlineCashSync.count()).toBe(1);
  });
  it('subtracts completed local cash quantities from cached stock before another sale', async () => {
    const first = await completeOfflineCash(
      candidate,
      fixture.authorization.id,
      50000,
      controller.signal,
      database,
      now,
    );
    const next = {
      ...candidate,
      id: first.value.replacementDraftId,
      lines: [{ ...candidate.lines[0]!, quantity: 1 }],
      updatedAt: now + 1,
    };
    await database.drafts.put(next);
    await prepareReview(next, null, database);
    await expect(
      completeOfflineCash(
        next,
        fixture.authorization.id,
        20000,
        controller.signal,
        database,
        now + 2,
      ),
    ).rejects.toThrow('cached stock');
    expect(await database.offlineCashReceipts.count()).toBe(1);
    expect(await database.drafts.get(['44', next.id])).toEqual(next);
  });
  it('rejects online-bound reviews, source-unsupported quantities and customer benefits', async () => {
    await bindReviewedCheckout(candidate, crypto.randomUUID(), database);
    await expect(
      completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      ),
    ).rejects.toThrow('online checkout');
    await database.reviewSnapshots.delete(['44', candidate.id]);
    candidate = { ...candidate, customerId: '81', updatedAt: now };
    await database.drafts.put(candidate);
    await prepareReview(candidate, null, database);
    await expect(
      completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      ),
    ).rejects.toThrow('walk-in');
    await database.reviewSnapshots.delete(['44', candidate.id]);
    candidate = {
      ...candidate,
      customerId: null,
      lines: [{ ...candidate.lines[0]!, quantity: 3 }],
    };
    await database.drafts.put(candidate);
    await prepareReview(candidate, null, database);
    await expect(
      completeOfflineCash(
        candidate,
        fixture.authorization.id,
        100000,
        controller.signal,
        database,
        now,
      ),
    ).rejects.toThrow('quantity');
    expect(await database.offlineCashReceipts.count()).toBe(0);
  });
  it('blocks stale reviewed/saved imports after cash completion without dropping the immutable receipt', async () => {
    const result = await completeOfflineCash(
      candidate,
      fixture.authorization.id,
      50000,
      controller.signal,
      database,
      now,
    );
    await database.drafts.put(candidate);
    await expect(prepareReview(candidate, null, database)).rejects.toThrow('Cash has already');
    await expect(queueDraft(candidate, database)).rejects.toThrow('Cash has already');
    await expect(bindReviewedCheckout(candidate, crypto.randomUUID(), database)).rejects.toThrow(
      'Cash has already',
    );
    expect((await database.offlineCashReceipts.toArray())[0]!.receiptId).toBe(
      result.value.receiptId,
    );
    expect(await database.completedSales.count()).toBe(0);
  });
  it('requires a current cached assignment for franchise role1 cash completion', async () => {
    const session = (await database.sessions.get('current'))!;
    await database.sessions.put({
      ...session,
      user: { ...session.user, role: 1, userType: 2, storeIds: [] },
    });
    await expect(
      completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      ),
    ).rejects.toThrow('cached operator');
    expect(await database.offlineCashReceipts.count()).toBe(0);
  });
  it('claims simultaneous reconnect sync once and retains immutable cash when the server reports stock conflicts', async () => {
    const value = (
      await completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      )
    ).value;
    const user = (await database.sessions.get('current'))!.user;
    let requests = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        replayOfflineCash(user, '1', {
          database,
          signal: controller.signal,
          clock: () => now,
          send: async (actor, storeId, envelope) => {
            requests++;
            expect(actor).toBe('44');
            expect(storeId).toBe('1');
            expect(envelope).toEqual(value.envelope);
            return accepted(value);
          },
        }),
      ),
    );
    expect(requests).toBe(1);
    const saved = (await database.offlineCashReceipts.toArray())[0]!;
    expect(saved.envelope).toEqual(value.envelope);
    expect(saved.syncState).toBe('conflicted');
    expect(saved.acceptance?.payableCents).toBe(39900);
    expect((await database.offlineCashSync.toArray())[0]!.state).toBe('accepted');
    expect(await database.completedSales.count()).toBe(0);
  });
  it('replays a lost receipt acknowledgment with the exact same identity and signature rather than another cash sale', async () => {
    const value = (
      await completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      )
    ).value;
    const user = (await database.sessions.get('current'))!.user,
      observed = new Set<string>();
    let requests = 0;
    const send = async (_actor: string, _store: string, envelope: typeof value.envelope) => {
      requests++;
      observed.add(JSON.stringify(envelope));
      if (requests === 1) throw new Error('Fixture response lost after server commit');
      return accepted(value);
    };
    await replayOfflineCash(user, '1', {
      database,
      signal: controller.signal,
      clock: () => now,
      send,
    });
    expect((await database.offlineCashSync.toArray())[0]!.state).toBe('retry');
    expect((await database.offlineCashReceipts.toArray())[0]!.syncState).toBe('pending');
    await replayOfflineCash(user, '1', {
      database,
      signal: controller.signal,
      clock: () => now + 5000,
      send,
    });
    expect(requests).toBe(2);
    expect(observed.size).toBe(1);
    expect(await database.offlineCashReceipts.count()).toBe(1);
    expect((await database.offlineCashReceipts.toArray())[0]!.envelope).toEqual(value.envelope);
  });
  it('keeps collected cash pending if a reply changes money or claims an incomplete import', async () => {
    const value = (
      await completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      )
    ).value;
    const user = (await database.sessions.get('current'))!.user;
    await replayOfflineCash(user, '1', {
      database,
      signal: controller.signal,
      clock: () => now,
      send: async () => ({ ...accepted(value), payableCents: 39800, changeCents: 10200 }),
    });
    expect((await database.offlineCashReceipts.toArray())[0]!.envelope).toEqual(value.envelope);
    expect((await database.offlineCashReceipts.toArray())[0]!.syncState).toBe('pending');
    await replayOfflineCash(user, '1', {
      database,
      signal: controller.signal,
      clock: () => now + 5000,
      send: async () => ({
        ...accepted(value),
        status: 'imported',
        orderId: '9001',
        importedAt: null,
      }),
    });
    expect((await database.offlineCashReceipts.toArray())[0]!.importedAt).toBeNull();
    expect((await database.offlineCashSync.toArray())[0]!.state).toBe('retry');
  });
  it('allows a current store manager to hand off a signed-out operator receipt after an interrupted old claim', async () => {
    const value = (
      await completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      )
    ).value;
    const owner = (await database.sessions.get('current'))!.user;
    await replayOfflineCash(owner, '1', {
      database,
      signal: controller.signal,
      clock: () => now,
      send: async () => {
        controller.abort();
        return accepted(value);
      },
    });
    expect((await database.offlineCashReceipts.toArray())[0]!.syncState).toBe('pending');
    const manager = { ...owner, id: '46', role: 4 as const },
      scope = new AbortController();
    await database.sessions.put({
      id: 'current',
      user: manager,
      expiresAt: fixture.authorization.expiresAt,
    });
    let requests = 0;
    await replayOfflineCash(manager, '1', {
      database,
      signal: scope.signal,
      clock: () => now + 31000,
      send: async (actor, storeId, envelope) => {
        requests++;
        expect(actor).toBe('46');
        expect(storeId).toBe('1');
        expect(envelope.receipt.operatorId).toBe('44');
        expect(envelope).toEqual(value.envelope);
        return accepted(value);
      },
    });
    expect(requests).toBe(1);
    expect((await database.offlineCashReceipts.toArray())[0]).toMatchObject({
      ownerId: '44',
      syncState: 'conflicted',
      acceptance: { operatorId: '44', payableCents: 39900 },
    });
    expect(await database.completedSales.count()).toBe(0);
  });
  it('stops another-owner handoff when cached manager role or store scope changes before claim or after the response', async () => {
    const value = (
      await completeOfflineCash(
        candidate,
        fixture.authorization.id,
        50000,
        controller.signal,
        database,
        now,
      )
    ).value;
    const original = (await database.sessions.get('current'))!,
      manager = { ...original.user, id: '46', role: 4 as const };
    await database.sessions.put({ ...original, user: { ...manager, role: 5 } });
    let calls = 0;
    const options = {
      database,
      signal: controller.signal,
      clock: () => now,
      send: async () => {
        calls++;
        await database.sessions.put({ ...original, user: { ...manager, storeIds: [] } });
        return accepted(value);
      },
    };
    await replayOfflineCash(manager, '1', options);
    expect(calls).toBe(0);
    await database.sessions.put({ ...original, user: manager });
    await replayOfflineCash(manager, '1', options);
    expect(calls).toBe(1);
    expect((await database.offlineCashReceipts.toArray())[0]!.acceptance).toBeNull();
    expect((await database.offlineCashReceipts.toArray())[0]!.envelope).toEqual(value.envelope);
  });
  it('refreshes a proved import without uploading or recreating the sale and never regresses its immutable link', async () => {
    const value = (
        await completeOfflineCash(
          candidate,
          fixture.authorization.id,
          50000,
          controller.signal,
          database,
          now,
        )
      ).value,
      user = (await database.sessions.get('current'))!.user;
    await replayOfflineCash(user, '1', {
      database,
      signal: controller.signal,
      clock: () => now,
      send: async () => accepted(value),
    });
    const detail = (reply: ReturnType<typeof accepted>) => ({
      ...reply,
      envelope: value.envelope,
      authorizationWindow: {
        issuedAt: fixture.authorization.issuedAt,
        expiresAt: fixture.authorization.expiresAt,
        businessDate: fixture.authorization.businessDate,
        timeZone: 'Asia/Kolkata',
      },
      auditEvents: [],
      activeApproval: null,
    });
    const imported = {
      ...accepted(value),
      status: 'imported' as const,
      conflicts: [],
      version: 2,
      orderId: '9007199254740993',
      importedAt: now + 10000,
    };
    await refreshOfflineCashReceipt(user, '1', value.receiptId, {
      database,
      signal: controller.signal,
      clock: () => now,
      read: async () => detail(imported),
    });
    const first = (await database.offlineCashReceipts.toArray())[0]!;
    expect(first).toMatchObject({
      syncState: 'imported',
      importedAt: now + 10000,
      acceptance: { version: 2, orderId: '9007199254740993' },
    });
    expect((await database.offlineCashSync.toArray())[0]!.state).toBe('imported');
    await refreshOfflineCashReceipt(user, '1', value.receiptId, {
      database,
      signal: controller.signal,
      clock: () => now,
      read: async () => detail(accepted(value)),
    });
    expect((await database.offlineCashReceipts.toArray())[0]).toEqual(first);
    await expect(
      refreshOfflineCashReceipt(user, '1', value.receiptId, {
        database,
        signal: controller.signal,
        clock: () => now,
        read: async () => detail({ ...imported, version: 3, orderId: '999' }),
      }),
    ).rejects.toThrow('import link changed');
    expect(await database.completedSales.count()).toBe(0);
  });
  it('rejects changed signed receipt data and aborts status publication after a cached scope change', async () => {
    const value = (
        await completeOfflineCash(
          candidate,
          fixture.authorization.id,
          50000,
          controller.signal,
          database,
          now,
        )
      ).value,
      session = (await database.sessions.get('current'))!,
      user = session.user;
    const detail = {
      ...accepted(value),
      envelope: value.envelope,
      authorizationWindow: {
        issuedAt: fixture.authorization.issuedAt,
        expiresAt: fixture.authorization.expiresAt,
        businessDate: fixture.authorization.businessDate,
        timeZone: 'Asia/Kolkata',
      },
      auditEvents: [],
      activeApproval: null,
    };
    await expect(
      refreshOfflineCashReceipt(user, '1', value.receiptId, {
        database,
        signal: controller.signal,
        clock: () => now,
        read: async () => ({
          ...detail,
          envelope: { ...value.envelope, signature: 'A'.repeat(86) },
        }),
      }),
    ).rejects.toThrow('original signed cash receipt');
    await refreshOfflineCashReceipt(user, '1', value.receiptId, {
      database,
      signal: controller.signal,
      clock: () => now,
      read: async () => {
        await database.sessions.put({ ...session, user: { ...user, storeIds: [] } });
        return detail;
      },
    });
    expect((await database.offlineCashReceipts.toArray())[0]!.acceptance).toBeNull();
    expect((await database.offlineCashReceipts.toArray())[0]!.envelope).toEqual(value.envelope);
  });
  it('keeps consumed sequence/budget on an authorization replay and rejects late replaced grants', async () => {
    await completeOfflineCash(
      candidate,
      fixture.authorization.id,
      50000,
      controller.signal,
      database,
      now,
    );
    const old = (await database.offlineCashAuthorizations.get(fixture.authorization.id))!;
    const replay = await activateCashAuthorization(
      '44',
      old.envelope,
      old.snapshot,
      old.serverKey,
      controller.signal,
      database,
      now,
    );
    expect(replay).toMatchObject({ nextSequence: 2, usedCents: 39900 });
    const signer = offlineCashSigner(
        generateKeyPairSync('ed25519')
          .privateKey.export({ format: 'pem', type: 'pkcs8' })
          .toString(),
      ),
      id = crypto.randomUUID();
    const grant = {
      ...fixture.authorization,
      id,
      issuedAt: now + 10,
      receiptPrefix: 'OC-' + id.replaceAll('-', '').toUpperCase(),
    };
    await activateCashAuthorization(
      '44',
      signer.authorize(grant),
      fixture.snapshot,
      signer.publicKey,
      controller.signal,
      database,
      now + 11,
    );
    await expect(
      activateCashAuthorization(
        '44',
        old.envelope,
        old.snapshot,
        old.serverKey,
        controller.signal,
        database,
        now + 12,
      ),
    ).rejects.toThrow('replaced or revoked');
    const staleId = crypto.randomUUID();
    await expect(
      activateCashAuthorization(
        '44',
        signer.authorize({
          ...fixture.authorization,
          id: staleId,
          receiptPrefix: 'OC-' + staleId.replaceAll('-', '').toUpperCase(),
        }),
        fixture.snapshot,
        signer.publicKey,
        controller.signal,
        database,
        now + 12,
      ),
    ).rejects.toThrow('newer or conflicting');
    expect((await database.offlineCashAuthorizations.get(id))!.revokedAt).toBeNull();
    expect(await database.offlineCashReceipts.count()).toBe(1);
  });
});
