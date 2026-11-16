import { asc, eq, sql } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import { ExpressLineItem, HasProduct, Order, OrderStore, Store } from '../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { assertCurrentStoreAccess } from '../administration/authorization.js';
import { invoiceHeaderNativeSql, invoiceLineNativeSql, invoiceNativeBinding } from './native.js';
import {
  fullInvoiceOwnership,
  invoiceDocumentScope,
  maxInvoiceLines,
  type InvoiceDocumentScope,
  type InvoiceOwnership,
} from './contracts.js';

export interface InvoiceAuthority {
  binding: string;
  number: string | null;
  customerId: string;
  orderStatus: string;
  updatedAt: string;
}
export interface InvoiceSnapshot extends InvoiceAuthority {
  ownership: InvoiceOwnership;
}
export function invoiceScopeSnapshot(db: Databases) {
  return async (user: Principal, raw: InvoiceDocumentScope): Promise<InvoiceSnapshot> => {
    const scope = invoiceDocumentScope.parse(raw);
    requireStore(user, scope.storeId);
    return db.get('writer').transaction(async (tx) => {
      await assertCurrentStoreAccess(tx, user.id, scope.storeId);
      const [store] = await tx
        .select({ active: Store.is_active })
        .from(Store)
        .where(eq(Store.id, BigInt(scope.storeId)))
        .limit(1)
        .for('share');
      if (!store?.active) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found.');
      const [order] = await tx
        .select({
          id: Order.id,
          customerId: Order.user,
          payment: Order.payment_statuses,
          orderStatus: Order.order_statuses,
          updatedAt: Order.updated_at,
          locationType: Order.location_type,
          locationId: Order.location_id,
          split: Order.is_split_order,
          addressOwned: sql<string>`CAST(CASE WHEN COALESCE(orders.has_address_id,0)=0 THEN 1 WHEN EXISTS(SELECT 1 FROM has_addresses WHERE has_addresses.id=orders.has_address_id AND has_addresses.user_id=orders.user_id) THEN 1 ELSE 0 END AS CHAR)`,
          addressId: sql<string | null>`CAST(orders.has_address_id AS CHAR)`,
          nativeHash: sql<string>`${sql.raw(invoiceHeaderNativeSql)}`,
        })
        .from(Order)
        .where(eq(Order.id, BigInt(scope.orderId)))
        .limit(1)
        .for('share');
      if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found in this store.');
      const mappings = await tx
        .select({
          id: OrderStore.id,
          storeId: OrderStore.store,
          counterId: OrderStore.counter,
          number: OrderStore.order_invoice,
        })
        .from(OrderStore)
        .where(eq(OrderStore.order, order.id))
        .orderBy(asc(OrderStore.id))
        .limit(2)
        .for('share');
      const lines = await tx
        .select({
          id: HasProduct.id,
          platformId: HasProduct.order_platform,
          nativeHash: sql<string>`${sql.raw(invoiceLineNativeSql)}`,
        })
        .from(HasProduct)
        .where(eq(HasProduct.order, order.id))
        .orderBy(asc(HasProduct.id))
        .limit(maxInvoiceLines + 1)
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
        .limit(maxInvoiceLines + 1)
        .for('share');
      const normalized = {
        storeId: scope.storeId,
        locationType: order.locationType,
        locationId: order.locationId === null ? null : String(order.locationId),
        split: order.split !== 0,
        mappings: mappings.map((row) => ({
          ...row,
          id: String(row.id),
          storeId: String(row.storeId),
          counterId: String(row.counterId),
        })),
        lines: lines.map((row) => ({
          ...row,
          id: String(row.id),
          platformId: String(row.platformId),
        })),
        express: express.map((row) => ({
          ...row,
          id: String(row.id),
          lineId: String(row.lineId),
          storeId: row.storeId === null ? null : String(row.storeId),
        })),
      };
      if (!fullInvoiceOwnership(normalized) && selectedExpressIds(normalized) === null)
        throw invoiceScopeUnavailable();
      if (order.addressOwned !== '1') throw invoiceScopeUnavailable();
      if (order.payment !== 4n)
        throw new AppError(
          409,
          'INVOICE_PAYMENT_PENDING',
          'The tax invoice is available after payment is confirmed.',
        );
      return {
        ownership: normalized,
        binding: invoiceNativeBinding([
          scope.storeId,
          scope.orderId,
          String(order.customerId),
          order.addressId,
          order.nativeHash,
          normalized.locationType,
          normalized.locationId,
          normalized.split,
          normalized.mappings.map((row) => [row.id, row.storeId, row.counterId, row.number]),
          normalized.lines.map((row) => [row.id, row.platformId, row.nativeHash]),
          normalized.express.map((row) => [row.id, row.lineId, row.storeId]),
        ]),
        number: mappings[0]?.number || null,
        customerId: String(order.customerId),
        orderStatus: String(order.orderStatus),
        updatedAt: order.updatedAt,
      };
    });
  };
}

export function invoiceDocumentAuthority(db: Databases) {
  const capture = invoiceScopeSnapshot(db);
  return async (user: Principal, scope: InvoiceDocumentScope): Promise<InvoiceAuthority> => {
    const snapshot = await capture(user, scope);
    if (!fullInvoiceOwnership(snapshot.ownership)) throw invoiceScopeUnavailable();
    return {
      binding: snapshot.binding,
      number: snapshot.number,
      customerId: snapshot.customerId,
      orderStatus: snapshot.orderStatus,
      updatedAt: snapshot.updatedAt,
    };
  };
}
export function invoiceScopeUnavailable() {
  return new AppError(
    404,
    'INVOICE_SCOPE_UNCONFIRMED',
    'The requested invoice is not authorized in this store.',
  );
}
export function selectedExpressIds(value: InvoiceOwnership): string[] | null {
  if (
    !value.lines.length ||
    value.lines.length > maxInvoiceLines ||
    value.express.length > maxInvoiceLines ||
    value.mappings.length > 1
  )
    return null;
  const lines = new Map(value.lines.map((line) => [line.id, line]));
  if (lines.size !== value.lines.length || value.express.some((row) => !lines.has(row.lineId)))
    return null;
  const selected = new Set(
    value.express.filter((row) => row.storeId === value.storeId).map((row) => row.lineId),
  );
  if (
    !selected.size ||
    value.express.some((row) => selected.has(row.lineId) && row.storeId !== value.storeId) ||
    [...selected].some((id) => lines.get(id)?.platformId !== '5')
  )
    return null;
  return value.lines.filter((line) => selected.has(line.id)).map((line) => line.id);
}
export function hasSourceSameDayInvoice(value: InvoiceOwnership) {
  return (
    value.split &&
    value.lines.some((line) => ['3', '4'].includes(line.platformId)) &&
    value.lines.some((line) => !['3', '4'].includes(line.platformId))
  );
}
