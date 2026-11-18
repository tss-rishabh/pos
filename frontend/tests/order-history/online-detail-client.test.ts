import { describe, expect, it } from 'vitest';
import {
  onlineOrderDetailLink,
  parseOnlineDetailLink,
} from '../../src/pages/order-history/online-detail-client';

describe('routed online detail workspace binding', () => {
  it('retains exact IDs and operator/store binding in reloadable and new-tab links', () => {
    const link = onlineOrderDetailLink({ id: '9' }, '2', '9007199254740993', 'N', {
      from: '2026-11-01',
      to: '2026-11-02',
    });
    const url = new URL(link, 'https://pos.example.invalid');
    expect(url.pathname).toBe('/orders/details/N/9007199254740993');
    expect(parseOnlineDetailLink('N', '9007199254740993', url.searchParams)).toEqual({
      operatorId: '9',
      storeId: '2',
      orderId: '9007199254740993',
      type: 'N',
      from: '2026-11-01',
      to: '2026-11-02',
    });
    const undated = new URL(
      onlineOrderDetailLink({ id: '9' }, '2', '123', 'HL'),
      'https://pos.example.invalid',
    );
    expect(undated.searchParams.has('from')).toBe(false);
    expect(undated.searchParams.has('to')).toBe(false);
  });
  it('rejects ambiguous or malformed routes before any private API request', () => {
    for (const [type, id, query] of [
      ['ST', '123', 'operatorId=9&storeId=2'],
      ['N', '1e3', 'operatorId=9&storeId=2'],
      ['N', '123', 'operatorId=9&storeId=2&storeId=1'],
      ['N', '123', 'operatorId=9&storeId=2&from=2026-11-01'],
      ['N', '123', 'operatorId=9&storeId=2&from=2026-11-02&to=2026-11-01'],
      ['N', '123', 'operatorId=9&storeId=2&customerId=7'],
      ['N', '123', 'storeId=2'],
    ] as const)
      expect(parseOnlineDetailLink(type, id, new URLSearchParams(query))).toBeNull();
  });
});
