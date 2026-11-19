import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPaymentRecovery, savePaymentRecovery } from '../src/pages/checkout/payment-recovery';
describe('immutable payment request recovery', () => {
  const input = {
    operationId: '11111111-1111-4111-8111-111111111111',
    channel: 'cash' as const,
    cashAmount: '99.95',
    onlineAmount: '0.00',
    cashReceived: '100.00',
  };
  afterEach(() => vi.unstubAllGlobals());
  it('retains exact original intent across reload and accepts old ID-only references without inventing a retry body', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    savePaymentRecovery('owner:order', { version: 2, kind: 'payment', input });
    input.cashReceived = '101.00';
    expect(readPaymentRecovery('owner:order')?.intent).toMatchObject({
      input: { cashReceived: '100.00' },
    });
    values.set('old', input.operationId);
    expect(readPaymentRecovery('old')).toEqual({ attemptId: input.operationId, intent: null });
    values.set('broken', '{malformed');
    expect(() => readPaymentRecovery('broken')).toThrow('needs review');
  });
  it('fails before dispatch when durable storage is unavailable and rejects contact/free-text payload additions', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('Quota');
      },
    });
    expect(() =>
      savePaymentRecovery('owner:order', { version: 2, kind: 'payment', input }),
    ).toThrow('Quota');
    expect(() =>
      savePaymentRecovery('owner:order', {
        version: 2,
        kind: 'payment',
        input: { ...input, email: 'private@example.test' },
      } as unknown as Parameters<typeof savePaymentRecovery>[1]),
    ).toThrow();
  });
});
