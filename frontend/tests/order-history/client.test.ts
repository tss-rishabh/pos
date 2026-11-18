import { describe, expect, it } from 'vitest';
import {
  currentOrderDay,
  orderBrowserDates,
  orderBrowsePage,
} from '../../src/pages/order-history/client';
import { defaultOrderRange, orderDefaultRanges } from '../../src/pages/order-history/search-client';
describe('public order browser date and keyset contracts', () => {
  it('uses validated server rolling bounds independently of device time and keeps explicit/invalid links authoritative', () => {
    const defaults = orderDefaultRanges.parse({
      generatedAt: '2026-12-31T18:29:55Z',
      timeZone: 'Asia/Kolkata',
      store: { placedFrom: '2026-12-26 23:59:00', placedTo: '2027-01-01 00:00:00' },
      online: { placedFrom: '2026-12-26 23:59:00', placedTo: '2026-12-31 23:59:00' },
    });
    expect(
      orderBrowserDates(new URLSearchParams(), Date.parse('2030-01-01T00:00:00Z'), defaults),
    ).toEqual({ from: '2026-12-26', to: '2027-01-01', explicit: false, valid: true });
    expect(
      orderBrowserDates(new URLSearchParams('orderId=9007199254740993'), 0, defaults).explicit,
    ).toBe(false);
    expect(
      orderBrowserDates(new URLSearchParams('from=2026-12-20&to=2026-12-21'), 0, defaults),
    ).toEqual({ from: '2026-12-20', to: '2026-12-21', explicit: true, valid: true });
    for (const query of ['from=invalid', 'from=2026-12-31&to=2026-12-01', 'to=2026-12-31'])
      expect(orderBrowserDates(new URLSearchParams(query), 0, defaults).valid).toBe(false);
    expect(defaultOrderRange(defaults, 'N').placedTo).toBe('2026-12-31 23:59:00');
    for (const type of ['ST', 'HL', 'HE'] as const)
      expect(defaultOrderRange(defaults, type).placedTo).toBe('2027-01-01 00:00:00');
    expect(orderDefaultRanges.safeParse({ ...defaults, timeZone: 'Invalid/Zone' }).success).toBe(
      false,
    );
    expect(
      orderDefaultRanges.safeParse({
        ...defaults,
        store: { ...defaults.store, placedTo: '2027-02-30 00:00:00' },
      }).success,
    ).toBe(false);
  });

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
