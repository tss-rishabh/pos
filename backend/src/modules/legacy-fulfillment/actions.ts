import { asc, eq, inArray } from 'drizzle-orm';
import { HasProduct, HyperlocalOrderLog, Order, PosUser } from '../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { assertCurrentStoreAccess } from '../administration/authorization.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { hyperlocalLifecycle, type ActionResult } from './hyperlocal.js';
import { pythonRepr } from '../../domain/python-compat.js';
import { locationStoreIds, parseLocationIds } from './python-text.js';
import type { LifecycleRuntime } from './runtime.js';
import { lifecycleStock } from './stock.js';

const notFound = () =>
  new AppError(
    404,
    'LEGACY_ORDER_NOT_FOUND',
    'The local delivery order was not found in this store.',
  );
const busy = () =>
  new AppError(
    409,
    'LOCAL_DELIVERY_IN_PROGRESS',
    'Another action on this order is still running. Refresh and try again.',
  );

/** Legacy `AjaxCheckOrderStatusView` messages (`order/views.py:4041-4056`). */
export function courierStatus(
  log: { action: string; createdInBorzo: number | null; error: string | null } | null,
) {
  if (log?.action === 'ACCEPTED' && log.createdInBorzo === 1)
    return { status: '200' as const, message: 'Order Created Succesfully at Borzo', error: '' };
  if (log?.action === 'CREATION_FAILED')
    return {
      status: '400' as const,
      message: 'Failed',
      error: `Order creation failed at borzo, error : ${log.error ?? 'None'}`,
    };
  if (log?.action === 'DECLINED')
    return { status: '400' as const, message: 'Failed', error: 'Order already canceled' };
  if (log?.action === 'NO_ACTION')
    return { status: '400' as const, message: 'Failed', error: 'Order creation not attempted' };
  return { status: '400' as const, message: 'Failed', error: 'Order not created' };
}
/** `str(error_msg)` of an AjaxHlOrderView failure, flattened into a readable message. */
export function failureMessage(result: ActionResult, fallback: string) {
  const parts = Object.entries(result.error)
    .filter(([key]) => key !== 'action')
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : pythonRepr(value)}`);
  return parts.length ? parts.join(' | ') : fallback;
}

/**
 * Operator actions on a local-delivery order: legacy AjaxHlOrderView, AjaxPassOrderView,
 * AJaxConvertOnlineView, AjaxOrderPackView, AjaxRtoRecievedView and AjaxCheckOrderStatusView.
 * Legacy checks only that the user is logged in; the rewrite also requires access to the
 * store the order is placed at (or transferred to). See the security decisions.
 */
export function legacyFulfillmentActions(runtime: LifecycleRuntime) {
  const stock = lifecycleStock(runtime),
    lifecycle = hyperlocalLifecycle(runtime, stock),
    { deps } = runtime;

  async function scope(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
  ) {
    requireStore(user, storeId);
    await assertCurrentStoreAccess(tx, user.id, storeId, [1, 2, 3, 4, 5], 'share');
    const [order] = await tx
      .select({
        id: Order.id,
        locationType: Order.location_type,
        locationId: Order.location_id,
        next: Order.next_location_ids,
        transfer: Order.is_transfer,
        split: Order.is_split_order,
        orderStatus: Order.order_statuses,
        paymentStatus: Order.payment_statuses,
      })
      .from(Order)
      .where(eq(Order.id, BigInt(orderId)))
      .limit(1);
    if (!order || order.locationType !== 'SW') throw notFound();
    const nextStoreIds = locationStoreIds(parseLocationIds(order.next));
    const eligible = [String(order.locationId ?? ''), ...(order.transfer ? nextStoreIds : [])];
    if (!eligible.includes(storeId)) throw notFound();
    return { ...order, nextStoreIds, eligible };
  }
  async function operator(tx: AdministrationTransaction, user: Principal) {
    const [row] = await tx
      .select({ first: PosUser.first_name, last: PosUser.last_name })
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(user.id)))
      .limit(1);
    if (!row) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    return row;
  }
  /** Rewrite-only fence so two operators cannot run one order's lifecycle step at once. */
  async function fenced<T>(orderId: string, run: () => Promise<T>): Promise<T> {
    const key = `pos:local_delivery_order_lock:${orderId}`,
      token = crypto.randomUUID();
    if (!(await deps.redis.set(key, token, { NX: true, PX: 120_000 }))) throw busy();
    try {
      return await run();
    } finally {
      await deps.redis.compareAndDelete(key, token).catch(() => false);
    }
  }
  const read = <T>(run: (tx: AdministrationTransaction) => Promise<T>) =>
    runtime.writer().transaction(run);

  return {
    lifecycle,
    stock,
    async status(user: Principal, storeId: string, orderId: string) {
      return read(async (tx) => {
        const order = await scope(tx, user, storeId, orderId);
        const [log] = await tx
          .select({
            action: HyperlocalOrderLog.action,
            borzoId: HyperlocalOrderLog.borzo_id,
            createdInBorzo: HyperlocalOrderLog.is_created_in_borzo,
            error: HyperlocalOrderLog.error_msg,
            packed: HyperlocalOrderLog.is_pack,
            rto: HyperlocalOrderLog.is_rto,
            received: HyperlocalOrderLog.rto_recieved,
            refunded: HyperlocalOrderLog.is_refunded,
            source: HyperlocalOrderLog.source_tracking_url,
            destination: HyperlocalOrderLog.destination_tracking_url,
          })
          .from(HyperlocalOrderLog)
          .where(eq(HyperlocalOrderLog.order_id, BigInt(orderId)))
          .orderBy(asc(HyperlocalOrderLog.id))
          .limit(1);
        const [child] = await tx
          .select({ id: Order.id })
          .from(Order)
          .where(eq(Order.hl_parent_order_id, BigInt(orderId)))
          .orderBy(asc(Order.id))
          .limit(1);
        const https = (value: string | null) => {
          if (!value) return null;
          try {
            const url = new URL(value);
            return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
          } catch {
            return null;
          }
        };
        return {
          orderId,
          storeId: order.locationId === null ? null : String(order.locationId),
          split: order.split === 1,
          orderStatusId: String(order.orderStatus),
          paymentStatusId: String(order.paymentStatus),
          transferred: Boolean(order.transfer),
          nextStoreIds: order.nextStoreIds,
          eligibleStoreIds: order.eligible,
          childOrderId: child ? String(child.id) : null,
          courier: log
            ? {
                action: log.action,
                courierOrderId: log.borzoId > 0n ? String(log.borzoId) : null,
                created: log.createdInBorzo === 1,
                packed: log.packed === 1,
                rto: log.rto === 1,
                rtoReceived: log.received === 1,
                refunded: log.refunded === 1,
                sourceTrackingUrl: https(log.source),
                destinationTrackingUrl: https(log.destination),
              }
            : null,
          check: courierStatus(
            log
              ? { action: log.action, createdInBorzo: log.createdInBorzo, error: log.error }
              : null,
          ),
        };
      });
    },
    /** AjaxOrderPackView (`order/views.py:4123-4151`): `is_pack=1` and an attributed log. */
    async pack(user: Principal, storeId: string, orderId: string, note: string) {
      return fenced(orderId, () =>
        runtime.writer().transaction(async (tx) => {
          await scope(tx, user, storeId, orderId);
          const who = await operator(tx, user);
          await tx
            .update(HyperlocalOrderLog)
            .set({ is_pack: 1 })
            .where(eq(HyperlocalOrderLog.order_id, BigInt(orderId)));
          await runtime.transactionLog(tx, {
            orderId,
            storeId: '0',
            posUserId: user.id,
            comment: `${note}, Order Packed By: ${who.first ?? 'None'}`,
          });
          return { status: '200' as const, message: 'RTO Order Delivered' };
        }),
      );
    },
    /**
     * AjaxRtoRecievedView (`order/views.py:4063-4120`). Legacy restocks again on a repeat; the
     * rewrite keeps the ledger-approved correction of restocking once, gated on
     * `hyperlocal_order_log.rto_recieved` in the same writer transaction.
     */
    async receiveRto(user: Principal, storeId: string, orderId: string, note: string) {
      return fenced(orderId, async () => {
        const synced: { storeId: string; productIds: string[] } = { storeId: '0', productIds: [] };
        const result = await runtime.writer().transaction(async (tx) => {
          const order = await scope(tx, user, storeId, orderId);
          const who = await operator(tx, user);
          const logs = await tx
            .select({ id: HyperlocalOrderLog.id, received: HyperlocalOrderLog.rto_recieved })
            .from(HyperlocalOrderLog)
            .where(eq(HyperlocalOrderLog.order_id, BigInt(orderId)))
            .for('update');
          if (logs.some((row) => row.received === 1))
            return {
              status: '200' as const,
              message: 'RTO Order Delivered',
              alreadyRecorded: true,
            };
          const target = order.locationId ? String(order.locationId) : '0';
          if (target !== '0' && !stock.ready(user.id))
            throw new AppError(
              503,
              'LOCAL_DELIVERY_INVENTORY_UNAVAILABLE',
              'Store inventory synchronization is not configured.',
            );
          if (logs.length)
            await tx
              .update(HyperlocalOrderLog)
              .set({ rto_recieved: 1 })
              .where(
                inArray(
                  HyperlocalOrderLog.id,
                  logs.map((row) => row.id),
                ),
              );
          if (target !== '0') {
            const lines = await tx
              .select({ productId: HasProduct.product, quantity: HasProduct.qty })
              .from(HasProduct)
              .where(eq(HasProduct.order, BigInt(orderId)))
              .orderBy(asc(HasProduct.id));
            synced.storeId = target;
            synced.productIds = await stock.restock(
              tx,
              target,
              lines.map((line) => ({
                productId: String(line.productId),
                quantity: Number(line.quantity),
              })),
              user.id,
              `Product inventory added from admin panel on Hyperlocal RTO, [Order ID:${orderId}]`,
            );
          }
          await runtime.transactionLog(tx, {
            orderId,
            storeId: '0',
            posUserId: user.id,
            comment: `${note}, RTO Package Recieved By: ${who.first ?? 'None'}`,
          });
          return { status: '200' as const, message: 'RTO Order Delivered', alreadyRecorded: false };
        });
        await stock.syncProducts(synced.productIds, synced.storeId, user.id);
        return result;
      });
    },
    /** AjaxHlOrderView with `is_create` (`order/views.py:3443-3452`). */
    async create(user: Principal, storeId: string, orderId: string) {
      await read((tx) => scope(tx, user, storeId, orderId));
      const result = await fenced(orderId, () => lifecycle.create(orderId, user.id, storeId));
      if (result.ok) return { status: '200' as const, message: 'Success' };
      throw new AppError(
        409,
        result.error.action ? 'LOCAL_DELIVERY_CONVERTING' : 'LOCAL_DELIVERY_COURIER_FAILED',
        failureMessage(result, 'The courier order could not be created.'),
      );
    },
    /** AjaxHlOrderView with `is_cancel`. */
    async cancel(user: Principal, storeId: string, orderId: string, reason: string) {
      await read((tx) => scope(tx, user, storeId, orderId));
      const result = await fenced(orderId, () => lifecycle.cancel(reason, orderId, user.id));
      if (result.ok) return { status: '200' as const, message: 'Success' };
      throw new AppError(
        409,
        'LOCAL_DELIVERY_CANCEL_FAILED',
        failureMessage(result, 'The order could not be cancelled.'),
      );
    },
    /** AjaxPassOrderView (`order/views.py:4254-4273`): O2 run synchronously with is_auto=False. */
    async pass(
      user: Principal,
      storeId: string,
      orderId: string,
      reason: string,
      reasonDropdown: string,
    ) {
      if (!deps.jobs)
        throw new AppError(
          503,
          'JOB_QUEUE_UNAVAILABLE',
          'Background order processing is unavailable. Try again shortly.',
        );
      const who = await read(async (tx) => {
        await scope(tx, user, storeId, orderId);
        return operator(tx, user);
      });
      const { message, opr } = await fenced(orderId, () =>
        lifecycle.transfer(orderId, {
          staffUser: `${who.first ?? 'None'} ${who.last ?? 'None'}`,
          reason,
          isAuto: false,
          reasonDropdown,
        }),
      );
      return {
        status: '200' as const,
        operation: opr || null,
        message:
          opr === 'convert'
            ? 'New online order creation is in-progress, please wait for a few seconds'
            : opr === 'transfer'
              ? 'Order transferring to other stores is in-progress, please wait for a few seconds'
              : message,
      };
    },
    /** AJaxConvertOnlineView (`order/views.py:3814-3836`): O3 run synchronously for an RTO order. */
    async convert(user: Principal, storeId: string, orderId: string) {
      await read((tx) => scope(tx, user, storeId, orderId));
      const result = await fenced(orderId, () => lifecycle.convertOnline(orderId, storeId));
      if (result.status === 400)
        throw new AppError(409, 'LOCAL_DELIVERY_CONVERSION_REFUSED', result.message);
      return { status: String(result.status), message: result.message };
    },
  };
}
export type LegacyFulfillmentActions = ReturnType<typeof legacyFulfillmentActions>;
