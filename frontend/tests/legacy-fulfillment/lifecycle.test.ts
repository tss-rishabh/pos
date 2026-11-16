import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRequestOperator } from '../../src/api/client';
import {
  reconcileDeliveryCommand,
  recoverDeliveryCommand,
  submitDeliveryCommand,
} from '../../src/pages/legacy-fulfillment/lifecycle-client';
import {
  deliveryReceipt,
  type DeliveryReceipt,
} from '../../src/pages/legacy-fulfillment/lifecycle-contracts';
const result = (id: string): DeliveryReceipt =>
  deliveryReceipt.parse({
    commandId: id,
    actorId: '44',
    storeId: '1',
    orderId: '9007199254740993',
    action: 'cancel',
    phase: 'queued',
    version: 2,
    outcome: 'pending',
    nextStoreIds: ['2'],
    nextJobAt: null,
    newOrderId: null,
    courierOrderId: null,
    providerCallIds: [],
    auditIds: [],
    inventoryMovementCommandId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    errorCode: null,
    integrationState: 'pending',
    recoveryActorId: null,
    moneyHistoryId: null,
  });
describe('captured local-delivery command journal', () => {
  const storage = new Map<string, string>();
  let calls: { path: string; method: string; body: Record<string, unknown> | null }[] = [],
    saved: DeliveryReceipt | null = null;
  beforeEach(() => {
    calls = [];
    saved = null;
    storage.clear();
    setRequestOperator('44');
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });
  afterEach(() => {
    setRequestOperator(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('rejects an overlong cancellation reason before persistence or transport', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(() =>
      submitDeliveryCommand('44', '1', '9007199254740993', 'cancel', 'x'.repeat(201), ''),
    ).toThrow();
    expect(storage.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  function fetcher(mode: 'lost-commit' | 'lost-before' | 'mismatch' | 'denied') {
    let posts = 0;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input),
        method = init?.method || 'GET',
        body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ path, method, body });
      expect(new Headers(init?.headers).get('X-Operator-ID')).toBe('44');
      if (method === 'GET')
        return saved
          ? Response.json(saved)
          : Response.json(
              { error: { code: 'LOCAL_DELIVERY_COMMAND_NOT_FOUND', message: 'Not found.' } },
              { status: 404 },
            );
      posts++;
      if (mode === 'denied')
        return Response.json(
          { error: { code: 'LOCAL_DELIVERY_CANCELLATION_UNAVAILABLE', message: 'Not available.' } },
          { status: 409 },
        );
      if (mode === 'lost-before' && posts === 1) throw new TypeError('Fixture lost response.');
      saved =
        mode === 'mismatch'
          ? { ...result(String(body!.commandId)), storeId: '2' }
          : result(String(body!.commandId));
      if (mode === 'lost-commit') throw new TypeError('Fixture lost committed response.');
      return Response.json(saved);
    });
  }
  it('confirms a queued command after a lost committed response without redispatching cancellation', async () => {
    fetcher('lost-commit');
    const receipt = await submitDeliveryCommand(
      '44',
      '1',
      '9007199254740993',
      'cancel',
      'Private reason',
      '',
    );
    expect(receipt.phase).toBe('queued');
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    expect(storage.size).toBe(0);
    expect(calls[0]!.path).toBe(
      '/api/v1/stores/1/local-deliveries/orders/9007199254740993/cancellations',
    );
    expect(calls[0]!.path).not.toContain('Private');
  });
  it('reuses the exact UUID and body only on explicit retry, persisting no reason/category', async () => {
    fetcher('lost-before');
    await expect(
      submitDeliveryCommand(
        '44',
        '1',
        '9007199254740993',
        'cancel',
        'Private reason',
        'Private category',
      ),
    ).rejects.toThrow();
    expect(storage.size).toBe(1);
    expect([...storage.values()][0]).not.toContain('Private');
    await expect(
      submitDeliveryCommand(
        '44',
        '1',
        '9007199254740993',
        'cancel',
        'Changed reason',
        'Private category',
      ),
    ).rejects.toThrow('previous request');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    await submitDeliveryCommand(
      '44',
      '1',
      '9007199254740993',
      'cancel',
      'Private reason',
      'Private category',
    );
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toEqual(posts[1]!.body);
    expect(storage.size).toBe(0);
  });
  it('keeps unknown UUIDs after GET404 and rejects a receipt outside the captured store', async () => {
    fetcher('lost-before');
    await expect(
      submitDeliveryCommand('44', '1', '9007199254740993', 'cancel', '', ''),
    ).rejects.toThrow();
    expect(await recoverDeliveryCommand('44', '1', '9007199254740993', 'cancel')).toBeNull();
    expect(storage.size).toBe(1);
    const marker = JSON.parse([...storage.values()][0]!) as { commandId: string };
    saved = { ...result(marker.commandId), storeId: '2' };
    await expect(recoverDeliveryCommand('44', '1', '9007199254740993', 'cancel')).rejects.toThrow(
      'does not match',
    );
    expect(storage.size).toBe(1);
  });
  it('clears only a newly rejected command and never creates a marker after operator changes during hashing', async () => {
    fetcher('denied');
    await expect(
      submitDeliveryCommand('44', '1', '9007199254740993', 'cancel', '', ''),
    ).rejects.toThrow('Not available');
    expect(storage.size).toBe(0);
    calls = [];
    const original = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      const value = await original(...args);
      setRequestOperator('9');
      return value;
    });
    await expect(
      submitDeliveryCommand('44', '1', '9007199254740993', 'cancel', '', ''),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(storage.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
  it('uses a captured manager and exact expected version for evidence checks and rejects mismatched result scope', async () => {
    const receipt = result(crypto.randomUUID()),
      operation = { commandId: crypto.randomUUID(), expectedVersion: receipt.version };
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        '/api/v1/local-delivery-commands/' + receipt.commandId + '/reconciliations',
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        ...operation,
        reason: 'Read provider receipt',
      });
      expect(new Headers(init?.headers).get('X-Operator-ID')).toBe('44');
      return Response.json({ ...receipt, version: 3, storeId: '2' });
    });
    await expect(
      reconcileDeliveryCommand('44', receipt, 'Read provider receipt', operation),
    ).rejects.toThrow('does not match');
  });
  it('rejects a stale manager before any evidence-check transport', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    setRequestOperator('9');
    await expect(
      reconcileDeliveryCommand('44', result(crypto.randomUUID()), 'Read provider receipt', {
        commandId: crypto.randomUUID(),
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
