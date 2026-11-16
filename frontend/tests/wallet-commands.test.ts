import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/api/types';
import { ApiError, setRequestOperator } from '../src/api/client';
import { PosDatabase } from '../src/offline/database';
import {
  activeWalletCommand,
  beginNewWalletAdjustment,
  dispatchWalletAdjustment,
  prepareWalletAdjustment,
  refreshWalletAdjustment,
} from '../src/offline/benefits/commands';
import {
  walletAdjustmentReceiptSchema,
  type WalletAdjustmentInput,
  type WalletAdjustmentReceipt,
} from '../src/offline/benefits/contracts';
import {
  walletAdjustmentContract,
  walletCorrectionPatchHash,
} from '../src/offline/benefits/fields';

describe('durable owner-bound wallet adjustment commands', () => {
  const user: Principal = {
      id: '44',
      name: 'Fixture administrator',
      email: 'operator@example.test',
      role: 2,
      userType: 1,
      storeIds: ['1'],
    },
    input = {
      customerId: '9007199254740993',
      adjustment: {
        asset: 'money' as const,
        direction: 'add' as const,
        amount: '10.00',
        platform: 'ORDER_REFUND' as const,
        reason: 'Other' as const,
        orderId: '0',
        productId: '0',
        expiry: '2026-12-31',
      },
    },
    storage = new Map<string, string>();
  let database: PosDatabase,
    peer: PosDatabase | undefined,
    now: number,
    server: WalletAdjustmentReceipt | undefined,
    requests: WalletAdjustmentInput[];
  const receipt = (request: WalletAdjustmentInput) =>
    walletAdjustmentReceiptSchema.parse({
      operationId: request.operationId,
      operatorId: user.id,
      customerId: request.customerId,
      asset: request.adjustment.asset,
      direction: request.adjustment.direction,
      amount: Number(request.adjustment.amount).toFixed(2),
      balanceBefore: '100.00',
      balanceAfter: (100 + Number(request.adjustment.amount)).toFixed(2),
      historyId: '9007199254740994',
      consumedHistories: 0,
      contract: walletAdjustmentContract,
      patchHash: walletCorrectionPatchHash,
      createdAt: '2026-11-16 10:00:00',
    });
  const read = async () => {
    if (!server)
      throw new ApiError(404, 'WALLET_ADJUSTMENT_NOT_FOUND', 'Fixture result not yet confirmed.');
    return server;
  };
  const options = () => ({ database, clock: () => now, read });
  const prepare = () => prepareWalletAdjustment(user, input, options());
  async function restart() {
    peer?.close();
    peer = undefined;
    const name = database.name;
    database.close();
    database = new PosDatabase(name);
  }
  beforeEach(async () => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    setRequestOperator(user.id);
    now = Date.parse('2026-11-16T04:30:00Z');
    server = undefined;
    requests = [];
    database = new PosDatabase('wallet-command-test-' + crypto.randomUUID());
    await database.sessions.add({ id: 'current', user, expiresAt: now + 3600000 });
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
  it('captures20 simultaneous tab submissions once, persists before POST and retains its receipt across reopen', async () => {
    peer = new PosDatabase(database.name);
    const prepared = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        prepareWalletAdjustment(user, input, {
          ...options(),
          database: index % 2 ? peer : database,
        }),
      ),
    );
    expect(new Set(prepared.map((value) => value.id)).size).toBe(1);
    const id = prepared[0]!.id;
    const send = async (actor: string, request: WalletAdjustmentInput) => {
      requests.push(request);
      expect(actor).toBe(user.id);
      expect((await peer!.walletCommands.get(id))?.state).toBe('dispatching');
      server = receipt(request);
      return server;
    };
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        dispatchWalletAdjustment(user, id, {
          ...options(),
          database: index % 2 ? peer : database,
          send,
        }),
      ),
    );
    expect(requests).toHaveLength(1);
    await restart();
    expect(await activeWalletCommand(user, options())).toMatchObject({
      id,
      state: 'completed',
      receipt: server,
    });
    expect(await database.walletCommands.count()).toBe(1);
    expect(await database.completedSales.count()).toBe(0);
    expect(JSON.stringify(await database.walletCommands.toArray())).not.toMatch(
      /operator@example|Fixture administrator|email/i,
    );
  });
  it('reconciles a committed lost response after reload with GET alone', async () => {
    const command = await prepare(),
      send = async (_actor: string, request: WalletAdjustmentInput) => {
        requests.push(request);
        server = receipt(request);
        throw new Error('Fixture response lost after commit');
      };
    await expect(
      dispatchWalletAdjustment(user, command.id, { ...options(), send }),
    ).rejects.toThrow('response lost');
    expect((await database.walletCommands.get(command.id))?.state).toBe('uncertain');
    await restart();
    await refreshWalletAdjustment(user, command.id, options());
    await dispatchWalletAdjustment(user, command.id, { ...options(), send }, true);
    expect(requests).toHaveLength(1);
    expect((await database.walletCommands.get(command.id))?.state).toBe('completed');
  });
  it('keeps30 unknown-result status checks read-only and retries the original UUID/body only after explicit action', async () => {
    const command = await prepare(),
      send = async (_actor: string, request: WalletAdjustmentInput) => {
        requests.push(request);
        if (requests.length === 1) throw new Error('Fixture interruption before commit');
        server = receipt(request);
        return server;
      };
    await expect(
      dispatchWalletAdjustment(user, command.id, { ...options(), send }),
    ).rejects.toThrow('interruption');
    await restart();
    for (let index = 0; index < 30; index++) {
      now += 30000;
      await refreshWalletAdjustment(user, command.id, options());
      await dispatchWalletAdjustment(user, command.id, { ...options(), send });
    }
    expect(requests).toHaveLength(1);
    await dispatchWalletAdjustment(user, command.id, { ...options(), send }, true);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect((await database.walletCommands.get(command.id))?.state).toBe('completed');
  });
  it('preserves an interrupted dispatch for the original actor and aborts late publication after an account switch', async () => {
    const command = await prepare(),
      send = async (_actor: string, request: WalletAdjustmentInput) => {
        requests.push(request);
        server = receipt(request);
        setRequestOperator('45');
        return server;
      };
    await dispatchWalletAdjustment(user, command.id, { ...options(), send });
    expect((await database.walletCommands.get(command.id))?.state).toBe('dispatching');
    setRequestOperator(user.id);
    await refreshWalletAdjustment(user, command.id, options());
    expect((await database.walletCommands.get(command.id))?.receipt).toEqual(server);
    expect(requests).toHaveLength(1);
  });
  it('stops on cached role/type/full assignment/expiry/logout changes without dropping its original intent', async () => {
    const command = await prepare(),
      send = vi.fn();
    for (const changed of [
      { ...user, role: 3 as const },
      { ...user, userType: 2 as const },
      { ...user, storeIds: ['1', '2'] },
      { ...user, id: '45' },
    ]) {
      await database.sessions.put({ id: 'current', user: changed, expiresAt: now + 60000 });
      await dispatchWalletAdjustment(user, command.id, { ...options(), send });
      expect(await activeWalletCommand(user, options())).toBeNull();
    }
    await database.sessions.put({ id: 'current', user, expiresAt: now });
    await dispatchWalletAdjustment(user, command.id, { ...options(), send });
    await database.sessions.put({ id: 'current', user, expiresAt: now + 60000 });
    storage.set('pos-pending-logout', '1');
    await dispatchWalletAdjustment(user, command.id, { ...options(), send });
    expect(send).not.toHaveBeenCalled();
    expect((await database.walletCommands.get(command.id))?.state).toBe('prepared');
  });
  it('keeps a newer command pointer when an older response arrives after GET-proven completion', async () => {
    const original = await prepare();
    let release: (value: WalletAdjustmentReceipt) => void = () => {
      throw new Error('Fixture request was not started.');
    };
    const pending = dispatchWalletAdjustment(user, original.id, {
      ...options(),
      send: async (_actor, request) => {
        requests.push(request);
        server = receipt(request);
        return new Promise<WalletAdjustmentReceipt>((resolve) => {
          release = resolve;
        });
      },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await refreshWalletAdjustment(user, original.id, options());
    expect(await beginNewWalletAdjustment(user, original.id, options())).toBe(true);
    const next = await prepareWalletAdjustment(
      user,
      { ...input, adjustment: { ...input.adjustment, amount: '20.00' } },
      options(),
    );
    release(server!);
    await pending;
    expect((await activeWalletCommand(user, options()))?.id).toBe(next.id);
    expect((await database.walletCommands.get(next.id))?.state).toBe('prepared');
    expect(await beginNewWalletAdjustment(user, original.id, options())).toBe(false);
    expect(await database.walletCommands.count()).toBe(2);
  });
  it('rejects changed money/customer/operation receipts without confirming or replacing its saved request', async () => {
    const command = await prepare();
    await expect(
      dispatchWalletAdjustment(user, command.id, {
        ...options(),
        send: async () => ({ ...receipt(command.request), amount: '20.00' }),
      }),
    ).rejects.toThrow('does not match');
    expect(await database.walletCommands.get(command.id)).toMatchObject({
      state: 'uncertain',
      request: command.request,
      receipt: null,
    });
    await expect(
      prepareWalletAdjustment(user, { ...input, customerId: '9007199254740995' }, options()),
    ).rejects.toThrow('Finish the saved');
    await expect(beginNewWalletAdjustment(user, command.id, options())).rejects.toThrow(
      'Confirm the saved',
    );
    expect(await database.walletCommands.count()).toBe(1);
  });
  it('rolls back a partial local command/pointer write before any dispatch', async () => {
    vi.spyOn(database.walletCommandOwners, 'add').mockRejectedValueOnce(
      new Error('Fixture storage exhausted'),
    );
    await expect(prepare()).rejects.toThrow('storage exhausted');
    expect(await database.walletCommands.count()).toBe(0);
    expect(await database.walletCommandOwners.count()).toBe(0);
    const command = await prepare();
    expect(command.state).toBe('prepared');
  });
  it('retains an uncertain command when local completion storage fails after the server committed, then proves it with GET', async () => {
    const command = await prepare(),
      failCompletion = (changes: object) => {
        if ('state' in changes && changes.state === 'completed')
          throw new Error('Fixture local completion storage failure');
      };
    database.walletCommands.hook('updating', failCompletion);
    await expect(
      dispatchWalletAdjustment(user, command.id, {
        ...options(),
        send: async (_actor, request) => {
          requests.push(request);
          server = receipt(request);
          return server;
        },
      }),
    ).rejects.toThrow('completion storage failure');
    expect((await database.walletCommands.get(command.id))?.state).toBe('uncertain');
    database.walletCommands.hook('updating').unsubscribe(failCompletion);
    await refreshWalletAdjustment(user, command.id, options());
    expect((await database.walletCommands.get(command.id))?.state).toBe('completed');
    expect(requests).toHaveLength(1);
  });
});
