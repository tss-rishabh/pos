import { describe, expect, it, vi } from 'vitest';
import {
  dispatchIpc,
  registerOfflineIpc,
  type IpcHandlers,
  type IpcMainLike,
} from '../../electron/offline/ipc';
import { OfflineBillingError } from '../../electron/offline/service';

const requestId = '6f1c1d3e-2f0a-4b8e-9c55-3a1d2b4c5e6f';

function handlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  const fail = () => {
    throw new Error('not expected');
  };
  return {
    'offline:status': fail,
    'offline:catalog:search': fail,
    'offline:catalog:barcode': fail,
    'offline:catalog:refresh': fail,
    'offline:salespeople:list': fail,
    'offline:sale:create': fail,
    'offline:sale:list': fail,
    'offline:sale:reprint': fail,
    'offline:sync:status': fail,
    'offline:sync:retry': fail,
    'offline:conflict:resolve': fail,
    'diagnostics:ui-error': fail,
    ...overrides,
  };
}
const sale = {
  saleId: '0b9f1a2c-3d4e-4f50-8a61-7b8c9d0e1f2a',
  storeId: '12',
  counterId: '3',
  lines: [{ productId: '1001', quantity: 2 }],
  salespersonId: '4401',
  tender: { mode: 'card', reference: 'RRN998877' },
};

describe('IPC validation', () => {
  it('rejects malformed envelopes without calling the handler', async () => {
    const log = vi.fn();
    const create = vi.fn();
    const reply = await dispatchIpc(
      'offline:sale:create',
      { payload: sale },
      handlers({ 'offline:sale:create': create }),
      log,
    );
    expect(reply).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(create).not.toHaveBeenCalled();
  });
  it.each([
    ['unknown field', { ...sale, discount: 10 }],
    ['duplicate product', { ...sale, lines: [sale.lines[0], sale.lines[0]] }],
    ['zero quantity', { ...sale, lines: [{ productId: '1001', quantity: 0 }] }],
    ['client price', { ...sale, lines: [{ productId: '1001', quantity: 1, price: 1 }] }],
    ['card without reference', { ...sale, tender: { mode: 'card' } }],
    ['coupon tender', { ...sale, tender: { mode: 'coupon', code: 'X' } }],
    ['bad store id', { ...sale, storeId: '1 OR 1=1' }],
  ])('rejects %s', async (_name, payload) => {
    const create = vi.fn();
    const reply = await dispatchIpc(
      'offline:sale:create',
      { requestId, payload },
      handlers({ 'offline:sale:create': create }),
      vi.fn(),
    );
    expect(reply).toEqual({
      ok: false,
      requestId,
      error: { code: 'INVALID_REQUEST', message: 'Check the entered details.' },
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('dispatches a valid call with the requestId as traceId', async () => {
    const create = vi.fn(async (_payload: unknown, traceId: string) => ({ traceId }));
    const reply = await dispatchIpc(
      'offline:sale:create',
      { requestId, payload: sale },
      handlers({ 'offline:sale:create': create }),
      vi.fn(),
    );
    expect(reply).toEqual({ ok: true, requestId, data: { traceId: requestId } });
    expect(create).toHaveBeenCalledWith(sale, requestId);
  });
  it('requires a manager reason and a tender only when correcting it', async () => {
    const resolve = vi.fn();
    const base = { saleId: sale.saleId, reason: 'Customer paid by card' };
    for (const payload of [
      { ...base, action: 'correct-tender' },
      { ...base, action: 'accept', tender: { mode: 'cash', receivedPaise: 100 } },
      { ...base, action: 'void', reason: 'no' },
    ]) {
      const reply = await dispatchIpc(
        'offline:conflict:resolve',
        { requestId, payload },
        handlers({ 'offline:conflict:resolve': resolve }),
        vi.fn(),
      );
      expect(reply.ok).toBe(false);
    }
    expect(resolve).not.toHaveBeenCalled();
  });
  it('maps domain errors and hides unexpected failures', async () => {
    const domain = await dispatchIpc(
      'offline:status',
      { requestId, payload: {} },
      handlers({
        'offline:status': () => {
          throw new OfflineBillingError('ORDER_LIMIT', 'Offline order limit reached.');
        },
      }),
      vi.fn(),
    );
    expect(domain).toMatchObject({ ok: false, error: { code: 'ORDER_LIMIT' } });
    const hidden = await dispatchIpc(
      'offline:status',
      { requestId, payload: {} },
      handlers({
        'offline:status': () => {
          throw new Error('SQLITE_CORRUPT at /Users/someone/secret.db');
        },
      }),
      vi.fn(),
    );
    expect(hidden).toMatchObject({ ok: false, error: { code: 'OFFLINE_BILLING_FAILED' } });
    expect(JSON.stringify(hidden)).not.toContain('secret');
  });
  it('logs only channel, outcome, code and timing (no payload values)', async () => {
    const log = vi.fn();
    await dispatchIpc(
      'offline:sale:create',
      { requestId, payload: sale },
      handlers({ 'offline:sale:create': async () => ({}) }),
      log,
    );
    const line = JSON.stringify(log.mock.calls);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'offline.ipc.completed',
        channel: 'offline:sale:create',
        traceId: requestId,
      }),
    );
    expect(line).not.toContain('RRN998877');
    expect(line).not.toContain('1001');
  });
  it('refuses calls from untrusted senders', async () => {
    const registered = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const ipc: IpcMainLike = {
      handle: (channel, listener) => void registered.set(channel, listener),
      removeHandler: (channel) => void registered.delete(channel),
    };
    const status = vi.fn(() => ({}));
    const unregister = registerOfflineIpc(
      ipc,
      handlers({ 'offline:status': status }),
      (event) => event === 'trusted',
      vi.fn(),
    );
    expect(registered.size).toBe(12);
    const rejected = await registered.get('offline:status')!('evil', { requestId, payload: {} });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } });
    expect(status).not.toHaveBeenCalled();
    const accepted = await registered.get('offline:status')!('trusted', { requestId, payload: {} });
    expect(accepted).toMatchObject({ ok: true });
    unregister();
    expect(registered.size).toBe(0);
  });
});
