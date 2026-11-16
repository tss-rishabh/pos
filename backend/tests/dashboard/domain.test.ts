import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { dashboardBounds, monthlySeries } from '../../src/modules/dashboard/domain.js';
import { readDashboardOptions } from '../../src/modules/dashboard/options.js';
describe('literal source dashboard month projection', () => {
  it('keeps store order and twelve zero months, including future-year source groups', () => {
    expect(
      monthlySeries(
        [
          { id: '2', name: 'Second' },
          { id: '1', name: 'First' },
        ],
        [{ store_id: '1', year: 2027, month: 3, order_count: '9007199254740993' }],
        2026,
      ),
    ).toEqual([
      { id: '2', name: 'Second', counts: Array<string>(12).fill('0') },
      {
        id: '1',
        name: 'First',
        counts: ['0', '0', '9007199254740993', '0', '0', '0', '0', '0', '0', '0', '0', '0'],
      },
    ]);
  });
  it('accepts same-value multi-year month overwrites but refuses source nondeterministic different counts', () => {
    const stores = [{ id: '1', name: 'Fixture' }],
      rows = [
        { store_id: '1', year: 2026, month: 1, order_count: '2' },
        { store_id: '1', year: 2027, month: 1, order_count: '2' },
      ];
    expect(monthlySeries(stores, rows, 2026)[0]?.counts[0]).toBe('2');
    expect(() =>
      monthlySeries(stores, [rows[0]!, { ...rows[1]!, order_count: '3' }], 2026),
    ).toThrowError(expect.objectContaining({ code: 'DASHBOARD_MONTH_AMBIGUOUS' }));
  });
  it('rejects foreign stores, duplicate groups and earlier-year rows', () => {
    const stores = [{ id: '1', name: 'Fixture' }],
      row = { store_id: '1', year: 2026, month: 1, order_count: '1' };
    for (const rows of [[{ ...row, store_id: '2' }], [row, row], [{ ...row, year: 2025 }]])
      expect(() => monthlySeries(stores, rows, 2026)).toThrowError(
        expect.objectContaining({ code: 'DASHBOARD_FACTS_INVALID' }),
      );
  });
  it('uses the configured business date/year at the UTC boundary and validates real publication options', () => {
    expect(dashboardBounds(Temporal.Instant.from('2025-12-31T18:30:00Z'), 'Asia/Kolkata')).toEqual({
      today: '2026-01-01',
      year: 2026,
      yearStart: '2026-01-01 00:00:00',
      dayStart: '2026-01-01 00:00:00',
      dayEnd: '2026-01-02 00:00:00',
    });
    expect(() => readDashboardOptions({ BQ_DASHBOARD_FACTS_VIEW: 'bad.sql;' })).toThrow();
    expect(readDashboardOptions({}).DASHBOARD_PUBLICATION_MAX_AGE_SECONDS).toBe(3600);
  });
});
