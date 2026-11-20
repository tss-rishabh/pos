import { pythonRound2 as round } from '../domain/python-compat.js';

export interface Rollup {
  store_id: number;
  store_name: string;
  location_code: string;
  order_date: string;
  order_count: number;
  qty: number;
  revenue: number;
  membership_purchase_orders: number;
  membership_orders_total: number;
  membership_revenue: number;
  tss_money_used_total: number;
  tss_points_used_total: number;
  pg_discount_total: number;
  gift_voucher_total: number;
  district_total: number;
  cash_total: number;
  total_online: number;
  payment_correction_cash_out?: number;
}
type Metric = number | string | null;
export type DailyRow = Record<string, Metric>;
export interface ReportAux {
  footfall: Record<string, number>;
  target: Record<string, number>;
  banking: Record<string, number>;
}
const numeric = (v: unknown): number => (v ? round(Number(v)) : 0);
const integer = (v: unknown): number => (v ? Math.trunc(Number(v)) : 0);
const key = (r: Rollup) => `${r.location_code}\u0000${r.order_date}`;
/** Direct semantic port of AjaxDailyStoreReportView._merge_rows; tested against Python. */
export function mergeDailyRows(store: Rollup[], online: Rollup[], aux: ReportAux): DailyRow[] {
  const stores = new Map(store.map((r) => [key(r), r])),
    others = new Map(online.map((r) => [key(r), r]));
  const keys = [...new Set([...stores.keys(), ...others.keys()])].sort((a, b) => {
    const [al, ad] = a.split('\u0000'),
      [bl, bd] = b.split('\u0000');
    return ad! < bd! ? -1 : ad! > bd! ? 1 : al! < bl! ? -1 : al! > bl! ? 1 : 0;
  });
  return keys.map((k) => {
    const s = stores.get(k),
      o = others.get(k),
      r = (s || o)!;
    const combine = (attr: keyof Rollup, cast = numeric) => cast(s?.[attr]) + cast(o?.[attr]);
    const storeOrders = integer(s?.order_count),
      onlineOrders = integer(o?.order_count),
      orders = storeOrders + onlineOrders;
    const storeRevenue = numeric(s?.revenue),
      onlineRevenue = numeric(o?.revenue),
      revenue = round(storeRevenue + onlineRevenue);
    const storeQty = numeric(s?.qty),
      onlineQty = numeric(o?.qty),
      qty = round(storeQty + onlineQty);
    const purchased = combine('membership_purchase_orders', integer),
      members = combine('membership_orders_total', integer),
      memberRevenue = combine('membership_revenue');
    const eligible = orders - (members - purchased);
    const lookup = `${r.store_name.trim()}\u0000${r.order_date}`;
    const footfall = aux.footfall[lookup],
      target = aux.target[lookup];
    return {
      store_name: r.store_name,
      date: r.order_date,
      target: target === undefined ? null : numeric(target),
      store_revenue: storeRevenue,
      online_revenue: onlineRevenue,
      total_revenue: revenue,
      target_achieved_pct: target ? round((revenue / target) * 100) : null,
      store_orders: storeOrders,
      online_orders: onlineOrders,
      total_orders: orders,
      aov: orders ? round(revenue / orders) : 0,
      online_qty: onlineQty,
      store_qty: storeQty,
      total_qty: qty,
      basket_size: orders ? round(qty / orders) : 0,
      footfall: footfall === undefined ? null : numeric(footfall),
      conversion_pct: footfall ? round((orders / footfall) * 100) : null,
      membership_purchase_orders: purchased,
      membership_orders_total: members,
      membership_conversion_pct: eligible > 0 ? round((purchased / eligible) * 100) : 0,
      membership_aov: members ? round(memberRevenue / members) : 0,
      tss_money_used: combine('tss_money_used_total'),
      tss_points_used: combine('tss_points_used_total'),
      revenue_per_footfall: footfall ? round(revenue / footfall) : null,
      pg_discount: combine('pg_discount_total'),
      gift_voucher: numeric(s?.gift_voucher_total),
      district: numeric(s?.district_total),
      cash: numeric(s?.cash_total),
      total_online: numeric(s?.total_online),
      banking: numeric(aux.banking[`${r.store_id}\u0000${r.order_date}`]),
      membership_revenue: memberRevenue,
      ...(s?.payment_correction_cash_out === undefined
        ? {}
        : {
            payment_correction_cash_out: numeric(s.payment_correction_cash_out),
            cash_after_payment_corrections: round(
              numeric(s.cash_total) - numeric(s.payment_correction_cash_out),
            ),
          }),
    };
  });
}
const summed = [
  'target',
  'store_revenue',
  'online_revenue',
  'total_revenue',
  'store_orders',
  'online_orders',
  'total_orders',
  'online_qty',
  'store_qty',
  'total_qty',
  'footfall',
  'membership_purchase_orders',
  'membership_orders_total',
  'membership_revenue',
  'tss_money_used',
  'tss_points_used',
  'pg_discount',
  'gift_voucher',
  'district',
  'cash',
  'total_online',
  'banking',
] as const;
export function dailyTotals(rows: DailyRow[]): DailyRow {
  const totals: DailyRow = {};
  for (const key of summed) {
    const values = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
    totals[key] = values.length
      ? round(values.reduce<number>((sum, v) => sum + Number(v), 0))
      : null;
  }
  if (rows.some((row) => row.payment_correction_cash_out !== undefined)) {
    totals.payment_correction_cash_out = round(
      rows.reduce((sum, row) => sum + numeric(row.payment_correction_cash_out), 0),
    );
    totals.cash_after_payment_corrections = round(
      Number(totals.cash || 0) - Number(totals.payment_correction_cash_out),
    );
  }
  const n = (key: string) => Number(totals[key] || 0);
  const revenue = n('total_revenue'),
    orders = n('total_orders'),
    qty = n('total_qty'),
    footfall = n('footfall');
  const members = n('membership_orders_total'),
    purchased = n('membership_purchase_orders'),
    eligible = orders - (members - purchased);
  return {
    ...totals,
    store_name: 'Total',
    date: '',
    target_achieved_pct: n('target') ? round((revenue / n('target')) * 100) : null,
    aov: orders ? round(revenue / orders) : 0,
    basket_size: orders ? round(qty / orders) : 0,
    conversion_pct: footfall ? round((orders / footfall) * 100) : null,
    membership_conversion_pct: eligible > 0 ? round((purchased / eligible) * 100) : 0,
    membership_aov: members ? round(n('membership_revenue') / members) : 0,
    revenue_per_footfall: footfall ? round(revenue / footfall) : null,
  };
}
