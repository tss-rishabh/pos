import { Temporal } from '@js-temporal/polyfill';
import { Decimal } from 'decimal.js';
import {
  and,
  eq,
  exists,
  gt,
  gte,
  inArray,
  lte,
  notExists,
  sql,
  type SQLWrapper,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { Databases } from '../../db/pools.js';
import { Order, OrderStore, StoreDayClose } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import {
  offlineCashOrderLinks as links,
  offlineCashReceipts as receipts,
  offlineCashCloseImpacts as impacts,
  offlineCashImportProofs as proofs,
} from '../checkout/offline-cash/schema.js';
import { assertOfflineCashImportProofs } from '../checkout/offline-cash/import-proof.js';
import { money } from './domain.js';

export type OfflineCashExecutor = Pick<ReturnType<Databases['get']>, 'select'>;
export interface OfflineCashAggregate {
  storeId: string;
  date: string;
  cash: string;
  orderCount: number;
  pendingOrderCount: number;
}

/** Keep frozen close figures visible while exposing cash accepted after its latest revision. */
export async function lateOfflineCashForLatestClose(
  executor: OfflineCashExecutor,
  storeIds: string[],
  from: string,
  to: string,
) {
  if (!storeIds.length) return [];
  const newer = alias(StoreDayClose, 'offline_cash_newer_close');
  const rows = await executor
    .select({
      storeId: receipts.storeId,
      date: receipts.businessDate,
      cents: sql<string>`cast(sum(${receipts.payableCents}) as char)`,
    })
    .from(receipts)
    .innerJoin(impacts, eq(impacts.receiptId, receipts.id))
    .innerJoin(StoreDayClose, eq(StoreDayClose.id, impacts.closeId))
    .where(
      and(
        inArray(receipts.storeId, storeIds),
        gte(receipts.businessDate, from),
        lte(receipts.businessDate, to),
        eq(StoreDayClose.status, 'STALE'),
        eq(receipts.storeId, sql`cast(${StoreDayClose.store_id} as char)`),
        eq(receipts.businessDate, StoreDayClose.close_date),
        notExists(
          executor
            .select({ id: newer.id })
            .from(newer)
            .where(
              and(
                eq(newer.store_id, StoreDayClose.store_id),
                eq(newer.close_date, StoreDayClose.close_date),
                gt(newer.version, StoreDayClose.version),
              ),
            ),
        ),
      ),
    )
    .groupBy(receipts.storeId, receipts.businessDate);
  return rows.map((row) => ({
    storeId: row.storeId,
    date: row.date,
    cash: money(new Decimal(row.cents).div(100)),
  }));
}
const reconciliationRequired = () =>
  new AppError(
    503,
    'OFFLINE_CASH_RECONCILIATION_REQUIRED',
    'Offline cash evidence requires reconciliation before calculating financial totals.',
  );

/** The receipt remains the cash authority after import, refunds or access revocation. */
export async function aggregateOfflineCash(
  executor: OfflineCashExecutor,
  stores: string[],
  from: string,
  to: string,
): Promise<OfflineCashAggregate[]> {
  const storeIds = [...new Set(stores.map((store) => identifier.parse(store)))];
  Temporal.PlainDate.from(from);
  Temporal.PlainDate.from(to);
  if (from > to)
    throw new AppError(400, 'INVALID_DATE_RANGE', 'The To date is before the From date.');
  if (!storeIds.length) return [];
  const scope = and(
    inArray(receipts.storeId, storeIds),
    gte(receipts.businessDate, from),
    lte(receipts.businessDate, to),
  );
  const rows = await executor
    .select({
      storeId: receipts.storeId,
      date: receipts.businessDate,
      cashCents: sql<string>`cast(coalesce(sum(${receipts.payableCents}),0) as char)`,
      orderCount: sql<string>`cast(count(*) as char)`,
      pendingOrderCount: sql<string>`cast(sum(case when ${receipts.status}='imported' then 0 else 1 end) as char)`,
      invalidCount: sql<string>`cast(sum(case when ${receipts.status} in ('accepted','conflicted','importing','imported') and ${receipts.payableCents}>0 and ${receipts.changeCents}>=0 and ${receipts.cashReceivedCents}-${receipts.changeCents}=${receipts.payableCents} then 0 else 1 end) as char)`,
    })
    .from(receipts)
    .where(scope)
    .groupBy(receipts.storeId, receipts.businessDate);
  for (const row of rows) if (row.invalidCount !== '0') throw reconciliationRequired();
  await assertOfflineCashImportProofs(executor, { storeIds, from, to });
  return rows.map((row) => {
    const orderCount = Number(row.orderCount),
      pendingOrderCount = Number(row.pendingOrderCount);
    if (!Number.isSafeInteger(orderCount) || !Number.isSafeInteger(pendingOrderCount))
      throw reconciliationRequired();
    return {
      storeId: row.storeId,
      date: row.date,
      cash: money(new Decimal(row.cashCents).div(100)),
      orderCount,
      pendingOrderCount,
    };
  });
}

/** Correlated against the outer ordinary Order/OrderStore query; bind IDs as strings. */
export function matchedImportedOfflineOrder(
  executor: OfflineCashExecutor,
  outer: { orderId: SQLWrapper; storeId: SQLWrapper; counterId: SQLWrapper } = {
    orderId: Order.id,
    storeId: OrderStore.store,
    counterId: OrderStore.counter,
  },
) {
  return exists(
    executor
      .select({ id: links.receiptId })
      .from(links)
      .innerJoin(receipts, eq(receipts.id, links.receiptId))
      .innerJoin(proofs, eq(proofs.receiptId, links.receiptId))
      .where(
        and(
          eq(links.orderId, sql`cast(${outer.orderId} as char)`),
          eq(receipts.orderId, links.orderId),
          eq(receipts.status, 'imported'),
          eq(receipts.storeId, sql`cast(${outer.storeId} as char)`),
          eq(receipts.counterId, sql`cast(${outer.counterId} as char)`),
          eq(proofs.orderId, links.orderId),
          eq(links.payableCents, receipts.payableCents),
          eq(links.businessDate, receipts.businessDate),
          sql`${links.finalizedAt}>0`,
          sql`${links.projectionHash} regexp '^[a-f0-9]{64}$'`,
        ),
      ),
  );
}
