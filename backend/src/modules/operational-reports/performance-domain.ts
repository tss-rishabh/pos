import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
export interface SalespersonPerformanceRecord {
  employeeId: string;
  storeName: string | null;
  salespersonName: string | null;
  totalSales: number | string;
}
export interface CashierPerformanceRecord {
  orderId: string;
  cashierId: string | null;
  cashierName: string | null;
  performanceJson: string;
  quantity: number | string | null;
}
const invalid = () =>
  new AppError(503, 'PERFORMANCE_DATA_INVALID', 'Some report timing data could not be processed.');
/** Python's round(float) uses ties to even, including negative values. */
function rounded(value: number) {
  if (!Number.isFinite(value)) throw invalid();
  const absolute = Math.abs(value),
    floor = Math.floor(absolute),
    fraction = absolute - floor,
    result = fraction > 0.5 || (fraction === 0.5 && floor % 2) ? floor + 1 : floor;
  return result === 0 ? 0 : value < 0 ? -result : result;
}
export function salespersonRatings(rows: SalespersonPerformanceRecord[]) {
  if (!rows.length) return [];
  const max = Math.max(...rows.map((row) => Number(row.totalSales)));
  if (!Number.isFinite(max)) throw invalid();
  return rows.map((row) => ({
    id: row.employeeId,
    store_name: row.storeName,
    salesperson_name: row.salespersonName,
    total_sales: row.totalSales,
    rating: max !== 0 ? rounded((Number(row.totalSales) * 100) / max) / 10 : 0,
  }));
}
function timing(value: unknown): number {
  if (typeof value !== 'string') throw invalid();
  const prefixed = '0' + value;
  if (!/^(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?)(?:[eE][+-]?\d(?:_?\d)*)?$/.test(prefixed))
    throw invalid();
  const result = Number(prefixed.replaceAll('_', ''));
  if (!Number.isFinite(result)) throw invalid();
  return result;
}
function performanceJson(value: string): Record<string, unknown> {
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(value) as unknown);
  } catch {
    throw invalid();
  }
}
export function performanceTimeLabel(milliseconds: number): string {
  const micros = rounded(milliseconds * 1000),
    days = Math.floor(micros / 86400000000),
    within = micros - days * 86400000000,
    hours = Math.floor(within / 3600000000),
    minutes = Math.floor((within % 3600000000) / 60000000),
    seconds = rounded((within % 60000000) / 1000000),
    minute = String(minutes).padStart(2, '0');
  return days !== 0
    ? `${days}D ${hours}H ${minute}M ${seconds}S`
    : hours
      ? `${hours}H ${minute}M ${seconds}S`
      : `${minute}M ${seconds}S`;
}
interface CashierSummary {
  id: string | null;
  cashier_name: string | null;
  product_sold: number;
  performanceTime: number;
  averageNeeded: number;
  perProductTime: number;
  score: number;
}
function stringOrder(left: string | null, right: string | null) {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  const a = Array.from(left),
    b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const first = a[index]!.codePointAt(0)!,
      second = b[index]!.codePointAt(0)!;
    if (first !== second) return first < second ? -1 : 1;
  }
  return a.length - b.length;
}
export type CashierSort = 'cashier_name' | 'cashier_id' | 'product_sold' | 'time_taken' | 'rating';
export function cashierPerformance(
  rows: CashierPerformanceRecord[],
  sort: CashierSort,
  direction: 'asc' | 'desc',
) {
  const staff = new Map<string | null, CashierSummary>(),
    perProduct: number[] = [];
  for (const row of rows) {
    const data = performanceJson(row.performanceJson),
      qty = Math.trunc(Number(row.quantity || 0));
    if (!Number.isSafeInteger(qty)) throw invalid();
    let current = staff.get(row.cashierId);
    if (!current) {
      current = {
        id: row.cashierId,
        cashier_name: row.cashierName,
        product_sold: 0,
        performanceTime: 0,
        averageNeeded: 0,
        perProductTime: 0,
        score: 0,
      };
      staff.set(row.cashierId, current);
    }
    current.product_sold += qty;
    const get = (key: string, fallback: string) => (data[key] === undefined ? fallback : data[key]);
    if (get('overall_performance_time', 'NaN') !== 'NaN') {
      const time =
        timing(get('overall_performance_time', '0')) -
        timing(get('proceed_to_payment', '0')) -
        timing(get('add_to_cart', '0')) -
        timing(get('user_behaviour', '0'));
      current.performanceTime += time;
      if (qty) perProduct.push(time / qty);
    } else current.averageNeeded += qty;
  }
  const average = perProduct.length
      ? perProduct.reduce((sum, value) => sum + value, 0) / perProduct.length
      : 0,
    values = [...staff.values()];
  for (const person of values)
    if (person.product_sold) {
      if (person.averageNeeded) person.performanceTime += person.averageNeeded * average;
      person.perProductTime = person.performanceTime / person.product_sold;
    }
  const times = values.map((person) => person.perProductTime),
    maximum = times.length ? Math.max(...times) : 0,
    minimumValue = times.length ? Math.min(...times) : 0,
    minimum = minimumValue !== maximum ? (3.33 * minimumValue - maximum) / 2.33 : 0;
  for (const person of values)
    person.score =
      maximum - minimum
        ? rounded(130 - ((person.perProductTime - minimum) * 100) / (maximum - minimum))
        : 100;
  values.sort((a, b) => {
    let compared: number;
    switch (sort) {
      case 'cashier_name':
        compared = stringOrder(a.cashier_name, b.cashier_name);
        break;
      case 'cashier_id':
        compared =
          a.id === b.id
            ? 0
            : a.id === null
              ? -1
              : b.id === null
                ? 1
                : BigInt(a.id) < BigInt(b.id)
                  ? -1
                  : 1;
        break;
      case 'product_sold':
        compared = a.product_sold - b.product_sold;
        break;
      case 'time_taken':
        compared = a.performanceTime - b.performanceTime;
        break;
      default:
        compared = a.score - b.score;
    }
    return direction === 'asc' ? compared : -compared;
  });
  return values.map((person) => ({
    id: person.id,
    cashier_name: person.cashier_name,
    product_sold: person.product_sold,
    time_taken: performanceTimeLabel(person.performanceTime),
    score: person.score,
  }));
}
