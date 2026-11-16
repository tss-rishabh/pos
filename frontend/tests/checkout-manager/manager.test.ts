import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { offlineCashFixture } from '../../../backend/tests/checkout/offline-cash-fixtures';
import type { Principal } from '../../src/api/types';
import { setRequestOperator } from '../../src/api/client';
import { PosDatabase } from '../../src/offline/database';
import { createCashDeviceKeys, signCashReceipt } from '../../src/offline/cash/crypto';
import type { LocalCashDevice, LocalCashReceipt } from '../../src/offline/cash/storage-types';
import {
  cashManagerAllowed,
  cashManagerAttribution,
  cashManagerSessionMatches,
  loadCashManagerLocalPage,
} from '../../src/pages/checkout/offline-cash/manager';

describe('cash manager handoff authorization and immutable device evidence', () => {
  const manager: Principal = {
    id: '1',
    name: 'Fixture manager',
    email: 'manager@example.test',
    role: 4,
    userType: 1,
    storeIds: ['1', '2'],
  };
  const fixture = offlineCashFixture(),
    now = fixture.receipt.completedAt + 1000,
    storage = new Map<string, string>();
  let database: PosDatabase, device: LocalCashDevice;
  async function saved(sequence = 1, storeId = '1'): Promise<LocalCashReceipt> {
    const receipt = {
      ...fixture.receipt,
      id: crypto.randomUUID(),
      draftId: crypto.randomUUID(),
      sequence,
      storeId,
      receiptNumber: fixture.authorization.receiptPrefix + '-' + String(sequence).padStart(4, '0'),
    };
    return {
      ownerId: '44',
      receiptId: receipt.id,
      draftId: receipt.draftId,
      storeId,
      counterId: '2',
      authorizationId: receipt.authorizationId,
      sequence,
      envelope: await signCashReceipt(receipt, device.privateKey),
      completedAt: receipt.completedAt,
      acceptance: null,
      syncState: 'pending',
      importedAt: null,
      preservedDraftId: null,
      replacementDraftId: crypto.randomUUID(),
    };
  }
  const read = (page = 0, options: Parameters<typeof loadCashManagerLocalPage>[3] = {}) =>
    loadCashManagerLocalPage(manager, '1', page, { database, clock: () => now, ...options });
  beforeEach(async () => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    setRequestOperator(manager.id);
    database = new PosDatabase('cash-manager-test-' + crypto.randomUUID());
    await database.sessions.put({ id: 'current', user: manager, expiresAt: now + 60_000 });
    device = {
      ownerId: '44',
      deviceId: fixture.receipt.deviceId,
      storeId: '1',
      counterId: '2',
      createdAt: now - 1000,
      ...(await createCashDeviceKeys()),
    };
    await database.offlineCashDevices.add(device);
  });
  afterEach(async () => {
    setRequestOperator(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    database.close();
    await database.delete();
  });

  it('limits managers and franchise administrators to current assigned stores', () => {
    for (const role of [1, 2, 3, 4] as const)
      expect(cashManagerAllowed({ ...manager, role }, '1')).toBe(true);
    expect(cashManagerAllowed({ ...manager, role: 5 }, '1')).toBe(false);
    expect(cashManagerAllowed({ ...manager, role: 1, storeIds: [] }, '99')).toBe(true);
    expect(cashManagerAllowed({ ...manager, role: 1, userType: 2, storeIds: ['1'] }, '99')).toBe(
      false,
    );
    expect(cashManagerAllowed({ ...manager, role: 1, userType: 2, storeIds: ['1'] }, '1')).toBe(
      true,
    );
    expect(cashManagerAllowed(manager, '01')).toBe(false);
  });
  it('rejects cached role, user type, full assignment scope, owner, expiry and pending logout changes', () => {
    const session = { id: 'current', user: manager, expiresAt: now + 1000 };
    expect(cashManagerSessionMatches(manager, '1', session, now)).toBe(true);
    expect(
      cashManagerSessionMatches(
        manager,
        '1',
        { ...session, user: { ...manager, storeIds: ['2', '1'] } },
        now,
      ),
    ).toBe(true);
    for (const user of [
      { ...manager, role: 5 },
      { ...manager, userType: 2 },
      { ...manager, id: '9' },
      { ...manager, storeIds: ['1'] },
    ])
      expect(cashManagerSessionMatches(manager, '1', { ...session, user }, now)).toBe(false);
    expect(cashManagerSessionMatches(manager, '1', { ...session, expiresAt: now }, now)).toBe(
      false,
    );
    expect(cashManagerSessionMatches(manager, '1', session, now, true)).toBe(false);
    expect(
      cashManagerSessionMatches(
        manager,
        '1',
        { ...session, user: { ...manager, storeIds: null } },
        now,
      ),
    ).toBe(false);
  });
  it('reads other-owner pending receipts by store without changing the original payment or owner', async () => {
    const original = await saved(),
      otherStore = await saved(2, '2');
    await database.offlineCashReceipts.bulkAdd([original, otherStore]);
    const page = await read();
    expect(page.authorized).toBe(true);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ ownerId: '44', envelope: original.envelope });
    expect(page.unreadable).toBe(0);
    expect(await database.offlineCashReceipts.get(['44', original.receiptId])).toEqual(original);
    expect(await database.offlineCashReceipts.where('ownerId').equals('1').count()).toBe(0);
  });
  it('never inspects other-owner receipt indexes when the cached manager scope is stale', async () => {
    await database.offlineCashReceipts.add(await saved());
    const where = vi.spyOn(database.offlineCashReceipts, 'where');
    for (const user of [
      { ...manager, role: 5 as const },
      { ...manager, storeIds: ['2'] },
      { ...manager, userType: 2 as const },
      { ...manager, id: '9' },
    ]) {
      await database.sessions.put({ id: 'current', user, expiresAt: now + 1000 });
      expect((await read()).rows).toEqual([]);
    }
    await database.sessions.put({ id: 'current', user: manager, expiresAt: now });
    expect((await read()).authorized).toBe(false);
    await database.sessions.put({ id: 'current', user: manager, expiresAt: now + 1000 });
    storage.set('pos-pending-logout', 'pending');
    expect((await read()).authorized).toBe(false);
    expect(where).not.toHaveBeenCalled();
  });
  it('keeps bad ownership, modified signatures and missing device evidence saved but out of the manager receipt view', async () => {
    const ownership = await saved(1),
      tampered = await saved(2),
      missing = await saved(3);
    ownership.ownerId = '45';
    tampered.envelope.receipt.payableCents++;
    missing.envelope.receipt.deviceId = crypto.randomUUID();
    await database.offlineCashReceipts.bulkAdd([ownership, tampered, missing]);
    const page = await read();
    expect(page.rows).toEqual([]);
    expect(page.unreadable).toBe(3);
    expect(await database.offlineCashReceipts.count()).toBe(3);
  });
  it('paginates25 saved receipts without loading another store or losing later pending cash', async () => {
    const rows = await Promise.all(Array.from({ length: 27 }, (_, index) => saved(index + 1)));
    await database.offlineCashReceipts.bulkAdd(rows);
    const first = await read(),
      second = await read(1);
    expect(first.rows).toHaveLength(25);
    expect(first.hasNext).toBe(true);
    expect(second.rows).toHaveLength(2);
    expect(second.hasNext).toBe(false);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.receiptId)).size).toBe(27);
    expect(await database.offlineCashReceipts.count()).toBe(27);
    await expect(read(Number.MAX_SAFE_INTEGER)).rejects.toThrow('valid saved-receipt page');
  });
  it('aborts stale local continuations before returning another operator cash evidence', async () => {
    await database.offlineCashReceipts.add(await saved());
    const controller = new AbortController(),
      verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
      const result = await verify(...args);
      controller.abort();
      return result;
    });
    await expect(read(0, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
  it('normalizes browser minute precision and bounds clock attribution to valid original business-day seconds', () => {
    const window = {
      businessDate: '2026-11-16',
      timeZone: 'Asia/Kolkata',
      issuedAt: Date.parse('2026-11-16T09:30:00.100+05:30'),
      expiresAt: Date.parse('2026-11-16T09:40:00.000+05:30'),
    };
    expect(cashManagerAttribution('2026-11-16T09:31', window)).toBe('2026-11-16 09:31:00');
    expect(cashManagerAttribution('2026-11-16T09:30:01', window)).toBe('2026-11-16 09:30:01');
    for (const value of [
      '2026-11-16T09:30:00',
      '2026-11-16T09:40:00',
      '2026-11-15T09:35:00',
      '2026-02-30T09:35:00',
      '2026-11-16T25:35:00',
      'script',
    ])
      expect(() => cashManagerAttribution(value, window)).toThrow();
  });
});
