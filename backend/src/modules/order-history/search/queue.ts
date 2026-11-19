import { createHash } from 'node:crypto';
import { and, eq, exists, inArray, isNull, ne, notExists, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import {
  Order,
  OrderStore,
  OrderStatus,
  HyperlocalOrderLog,
  HyperlocalLocation,
  Store,
} from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import { positiveId } from '../contracts.js';
import type { OrderSearchInput, SourceSearchScope } from './contracts.js';
import { searchDataInvalid } from './format.js';
export interface LiveQueueOrder {
  locationLabel: string | null;
  id: string;
  statusId: string | null;
  status: { id: string; label: string } | null;
  locationId: string;
  locationType: string;
  transfer: number | null;
  nextLocations: string | null;
  ownerStoreId: string | null;
}
const backup = z
  .array(z.union([positiveId, z.number().int().positive().safe().transform(String)]))
  .max(40);
/** Token equality intentionally corrects the source's unsafe substring match (1 must not match 11). */
export function queuedForStore(next: string | null, storeId: string) {
  if (!next?.trim()) return false;
  let value: unknown;
  try {
    value = JSON.parse(next) as unknown;
  } catch {
    throw searchDataInvalid();
  }
  const parsed = backup.safeParse(value);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length)
    throw searchDataInvalid();
  return parsed.data.includes(storeId);
}
/** Legacy in_queue / not_packed selections (`orders_datatable.py:73-87`), with no row bound as legacy. */
export function sourceQueueRepository(db: Databases) {
  return async function discover(scope: SourceSearchScope, input: OrderSearchInput) {
    const storeId = scope.checkedInStoreId;
    if (!storeId)
      throw new AppError(
        409,
        'ORDER_QUEUE_CHECK_IN_REQUIRED',
        'Check in before opening this queue.',
      );
    const tx = db.get('primary');
    const rows = await tx
      .select({
        id: Order.id,
        statusId: Order.order_statuses,
        label: OrderStatus.order_status,
        relatedStatus: OrderStatus.id,
        locationId: Order.location_id,
        locationType: Order.location_type,
        transfer: Order.is_transfer,
        nextLocations: Order.next_location_ids,
        warehouseStore: HyperlocalLocation.store_id,
        warehouseCode: HyperlocalLocation.location_code,
        storeName: Store.store_name,
        storeCode: Store.location_code,
        relatedStore: Store.id,
      })
      .from(Order)
      .leftJoin(
        OrderStatus,
        and(eq(OrderStatus.id, Order.order_statuses), ne(Order.order_statuses, 0n)),
      )
      .leftJoin(
        HyperlocalLocation,
        and(
          eq(Order.location_type, 'NW'),
          eq(HyperlocalLocation.id, sql`CAST(${Order.location_id} AS SIGNED)`),
        ),
      )
      .leftJoin(
        Store,
        and(eq(Order.location_type, 'SW'), eq(Store.id, sql`CAST(${Order.location_id} AS SIGNED)`)),
      )
      .where(
        and(
          or(isNull(Order.order_statuses), ne(Order.order_statuses, 0n)),
          notExists(
            tx.select({ id: OrderStore.id }).from(OrderStore).where(eq(OrderStore.order, Order.id)),
          ),
          input.notPacked
            ? and(
                eq(sql<string>`CAST(${Order.location_id} AS CHAR)`, storeId),
                or(isNull(Order.order_statuses), ne(Order.order_statuses, 4n)),
                exists(
                  tx
                    .select({ id: HyperlocalOrderLog.id })
                    .from(HyperlocalOrderLog)
                    .where(
                      and(
                        eq(HyperlocalOrderLog.order_id, Order.id),
                        eq(HyperlocalOrderLog.action, 'ACCEPTED'),
                        eq(HyperlocalOrderLog.is_pack, 0),
                        eq(HyperlocalOrderLog.is_rto, 0),
                        eq(HyperlocalOrderLog.is_refunded, 0),
                      ),
                    ),
                ),
              )
            : undefined,
          input.inQueue
            ? and(
                eq(Order.order_statuses, 1n),
                inArray(Order.location_type, ['SW', 'NW']),
                or(
                  eq(sql<string>`CAST(${Order.location_id} AS CHAR)`, storeId),
                  and(
                    eq(Order.is_transfer, 1),
                    sql`${Order.next_location_ids} LIKE ${'%' + storeId + '%'}`,
                  ),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(Order.id);
    const orders: LiveQueueOrder[] = [];
    for (const row of rows) {
      if (row.locationId === null) continue;
      const locationId = String(row.locationId),
        ownerStoreId =
          row.locationType === 'SW'
            ? locationId
            : row.locationType === 'NW' && row.warehouseStore !== null
              ? String(row.warehouseStore)
              : null;
      const direct = locationId === storeId;
      const transferred =
        input.inQueue && row.transfer === 1 && queuedForStore(row.nextLocations, storeId);
      if (!direct && !transferred) continue;
      // A numerically equal warehouse/location ID is not evidence of store ownership.
      if (
        !ownerStoreId ||
        (direct && ownerStoreId !== storeId) ||
        (row.locationType === 'SW' && row.relatedStore === null)
      )
        throw searchDataInvalid();
      if (row.statusId !== null && row.statusId !== 0n && row.relatedStatus === null)
        throw searchDataInvalid();
      orders.push({
        locationLabel:
          row.locationType === 'SW'
            ? `${row.storeCode === null ? 'None' : row.storeCode} (${row.storeName === null ? 'None' : row.storeName})`
            : row.warehouseCode,
        id: String(row.id),
        statusId: row.statusId === null ? null : String(row.statusId),
        status:
          row.relatedStatus === null ? null : { id: String(row.relatedStatus), label: row.label! },
        locationId,
        locationType: row.locationType,
        transfer: row.transfer,
        nextLocations: row.nextLocations,
        ownerStoreId,
      });
    }
    return { orders, binding: createHash('sha256').update(JSON.stringify(orders)).digest('hex') };
  };
}
