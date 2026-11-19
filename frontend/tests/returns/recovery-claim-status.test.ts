import { afterEach, describe, expect, it, vi } from 'vitest';
import { setRequestOperator } from '../../src/api/client';
import {
  loadRecovery,
  saveRecovery,
  readExchangeClaimStatus,
} from '../../src/pages/returns/client';
const oldProof = '10000000-0000-4000-8000-000000000001',
  claimId = '10000000-0000-4000-8000-000000000003',
  operationId = '10000000-0000-4000-8000-000000000004';
afterEach(() => {
  setRequestOperator(null);
  vi.unstubAllGlobals();
});
describe('original recovery claim transport and retained command identity', () => {
  it('keeps the original claim/counter, restores a value saved with the removed return proof and reads the outcome without replaying POST', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const original = {
      orderId: '9240',
      returnId: null,
      kind: 'exchange' as const,
      pendingRecoveryClaim: {
        operationId: claimId,
        revision: 'a'.repeat(64),
        lineId: '9340',
        counterId: '3',
        salespersonId: '5',
      },
    };
    saveRecovery('44', '1', '3', original);
    expect(loadRecovery('44', '1', '3')).toEqual(original);
    // A value stored before the return OTP step was removed still restores its claim.
    values.set(
      'souled-return:44:1:3',
      JSON.stringify({
        ...original,
        verificationId: oldProof,
        pendingRecoveryClaim: { ...original.pendingRecoveryClaim, verificationId: oldProof },
      }),
    );
    expect(loadRecovery('44', '1', '3')).toEqual(original);
    const fetcher = vi.fn(
      async (_path: RequestInfo | URL, _options?: RequestInit) =>
        new Response(JSON.stringify({ status: 'recorded', operationId }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    setRequestOperator('44');
    expect(await readExchangeClaimStatus('1', '9240', '9340', claimId, '3', '44')).toEqual({
      status: 'recorded',
      operationId,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(path), 'http://127.0.0.1');
    expect(url.pathname).toBe(
      `/api/v1/stores/1/orders/9240/line-items/9340/exchange-recovery-claims/${claimId}`,
    );
    expect([...url.searchParams.keys()]).toEqual(['counterId']);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('X-Operator-ID')).toBe('44');
    expect(loadRecovery('44', '1', '3')?.pendingRecoveryClaim).toEqual(
      original.pendingRecoveryClaim,
    );
  });
  it('refuses a changed operator before sending a receipt lookup', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    setRequestOperator('45');
    await expect(
      readExchangeClaimStatus('1', '9240', '9340', claimId, '3', '44'),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires the exact minimal receipt envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ status: 'recorded', operationId, unexpected: 'unaccepted' }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    setRequestOperator('44');
    await expect(
      readExchangeClaimStatus('1', '9240', '9340', claimId, '3', '44'),
    ).rejects.toThrow();
  });
});
