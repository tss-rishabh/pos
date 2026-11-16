import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRequestOperator } from '../../src/api/client';
import type { Principal } from '../../src/api/types';
import { db } from '../../src/offline/database';
import {
  claimAutomaticInvoicePrint,
  createAutomaticInvoiceRequest,
  createAutomaticExchangeInvoiceRequest,
  currentAutomaticInvoice,
} from '../../src/pages/invoice-documents/automatic';
import { readInvoiceDocument, invoicePreviewPath } from '../../src/pages/invoice-documents/client';
import type { ConfirmedPayment } from '../../src/pages/checkout/receipts';

const user: Principal = {
    id: '44',
    role: 5,
    userType: 1,
    storeIds: ['1'],
    name: 'Fixture operator',
    email: 'fixture@example.test',
  },
  session = new Map<string, string>(),
  local = new Map<string, string>();
let receipt: ConfirmedPayment;
beforeEach(async () => {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key),
  });
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => session.set(key, value),
    removeItem: (key: string) => session.delete(key),
  });
  local.clear();
  session.clear();
  setRequestOperator(user.id);
  await db.sessions.put({ id: 'current', user, expiresAt: Date.now() + 300000 });
  const id = crypto.randomUUID();
  receipt = {
    status: 'paid',
    source: 'counter',
    orderId: '9007199254740993',
    receiptId: id,
    paymentAttemptId: id,
    transactionId: 'FIXTURE',
    cashAmount: '100.00',
    onlineAmount: '0.00',
  };
});
afterEach(async () => {
  await db.sessions.clear();
  setRequestOperator(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('fresh paid invoice print capability', () => {
  it('accepts exact counter/prepaid receipt bindings and rejects malformed or restored requests', () => {
    const request = createAutomaticInvoiceRequest(user, '1', receipt)!;
    expect(currentAutomaticInvoice(request, user)).toBe(true);
    expect(currentAutomaticInvoice(structuredClone(request), user)).toBe(false);
    expect(createAutomaticInvoiceRequest(user, '2', receipt)).toBeNull();
    expect(
      createAutomaticInvoiceRequest(user, '1', { ...receipt, receiptId: crypto.randomUUID() }),
    ).toBeNull();
    const id = crypto.randomUUID();
    expect(
      createAutomaticInvoiceRequest(user, '1', {
        status: 'paid',
        source: 'prepaid',
        orderId: receipt.orderId,
        receiptId: id,
        checkoutId: crypto.randomUUID(),
        checkoutOperationId: id,
        transactionId: '',
        cashAmount: '0.00',
        onlineAmount: '0.00',
      }),
    ).not.toBeNull();
  });
  it('brands completed exchange child evidence without fabricating a financial receipt', async () => {
    const evidence = {
        source: 'exchange' as const,
        exchangeId: crypto.randomUUID(),
        orderId: '9007199254740993',
      },
      request = createAutomaticExchangeInvoiceRequest(user, '1', evidence)!;
    expect(request.receipt).toEqual(evidence);
    expect(Object.keys(request.receipt).sort()).toEqual(['exchangeId', 'orderId', 'source']);
    expect(currentAutomaticInvoice(request, user)).toBe(true);
    expect(currentAutomaticInvoice(structuredClone(request), user)).toBe(false);
    expect(createAutomaticExchangeInvoiceRequest(user, '2', evidence)).toBeNull();
    expect(
      createAutomaticExchangeInvoiceRequest(user, '1', { ...evidence, exchangeId: 'invalid' }),
    ).toBeNull();
    expect(
      createAutomaticExchangeInvoiceRequest(user, '1', {
        ...evidence,
        orderId: '9223372036854775808',
      }),
    ).toBeNull();
    const claims = await Promise.all(
      Array.from({ length: 20 }, () =>
        claimAutomaticInvoicePrint(request, user, new AbortController().signal),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await claimAutomaticInvoicePrint(
        createAutomaticExchangeInvoiceRequest(user, '1', evidence)!,
        user,
        new AbortController().signal,
      ),
    ).toBe(false);
    const persisted = JSON.stringify([...session]);
    expect(session.size).toBe(1);
    for (const forbidden of [evidence.orderId, evidence.exchangeId, user.email, user.name])
      expect(persisted).not.toContain(forbidden);
  });
  it('claims once across20 concurrent attempts and fresh component request remounts', async () => {
    const request = createAutomaticInvoiceRequest(user, '1', receipt)!;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        claimAutomaticInvoicePrint(request, user, new AbortController().signal),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await claimAutomaticInvoicePrint(
        createAutomaticInvoiceRequest(user, '1', receipt)!,
        user,
        new AbortController().signal,
      ),
    ).toBe(false);
    expect([...session]).toHaveLength(1);
    expect([...session][0]![0]).toMatch(/^pos-invoice-print:[a-f0-9]{64}$/);
    expect([...session][0]![1]).toBe('1');
    const persisted = JSON.stringify([...session]);
    for (const forbidden of [
      receipt.orderId,
      receipt.receiptId,
      user.email,
      user.name,
      '100.00',
      '<html>',
    ])
      expect(persisted).not.toContain(forbidden);
  });
  it('expires after60seconds and refuses actor/role/scope changes before a claim', async () => {
    const request = createAutomaticInvoiceRequest(user, '1', receipt)!;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001);
    expect(currentAutomaticInvoice(request, user)).toBe(false);
    vi.restoreAllMocks();
    await db.sessions.put({
      id: 'current',
      user: { ...user, role: 4 },
      expiresAt: Date.now() + 300000,
    });
    await expect(
      claimAutomaticInvoicePrint(request, user, new AbortController().signal),
    ).rejects.toThrow('current operator');
    expect(session.size).toBe(0);
    setRequestOperator('55');
    expect(currentAutomaticInvoice(request, user)).toBe(false);
  });
  it('disables automatic printing if the attempt marker cannot be persisted', async () => {
    const request = createAutomaticInvoiceRequest(user, '1', receipt)!;
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('Storage denied');
      },
    });
    expect(await claimAutomaticInvoicePrint(request, user, new AbortController().signal)).toBe(
      false,
    );
  });
});
describe('private document reads', () => {
  const html =
    '<!doctype html><html><head><meta name="pos-invoice" content="sanitized"></head><body>Fixture</body></html>';
  it('uses only the exact owner-bound GET and validates the document scope', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      expect(String(input)).toBe(`/api/v1/stores/1/orders/${receipt.orderId}/invoices/online`);
      expect(options?.method ?? 'GET').toBe('GET');
      expect(new Headers(options?.headers).get('X-Operator-ID')).toBe(user.id);
      return Response.json({
        kind: 'online',
        storeId: '1',
        orderId: receipt.orderId,
        number: null,
        filename: `online-tax-invoice-${receipt.orderId}.html`,
        html,
      });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(
      (
        await readInvoiceDocument(
          user.id,
          '1',
          receipt.orderId,
          'online',
          new AbortController().signal,
        )
      ).html,
    ).toBe(html);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('loads SDD and selected Express downloads only through their captured actor paths', async () => {
    for (const kind of ['same-day', 'express'] as const) {
      const fetcher = vi.fn<typeof fetch>(async (input, options) => {
        expect(String(input)).toBe(`/api/v1/stores/1/orders/${receipt.orderId}/invoices/${kind}`);
        expect(new Headers(options?.headers).get('X-Operator-ID')).toBe(user.id);
        return Response.json({
          kind,
          storeId: '1',
          orderId: receipt.orderId,
          number: null,
          filename: `${kind}-tax-invoice-${receipt.orderId}.html`,
          html,
        });
      });
      vi.stubGlobal('fetch', fetcher);
      expect(
        await readInvoiceDocument(
          user.id,
          '1',
          receipt.orderId,
          kind,
          new AbortController().signal,
        ),
      ).toMatchObject({ kind, storeId: '1', orderId: receipt.orderId });
      expect(invoicePreviewPath(user.id, '1', receipt.orderId, kind)).toBe(
        `/api/v1/operators/${user.id}/stores/1/orders/${receipt.orderId}/invoices/${kind}/preview`,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('refuses a whole online invoice substituted for a selected Express document', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          kind: 'online',
          storeId: '1',
          orderId: receipt.orderId,
          number: null,
          filename: `online-tax-invoice-${receipt.orderId}.html`,
          html,
        }),
      ),
    );
    await expect(
      readInvoiceDocument(user.id, '1', receipt.orderId, 'express', new AbortController().signal),
    ).rejects.toThrow('does not match');
  });
  it('rejects substituted order/filename, active script and old actor results', async () => {
    for (const changes of [
      { orderId: '3' },
      { filename: 'tax-invoice-3.html' },
      { html: html + '<script>BAD</script>' },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            orderId: receipt.orderId,
            number: null,
            filename: `tax-invoice-${receipt.orderId}.html`,
            html,
            ...changes,
          }),
        ),
      );
      await expect(
        readInvoiceDocument(user.id, '1', receipt.orderId, 'store', new AbortController().signal),
      ).rejects.toThrow('does not match');
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        setRequestOperator('55');
        return Response.json({
          orderId: receipt.orderId,
          number: null,
          filename: `tax-invoice-${receipt.orderId}.html`,
          html,
        });
      }),
    );
    await expect(
      readInvoiceDocument(user.id, '1', receipt.orderId, 'store', new AbortController().signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
