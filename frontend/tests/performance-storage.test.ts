import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRequestOperator } from '../src/api/client';
import { PosDatabase } from '../src/offline/database';
import {
  recordCustomerConnection,
  recordCustomerHistoryPerformance,
  recordPerformancePhase,
} from '../src/offline/performance/storage';
import { emptyPerformance, performanceValues } from '../src/offline/performance/contracts';

// The fast-cash binder (freezePerformance/bindPaidPerformance) was removed with
// fast cash. These cases cover the surviving local capture functions directly.
describe('durable performance measurements independent of money', () => {
  let database: PosDatabase,
    command: {
      ownerId: string;
      storeId: string;
      counterId: string;
      draftId: string;
      checkoutId: string;
    },
    now: number;
  const local = new Map<string, string>();
  const options = () => ({ database, clock: () => now });
  const owner = () => ({
    ownerId: command.ownerId,
    storeId: command.storeId,
    counterId: command.counterId,
    draftId: command.draftId,
  });
  const connection = () => ({ ...owner(), checkoutId: command.checkoutId });
  const capture = async () => database.performanceCaptures.get([command.ownerId, command.draftId]);
  beforeEach(async () => {
    local.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => local.set(key, value),
      removeItem: (key: string) => local.delete(key),
    });
    setRequestOperator('44');
    now = Date.now();
    database = new PosDatabase('performance-fixture-' + crypto.randomUUID());
    await database.sessions.put({
      id: 'current',
      expiresAt: now + 300000,
      user: {
        id: '44',
        role: 5,
        userType: 1,
        name: 'Fixture operator',
        email: 'fixture@example.test',
        storeIds: ['1'],
      },
    });
    command = {
      ownerId: '44',
      storeId: '1',
      counterId: '2',
      draftId: crypto.randomUUID(),
      checkoutId: crypto.randomUUID(),
    };
  });
  afterEach(async () => {
    if (database) {
      database.close();
      await database.delete();
    }
    vi.unstubAllGlobals();
  });
  it('preserves source string milliseconds, empty fields and the last phase measurement', async () => {
    const connectedAt = now;
    await recordCustomerConnection(connection(), crypto.randomUUID(), true, options());
    await recordPerformancePhase(owner(), 'add_to_cart', 12.346, options());
    await recordPerformancePhase(owner(), 'add_to_cart', 4.321, options());
    await recordPerformancePhase(owner(), 'user_behaviour', 100.5, options());
    const saved = await capture();
    expect(saved?.phases).toEqual({
      product_main_list: '',
      user_behaviour: '100.50',
      add_to_cart: '4.32',
      proceed_to_payment: '',
    });
    expect(saved?.startedAt).toBe(connectedAt);
    expect(await database.completedSales.count()).toBe(0);
    expect(await database.performanceCommands.count()).toBe(0);
    expect(JSON.stringify(saved)).not.toMatch(
      /email|telephone|comment|token|cashAmount|payable|productId/,
    );
  });
  it('exact connection replay never restarts the timer; a new connection intent does', async () => {
    const operationId = crypto.randomUUID(),
      connectedAt = now;
    await recordCustomerConnection(connection(), operationId, true, options());
    now += 1000;
    await recordCustomerConnection(connection(), operationId, true, options());
    expect((await capture())?.startedAt).toBe(connectedAt);
    await recordCustomerConnection(connection(), crypto.randomUUID(), true, options());
    expect((await capture())?.startedAt).toBe(now);
  });
  it('ignores late history and connection callbacks from a previous customer version', async () => {
    await recordCustomerConnection(
      { ...connection(), checkoutVersion: 3 },
      crypto.randomUUID(),
      true,
      options(),
    );
    await recordCustomerHistoryPerformance('44', '1', command.checkoutId, 3, 10, options());
    now += 100;
    await recordCustomerConnection(
      { ...connection(), checkoutVersion: 4 },
      crypto.randomUUID(),
      true,
      options(),
    );
    await recordCustomerHistoryPerformance('44', '1', command.checkoutId, 3, 999, options());
    await recordCustomerConnection(
      { ...connection(), checkoutVersion: 3 },
      crypto.randomUUID(),
      true,
      options(),
    );
    expect(
      (await database.performanceCaptures.get(['44', command.draftId]))?.phases.user_behaviour,
    ).toBe('');
    await recordCustomerHistoryPerformance('44', '1', command.checkoutId, 4, 20, options());
    expect((await capture())?.phases.user_behaviour).toBe('20.00');
  });
  it('refuses expired, changed or logged-out identities before publishing local metrics', async () => {
    await database.sessions.update('current', { expiresAt: now - 1 });
    await expect(recordPerformancePhase(owner(), 'add_to_cart', 5, options())).rejects.toThrow(
      'operator session',
    );
    await database.sessions.update('current', { expiresAt: now + 300000 });
    local.set('pos-pending-logout', '44');
    await expect(recordPerformancePhase(owner(), 'add_to_cart', 5, options())).rejects.toThrow(
      'operator session',
    );
    local.clear();
    setRequestOperator('45');
    await expect(recordPerformancePhase(owner(), 'add_to_cart', 5, options())).rejects.toThrow(
      'operator changed',
    );
    expect(await database.performanceCommands.count()).toBe(0);
    expect(await database.performanceCaptures.count()).toBe(0);
  });
  it('validates the exact source field set and native255-byte limit without accepting arbitrary text or object fields', () => {
    expect(performanceValues.parse(emptyPerformance())).toEqual(emptyPerformance());
    for (const value of [
      { ...emptyPerformance(), add_to_cart: 'NaN' },
      { ...emptyPerformance(), comment: 'private' },
      { ...emptyPerformance(), overall_performance_time: '1e5' },
      { ...emptyPerformance(), fast_payment: 'a'.repeat(300) },
    ])
      expect(performanceValues.safeParse(value).success).toBe(false);
  });
});
