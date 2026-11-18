import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setRequestOperator } from '../src/api/client';
import { PosDatabase } from '../src/offline/database';
import {
  emptyPerformance,
  performanceCommand,
  performanceValues,
  type PerformanceCommand,
} from '../src/offline/performance/contracts';
import {
  recordPreparedPerformance,
  syncPreparedPerformance,
} from '../src/offline/performance/sync';
import {
  assertPerformanceReceipt,
  type PerformanceApi,
  type PerformanceReceipt,
} from '../src/offline/performance/client';

describe('optional post-payment performance recording', () => {
  let database: PosDatabase,
    peer: PosDatabase | undefined,
    job: PerformanceCommand,
    now: number,
    api: PerformanceApi,
    saved: PerformanceReceipt | null;
  let writes: PerformanceCommand[], reads: string[];
  const options = () => ({ database, api, clock: () => now });
  const receipt = (command = job): PerformanceReceipt => ({
    operationId: command.operationId,
    checkoutId: command.checkoutId,
    orderId: command.orderId!,
    status: 'recorded',
    performance: command.performance,
    recordedAt: '2026-11-16T12:00:00.000Z',
  });
  beforeEach(async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    setRequestOperator('44');
    now = Date.now();
    writes = [];
    reads = [];
    saved = null;
    database = new PosDatabase('performance-sync-fixture-' + crypto.randomUUID());
    await database.sessions.put({
      id: 'current',
      expiresAt: now + 360000,
      user: {
        id: '44',
        role: 5,
        userType: 1,
        name: 'Fixture operator',
        email: 'fixture@example.test',
        storeIds: ['1'],
      },
    });
    // Represents only the metadata row produced by the separately tested paid
    // binder. This fixture neither creates an order nor simulates a charge.
    job = performanceCommand.parse({
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      ownerId: '44',
      storeId: '1',
      counterId: '2',
      draftId: crypto.randomUUID(),
      draftVersion: now,
      checkoutId: crypto.randomUUID(),
      submissionId: crypto.randomUUID(),
      paymentId: crypto.randomUUID(),
      performance: { ...emptyPerformance(), overall_performance_time: '1234' },
      orderId: '9007199254740993',
      receiptId: crypto.randomUUID(),
      state: 'prepared',
      revision: 0,
      claimId: null,
      claimedAt: null,
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      errorCode: null,
    });
    await database.performanceCommands.add(job);
    api = {
      read: async (command) => {
        reads.push(command.operationId);
        return saved;
      },
      write: async (command) => {
        writes.push(command);
        saved = receipt(command);
        return saved;
      },
    };
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
  it('twenty observers across two tabs record one exact metadata intent without touching cash tables', async () => {
    peer = new PosDatabase(database.name);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        recordPreparedPerformance(job.id, '44', {
          ...options(),
          database: i % 2 ? peer : database,
        }),
      ),
    );
    expect(writes).toHaveLength(1);
    expect(reads).toHaveLength(0);
    expect(await database.performanceCommands.get(job.id)).toMatchObject({
      state: 'recorded',
      operationId: job.operationId,
      performance: job.performance,
    });
    expect(await database.completedSales.count()).toBe(0);
  });
  it('recovers a lost committed response by GET without another POST or new timing values', async () => {
    api.write = async (command) => {
      writes.push(command);
      saved = receipt(command);
      throw new Error('Fixture lost response');
    };
    expect(await recordPreparedPerformance(job.id, '44', options())).toMatchObject({
      state: 'unknown',
    });
    now += 5000;
    expect(await recordPreparedPerformance(job.id, '44', options())).toMatchObject({
      state: 'recorded',
      performance: job.performance,
    });
    expect(writes).toHaveLength(1);
    expect(reads).toEqual([job.operationId]);
  });
  it('looks up an uncommitted result before retrying exactly the original metadata body', async () => {
    api.write = async (command) => {
      writes.push(command);
      if (writes.length === 1) throw new Error('Fixture network failure');
      saved = receipt(command);
      return saved;
    };
    await recordPreparedPerformance(job.id, '44', options());
    now += 5000;
    await recordPreparedPerformance(job.id, '44', options());
    expect(reads).toEqual([job.operationId]);
    expect(writes).toHaveLength(2);
    expect(
      writes.map((command) => [command.operationId, command.orderId, command.performance]),
    ).toEqual(Array.from({ length: 2 }, () => [job.operationId, job.orderId, job.performance]));
    expect(await database.performanceCommands.get(job.id)).toMatchObject({ state: 'recorded' });
  });
  it('does not publish a late acknowledgement over a newer uncertain lease', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.write = async (command) => {
      writes.push(command);
      await held;
      saved = receipt(command);
      return saved;
    };
    const first = recordPreparedPerformance(job.id, '44', options());
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    now += 31000;
    api.read = async () => {
      throw new ApiError(503, 'TEMPORARY_FAILURE', 'Fixture unavailable');
    };
    expect(await recordPreparedPerformance(job.id, '44', options())).toMatchObject({
      state: 'unknown',
    });
    release();
    expect(await first).toMatchObject({ state: 'unknown' });
    now += 10000;
    api.read = async () => saved;
    expect(await recordPreparedPerformance(job.id, '44', options())).toMatchObject({
      state: 'recorded',
    });
    expect(writes).toHaveLength(1);
  });
  it('freezes a wrong receipt as unknown and never treats a different order or timing as recorded', async () => {
    api.write = async (command) => ({ ...receipt(command), orderId: '99' });
    expect(await recordPreparedPerformance(job.id, '44', options())).toMatchObject({
      state: 'unknown',
    });
    expect(() =>
      assertPerformanceReceipt(job, {
        ...receipt(),
        performance: { ...job.performance, add_to_cart: '1.00' },
      }),
    ).toThrow('original sale');
    const reordered = Object.fromEntries(Object.entries(job.performance).reverse());
    expect(
      assertPerformanceReceipt(job, {
        ...receipt(),
        performance: performanceValues.parse(reordered),
      }).performance,
    ).toEqual(job.performance);
  });
  it('keeps explicit permission rejection final and stops before HTTP when the operator changes', async () => {
    api.write = async () => {
      throw new ApiError(403, 'FORBIDDEN', 'Fixture denied');
    };
    expect(await recordPreparedPerformance(job.id, '44', options())).toMatchObject({
      state: 'rejected',
      errorCode: 'FORBIDDEN',
    });
    now += 10000;
    expect(await recordPreparedPerformance(job.id, '44', options())).toBe(null);
    setRequestOperator('45');
    await expect(syncPreparedPerformance('44', '1', '2', options())).rejects.toThrow(
      'operator changed',
    );
    expect(writes).toHaveLength(0);
  });
  it('does not let sleeping jobs starve a due metadata row, and never sends another counter’s work', async () => {
    await database.performanceCommands.delete(job.id);
    for (let i = 0; i < 12; i++)
      await database.performanceCommands.add({
        ...job,
        id: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        nextAttemptAt: now + 10000,
      });
    await database.performanceCommands.add(job);
    await syncPreparedPerformance('44', '1', '9', options());
    expect(writes).toHaveLength(0);
    await syncPreparedPerformance('44', '1', '2', options());
    expect(writes).toHaveLength(1);
    expect(writes[0]?.id).toBe(job.id);
  });
});
