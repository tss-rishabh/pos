import type { CopyFactsPort } from '../checkout/order-copy/contracts.js';
import type { OrderHistoryPort } from './contracts.js';

export function historicalOrderCopyFacts(
  history: Pick<OrderHistoryPort, 'copyFacts'>,
): CopyFactsPort {
  return {
    async read({ source, targetCustomerId, cutoff }) {
      const facts = await history.copyFacts({
        source:
          source.kind === 'store'
            ? { kind: 'store', storeId: source.storeId }
            : { kind: 'customer', customerId: targetCustomerId },
        orderId: source.orderId,
        cutoff,
      });
      return {
        orderId: facts.orderId,
        sourceCustomerId: facts.sourceCustomerId,
        sourceStoreId: source.kind === 'store' ? source.storeId : null,
        createdAt: facts.createdAt,
        reader: facts.reader,
        fetchedAt: facts.fetchedAt,
        generationId: facts.generationId,
        complete: facts.complete,
        lines: facts.lines,
      };
    },
  };
}
