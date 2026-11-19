import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  AmountToBeRefundedLog,
  HasProduct,
  HyperlocalFdLog,
  HyperlocalOrderLog,
  HyperlocalToOnlineOrderLog,
  MUser,
  Order,
  OrderAddon,
  OrderStatus,
  PosHyperlocalSlot,
  Store,
  TssMoneyHistory,
} from '../../db/legacy-schema.js';
import { hasProductStatuses } from '../../db/legacy-enums.js';
import { storedEnumValue } from '../../db/legacy-columns.js';
import { aggregateStock } from '../../db/stock-projection/schema.js';
import { AppError } from '../../domain/errors.js';
import { pythonRound2 } from '../../domain/python-round.js';
import type { JobArgs, JobName, EnqueueOptions } from '../../jobs/contract.js';
import type { GatewayResponse } from './gateway.js';
import {
  asPythonValue,
  locationStoreIds,
  parseLocationIds,
  pythonFloatDict,
  pythonJsonDumps,
  pythonRepr,
  type PythonValue,
} from './python-text.js';
import type { LifecycleRuntime } from './runtime.js';
import type { LifecycleStock } from './stock.js';

export type ErrorDictionary = Record<string, PythonValue>;
export interface ActionResult {
  ok: boolean;
  error: ErrorDictionary;
}
export interface OnlineResult {
  status: 200 | 201 | 400;
  message: string;
}
const terminalActions = ['ACCEPTED', 'DECLINED', 'CONVERT_ONLINE'] as const;
const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export const jobUnavailable = () =>
  new AppError(
    503,
    'JOB_QUEUE_UNAVAILABLE',
    'Background order processing is unavailable. Try again shortly.',
  );

/**
 * Legacy hyperlocal order lifecycle (`order/views.py:3433-4031, 4253-4312`):
 * AjaxHlOrderView.create/cancel, AutoHlOrderView, auto_hl_order_transfer (O2),
 * auto_hl_order_to_online (O3) and WebhookCancelledOrderView. Guards re-read the durable
 * legacy flags on every call (`hyperlocal_order_log.action`, `orders.is_transfer`,
 * `orders.hl_parent_order_id`). Delayed work goes through the job queue with legacy names.
 */
