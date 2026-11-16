import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';

export const dashboardCount = z
  .union([
    z.string().regex(/^\d+$/),
    z.number().int().safe().nonnegative(),
    z.bigint().nonnegative(),
  ])
  .transform(String)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
export const dashboardStore = z
  .object({ id: identifier, name: z.string().max(255).nullable() })
  .strict();
export type DashboardStore = z.infer<typeof dashboardStore>;
export const monthlyRow = z
  .object({
    store_id: identifier,
    year: z.coerce.number().int().min(1000).max(9999),
    month: z.coerce.number().int().min(1).max(12),
    order_count: dashboardCount,
  })
  .strict();
export type MonthlyRow = z.infer<typeof monthlyRow>;
export const dashboardMonths = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
export function dashboardBounds(now: Temporal.Instant, zone: string) {
  const today = now.toZonedDateTimeISO(zone).toPlainDate(),
    year = today.year,
    format = (date: Temporal.PlainDate) => date.toString() + ' 00:00:00';
  return {
    today: today.toString(),
    year,
    yearStart: `${year}-01-01 00:00:00`,
    dayStart: format(today),
    dayEnd: format(today.add({ days: 1 })),
  };
}
export function monthlySeries(
  stores: readonly DashboardStore[],
  rows: readonly MonthlyRow[],
  minimumYear: number,
) {
  const allowed = new Set(stores.map((store) => store.id)),
    seen = new Set<string>(),
    slots = new Map<string, string[]>();
  for (const store of stores) slots.set(store.id, Array<string>(12).fill('0'));
  for (const row of rows) {
    if (
      !allowed.has(row.store_id) ||
      row.year < minimumYear ||
      seen.has(`${row.store_id}:${row.year}:${row.month}`)
    )
      throw new AppError(
        503,
        'DASHBOARD_FACTS_INVALID',
        'Dashboard history does not match its source contract.',
      );
    seen.add(`${row.store_id}:${row.year}:${row.month}`);
    const counts = slots.get(row.store_id)!,
      index = row.month - 1,
      key = `${row.store_id}:${row.month}`;
    if (seen.has(key) && counts[index] !== row.order_count)
      throw new AppError(
        409,
        'DASHBOARD_MONTH_AMBIGUOUS',
        `Store ${row.store_id} has conflicting monthly counts across years. Reconcile future-dated orders before using this graph.`,
      );
    seen.add(key);
    counts[index] = row.order_count;
  }
  return stores.map((store) => ({ ...store, counts: slots.get(store.id)! }));
}
