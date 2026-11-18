import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import {
  sourceOrderDefaults,
  sourceSearchReadPlan,
} from '../../src/modules/order-history/search/default-ranges.js';
import { orderSearchInput } from '../../src/modules/order-history/search/contracts.js';
import { orderRange } from '../../src/modules/order-history/contracts.js';
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
  it('keeps ordinary historical/mixed selections on the original complete whole-window contract', () => {
    const now = Date.parse('2026-11-18T12:00:00Z'),
      defaults = sourceOrderDefaults(now, 'Asia/Kolkata');
    const input = orderSearchInput.parse({
      ...defaults.store,
      from: '2026-11-13',
      to: '2026-11-18',
    });
    const plan = sourceSearchReadPlan(input, 'Asia/Kolkata', now);
    expect(plan.selected).toEqual(
      orderRange({ from: input.from, to: input.to }, 'Asia/Kolkata', now),
    );
    expect(plan.historical).toEqual(plan.selected);
    expect(plan.current).toBeUndefined();
  });
  it('preserves the midnight endpoint with a future PRIMARY fraction and no future warehouse day', () => {
    const now = Date.parse('2026-12-31T18:29:55Z'),
      defaults = sourceOrderDefaults(now, 'Asia/Kolkata');
    const input = orderSearchInput.parse({
      ...defaults.store,
      from: '2026-12-26',
      to: '2027-01-01',
    });
    const plan = sourceSearchReadPlan(input, 'Asia/Kolkata', now);
    expect(input.placedTo).toBe('2027-01-01 00:00:00');
    expect(plan.historical?.to).toBe('2026-12-31');
    expect(plan.current).toMatchObject({
      reader: 'primary',
      start: '2027-01-01 00:00:00',
      end: '2027-01-01 00:00:00.000001',
    });
    for (const orderType of ['ST', 'HL', 'HE', 'N'] as const)
      expect(
        sourceSearchReadPlan(
          orderSearchInput.parse({ ...input, orderType, storeIds: ['1'] }),
          'Asia/Kolkata',
          now,
        ),
      ).toEqual(plan);
    // A frozen original view remains exactly bounded after midnight; it is not regenerated.
    const later = sourceSearchReadPlan(input, 'Asia/Kolkata', now + 120000);
    expect(later.selected.to).toBe('2027-01-01');
    expect(input.placedTo).toBe(defaults.store.placedTo);
  });
  it('rejects tampered future dates/times and preserves invalid/span/report validation', () => {
    const now = Date.parse('2026-12-31T18:29:55Z'),
      base = {
        ...sourceOrderDefaults(now, 'Asia/Kolkata').store,
        from: '2026-12-26',
        to: '2027-01-01',
      };
    for (const change of [
      { placedTo: '2027-01-01 00:01:00' },
      { placedTo: '2026-12-31 23:59:00' },
      { intent: 'report' },
      { to: '2027-01-02' },
      { from: '2027-01-01' },
      { from: '2026-10-01' },
    ])
      expect(() =>
        sourceSearchReadPlan(orderSearchInput.parse({ ...base, ...change }), 'Asia/Kolkata', now),
      ).toThrow();
    expect(() =>
      sourceSearchReadPlan(
        orderSearchInput.parse({ from: '2026-12-31', to: '2026-12-26' }),
        'Asia/Kolkata',
        now,
      ),
    ).toThrow();
    expect(() => sourceOrderDefaults(now, 'Invalid/Zone')).toThrow();
    expect(() => sourceOrderDefaults(NaN, 'UTC')).toThrow();
  });
});
