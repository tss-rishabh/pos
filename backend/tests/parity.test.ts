import { describe, expect, it } from 'vitest';
import {
  mergeDailyRows,
  dailyTotals,
  type Rollup,
  type ReportAux,
} from '../src/modules/daily-report.js';
import { pythonRound2 } from '../src/domain/python-round.js';
import {
  addCartPayload,
  setCartPayload,
  deleteCartPayload,
  validatePayload,
  processPayload,
} from '../src/modules/upstream.js';
import { goldenStdout } from './golden/load.js';

function oracle(input: unknown): unknown {
  return JSON.parse(goldenStdout('core', 'parity', JSON.stringify(input)));
}
function row(partial: Partial<Rollup> = {}): Rollup {
  return {
    store_id: 1,
    store_name: 'Sample store',
    location_code: 'LOC-A',
    order_date: '2026-11-15',
    order_count: 3,
    qty: 4,
    revenue: 1200.125,
    membership_purchase_orders: 1,
    membership_orders_total: 2,
    membership_revenue: 700.15,
    tss_money_used_total: 12,
    tss_points_used_total: 5.5,
    pg_discount_total: 4.5,
    gift_voucher_total: 3,
    district_total: 50,
    cash_total: 400,
    total_online: 747,
    ...partial,
  };
}
describe('Parity against isolated execution of the original Python', () => {
  it('matches daily report rows and weighted footer totals, including missing dimensions', () => {
    const aux: ReportAux = {
      footfall: { ['Sample store\0' + '2026-11-15']: 17 },
      target: { ['Sample store\0' + '2026-11-15']: 5000 },
      banking: { ['1\0' + '2026-11-15']: 123.45 },
    };
    const cases: Array<{ store: Rollup[]; online: Rollup[]; aux: ReportAux }> = [
      { store: [], online: [], aux },
      { store: [row()], online: [], aux },
      { store: [], online: [row()], aux },
    ];
    for (let seed = 0; seed < 35; seed++)
      cases.push({
        store: [
          row({ order_count: seed % 6, revenue: seed * 24.675, qty: seed % 8 }),
          row({
            store_id: 2,
            location_code: 'LOC-B',
            store_name: ' Other store ',
            order_date: '2026-11-14',
            order_count: seed % 3,
            revenue: seed * 35.123,
          }),
        ],
        online: [
          row({
            order_count: seed % 4,
            revenue: seed * 13.555,
            qty: seed % 5,
            membership_purchase_orders: 0,
          }),
        ],
        aux,
      });
    expect(
      cases.map((c) => {
        const rows = mergeDailyRows(c.store, c.online, c.aux);
        return { rows, totals: dailyTotals(rows) };
      }),
    ).toEqual(oracle({ operation: 'reports', cases }));
  });
  it('preserves CPython binary float rounding at financial report boundaries', () => {
    const values = [
      2.675,
      1.005,
      4.125,
      -2.675,
      -1.005,
      0,
      0.125,
      1.375,
      10000000000.125,
      ...Array.from({ length: 1000 }, (_, i) => (i - 500) * 0.12345),
    ];
    expect(values.map(pythonRound2)).toEqual(oracle({ operation: 'round', values }));
  });
  it('preserves checkout request payloads for operator and customer carts', () => {
    const actual = [];
    for (const endUser of [false, true]) {
      const c = { storeId: 1, tabId: 2, endUser };
      actual.push(
        { path: 'pos/product', payload: addCartPayload(c, '8900000001001') },
        { path: 'cart', payload: setCartPayload(c, 1001, 3) },
        { path: 'cart', payload: deleteCartPayload(c, 1001) },
        { path: 'cart', payload: deleteCartPayload(c, 1001, 12) },
        { path: 'validatecheckout', payload: validatePayload(c) },
        { path: 'processorder', payload: processPayload(c, { products: { items: [] } }) },
      );
    }
    expect(actual).toEqual(oracle({ operation: 'payloads' }));
  });
});
