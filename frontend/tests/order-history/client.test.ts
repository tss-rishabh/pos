import { describe, expect, it } from 'vitest';
import {
  currentOrderDay,
  orderBrowserDates,
  orderBrowsePage,
} from '../../src/pages/order-history/client';
describe('public order browser date and keyset contracts', () => {
  it('uses the source business timezone and retains unknown-age deep links without an invented date', () => {
    const now = Date.parse('2026-11-16T20:00:00Z');
    expect(currentOrderDay(now)).toBe('2026-11-17');
    expect(orderBrowserDates(new URLSearchParams('orderId=1'), now)).toMatchObject({
      from: '2026-11-17',
      to: '2026-11-17',
      explicit: false,
      valid: true,
    });
    expect(
      orderBrowserDates(new URLSearchParams('from=2026-11-15&to=2026-11-16'), now),
    ).toMatchObject({ explicit: true, valid: true });
    expect(orderBrowserDates(new URLSearchParams('from=invalid'), now).valid).toBe(false);
    expect(orderBrowserDates(new URLSearchParams('from=2026-11-17&to=2026-11-15'), now).valid).toBe(
      false,
    );
  });
  it('accepts full-width order/association identities and bound opaque cursors without coercion', () => {
    const value = {
      data: [
        {
          id: '9007199254740993',
          rowId: '9007199254740995',
          reference: 'SYNTHETIC',
          storeId: '1',
          customer: 'Synthetic customer',
          amount: '1',
          status: '',
          paymentStatus: '',
          createdAt: '2026-11-16 00:00:00',
        },
      ],
      nextCursor: 'body.' + 'a'.repeat(43),
    };
    expect(orderBrowsePage.parse(value).data[0]?.rowId).toBe('9007199254740995');
    expect(orderBrowsePage.safeParse({ ...value, nextCursor: 'arbitrary' }).success).toBe(false);
  });
});
