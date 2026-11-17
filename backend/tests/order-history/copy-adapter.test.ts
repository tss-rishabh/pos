import { describe, expect, it, vi } from 'vitest';
import {
  copyFactsSchema,
  type CopySource,
} from '../../src/modules/checkout/order-copy/contracts.js';
import type { OrderHistoryPort } from '../../src/modules/order-history/contracts.js';
import { historicalOrderCopyFacts } from '../../src/modules/order-history/copy-adapter.js';

describe('historical source facts shared by order browsing and copying', () => {
  it.each<CopySource>([
    { kind: 'store', storeId: '9007199254740993', orderId: '9007199254740994' },
    { kind: 'customer', orderId: '9007199254740994' },
  ])(
    'binds the $kind source and preserves only the validated copy fact contract',
    async (source) => {
      const copyFacts = vi.fn<OrderHistoryPort['copyFacts']>(async (request) => ({
        orderId: request.orderId,
        sourceCustomerId: '7',
        createdAt: '2026-11-01 10:00:00',
        source: request.source,
        reader: 'bigquery',
        fetchedAt: '2026-11-16T10:00:00.000Z',
        generationId: '00000000-0000-4000-8000-000000000001',
        complete: true,
        lines: [{ lineId: '9007199254740995', productId: '9007199254740996' }],
      }));
      const response = await historicalOrderCopyFacts({ copyFacts }).read({
        source,
        targetCustomerId: '7',
        cutoff: '2026-11-16 00:00:00',
      });
      expect(copyFacts).toHaveBeenCalledWith({
        source:
          source.kind === 'store'
            ? { kind: 'store', storeId: source.storeId }
            : { kind: 'customer', customerId: '7' },
        orderId: source.orderId,
        cutoff: '2026-11-16 00:00:00',
      });
      expect(copyFactsSchema.parse(response)).toEqual(response);
      expect(response.sourceStoreId).toBe(source.kind === 'store' ? source.storeId : null);
      expect(response.lines).toEqual([
        { lineId: '9007199254740995', productId: '9007199254740996' },
      ]);
      expect(response).not.toHaveProperty('source');
    },
  );
  it('preserves a failed publication read without a substitute source or invented result', async () => {
    const failure = new Error('Synthetic publication unavailable');
    const copyFacts = vi.fn<OrderHistoryPort['copyFacts']>(async () => {
      throw failure;
    });
    await expect(
      historicalOrderCopyFacts({ copyFacts }).read({
        source: { kind: 'customer', orderId: '1' },
        targetCustomerId: '7',
        cutoff: '2026-11-16 00:00:00',
      }),
    ).rejects.toBe(failure);
    expect(copyFacts).toHaveBeenCalledOnce();
  });
});
