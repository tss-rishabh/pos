import { describe, expect, it } from 'vitest';
import {
  cashierPerformance,
  salespersonRatings,
  performanceTimeLabel,
  type CashierPerformanceRecord,
  type CashierSort,
} from '../../src/modules/operational-reports/performance-domain.js';
import { goldenStdout } from '../golden/load.js';
function row(
  order: number,
  cashier: number,
  quantity: number,
  overall: string | null,
  offset = '0',
): CashierPerformanceRecord {
  return {
    orderId: String(order),
    cashierId: String(cashier),
    cashierName: `Fixture ${cashier}`,
    quantity,
    performanceJson: JSON.stringify(
      overall === null
        ? {}
        : {
            overall_performance_time: overall,
            proceed_to_payment: offset,
            add_to_cart: '5',
            user_behaviour: '0',
          },
    ),
  };
}
describe('source staff performance arithmetic', () => {
  it('executes actual Python reducers for inferred timing, quantity weighting, ties, zero and negative durations', () => {
    const groups = [
      [],
      [row(1, 1, 0, '0')],
      [row(1, 1, 1, '1000')],
      [row(1, 1, 2, '1000'), row(2, 2, 3, '3000')],
      [row(1, 1, 2, null), row(2, 2, 4, '16000')],
      [row(1, 1, 1, '1', '1000'), row(2, 2, 2, '0', '0')],
      [row(1, 1, 1, '60505'), row(2, 2, 1, '59505')],
      [row(1, 1, 0, null), row(2, 2, 0, null)],
    ];
    const cashierCases = groups.flatMap((rows) =>
        (
          ['cashier_name', 'cashier_id', 'product_sold', 'time_taken', 'rating'] as CashierSort[]
        ).flatMap((sort) =>
          (['asc', 'desc'] as const).map((direction) => ({
            kind: 'cashier',
            rows,
            sort,
            direction,
          })),
        ),
      ),
      salesCases = [[], [0, 0], [1, 2, 3], [2.675, 5.35], [1.005, 10], [-1, -3], [0, -5]].map(
        (values) => ({
          kind: 'salesperson',
          rows: values.map((totalSales, index) => ({
            employeeId: String(index),
            storeName: 'Fixture',
            salespersonName: `Person ${index}`,
            totalSales,
          })),
        }),
      );
    const expected: unknown = JSON.parse(
      goldenStdout(
        'operational-reports',
        'performance-domain',
        JSON.stringify({ cases: [...cashierCases, ...salesCases] }),
      ),
    );
    expect([
      ...cashierCases.map((value) => cashierPerformance(value.rows, value.sort, value.direction)),
      ...salesCases.map((value) => salespersonRatings(value.rows)),
    ]).toEqual(expected);
  });
  it('fails malformed timing records with a static error and retains the source rounded-second display', () => {
    expect(() =>
      cashierPerformance(
        [{ ...row(1, 1, 2, '1'), performanceJson: 'invalid private payload' }],
        'rating',
        'desc',
      ),
    ).toThrowError('Some report timing data could not be processed.');
    expect(performanceTimeLabel(59999)).toBe('00M 60S');
    expect(performanceTimeLabel(-1)).toBe('-1D 23H 59M 60S');
  });
});
