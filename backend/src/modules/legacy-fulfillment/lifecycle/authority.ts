import { and, asc, eq } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import {
  ExpressLineItem,
  HasProduct,
  MUser,
  Order,
  PosUser,
  Store,
} from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { legacyHyperlocalLogs } from '../schema.js';
import {
  deliverySnapshot,
  type DeliverySnapshot,
  type LifecycleActor,
  type ProviderRequest,
} from './contracts.js';
import { backupStores, reconciliation } from './domain.js';

export function lifecycleAuthority(config: Config, db: Databases) {
  const checkins = checkInService(db, config);
  async function actor(
    tx: AdministrationTransaction,
    subject: LifecycleActor,
    storeId: string,
    checkedIn = false,
  ) {
    if (subject.kind === 'operator') {
      await assertCurrentStoreAccess(tx, subject.id, storeId);
      if (checkedIn) await checkins.assertCheckIn(subject.id, storeId, undefined, tx);
    }
    const [store] = await tx
      .select({ id: Store.id, name: Store.store_name, type: Store.type, active: Store.is_active })
      .from(Store)
      .where(eq(Store.id, BigInt(storeId)))
      .limit(1)
      .for('update');
    if (!store?.active) throw new AppError(409, 'STORE_UNAVAILABLE', 'This store is unavailable.');
    return store;
  }
  return {
    actor,
    async auxiliary(
      tx: AdministrationTransaction,
      snapshot: DeliverySnapshot,
      request: ProviderRequest,
    ) {
      if (
        !['slack', 'support-ticket', 'new-order-email', 'order-producer'].includes(request.kind) ||
        request.orderId !== snapshot.orderId ||
        request.customerId !== snapshot.customerId ||
        ![snapshot.ownerStoreId, ...snapshot.nextStoreIds].includes(request.storeId)
      )
        throw reconciliation();
      await actor(tx, { kind: 'service', id: 'service' }, request.storeId);
      const [order] = await tx
        .select({ customerId: Order.user, split: Order.is_split_order })
        .from(Order)
        .where(eq(Order.id, BigInt(snapshot.orderId)))
        .limit(1)
        .for('share');
      const rows = await tx
        .select({
          id: HasProduct.id,
          productId: HasProduct.product,
          quantity: HasProduct.qty,
          platform: HasProduct.order_platform,
          status: HasProduct.status,
        })
        .from(HasProduct)
        .where(eq(HasProduct.order, BigInt(snapshot.orderId)))
        .orderBy(asc(HasProduct.id))
        .limit(1001)
        .for('share');
      if (
        !order ||
        String(order.customerId) !== snapshot.customerId ||
        !!order.split !== snapshot.split ||
        rows.length !== snapshot.lines.length
      )
        throw reconciliation();
      const expected = new Map(snapshot.lines.map((line) => [line.id, line]));
      for (const row of rows) {
        const line = expected.get(String(row.id));
        if (
          !line ||
          line.productId !== String(row.productId) ||
          BigInt(line.quantity) !== BigInt(row.quantity) ||
          line.platform !== String(row.platform)
        )
          throw reconciliation();
      }
    },
    async context(
      tx: AdministrationTransaction,
      subject: LifecycleActor,
      storeId: string,
      orderId: string,
      options: { checkedIn?: boolean; allowBackup?: boolean } = {},
    ) {
      identifier.parse(orderId);
      identifier.parse(storeId);
      const store = await actor(tx, subject, storeId, options.checkedIn),
        [order] = await tx
          .select({
            id: Order.id,
            customerId: Order.user,
            ownerStoreId: Order.location_id,
            locationType: Order.location_type,
            split: Order.is_split_order,
            nextIds: Order.next_location_ids,
            isTransferred: Order.is_transfer,
            start: Order.start_timeslot,
            orderStatus: Order.order_statuses,
            paymentStatus: Order.payment_statuses,
            hlCharges: Order.hl_charges,
          })
          .from(Order)
          .where(eq(Order.id, BigInt(orderId)))
          .limit(1)
          .for('update');
      if (!order || order.locationType !== 'SW' || order.ownerStoreId === null)
        throw new AppError(404, 'LOCAL_DELIVERY_NOT_FOUND', 'Local delivery not found.');
      const backups = backupStores(order.nextIds);
      if (
        String(order.ownerStoreId) !== storeId &&
        !(options.allowBackup && order.isTransferred && backups.includes(storeId))
      )
        throw new AppError(
          404,
          'LOCAL_DELIVERY_NOT_FOUND',
          'Local delivery not found in this store.',
        );
      const express = await tx
        .select({ id: ExpressLineItem.id })
        .from(ExpressLineItem)
        .where(eq(ExpressLineItem.order, order.id))
        .limit(1)
        .for('share');
      if (express.length)
        throw new AppError(
          409,
          'EXPRESS_FULFILLMENT_REQUIRED',
          'Use Express fulfillment for this order.',
        );
      const logs = await tx
        .select()
        .from(legacyHyperlocalLogs)
        .where(eq(legacyHyperlocalLogs.orderId, order.id))
        .orderBy(asc(legacyHyperlocalLogs.id))
        .limit(101)
        .for('update');
      if (
        logs.length > 100 ||
        new Set(
          logs.map((row) =>
            JSON.stringify([
              row.action,
              String(row.borzoId),
              row.createdInBorzo,
              row.mainStoreId || 0,
            ]),
          ),
        ).size > 1
      )
        throw reconciliation();
      const rows = await tx
        .select({
          id: HasProduct.id,
          productId: HasProduct.product,
          quantity: HasProduct.qty,
          platform: HasProduct.order_platform,
          status: HasProduct.status,
        })
        .from(HasProduct)
        .where(eq(HasProduct.order, order.id))
        .orderBy(asc(HasProduct.id))
        .limit(1001)
        .for('update');
      if (
        !rows.length ||
        rows.length > 1000 ||
        order.orderStatus === null ||
        order.paymentStatus === null
      )
        throw reconciliation();
      // Platform 4 is the source HL identity. Missing logs must never admit a normal POS order.
      if (!logs.length && !rows.some((row) => row.platform === 4n))
        throw new AppError(404, 'LOCAL_DELIVERY_NOT_FOUND', 'Local delivery not found.');
      const snapshot = deliverySnapshot.parse({
        orderId,
        customerId: String(order.customerId),
        ownerStoreId: String(order.ownerStoreId),
        split: !!order.split,
        nextStoreIds: backups,
        rawNextIds: order.nextIds,
        startTimeslot: order.start,
        isTransferred: !!order.isTransferred,
        lines: rows.map((row) => ({
          id: String(row.id),
          productId: String(row.productId),
          quantity: Number(row.quantity),
          platform: String(row.platform),
          status: row.status,
        })),
      });
      if (rows.some((row) => BigInt(row.quantity) > 2147483647n)) throw reconciliation();
      return {
        store,
        order,
        snapshot,
        logs,
        selected: snapshot.lines.filter((line) => !snapshot.split || line.platform === '4'),
      };
    },
    async customer(tx: AdministrationTransaction, customerId: string) {
      const [customer] = await tx
        .select({
          id: MUser.id,
          active: MUser.status,
          blocked: MUser.is_block,
          twoFactor: MUser.is_two_fa,
          firstName: MUser.firstname,
          lastName: MUser.lastname,
          email: MUser.email,
          telephone: MUser.telephone,
        })
        .from(MUser)
        .where(eq(MUser.id, BigInt(customerId)))
        .limit(1)
        .for('share');
      if (!customer || customer.active !== 1 || customer.blocked === 1)
        throw new AppError(403, 'CUSTOMER_DISABLED', 'This customer account is disabled.');
      return customer;
    },
    async operator(tx: AdministrationTransaction, subject: LifecycleActor) {
      if (subject.kind === 'service') return { firstName: '', lastName: '', id: '0', role: 0 };
      const [operator] = await tx
        .select({
          firstName: PosUser.first_name,
          lastName: PosUser.last_name,
          id: PosUser.id,
          role: PosUser.role,
        })
        .from(PosUser)
        .where(and(eq(PosUser.id, BigInt(subject.id)), eq(PosUser.is_active, true)))
        .limit(1)
        .for('share');
      if (!operator) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      return { ...operator, id: String(operator.id) };
    },
  };
}
export function assertSnapshot(before: DeliverySnapshot, current: DeliverySnapshot) {
  if (
    before.orderId !== current.orderId ||
    before.customerId !== current.customerId ||
    before.split !== current.split ||
    JSON.stringify(
      before.lines.map(({ id, productId, quantity, platform }) => [
        id,
        productId,
        quantity,
        platform,
      ]),
    ) !==
      JSON.stringify(
        current.lines.map(({ id, productId, quantity, platform }) => [
          id,
          productId,
          quantity,
          platform,
        ]),
      )
  )
    throw reconciliation();
}
export function cancellationSets(snapshot: DeliverySnapshot, sideEffectSkus?: readonly string[]) {
  const selected = snapshot.lines.filter((line) => !snapshot.split || line.platform === '4'),
    ids = new Set(selected.map((line) => line.id)),
    skus = [...new Set(selected.map((line) => line.productId))];
  if (
    !selected.length ||
    snapshot.lines.some((line) => skus.includes(line.productId) && !ids.has(line.id)) ||
    (snapshot.lines.some((line) => !ids.has(line.id)) &&
      (!sideEffectSkus ||
        snapshot.lines.some(
          (line) => !ids.has(line.id) && sideEffectSkus.includes(line.productId),
        ))) ||
    (snapshot.split &&
      !!sideEffectSkus &&
      snapshot.lines.some((line) => sideEffectSkus.includes(line.productId)))
  )
    throw new AppError(
      409,
      'PER_HP_CANCELLATION_REQUIRED',
      'These line items require a cancellation service that scopes each exact order line.',
    );
  return skus;
}
