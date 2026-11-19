import { and, eq, gt, gte, inArray, isNotNull, like, sql, type SQL } from 'drizzle-orm';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { describe, expect, it } from 'vitest';
import * as m from '../src/db/legacy-schema.js';
import { matchedPaymentCorrectionOrder } from '../src/modules/daily-report-corrections.js';

/**
 * W11 (ORM-only) evidence for fragment rewrites whose suites cannot run against the production
 * snapshot or do not reach the predicate: the former hand-written fragment and its Drizzle
 * operator render the same statement text (modulo whitespace) with the same bound values.
 */
const dialect = new MySqlDialect();
function rendered(value: SQL | undefined) {
  const query = dialect.sqlToQuery(value!);
  return { sql: query.sql.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ','), params: query.params };
}

describe('ORM operator rewrites render the former SQL', () => {
  it('keeps column references when a column is no longer wrapped in sql', () => {
    for (const [left, right] of [
      [m.Store.id, m.StoreCounter.store],
      [m.Store.id, m.StoreStorage.store],
      [m.Store.id, m.UserStore.store_id],
      [m.Store.id, m.PosMachine.store_id],
      [m.Store.id, m.PosPaytmMachine.store_id],
      [m.Store.id, m.ExpressLineItem.store_id],
      [m.UsersNotification.notification, m.Notification.id],
    ] as const)
      expect(rendered(eq(left, right))).toEqual(rendered(eq(left, sql`${right}`)));
  });

  it('renders the same predicates and bound values as the former fragments', () => {
    const day = '2026-11-19 00:00:00';
    expect(rendered(like(m.Attributes.attr, '%size%'))).toEqual(
      rendered(sql`${m.Attributes.attr} like ${'%size%'}`),
    );
    expect(rendered(gte(m.ProductInventoryLog.created_at, day))).toEqual(
      rendered(sql`${m.ProductInventoryLog.created_at} >= ${day}`),
    );
    expect(rendered(isNotNull(m.OrderStore.district_transaction_id))).toEqual(
      rendered(sql`${m.OrderStore.district_transaction_id} is not null`),
    );
    expect(rendered(gt(m.ProductStore.stock, 0))).toEqual(
      rendered(sql`${m.ProductStore.stock} > ${0}`),
    );
    expect(rendered(and(inArray(m.Store.id, [])))).toEqual(rendered(sql`false`));
  });

  it('keeps the verified payment-correction order predicate', () => {
    const order = sql.raw('o.id');
    expect(rendered(matchedPaymentCorrectionOrder(order, []))).toEqual(rendered(sql`false`));
    expect(rendered(matchedPaymentCorrectionOrder(order, ['7', '9007199254740993']))).toEqual(
      rendered(sql`${order} in (${7n}, ${9007199254740993n})`),
    );
  });
});
