import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRequestOperator } from '../src/api/client';
import { PosDatabase } from '../src/offline/database';
import { fastCashCommandSchema, type FastCashCommand } from '../src/offline/fast-cash/contracts';
import {
  bindPaidPerformance,
  freezePerformance,
  recordCustomerConnection,
  recordCustomerHistoryPerformance,
  recordPerformancePhase,
} from '../src/offline/performance/storage';
import { syncPreparedPerformance } from '../src/offline/performance/sync';
import { emptyPerformance, performanceValues } from '../src/offline/performance/contracts';

describe('durable performance measurements independent of money', () => {
  let database: PosDatabase, peer: PosDatabase | undefined, command: FastCashCommand, now: number;
  const local = new Map<string, string>();
  const options = () => ({ database, clock: () => now });
  const owner = () => ({
    ownerId: command.ownerId,
    storeId: command.storeId,
    counterId: command.counterId,
    draftId: command.draftId,
  });
  const connection = () => ({ ...owner(), checkoutId: command.checkoutId });
  const paid = () =>
    fastCashCommandSchema.parse({
      ...command,
      state: 'paid',
      orderId: '9007199254740993',
      orderAttempts: 1,
      paymentAttempts: 1,
      receipt: {
        status: 'paid',
        source: 'counter',
        orderId: '9007199254740993',
        receiptId: command.paymentId,
        paymentAttemptId: command.paymentId,
        transactionId: 'FIXTURE',
        cashAmount: command.payable,
        onlineAmount: '0.00',
      },
    });
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
    command = fastCashCommandSchema.parse({
      id: crypto.randomUUID(),
      revision: 0,
      ownerId: '44',
      storeId: '1',
      counterId: '2',
      draftId: crypto.randomUUID(),
      draftVersion: now,
      checkoutId: crypto.randomUUID(),
      checkoutVersion: 2,
      quoteHash: 'a'.repeat(64),
      noteHash: 'b'.repeat(64),
      payable: '10.00',
      cashReceived: '10.00',
      submissionId: crypto.randomUUID(),
      paymentId: crypto.randomUUID(),
      orderId: null,
      state: 'prepared',
      claimId: null,
      claimedAt: null,
      orderAttempts: 0,
      paymentAttempts: 0,
      receipt: null,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    });
  });
  afterEach(async () => {
    peer?.close();
    peer = undefined;
    if (database) {
      database.close();
      await database.delete();
    }
    vi.unstubAllGlobals();
  });
  it('preserves source string milliseconds, empty fields and the last phase measurement', async () => {
    await recordCustomerConnection(connection(), crypto.randomUUID(), true, options());
    await recordPerformancePhase(owner(), 'add_to_cart', 12.346, options());
    await recordPerformancePhase(owner(), 'add_to_cart', 4.321, options());
    await recordPerformancePhase(owner(), 'user_behaviour', 100.5, options());
    now += 500;
    const saved = await freezePerformance(command, options());
    expect(saved.performance).toEqual({
      product_main_list: '',
      user_behaviour: '100.50',
      add_to_cart: '4.32',
      proceed_to_payment: '',
      overall_performance_time: '500',
    });
    expect(await database.completedSales.count()).toBe(0);
    expect(await database.fastCashCommands.count()).toBe(0);
    expect(JSON.stringify(saved)).not.toMatch(
      /email|telephone|comment|token|cashAmount|payable|productId/,
    );
  });
  it('twenty cross-tab captures freeze one original snapshot and operation, despite later clocks and measurements', async () => {
    peer = new PosDatabase(database.name);
    await recordCustomerConnection(connection(), crypto.randomUUID(), true, options());
    now += 123;
    const captures = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        freezePerformance(command, { ...options(), database: i % 2 ? peer : database }),
      ),
    );
    expect(new Set(captures.map((value) => value.operationId)).size).toBe(1);
    expect(await database.performanceCommands.count()).toBe(1);
    now += 5000;
    await recordPerformancePhase(owner(), 'add_to_cart', 999, options());
    expect(await freezePerformance(command, options())).toEqual(captures[0]);
  });
  it('exact connection replay never restarts the timer; a new connection intent does', async () => {
    const operationId = crypto.randomUUID();
    await recordCustomerConnection(connection(), operationId, true, options());
    now += 1000;
    await recordCustomerConnection(connection(), operationId, true, options());
    expect((await freezePerformance(command, options())).performance.overall_performance_time).toBe(
      '1000',
    );
    const next = { ...command, id: crypto.randomUUID() };
    await recordCustomerConnection(connection(), crypto.randomUUID(), true, options());
    now += 5;
    expect((await freezePerformance(next, options())).performance.overall_performance_time).toBe(
      '5',
    );
  });
  it('uses the source NaN branch for an unproved, backwards or late-recovered clock instead of poisoning reports', async () => {
    expect((await freezePerformance(command, options())).performance).toEqual(emptyPerformance());
    await recordCustomerConnection(connection(), crypto.randomUUID(), true, options());
    now -= 100;
    expect(
      (await freezePerformance({ ...command, id: crypto.randomUUID() }, options())).performance
        .overall_performance_time,
    ).toBe('NaN');
    expect(
      (
        await freezePerformance(
          { ...command, id: crypto.randomUUID(), state: 'order-uncertain', orderAttempts: 1 },
          options(),
        )
      ).performance,
    ).toEqual(emptyPerformance());
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
    expect((await freezePerformance(command, options())).performance.user_behaviour).toBe('20.00');
  });
  it('repairs a crash between the retained paid command and optional metadata binding without changing cash', async () => {
    const frozen = await freezePerformance(command, options());
    const cash = paid();
    await database.fastCashCommands.put(cash);
    now += 1000;
    let writes = 0;
    await syncPreparedPerformance('44', '1', '2', {
      ...options(),
      api: {
        read: async () => null,
        write: async (value) => {
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
      },
    });
    expect(writes).toBe(1);
    expect(await database.performanceCommands.get(command.id)).toMatchObject({
      operationId: frozen.operationId,
      state: 'recorded',
      performance: frozen.performance,
    });
    expect(await database.fastCashCommands.get(command.id)).toEqual(cash);
  });
  it('does not infer timing for another checkout or silently rebind an existing command', async () => {
    await recordCustomerConnection(connection(), crypto.randomUUID(), true, options());
    await expect(
      recordCustomerConnection(
        { ...connection(), checkoutId: crypto.randomUUID() },
        crypto.randomUUID(),
        true,
        options(),
      ),
    ).rejects.toThrow('owning checkout');
    const frozen = await freezePerformance(command, options());
    await expect(
      freezePerformance({ ...command, paymentId: crypto.randomUUID() }, options()),
    ).rejects.toThrow('original cash intent');
    expect(await database.performanceCommands.get(command.id)).toEqual(frozen);
  });
  it('binds only an existing exact paid receipt without changing its source command or creating money', async () => {
    await freezePerformance(command, options());
    const cash = paid();
    await database.fastCashCommands.put(cash);
    const recorded = await bindPaidPerformance(cash, options());
    expect(recorded).toMatchObject({
      orderId: cash.orderId,
      receiptId: cash.receipt?.receiptId,
      state: 'prepared',
    });
    expect(await bindPaidPerformance(cash, options())).toEqual(recorded);
    expect(await database.fastCashCommands.get(cash.id)).toEqual(cash);
    await expect(
      bindPaidPerformance(
        fastCashCommandSchema.parse({
          ...cash,
          receipt: { ...cash.receipt!, cashAmount: '11.00' },
        }),
        options(),
      ),
    ).rejects.toThrow('original paid sale');
    await expect(bindPaidPerformance(command, options())).rejects.toThrow('original paid sale');
  });
  it('refuses expired, changed or logged-out identities before publishing local metrics', async () => {
    await database.sessions.update('current', { expiresAt: now - 1 });
    await expect(freezePerformance(command, options())).rejects.toThrow('operator session');
    await database.sessions.update('current', { expiresAt: now + 300000 });
    local.set('pos-pending-logout', '44');
    await expect(recordPerformancePhase(owner(), 'add_to_cart', 5, options())).rejects.toThrow(
      'operator session',
    );
    local.clear();
    setRequestOperator('45');
    await expect(freezePerformance(command, options())).rejects.toThrow('operator changed');
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
