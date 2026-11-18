import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import {
  Order,
  OrderStore,
  ExpressLineItem,
  HyperlocalLocation,
  Store,
} from '../../../db/legacy-schema.js';
import { sourceSearchAuthority } from '../search/scope.js';
import { orderSearchInput } from '../search/contracts.js';
import { detailIdentifier as positiveId } from './contracts.js';
import type { OnlineDetailSelection, OnlineDetailFact } from './contracts.js';

import { detailUnavailable, detailInvalid } from './errors.js';
export { detailUnavailable, detailInvalid } from './errors.js';
export function nextStoreIds(value: string): string[] {
  if (!value.trim()) return [];
  try {
    return [
      ...new Set(
        z
          .array(z.union([positiveId, z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]))
          .max(1000)
          .parse(JSON.parse(value) as unknown)
          .map(String),
      ),
    ].sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1));
  } catch {
    throw detailInvalid();
  }
}
/** Minimal current operational IDs only; never a historical fact fallback. */
export function onlineDetailAuthority(config: Config, db: Databases) {
  const sourceScope = sourceSearchAuthority(config, db);
  return async (
    user: Principal,
    storeId: string,
    orderId: string,
    selection: OnlineDetailSelection,
  ) => {
    positiveId.parse(storeId);
    positiveId.parse(orderId);
    const scope = await sourceScope(
      user,
      storeId,
      orderSearchInput.parse({
        orderType: selection.type,
        orderIds: [orderId],
        storeIds: [storeId],
      }),
    );
    if (selection.type !== 'N' && scope.checkedInStoreId !== storeId)
      throw new AppError(
        409,
        'ORDER_DETAIL_CHECK_IN_REQUIRED',
        'Check in to this store before opening its delivery details.',
      );
    return db.get('writer').transaction(async (tx) => {
      const [store] = await tx
        .select({ active: Store.is_active })
        .from(Store)
        .where(eq(Store.id, BigInt(storeId)))
        .limit(1)
        .for('share');
      if (!store?.active) throw detailUnavailable();
      const [order] = await tx
        .select({
          id: Order.id,
          customerId: Order.user,
          locationId: Order.location_id,
          locationType: Order.location_type,
          transfer: Order.is_transfer,
          next: Order.next_location_ids,
        })
        .from(Order)
        .where(eq(Order.id, BigInt(orderId)))
        .limit(1)
        .for('share');
      if (!order || order.customerId <= 0n) throw detailUnavailable();
      const mappings = await tx
        .select({ id: OrderStore.id, storeId: OrderStore.store })
        .from(OrderStore)
        .where(eq(OrderStore.order, order.id))
        .orderBy(asc(OrderStore.id))
        .limit(10001)
        .for('share');
      const express = await tx
        .select({
          id: ExpressLineItem.id,
          lineId: ExpressLineItem.has_product,
          storeId: ExpressLineItem.store_id,
        })
        .from(ExpressLineItem)
        .where(eq(ExpressLineItem.order, order.id))
        .orderBy(asc(ExpressLineItem.id))
        .limit(10001)
        .for('share');
      if (mappings.length > 10000 || express.length > 10000)
        throw new AppError(
          422,
          'ORDER_DETAIL_TOO_LARGE',
          'This order exceeds the complete detail limit.',
        );
      let ownerStoreId: string | null = null;
      if (order.locationId !== null && order.locationType === 'SW')
        ownerStoreId = String(order.locationId);
      if (order.locationId !== null && order.locationType === 'NW') {
        const [location] = await tx
          .select({ storeId: HyperlocalLocation.store_id })
          .from(HyperlocalLocation)
          .where(eq(HyperlocalLocation.id, BigInt(order.locationId)))
          .limit(1)
          .for('share');
        if (location?.storeId !== null && location?.storeId !== undefined)
          ownerStoreId = String(location.storeId);
      }
      const next = nextStoreIds(order.next),
        transferable = Boolean(order.transfer) && next.includes(storeId);
      const allowed =
        selection.type === 'N'
          ? scope.globalReader && !mappings.length && order.locationId === null
          : selection.type === 'HL'
            ? !mappings.length &&
              order.locationId !== null &&
              (ownerStoreId === storeId || transferable)
            : express.some((line) => line.storeId !== null && String(line.storeId) === storeId);
      if (!allowed) throw detailUnavailable();
      const normalized = {
        orderId,
        customerId: String(order.customerId),
        storeIds: [...new Set(mappings.map((row) => String(row.storeId)))].sort(),
        ownerStoreId,
        locationId: order.locationId === null ? null : String(order.locationId),
        locationType: order.locationType,
        nextStoreIds: next,
        express: express.map((row) => ({
          id: String(row.id),
          lineId: String(row.lineId),
          storeId: row.storeId === null ? null : String(row.storeId),
        })),
      };
      return {
        ...normalized,
        binding: createHash('sha256')
          .update(JSON.stringify([scope.binding, selection.type, normalized]))
          .digest('hex'),
      };
    });
  };
}
export type OnlineDetailAuthority = Awaited<ReturnType<ReturnType<typeof onlineDetailAuthority>>>;
export function assertDetailBinding(
  fact: OnlineDetailFact,
  authority: OnlineDetailAuthority,
  selection: OnlineDetailSelection,
) {
  if (fact.orderId !== authority.orderId || fact.customerId !== authority.customerId)
    throw detailInvalid();
  // Re-check type against the complete published facts as well as current authority.
  const matches =
    selection.type === 'N'
      ? !fact.storeIds.length && fact.delivery.locationId === null
      : selection.type === 'HL'
        ? !fact.storeIds.length && fact.delivery.locationId !== null
        : fact.lines.some((line) => line.express.some((item) => item.storeId !== null));
  if (!matches) throw detailInvalid();
}
