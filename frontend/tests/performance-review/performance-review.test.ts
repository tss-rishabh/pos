import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PosDatabase } from '../../src/offline/database';
import {
  performanceCommand,
  emptyPerformance,
  type PerformanceCommand,
} from '../../src/offline/performance/contracts';
import { recordPerformancePhase } from '../../src/offline/performance/storage';
import { syncPreparedPerformance } from '../../src/offline/performance/sync';
import type { PerformanceApi } from '../../src/offline/performance/client';

const owner = { ownerId: '1', storeId: '1', counterId: '1', draftId: randomUUID() };
const now = 100000;
describe('independent performance ownership and bounded-work review', () => {
  let database: PosDatabase;
  beforeEach(async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    database = new PosDatabase('performance-review-' + randomUUID());
    await database.sessions.put({
      id: 'current',
      expiresAt: now + 3600000,
      user: {
        id: '1',
        role: 1,
        userType: 1,
        name: 'Synthetic operator',
        email: 'operator.fixture@example.test',
        storeIds: ['1'],
      },
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await database.delete();
    vi.unstubAllGlobals();
  });
  function command(state: PerformanceCommand['state']): PerformanceCommand {
    return performanceCommand.parse({
      ...owner,
      id: randomUUID(),
      operationId: randomUUID(),
      checkoutId: randomUUID(),
      draftVersion: 1,
      submissionId: randomUUID(),
      paymentId: randomUUID(),
      performance: emptyPerformance(),
      orderId: '77',
      receiptId: randomUUID(),
      state,
      revision: 0,
      claimId: null,
      claimedAt: null,
      attempts: 0,
      nextAttemptAt: state === 'recorded' ? 0 : now - 1,
      createdAt: now - 1000,
      errorCode: null,
    });
  }
  it('fails closed on a corrupted NaN cached-session expiry before writing capture metadata', async () => {
    await database.sessions.update('current', { expiresAt: Number.NaN });
    await expect(
      recordPerformancePhase(owner, 'add_to_cart', 12.5, {
        database,
        clock: () => now,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(await database.performanceCaptures.count()).toBe(0);
  });
  it('does bounded sync work despite a long terminal history and only touches optional metadata', async () => {
    const finished = Array.from({ length: 300 }, () => command('recorded')),
      pending = command('prepared');
    await database.performanceCommands.bulkAdd([...finished, pending]);
    let cursorMoves = 0,
      writes = 0;
    const original = IDBCursor.prototype.continue;
    vi.spyOn(IDBCursor.prototype, 'continue').mockImplementation(function (
      this: IDBCursor,
      key?: IDBValidKey,
    ) {
      const store = this.source instanceof IDBIndex ? this.source.objectStore : this.source;
      if (store.name === 'performanceCommands') cursorMoves++;
      if (key === undefined) return original.call(this);
      return original.call(this, key);
    });
    const api: PerformanceApi = {
      async read() {
        return null;
      },
      async write(value) {
        writes++;
        return {
          operationId: value.operationId,
          checkoutId: value.checkoutId,
          orderId: value.orderId!,
          status: 'recorded',
          performance: value.performance,
          recordedAt: new Date(now).toISOString(),
        };
      },
    };
    await syncPreparedPerformance('1', '1', '1', {
      database,
      api,
      clock: () => now,
      signal: new AbortController().signal,
    });
    expect(writes).toBe(1);
    expect((await database.performanceCommands.get(pending.id))?.state).toBe('recorded');
    expect(await database.fastCashCommands.count()).toBe(0);
    expect(await database.completedSales.count()).toBe(0);
    expect(await database.offlineCashReceipts.count()).toBe(0);
    expect(cursorMoves).toBeLessThanOrEqual(30);
  });
});
