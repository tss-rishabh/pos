import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Databases } from '../../../db/pools.js';
import { ExpressLineItem, HasProduct, Store } from '../../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { sourceIntId } from '../source-id.js';
import {
  shippingLabelSchema,
  sourceShippingAddress,
  sourceShippingStoreAddress,
} from './contracts.js';
import { shippingAddresses, shippingCountries, shippingOrders, shippingZones } from './schema.js';

const unavailable = () =>
  new AppError(
    503,
    'SHIPPING_LABEL_NOT_READY',
    'The shipping label is not ready. Refresh after source synchronization.',
  );
/** Keeps live writer scope/association locks while obtaining one primary-reader snapshot. */
export function shippingLabelService(db: Databases) {
  return async (user: Principal, storeId: string, orderId: string) => {
    identifier.parse(storeId);
    identifier.parse(orderId);
    requireStore(user, storeId);
    return db.get('writer').transaction(async (authority) => {
      await assertCurrentStoreAccess(authority, user.id, storeId);
      const [store] = await authority
        .select({ id: Store.id, active: Store.is_active })
        .from(Store)
        .where(eq(Store.id, BigInt(storeId)))
        .limit(1)
        .for('share');
      if (!store?.active) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found.');
      const [order] = await authority
        .select({ id: shippingOrders.id, addressId: shippingOrders.addressId })
        .from(shippingOrders)
        .where(eq(shippingOrders.id, BigInt(orderId)))
        .limit(1)
        .for('share');
      if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
      const linked = await authority
        .select({ lineId: ExpressLineItem.id, hasProductId: ExpressLineItem.has_product })
        .from(ExpressLineItem)
        .where(
          and(
            eq(ExpressLineItem.order, BigInt(orderId)),
            eq(ExpressLineItem.store_id, sourceIntId(storeId)),
          ),
        )
        .orderBy(asc(ExpressLineItem.id))
        .limit(10001)
        .for('share');
      if (!linked.length)
        throw new AppError(
          404,
          'SHIPPING_LINES_NOT_FOUND',
          'No express line items were found for this order and store.',
        );
      if (linked.length > 10000)
        throw new AppError(
          409,
          'SHIPPING_LABEL_RECONCILIATION_REQUIRED',
          'This shipping label requires source reconciliation.',
        );
      const hasProductIds = [
        ...new Set(
          linked.filter((row) => row.hasProductId !== null).map((row) => String(row.hasProductId)),
        ),
      ].map((value) => BigInt(identifier.parse(value)));
      return db.get('primary').transaction(
        async (reader) => {
          const [header] = await reader
            .select({
              id: shippingOrders.id,
              reference: shippingOrders.reference,
              createdAt: shippingOrders.createdAt,
              addressId: shippingAddresses.id,
              firstName: shippingAddresses.firstName,
              lastName: shippingAddresses.lastName,
              flat: shippingAddresses.flat,
              address1: shippingAddresses.address1,
              address2: shippingAddresses.address2,
              address3: shippingAddresses.address3,
              address4: shippingAddresses.address4,
              city: shippingAddresses.city,
              postcode: shippingAddresses.postcode,
              phone: shippingAddresses.phone,
              zoneName: shippingZones.name,
              countryName: shippingCountries.name,
              storeAddress: Store.address,
              alternateAddress: Store.alt_address,
              storePhone: Store.phone,
            })
            .from(shippingOrders)
            .innerJoin(Store, eq(Store.id, BigInt(storeId)))
            .leftJoin(shippingAddresses, eq(shippingAddresses.id, shippingOrders.addressId))
            .leftJoin(shippingZones, eq(shippingZones.id, shippingAddresses.zoneId))
            .leftJoin(shippingCountries, eq(shippingCountries.id, shippingAddresses.countryId))
            .where(
              and(
                eq(shippingOrders.id, BigInt(orderId)),
                order.addressId === null
                  ? isNull(shippingOrders.addressId)
                  : eq(shippingOrders.addressId, order.addressId),
              ),
            )
            .limit(1);
          if (!header) throw unavailable();
          const rows = hasProductIds.length
            ? await reader
                .select({
                  id: HasProduct.id,
                  orderId: HasProduct.order,
                  quantity: HasProduct.qty,
                  awb: HasProduct.awb,
                  eligibleAwb:
                    sql<number>`CASE WHEN ${or(isNull(HasProduct.awb), ne(HasProduct.awb, ''))} THEN 1 ELSE 0 END`.mapWith(
                      Number,
                    ),
                })
                .from(HasProduct)
                .where(inArray(HasProduct.id, hasProductIds))
                .orderBy(asc(HasProduct.id))
            : [];
          if (rows.length !== hasProductIds.length) throw unavailable();
          if (
            rows.some((row) => row.orderId !== BigInt(orderId) || typeof row.quantity !== 'bigint')
          )
            throw new AppError(
              409,
              'SHIPPING_LABEL_RECONCILIATION_REQUIRED',
              'This shipping label requires source reconciliation.',
            );
          const totalQuantity = rows.reduce((sum, row) => sum + row.quantity, 0n).toString(),
            firstAwb = rows.find((row) => row.eligibleAwb === 1)?.awb;
          return shippingLabelSchema.parse({
            orderId,
            storeId,
            orderReference: header.reference === null ? 'None' : header.reference,
            orderDate: header.createdAt,
            storeAddress: sourceShippingStoreAddress({
              address: header.storeAddress,
              alternateAddress: header.alternateAddress,
              phone: header.storePhone,
            }),
            shippingAddress:
              header.addressId === null
                ? null
                : sourceShippingAddress({
                    firstName: header.firstName,
                    lastName: header.lastName,
                    flat: header.flat,
                    address1: header.address1,
                    address2: header.address2,
                    address3: header.address3,
                    address4: header.address4,
                    city: header.city,
                    postcode: header.postcode,
                    phone: header.phone,
                    zoneName: header.zoneName,
                    countryName: header.countryName,
                  }),
            paymentMode: 'Prepaid',
            product: 'Cloths',
            totalQuantity,
            awb: firstAwb || '0',
            dimensionsCm: ['30.000', '30.000', '2.000'],
            weightKg: '0.384',
          });
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    });
  };
}
