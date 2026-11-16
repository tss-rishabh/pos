import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRequestOperator } from '../../src/api/client';
import {
  checkSavedLegacyCommand,
  sendLegacyCommand,
} from '../../src/pages/legacy-fulfillment/commands';
import type { LegacyReceipt } from '../../src/pages/legacy-fulfillment/contracts';

describe('captured legacy fulfillment command receipts', () => {
  const storage = new Map<string, string>();
  let calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [],
    reply: LegacyReceipt | null = null;
  const result = (commandId: string): LegacyReceipt => ({
    commandId,
    actorId: '44',
    storeId: '1',
    orderId: '9007199254740993',
    action: 'rto-receipt',
    outcome: 'rto-received',
    originalCommandId: null,
    recordedBy: 'rewrite',
    auditId: '9007199254742993',
    restoredUnits: '3',
    split: true,
    excludedLineCount: 1,
    steps: [],
    syncEventId: commandId,
    integrationState: 'pending',
    createdAt: Date.now(),
    correctionContract: 'pos-legacy-rto-same-store-hp-v1',
  });
  beforeEach(() => {
    calls = [];
    reply = null;
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    setRequestOperator('44');
  });
  afterEach(() => {
    setRequestOperator(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  function transport(mode: 'lost-after-commit' | 'retry-exact' | 'mismatch') {
    let posts = 0;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input),
        method = init?.method || 'GET',
        body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ method, path, body });
      expect(new Headers(init?.headers).get('X-Operator-ID')).toBe('44');
      if (method === 'GET')
        return reply
          ? Response.json(reply)
          : Response.json(
              { error: { code: 'LEGACY_COMMAND_NOT_FOUND', message: 'Not found.' } },
              { status: 404 },
            );
      posts++;
      const id = String(body!.commandId);
      if (mode === 'lost-after-commit') {
        reply = result(id);
        throw new TypeError('Fixture transport interrupted.');
      }
      if (mode === 'retry-exact' && posts === 1)
        throw new TypeError('Fixture transport interrupted.');
      reply = mode === 'mismatch' ? { ...result(id), storeId: '2' } : result(id);
      return Response.json(reply);
    });
  }
  it('confirms a lost committed response by GET without another stock mutation', async () => {
    transport('lost-after-commit');
    const receipt = await sendLegacyCommand(
      '44',
      '1',
      '9007199254740993',
      'rto-receipt',
      'Checked parcel',
    );
    expect(receipt.restoredUnits).toBe('3');
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    expect(storage.size).toBe(0);
  });
  it('reuses the exact opaque command on an explicit unknown-outcome retry and never stores the free-text note', async () => {
    transport('retry-exact');
    await expect(
      sendLegacyCommand('44', '1', '9007199254740993', 'rto-receipt', 'Private business note'),
    ).rejects.toThrow();
    expect(storage.size).toBe(1);
    expect([...storage.values()][0]).not.toContain('Private business note');
    const pending = JSON.parse([...storage.values()][0]!) as Record<string, unknown>;
    expect(Object.keys(pending).sort()).toEqual(['commandId', 'hash']);
    await sendLegacyCommand('44', '1', '9007199254740993', 'rto-receipt', 'Private business note');
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toEqual(posts[1]!.body);
    expect(storage.size).toBe(0);
  });
  it('rejects a receipt for another store and retains reconciliation metadata', async () => {
    transport('mismatch');
    await expect(
      sendLegacyCommand('44', '1', '9007199254740993', 'rto-receipt', 'Checked'),
    ).rejects.toThrow('does not match');
    expect(storage.size).toBe(1);
  });
  it('aborts before marker creation or transport if the actor changes during hashing', async () => {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      const hash = await original(...args);
      setRequestOperator('9');
      return hash;
    });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      sendLegacyCommand('44', '1', '9007199254740993', 'rto-receipt', 'Checked'),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(storage.size).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never treats an absent saved receipt as authority to create a new command', async () => {
    transport('retry-exact');
    await expect(
      sendLegacyCommand('44', '1', '9007199254740993', 'rto-receipt', 'Checked'),
    ).rejects.toThrow();
    const count = calls.length;
    expect(await checkSavedLegacyCommand('44', '1', '9007199254740993', 'rto-receipt')).toBeNull();
    expect(calls.slice(count).map((call) => call.method)).toEqual(['GET']);
    expect(storage.size).toBe(1);
  });
});
