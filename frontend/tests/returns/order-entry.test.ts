import { describe, expect, it } from 'vitest';
import {
  matchingReturnEntryLine,
  readReturnOrderEntry,
  returnOrderLink,
} from '../../src/pages/returns/order-entry';

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
      `${search}&__proto__=example`,
      `${search}&constructor=example`,
      search.replace('exchange', 'refund'),
    ]) {
      expect(readReturnOrderEntry(value, context)).toEqual({ status: 'invalid' });
    }
  });
  it('keeps ordinary returns available without a linked selection', () => {
    expect(readReturnOrderEntry('', context)).toEqual({ status: 'absent' });
  });
});

describe('verified line selection hints', () => {
  const linked = { ...entry, lineId: '9007199254740995' };
  const line = {
    id: linked.lineId,
    productId: '8',
    name: 'Synthetic',
    parentId: '7',
    quantity: '1',
    status: 'DELIVERED',
    returnStatus: 0,
  };
  it('retains exact wide line IDs in a reloadable bound URL', () => {
    expect(readReturnOrderEntry(returnOrderLink(linked).slice('/returns'.length), context)).toEqual(
      { status: 'ready', entry: linked },
    );
  });
  it('selects only a matching line returned for the verified order and mode', () => {
    expect(matchingReturnEntryLine(linked, entry.orderId, 'exchange', [line])).toBe(line);
    expect(matchingReturnEntryLine(linked, '2', 'exchange', [line])).toBeNull();
    expect(matchingReturnEntryLine(linked, entry.orderId, 'return', [line])).toBeNull();
    expect(matchingReturnEntryLine(linked, entry.orderId, 'exchange', [])).toBeNull();
    expect(matchingReturnEntryLine(linked, entry.orderId, 'exchange', [line, line])).toBeNull();
  });
  it('refuses returned or unbound replacement lines', () => {
    for (const invalid of [
      { ...line, status: 'PRODUCT_RETURNED' },
      { ...line, returnStatus: 1 },
      { ...line, parentId: '0' },
    ])
      expect(matchingReturnEntryLine(linked, entry.orderId, 'exchange', [invalid])).toBeNull();
  });
  it('rejects invalid line hints without throwing', () => {
    for (const id of ['0', '1e3', '9223372036854775808'])
      expect(readReturnOrderEntry(`${search}&lineId=${id}`, context)).toEqual({
        status: 'invalid',
      });
  });
});
