import { describe, expect, it } from 'vitest';
import { readReturnOrderEntry, returnOrderLink } from '../../src/pages/returns/order-entry';

const context = { operatorId: '1', storeId: '2', counterId: '3' };
const entry = { ...context, orderId: '9007199254740993', kind: 'exchange' as const };
const search = returnOrderLink(entry).slice('/returns'.length);

describe('order-bound return navigation', () => {
  it('preserves large IDs and the selected flow across a copied URL', () => {
    expect(readReturnOrderEntry(search, context)).toEqual({ status: 'ready', entry });
  });
  it.each(['operatorId', 'storeId', 'counterId'] as const)('refuses a different %s', (key) => {
    expect(readReturnOrderEntry(search, { ...context, [key]: '4' })).toEqual({
      status: 'mismatch',
    });
  });
  it.each(['orderId=1', 'kind=return', 'operatorId=1'])('rejects duplicate %s', (duplicate) => {
    expect(readReturnOrderEntry(`${search}&${duplicate}`, context)).toEqual({ status: 'invalid' });
  });
  it.each(['1e3', '1.5', '-1', '0', '9223372036854775808', '9'.repeat(1000)])(
    'rejects malformed or oversized identifiers without throwing',
    (orderId) => {
      const params = new URLSearchParams(search);
      params.set('orderId', orderId);
      expect(readReturnOrderEntry(`?${params}`, context)).toEqual({ status: 'invalid' });
    },
  );
  it('rejects incomplete, unexpected and invalid flow parameters', () => {
    for (const value of [
      '?orderId=1',
      `${search}&customerEmail=example`,
      search.replace('exchange', 'refund'),
    ]) {
      expect(readReturnOrderEntry(value, context)).toEqual({ status: 'invalid' });
    }
  });
  it('keeps ordinary returns available without a linked selection', () => {
    expect(readReturnOrderEntry('', context)).toEqual({ status: 'absent' });
  });
});
