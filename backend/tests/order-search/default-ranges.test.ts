import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { sourceOrderDefaults } from '../../src/modules/order-history/search/default-ranges.js';
import { searchWindow } from '../../src/modules/order-history/search/service.js';
import { orderSearchInput } from '../../src/modules/order-history/search/contracts.js';
import { goldenStdout } from '../golden/load.js';

const vectors = [
  ['2026-11-18T12:03:45.678Z', 'Asia/Kolkata'],
  ['2026-12-31T18:29:59.999Z', 'Asia/Kolkata'],
  ['2028-02-29T18:29:40Z', 'Asia/Kolkata'],
  ['2026-03-08T06:59:40Z', 'America/New_York'],
  ['2026-11-01T05:59:40Z', 'America/New_York'],
  ['2026-11-01T06:59:40Z', 'America/New_York'],
  ['2026-12-31T23:59:55Z', 'UTC'],
] as const;
describe('source-authoritative rolling order defaults', () => {
  it.each(vectors)(
    'matches literal original helper and active store view prefix at %s in %s',
    (instant, zone) => {
      const now = Date.parse(instant),
        defaults = sourceOrderDefaults(now, zone);
      const local = Temporal.Instant.fromEpochMilliseconds(now)
        .toZonedDateTimeISO(zone)
        .toPlainDateTime()
        .toString();
      for (const online of [false]) {
        const expected: unknown = JSON.parse(
          // Captured from the literal pinned helper and store-view prefix (see the
          // golden file's recorded program); the checkout path is not part of the key.
          goldenStdout('order-search', 'default-ranges', JSON.stringify({ local, online })),
        );
        expect(defaults.store).toEqual(expected);
      }
    },
  );
  it('accepts any legacy window and rejects only malformed ones', () => {
    const now = Date.parse('2026-12-31T18:29:55Z');
    // Legacy has no 62-day span or future-date limit.
    expect(searchWindow(orderSearchInput.parse({ from: '2024-01-01', to: '2027-01-01' }))).toEqual({
      start: '2024-01-01 00:00:00',
      end: '2027-01-02 00:00:00',
      inclusive: false,
    });
    expect(searchWindow(orderSearchInput.parse({}))).toBeNull();
    expect(() => orderSearchInput.parse({ from: '2026-12-31', to: '2026-12-26' })).toThrow();
    expect(() =>
      orderSearchInput.parse({
        placedFrom: '2026-12-31 10:00:00',
        placedTo: '2026-12-30 10:00:00',
      }),
    ).toThrow();
    expect(() => sourceOrderDefaults(now, 'Invalid/Zone')).toThrow();
    expect(() => sourceOrderDefaults(NaN, 'UTC')).toThrow();
  });
});