export function hyperlocalLifecycle(runtime: LifecycleRuntime, stock: LifecycleStock) {
  const { deps } = runtime;
  const db = () => runtime.writer();

  async function enqueue(name: JobName, args: JobArgs, options: EnqueueOptions) {
    if (!deps.jobs) throw jobUnavailable();
    await deps.jobs.enqueue(name, args, {
      ...options,
      ...(options.delaySeconds !== undefined
        ? { delaySeconds: Math.max(0, Math.trunc(options.delaySeconds)) }
        : {}),
    });
  }
  async function order(orderId: string) {
    if (!/^[1-9]\d{0,18}$/.test(orderId)) return undefined;
    const [row] = await db()
      .select({
        id: Order.id,
        userId: Order.user,
        split: Order.is_split_order,
        orderStatus: Order.order_statuses,
        paymentStatus: Order.payment_statuses,
        locationType: Order.location_type,
        locationId: Order.location_id,
        next: Order.next_location_ids,
        transfer: Order.is_transfer,
        start: Order.start_timeslot,
      })
      .from(Order)
      .where(eq(Order.id, BigInt(orderId)))
      .limit(1);
    return row;
  }
  async function customer(userId: bigint) {
    const [row] = await db()
      .select({
        id: MUser.id,
        name: MUser.firstname,
        telephone: MUser.telephone,
        email: MUser.email,
        twoFactor: MUser.is_two_fa,
        tssMoney: MUser.tss_money,
      })
      .from(MUser)
      .where(eq(MUser.id, userId))
      .limit(1);
    return row;
  }
  async function firstAction(
    orderId: string,
    actions: readonly (typeof terminalActions)[number][],
  ) {
    const [row] = await db()
      .select({ action: HyperlocalOrderLog.action })
      .from(HyperlocalOrderLog)
      .where(
        and(
          eq(HyperlocalOrderLog.order_id, BigInt(orderId)),
          inArray(HyperlocalOrderLog.action, [...actions]),
        ),
      )
      .orderBy(asc(HyperlocalOrderLog.id))
      .limit(1);
    return row?.action;
  }
  async function storeName(storeId: string) {
    if (!/^[1-9]\d{0,18}$/.test(storeId)) return '';
    const [row] = await db()
      .select({ name: Store.store_name })
      .from(Store)
      .where(eq(Store.id, BigInt(storeId)))
      .limit(1);
    return row?.name ?? '';
  }
  async function cancelledStatus() {
    const [row] = await db()
      .select({ name: OrderStatus.order_status })
      .from(OrderStatus)
      .where(eq(OrderStatus.id, 4n))
      .limit(1);
    return storedEnumValue(hasProductStatuses, row?.name ?? '');
  }

  /** `Helpers.create_od_ticket` (`helpers/helpers.py:891-933`). */
  async function odTicket(input: {
    orderId: string;
    name: string;
    subject: string;
    description: string;
    reason: string;
    newOrder: string;
    staffUser: string;
  }) {
    const response = await deps.gateway.createOdTicket(input);
    let ticketId: string | null = null;
    if (response.status === 200) {
      const [row] = await db()
        .select({ ticket: HyperlocalFdLog.fd_ticket_id })
        .from(HyperlocalFdLog)
        .where(eq(HyperlocalFdLog.order_id, BigInt(input.orderId)))
        .orderBy(asc(HyperlocalFdLog.id))
        .limit(1);
      ticketId = row?.ticket ?? null;
    }
    runtime.log({
      eventId: 'legacy-fulfillment.od-ticket.sent',
      orderId: input.orderId,
      outcome: 'posted',
      status: response.status,
    });
    const reason = input.reason ? ` Reason : ${input.reason} |` : '';
    let message =
      input.newOrder && input.newOrder !== '0'
        ? `Hyperlocal Order Id: ${input.orderId} Converted into new online Order Id: ${input.newOrder} |${reason}`
        : `${input.subject} | Order ID : ${input.orderId} |${reason}`;
    if (ticketId) message += ` CRM Ticket Id: ${ticketId}`;
    if (input.staffUser) message += ` | Staff User : ${input.staffUser}`;
    await runtime.slackText(message);
  }

  /** `AjaxHlOrderView.cancel` (`order/views.py:3575-3663`). */
  async function cancel(
    reason: string,
    orderId: string,
    adminId: string,
    platform = '',
  ): Promise<ActionResult> {
    const current = await order(orderId);
    if (!current) return { ok: false, error: { Order: 'Order Not found' } };
    const storeId =
      current.locationType === 'SW' && current.locationId ? String(current.locationId) : '0';
    if (storeId === '0') return { ok: false, error: {} };
    const [refunded] = await db()
      .select({ id: HyperlocalOrderLog.id })
      .from(HyperlocalOrderLog)
      .where(
        and(
          eq(HyperlocalOrderLog.order_id, BigInt(orderId)),
          eq(HyperlocalOrderLog.is_refunded, 1),
        ),
      )
      .limit(1);
    if (refunded) return { ok: false, error: { Order: 'Already refunded' } };
    const split = current.split === 1;
    const lines = await stock.hyperlocalLines(orderId, split);
    const user = await customer(current.userId);
    const response: GatewayResponse | null = await deps.gateway.cancelRefund({
      customer: { id: String(current.userId), twoFactor: user?.twoFactor === 1 },
      orderId,
      reason,
      platform,
      splitProductIds: split ? lines.map((line) => String(line.productId)) : null,
    });
    runtime.log({
      eventId: 'legacy-fulfillment.cancel-refund.sent',
      orderId,
      outcome: 'posted',
      status: response?.status ?? 0,
    });
    if (response?.status !== 200) return { ok: false, error: { Order: response?.text ?? '' } };
    const status = await cancelledStatus();
    await db().transaction(async (tx) => {
      if (split) {
        const others = await tx
          .select({ status: HasProduct.status })
          .from(HasProduct)
          .where(
            and(
              eq(HasProduct.order, BigInt(orderId)),
              inArray(HasProduct.order_platform, [1n, 2n, 3n]),
            ),
          );
        if (!others.some((row) => row.status !== status))
          await tx
            .update(Order)
            .set({ payment_statuses: 5n, order_statuses: 4n })
            .where(eq(Order.id, BigInt(orderId)));
        await tx
          .update(HasProduct)
          .set({ status })
          .where(and(eq(HasProduct.order, BigInt(orderId)), eq(HasProduct.order_platform, 4n)));
      } else {
        await tx
          .update(Order)
          .set({ payment_statuses: 5n, order_statuses: 4n })
          .where(eq(Order.id, BigInt(orderId)));
        await tx
          .update(HasProduct)
          .set({ status })
          .where(eq(HasProduct.order, BigInt(orderId)));
      }
      if (platform !== 'webhook')
        await runtime.upsertCourierLog(tx, orderId, {
          borzo_id: 0n,
          action: 'DECLINED',
          is_created_in_borzo: 0,
          borzo_resp: '',
          source_tracking_url: '',
          destination_tracking_url: '',
          pos_admin_id: Number(adminId),
        });
      await runtime.transactionLog(tx, {
        orderId,
        storeId,
        posUserId: adminId,
        comment: 'Hyperlocal Order Cancelled : Amount Refunded',
      });
      for (const line of lines) {
        const [refund] = await tx
          .select({
            points: AmountToBeRefundedLog.tss_point_used,
            money: AmountToBeRefundedLog.tss_money_used,
            voucher: AmountToBeRefundedLog.gift_voucher_amount,
          })
          .from(AmountToBeRefundedLog)
          .where(
            and(
              eq(AmountToBeRefundedLog.order_id, BigInt(orderId)),
              eq(AmountToBeRefundedLog.prod_id, line.productId),
            ),
          )
          .orderBy(asc(AmountToBeRefundedLog.id))
          .limit(1);
        if (refund && (refund.points || refund.money || refund.voucher))
          await runtime.transactionLog(tx, {
            orderId,
            storeId,
            posUserId: adminId,
            payDict: pythonFloatDict({
              'tss point refunded': refund.points,
              'tss money refunded': refund.money,
              'gift voucher amount refunded': refund.voucher,
            }),
            comment: `Hyperlocal Order cancel refund for Product id: ${line.productId}`,
          });
      }
    });
    if (platform === 'webhook') {
      try {
        const synced = await db().transaction((tx) =>
          stock.restock(
            tx,
            storeId,
            lines.map((line) => ({
              productId: String(line.productId),
              quantity: Number(line.quantity),
            })),
            '0',
            `Product inventory added from admin panel on order cancel, [Order ID:${orderId}]`,
          ),
        );
        await stock.syncProducts(synced, storeId, '0');
      } catch {
        runtime.log({
          eventId: 'legacy-fulfillment.cancel-restock.failed',
          orderId,
          storeId,
          outcome: 'not-restocked',
        });
      }
    }
    return { ok: true, error: {} };
  }

  /** `AjaxHlOrderView.create` (`order/views.py:3455-3573`). */
  async function create(orderId: string, adminId: string, storeId: string): Promise<ActionResult> {
    const current = await order(orderId);
    if (!current) return { ok: false, error: { Order: 'Order Not found' } };
    const name = await storeName(storeId);
    if (await firstAction(orderId, terminalActions))
      return { ok: false, error: { Order: 'Order Already created' } };
    const response = await deps.gateway.createBorzoOrder(orderId, storeId);
    runtime.log({
      eventId: 'legacy-fulfillment.borzo.sent',
      orderId,
      storeId,
      outcome: 'posted',
      status: response.status,
    });
    // `if response:` is false for a 4xx/5xx response (requests.Response.__bool__).
    if (response.status < 200 || response.status >= 400) return { ok: false, error: {} };
    const body = asPythonValue(response.body);
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw new AppError(
        502,
        'COURIER_RESPONSE_INVALID',
        'The courier service returned an unreadable response.',
      );
    const value = body as Record<string, PythonValue>;
    if (value.is_successful === true) {
      const data = value.order as Record<string, PythonValue> | undefined;
      const points = (data?.points ?? []) as Record<string, PythonValue>[];
      const borzoId = data?.order_id;
      if (
        !data ||
        points.length < 2 ||
        (typeof borzoId !== 'number' && typeof borzoId !== 'string')
      )
        throw new AppError(
          502,
          'COURIER_RESPONSE_INVALID',
          'The courier service returned an unreadable response.',
        );
      const tracking = (point: Record<string, PythonValue>) =>
        typeof point.tracking_url === 'string' ? point.tracking_url.slice(0, 255) : null;
      await db().transaction(async (tx) => {
        await runtime.upsertCourierLog(tx, orderId, {
          borzo_id: BigInt(String(borzoId)),
          action: 'ACCEPTED',
          is_created_in_borzo: 1,
          borzo_resp: pythonJsonDumps(response.body),
          source_tracking_url: tracking(points[0]!),
          destination_tracking_url: tracking(points[1]!),
          pos_admin_id: Number(adminId),
        });
        await runtime.transactionLog(tx, {
          orderId,
          storeId,
          posUserId: adminId,
          comment: `Hyperlocal Order Created in Borzo, Order location : ${name}`,
        });
        if (current.split === 1) {
          // Approved divergence (user, 20 November 2026): legacy `views.py:3504` compares the
          // order_statuses FK object with 1, which is never true, so a split order never moved.
          // The intended rule applies: a split order still "Order Placed" (1) moves to this
          // store and status 21 ("Processing").
          await tx
            .update(Order)
            .set({ location_id: Number(storeId), order_statuses: 21n })
            .where(and(eq(Order.id, BigInt(orderId)), eq(Order.order_statuses, 1n)));
          await tx
            .update(HasProduct)
            .set({ status: 'PROCESSING' })
            .where(and(eq(HasProduct.order, BigInt(orderId)), eq(HasProduct.order_platform, 4n)));
        } else {
          await tx
            .update(Order)
            .set({ location_id: Number(storeId), order_statuses: 21n })
            .where(eq(Order.id, BigInt(orderId)));
          await tx
            .update(HasProduct)
            .set({ status: 'PROCESSING' })
            .where(eq(HasProduct.order, BigInt(orderId)));
        }
      });
      if (current.split !== 1) {
        const pushed = await deps.gateway.pushOrderKinesis(orderId);
        runtime.log({
          eventId: 'legacy-fulfillment.order-producer.sent',
          orderId,
          outcome: 'posted',
          status: pushed.status,
        });
      }
      await runtime.slackText(
        `Hyperlocal Order ID:${orderId} Accepted at ${name}, and created in Borzo Succesfully`,
      );
      return { ok: true, error: {} };
    }
    const error: ErrorDictionary = {};
    const parameters = value.parameter_errors;
    if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
      const pointErrors = (parameters as Record<string, PythonValue>).points;
      if (Array.isArray(pointErrors) && pointErrors.length) {
        const store = pointErrors[0] as Record<string, PythonValue> | null;
        const user = pointErrors[1] as Record<string, PythonValue> | null | undefined;
        const field = (point: Record<string, PythonValue>, key: string) =>
          key in point ? point[key]! : null;
        if (store && typeof store === 'object' && Object.keys(store).length)
          error['Store Address'] = field(store, 'address');
        if (user && typeof user === 'object' && Object.keys(user).length) {
          error['User Address'] = field(user, 'address');
          error['Start Datetime'] = field(user, 'required_start_datetime');
          error['Finish Datetime'] = field(user, 'required_finish_datetime');
        }
      }
    }
    await runtime.upsertCourierLog(db(), orderId, {
      borzo_id: 0n,
      action: 'CREATION_FAILED',
      is_created_in_borzo: 0,
      borzo_resp: pythonJsonDumps(response.body),
      error_msg: pythonRepr(error),
      source_tracking_url: '',
      destination_tracking_url: '',
      pos_admin_id: Number(adminId),
    });
    const reason = `Order creation failed at Borzo: ${pythonRepr(error)}`;
    await toOnline({
      orderId,
      storeId,
      platform: 'CONVERT_ONLINE',
      nextIds: current.next === null ? 'None' : current.next,
      reason,
      staffUser: '',
      reasonDropdown: reason,
    });
    error.Order = 'Creating the new online order, please wait.';
    error.action = 'Convert to online';
    return { ok: false, error };
  }

  /** `Helpers.refund_hl_charges` (`helpers/helpers.py:935-965`). */
  async function refundHlCharges(
    orderId: string,
    storeId: string,
    userId: bigint,
    charges: number,
  ) {
    if (!(charges > 0)) return;
    await db().transaction(async (tx) => {
      const [user] = await tx
        .select({ money: MUser.tss_money })
        .from(MUser)
        .where(eq(MUser.id, userId))
        .limit(1)
        .for('update');
      if (!user) return;
      const updated = user.money + charges;
      const at = runtime.now();
      await tx.insert(TssMoneyHistory).values({
        user_id: userId,
        order_id: BigInt(orderId),
        added_amt: charges,
        used_amt: 0,
        amt_before_update: user.money,
        amt_after_update: pythonRound2(updated),
        platform: 'ORDER_REFUND',
        comment: 'Hyperlocal charges refunded',
        added_user: 0n,
        expiry: runtime.timestamp(at.add({ days: 365 })),
        created_at: runtime.timestamp(at),
        updated_at: runtime.timestamp(at),
      });
      await tx
        .update(MUser)
        .set({ cashback: updated, tss_money: updated })
        .where(eq(MUser.id, userId));
      await runtime.transactionLog(tx, {
        orderId,
        storeId,
        posUserId: '0',
        payDict: pythonRepr({ 'Hyperlocal Charges refunded into tss money': charges }),
        comment:
          'Hyperlocal Charges Refunded into tss money and Order has been converted to online order',
      });
    });
  }

  /** `Helpers.create_online_order` (`helpers/helpers.py:1005-1090`). */
  async function createOnlineOrder(input: {
    userId: bigint;
    twoFactor: boolean;
    orderId: string;
    storeId: string;
    nextIds: string;
    platform: 'CONVERT_ONLINE' | 'RTO_CONVERT_ONLINE';
    split: boolean;
    reason: string;
    reasonDropdown: string;
  }): Promise<string | null> {
    const response = await deps.gateway.placeOnlineOrder(
      { id: String(input.userId), twoFactor: input.twoFactor },
      input.orderId,
      input.split,
    );
    runtime.log({
      eventId: 'legacy-fulfillment.online-order.sent',
      orderId: input.orderId,
      outcome: 'posted',
      status: response.status,
    });
    const body = asPythonValue(response.body);
    const value =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, PythonValue>)
        : null;
    const created = value?.order;
    if (
      response.status !== 200 ||
      (typeof created !== 'number' && typeof created !== 'string') ||
      !/^\d{1,19}$/.test(String(created))
    )
      return null;
    const newOrderId = String(created);
    const charges =
      typeof value?.hl_charges_to_be_refunded === 'number' ? value.hl_charges_to_be_refunded : 0;
    const status = await cancelledStatus();
    const at = runtime.timestamp();
    await db().transaction(async (tx) => {
      await tx.insert(HyperlocalToOnlineOrderLog).values({
        order_id: BigInt(input.orderId),
        new_order_id: BigInt(newOrderId),
        platform: input.platform,
        location_type: 'SW',
        location_id: BigInt(input.storeId),
        location_ids: input.nextIds.slice(0, 255),
        reason: input.reasonDropdown.slice(0, 255),
        remark: input.reason.slice(0, 255),
        created_at: at,
        updated_at: at,
      });
      await runtime.upsertCourierLog(tx, input.orderId, {
        borzo_id: 0n,
        action: 'CONVERT_ONLINE',
        is_created_in_borzo: 0,
        borzo_resp: '',
        source_tracking_url: '',
        destination_tracking_url: '',
        pos_admin_id: 0,
      });
      if (input.split) {
        const [other] = await tx
          .select({ id: HasProduct.id })
          .from(HasProduct)
          .where(
            and(
              eq(HasProduct.order, BigInt(input.orderId)),
              inArray(HasProduct.order_platform, [1n, 2n, 3n]),
            ),
          )
          .limit(1);
        if (!other)
          await tx
            .update(Order)
            .set({ payment_statuses: 5n, order_statuses: 4n })
            .where(eq(Order.id, BigInt(input.orderId)));
        await tx
          .update(HasProduct)
          .set({ status })
          .where(
            and(eq(HasProduct.order, BigInt(input.orderId)), eq(HasProduct.order_platform, 4n)),
          );
      }
    });
    if (input.split) {
      const refund = await deps.gateway.refundHlChargesSplit(input.orderId);
      runtime.log({
        eventId: 'legacy-fulfillment.split-charges.sent',
        orderId: input.orderId,
        outcome: 'posted',
        status: refund.status,
      });
    } else {
      await refundHlCharges(input.orderId, input.storeId, input.userId, charges);
      await db().transaction(async (tx) => {
        await tx
          .update(Order)
          .set({ payment_statuses: 5n, order_statuses: 4n })
          .where(eq(Order.id, BigInt(input.orderId)));
        await tx
          .update(HasProduct)
          .set({ status })
          .where(eq(HasProduct.order, BigInt(input.orderId)));
      });
    }
    return newOrderId;
  }

  /** `auto_hl_order_to_online` (O3, `order/views.py:3937-4029`). */
  async function toOnline(input: {
    orderId: string;
    storeId: string;
    platform: 'CONVERT_ONLINE' | 'RTO_CONVERT_ONLINE';
    /** `str(next_ids)` exactly as legacy formats it. */
    nextIds: string;
    reason: string;
    staffUser: string;
    reasonDropdown: string;
  }): Promise<OnlineResult> {
    const { orderId, storeId, platform } = input;
    const blocked = await firstAction(
      orderId,
      platform === 'CONVERT_ONLINE' ? terminalActions : (['DECLINED', 'CONVERT_ONLINE'] as const),
    );
    if (blocked) return { status: 400, message: `Order Already ${blocked}` };
    const current = await order(orderId);
    if (!current) throw new AppError(404, 'LOCAL_DELIVERY_ORDER_NOT_FOUND', 'Order not found.');
    const split = current.split === 1;
    const user = await customer(current.userId);
    const name = user?.name ?? '',
      telephone = user?.telephone ?? '0',
      email = user?.email ?? '';
    const lines = await stock.hyperlocalLines(orderId, split);
    const productIds = [...new Set(lines.map((line) => line.productId))];
    const stocks = productIds.length
      ? await db()
          .select({ id: aggregateStock.productId, stock: aggregateStock.stock })
          .from(aggregateStock)
          .where(inArray(aggregateStock.productId, productIds))
      : [];
    const available = new Map(stocks.map((row) => [String(row.id), row.stock]));
    const online = lines.every((line) => (available.get(String(line.productId)) ?? 0n) > 0n);
    if (!online) {
      const comment = 'Online Conversion Failed: Stock not available at online warehouse';
      await runtime.transactionLog(db(), { orderId, storeId, posUserId: '0', comment });
      if (platform === 'CONVERT_ONLINE') {
        await cancel(comment, orderId, '0');
        const description = `Order ID : ${orderId} | User Mobile ${telephone} and email ${email} |Status:Cancelled/refund`;
        await odTicket({
          orderId,
          name,
          subject: comment,
          description,
          reason: input.reason,
          newOrder: '0',
          staffUser: input.staffUser,
        });
        await stock.unholdForConvert(orderId, storeId);
        return { status: 200, message: description };
      }
      return { status: 400, message: comment };
    }
    const [child] = await db()
      .select({ id: Order.id })
      .from(Order)
      .where(eq(Order.hl_parent_order_id, BigInt(orderId)))
      .orderBy(asc(Order.id))
      .limit(1);
    if (child)
      return {
        status: 400,
        message: `Online Order already created for order_id: ${orderId} and order is ${child.id}`,
      };
    const newOrderId = await createOnlineOrder({
      userId: current.userId,
      twoFactor: user?.twoFactor === 1,
      orderId,
      storeId,
      nextIds: input.nextIds,
      platform,
      split,
      reason: input.reason,
      reasonDropdown: input.reasonDropdown,
    });
    if (!newOrderId) {
      const comment = 'New Online order creation failed';
      await cancel(comment, orderId, '0');
      const description = `Order ID : ${orderId} | User Mobile ${telephone} and email ${email} | Status:Cancelled/refund`;
      await odTicket({
        orderId,
        name,
        subject: comment,
        description,
        reason: input.reason,
        newOrder: '0',
        staffUser: input.staffUser,
      });
      await stock.unholdForConvert(orderId, storeId);
      return { status: 200, message: `${comment}, Initiating the refund` };
    }
    try {
      await enqueue(
        'core.tasks.new_order_create_communication',
        { order_id: newOrderId },
        { queue: 'core' },
      );
    } catch {
      runtime.log({
        eventId: 'legacy-fulfillment.job.enqueue-failed',
        orderId,
        outcome: 'new-order-communication',
      });
    }
    if (platform === 'CONVERT_ONLINE') {
      const description = input.reason
        ? `User Mobile ${telephone} and email ${email} | Order ID : ${orderId} | New Order ID : ${newOrderId} | Reason : ${input.reason}`
        : `User Mobile ${telephone} and email ${email} | Order ID : ${orderId} | New Order ID : ${newOrderId}`;
      await odTicket({
        orderId,
        name,
        subject: 'Hyperlocal order convert into online',
        description,
        reason: input.reason,
        newOrder: newOrderId,
        staffUser: input.staffUser,
      });
    }
    let comment = `Hyperlocal Order Convert into the New Online order, Order ID : # ${newOrderId}`;
    if (input.staffUser) comment += ` | By Staff User: ${input.staffUser}`;
    await runtime.transactionLog(db(), { orderId, storeId, posUserId: '0', comment });
    await stock.unholdForConvert(orderId, storeId);
    return { status: 201, message: 'Order Succesfully convert to online' };
  }

  /** Cut-off countdown: `combine(date, HYPERLOCAL_CUT_OFF_TIME) - now` in whole seconds. */
  function cutOffSeconds(date: Temporal.PlainDate) {
    const [hour, minute] = deps.env.HYPERLOCAL_CUT_OFF_TIME.split(':').map(Number);
    return runtime.secondsUntil(date.toPlainDateTime({ hour: hour!, minute: minute! }));
  }

  /** `auto_hl_order_transfer` (O2, `order/views.py:3844-3935`). */
  async function transfer(
    orderId: string,
    input: { staffUser?: string; reason?: string; isAuto?: boolean; reasonDropdown?: string } = {},
  ): Promise<{ message: string; opr: '' | 'transfer' | 'convert' }> {
    const staffUser = input.staffUser ?? '',
      reason = input.reason ?? '',
      isAuto = input.isAuto ?? true,
      reasonDropdown = input.reasonDropdown ?? '';
    const current = await order(orderId);
    if (!current) throw new AppError(404, 'LOCAL_DELIVERY_ORDER_NOT_FOUND', 'Order not found.');
    const storeId =
      current.locationType === 'SW' && current.locationId ? String(current.locationId) : '';
    let message = '',
      opr: '' | 'transfer' | 'convert' = '';
    if (!storeId) return { message, opr };
    const done = await firstAction(orderId, terminalActions);
    if (done) return { message: `Already ${done}`, opr };
    const raw = (current.next ?? '').trim();
    const platform = 'CONVERT_ONLINE' as const;
    const eligible = !(deps.env.HYPERLOCAL_CUT_OFF_SWITCH && isAuto);
    const online = (
      nextIds: string,
      delaySeconds: number,
      args: { reason: string; staffUser: string; reasonDropdown: string },
    ) =>
      enqueue(
        'order.views.auto_hl_order_to_online',
        {
          order_id: orderId,
          store_id: storeId,
          platform,
          next_ids: nextIds,
          reason: args.reason,
          staff_user: args.staffUser,
          reason_dropdown: args.reasonDropdown,
        },
        { queue: 'order_create', delaySeconds },
      );
    if (!current.transfer) {
      const nextIds = parseLocationIds(raw);
      const stores = locationStoreIds(nextIds);
      if (nextIds.length && eligible) {
        await db()
          .update(Order)
          .set({ is_transfer: 1 })
          .where(eq(Order.id, BigInt(orderId)));
        for (const target of stores)
          await runtime.orderNotification('Hyperlocal Order Transferred', orderId, target, {
            isSlack: true,
            flag: '❌',
            staffUser,
            reason,
          });
        try {
          const lines = await stock.hyperlocalLines(orderId, current.split === 1);
          for (const line of lines) {
            const productId = String(line.productId),
              quantity = Number(line.quantity);
            await stock.unhold(
              productId,
              storeId,
              quantity,
              '0',
              `Hyperlocal order transferred, inventory unhold for order ${orderId}`,
            );
            for (const target of stores)
              await stock.hold(
                productId,
                target,
                quantity,
                '0',
                `Hyperlocal order transferred, inventory hold for order ${orderId}`,
              );
          }
        } catch {
          runtime.log({
            eventId: 'legacy-fulfillment.transfer-stock.failed',
            orderId,
            outcome: 'logged',
          });
        }
        const buffer = deps.env.HYPERLOCAL_CUT_OFF_SWITCH
          ? cutOffSeconds(runtime.now().toPlainDate())
          : await runtime.orderCreationBufferSeconds();
        await db()
          .update(OrderAddon)
          .set({ order_transferred_timestamp: runtime.timestamp() })
          .where(eq(OrderAddon.order_id, BigInt(orderId)));
        // Approved divergence (user, 20 November 2026): legacy `views.py:3915` passes
        // [order_id, store_id, platform, next_ids, "", reason_dropdown] positionally, so the
        // dropdown landed in `staff_user` and `reason_dropdown` stayed "". The pass reason now
        // goes to `reason_dropdown` and the staff user to `staff_user`, as the other branches.
        await online(pythonRepr(nextIds), buffer, {
          reason: '',
          staffUser,
          reasonDropdown,
        });
        const comment = `Hyperlocal Order has been Transferred to the other stores, ${pythonRepr(nextIds)}`;
        await runtime.transactionLog(db(), { orderId, storeId, posUserId: '0', comment });
        message = comment;
        opr = 'transfer';
      } else {
        message = 'Next store not alligned, Online order creating is in progress';
        await online(pythonRepr(nextIds), 0, { reason, staffUser, reasonDropdown });
        opr = 'convert';
      }
    } else {
      await online(raw, 0, { reason, staffUser, reasonDropdown });
      opr = 'convert';
    }
    if (isAuto)
      await runtime.slackText(`Order wait time exceeded for ID: ${orderId}`, { flag: '⏱️' });
    return { message, opr };
  }

  /** `AutoHlOrderView.post` (`order/views.py:3675-3720`), after authentication. */
  async function arrival(orderId: string, locationId: string, notify: boolean) {
    // Refuse before any hold or notice when the O2 timer cannot be scheduled.
    if (!deps.jobs) throw jobUnavailable();
    const current = await order(orderId);
    if (!current?.start)
      throw new AppError(404, 'LOCAL_DELIVERY_ORDER_NOT_FOUND', 'Order not found.');
    const start = Temporal.PlainDateTime.from(current.start.replace(' ', 'T')).toPlainDate();
    const now = runtime.now();
    const today = now.toPlainDate();
    const target = Temporal.PlainDate.compare(start, today) > 0 ? start : today;
    let advance: Temporal.PlainDateTime | null = null;
    if (/^[1-9]\d{0,18}$/.test(locationId)) {
      const [slot] = await db()
        .select({ start: PosHyperlocalSlot.start_timeslot })
        .from(PosHyperlocalSlot)
        .where(
          and(
            eq(PosHyperlocalSlot.store_id, BigInt(locationId)),
            eq(PosHyperlocalSlot.weekday, weekdays[target.dayOfWeek - 1]!),
          ),
        )
        .orderBy(asc(PosHyperlocalSlot.id))
        .limit(1);
      if (slot) {
        const storeTime = target.toPlainDateTime(Temporal.PlainTime.from(slot.start));
        if (Temporal.PlainDateTime.compare(storeTime, now) > 0) {
          await db()
            .update(OrderAddon)
            .set({ order_success_timestamp: runtime.timestamp(storeTime) })
            .where(eq(OrderAddon.order_id, BigInt(orderId)));
          advance = storeTime;
        }
      }
    }
    let extra = 0;
    const title = 'Hyperlocal Order';
    if (advance) {
      extra = runtime.secondsUntil(advance);
      if (notify)
        await enqueue(
          'order.views.advance_order_notification',
          {
            title,
            order_id: orderId,
            store_id: locationId,
            is_slack: true,
            is_new_order: true,
            send_to_common: true,
          },
          { queue: 'order_create', delaySeconds: extra },
        );
    } else if (notify)
      // Legacy T5: an un-awaited task on the request loop (`views.py:3701-3703`).
      void runtime
        .orderNotification(title, orderId, locationId, { isSlack: true, isNewOrder: true })
        .catch(() =>
          runtime.log({
            eventId: 'legacy-fulfillment.arrival-notice.failed',
            orderId,
            outcome: 'dropped',
          }),
        );
    try {
      const lines = await stock.hyperlocalLines(orderId, current.split === 1);
      for (const line of lines)
        await stock.hold(
          String(line.productId),
          locationId,
          Number(line.quantity),
          '0',
          `Hyperlocal Order placed, inventory hold for order ${orderId}`,
        );
    } catch {
      runtime.log({
        eventId: 'legacy-fulfillment.arrival-hold.failed',
        orderId,
        outcome: 'logged',
      });
    }
    const buffer = deps.env.HYPERLOCAL_CUT_OFF_SWITCH
      ? cutOffSeconds(Temporal.PlainDate.compare(start, today) > 0 ? start : today)
      : (await runtime.orderCreationBufferSeconds()) + extra;
    await enqueue(
      'order.views.auto_hl_order_transfer',
      { order_id: orderId },
      { queue: 'order_create', delaySeconds: buffer },
    );
    try {
      const storeId = current.locationId ? String(current.locationId) : '';
      const raw = current.next?.trim();
      const nextIds = raw ? (JSON.parse(raw) as unknown) : [];
      if (!Array.isArray(nextIds)) throw new Error('next_location_ids');
      let backups = '';
      for (const id of nextIds) {
        const name = await storeName(String(id));
        if (!name) throw new Error('backup store');
        backups += `${name}, `;
      }
      const name = storeId ? await storeName(storeId) : '';
      if (name)
        await runtime.transactionLog(db(), {
          orderId,
          storeId,
          posUserId: '0',
          comment:
            `Hyperlocal Order first lands on ${name}` +
            (backups
              ? ` and backup stores are ${backups}`
              : ' and not a single backup store aligned'),
        });
    } catch {
      runtime.log({ eventId: 'legacy-fulfillment.arrival-log.failed', orderId, outcome: 'logged' });
    }
  }

  /** `WebhookCancelledOrderView.post` (`order/views.py:4279-4305`), after authentication. */
  async function webhookCancel(input: {
    orderId: string;
    storeId: string;
    platform: string;
    notify: boolean;
    title: string;
  }) {
    const comment =
      input.platform === 'rto'
        ? 'RTO-intransit'
        : input.platform === 'cancelled'
          ? 'Delivery cancelled'
          : 'cancelled';
    if (input.notify)
      await runtime.orderNotification(
        input.title || 'Hyperlocal Order',
        input.orderId,
        input.storeId,
      );
    return cancel(comment, input.orderId, '0', 'webhook');
  }

  /** `AJaxConvertOnlineView.convert_online` (`order/views.py:3831-3836`). */
  async function convertOnline(orderId: string, storeId: string) {
    const current = await order(orderId);
    if (!current) throw new AppError(404, 'LOCAL_DELIVERY_ORDER_NOT_FOUND', 'Order not found.');
    return toOnline({
      orderId,
      storeId,
      platform: 'RTO_CONVERT_ONLINE',
      nextIds: (current.next ?? '').trim(),
      reason: '',
      staffUser: '',
      reasonDropdown: '',
    });
  }
  return {
    order,
    create,
    cancel,
    transfer,
    toOnline,
    arrival,
    webhookCancel,
    convertOnline,
    firstAction,
  };
}
export type HyperlocalLifecycle = ReturnType<typeof hyperlocalLifecycle>;
