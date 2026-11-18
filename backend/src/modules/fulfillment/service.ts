import { sourceIntId as integerId } from './source-id.js';
import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, min, or, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  ExpressLineItem,
  ExpressOrderStatusLog,
  HasProduct,
  HyperlocalRejectionReason,
  Notification,
  Order,
  OrderStatus,
  Product,
  UsersNotification,
} from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { assertCurrentStoreAccess } from '../administration/authorization.js';
import { checkInService } from '../administration/checkins.js';
import { requireRole, requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import {
  actionableLines,
  actionStates,
  calendarBounds,
  fulfillmentOrderFacts,
  localTimestamp,
  planEffects,
  tabStatuses,
  type FulfillmentAction,
  type FulfillmentLine,
  type FulfillmentTab,
} from './domain.js';
import { fulfillmentCommands, fulfillmentEffects, type ActionReceipt } from './schema.js';

function safeNotificationUrl(value: string | null): string | null {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u001f\u007f]/.test(value)
  )
    return null;
  try {
    // WHATWG parsing normalizes slash/backslash prefixes into network URLs.
    // Validate the actual destination rather than a leading-slash regex alone.
    const origin = 'https://pos.invalid';
    const parsed = new URL(value, origin);
    return parsed.origin === origin && !parsed.username && !parsed.password ? value : null;
  } catch {
    return null;
  }
}

export const lineSelection = {
  id: ExpressLineItem.id,
  orderId: ExpressLineItem.order,
  storeId: ExpressLineItem.store_id,
  hasProductId: ExpressLineItem.has_product,
  status: ExpressLineItem.status,
  pendingExpiresAt: ExpressLineItem.pending_expires_at,
  acceptedExpiresAt: ExpressLineItem.accepted_expires_at,
  productId: HasProduct.product,
  productName: Product.product,
  productStatus: HasProduct.status,
  quantity: HasProduct.qty,
  preGstAmount: HasProduct.pre_gst_amt,
  gst: HasProduct.gst,
  awb: HasProduct.awb,
  shipmentId: HasProduct.shipment_id,
  vincStatus: ExpressLineItem.vinc_status,
};
type LineRecord = { [K in keyof typeof lineSelection]: unknown };
export function linesToDto(rows: LineRecord[]): FulfillmentLine[] {
  return rows.map((row) => ({
    id: String(row.id),
    orderId: String(row.orderId),
    storeId: String(row.storeId),
    hasProductId: String(row.hasProductId),
    status: row.status === null ? null : String(row.status),
    pendingExpiresAt: row.pendingExpiresAt === null ? null : String(row.pendingExpiresAt),
    acceptedExpiresAt: row.acceptedExpiresAt === null ? null : String(row.acceptedExpiresAt),
    productId: row.productId === null ? null : String(row.productId),
    productName: row.productName === null ? null : String(row.productName),
    productStatus: row.productStatus === null ? null : String(row.productStatus),
    quantity: row.quantity === null ? null : String(row.quantity),
    preGstAmount: row.preGstAmount === null ? null : Number(row.preGstAmount),
    gst: row.gst === null ? null : Number(row.gst),
    awb: row.awb === null ? null : String(row.awb),
    shipmentId: row.shipmentId === null ? null : String(row.shipmentId),
    vincStatus: String(row.vincStatus || ''),
  }));
}

export interface FulfillmentCommand {
  commandId: string;
  action: FulfillmentAction;
  storeId: string;
  orderId: string;
  rejectionReasonId?: string;
  lineId?: string;
  sourceReference?: string;
}
export interface AdminFulfillmentEdit {
  status?: string;
  pendingExpiresAt?: string;
  acceptedExpiresAt?: string;
}

export function fulfillmentService(
  config: Config,
  databases: Databases,
  clock = () => Temporal.Now.instant(),
) {
  const checkins = checkInService(databases, config);
  const timestamp = () => localTimestamp(clock(), config.BUSINESS_TIMEZONE);
  const todayFilter = (tab: FulfillmentTab, storeId: string) => {
    const bounds = calendarBounds(clock(), config.BUSINESS_TIMEZONE);
    const expires =
      tab === 'in_queue' ? ExpressLineItem.pending_expires_at : ExpressLineItem.accepted_expires_at;
    return and(
      eq(ExpressLineItem.store_id, integerId(storeId)),
      inArray(ExpressLineItem.status, [...tabStatuses[tab]]),
      gte(expires, bounds.start),
      lt(expires, bounds.end),
    );
  };
  async function executeCommand(
    user: Principal,
    command: FulfillmentCommand,
    requestId: string | null = null,
    fromCourier = false,
  ): Promise<ActionReceipt> {
    if (!fromCourier && !/^[1-9]\d*$/.test(user.id))
      throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    requireStore(user, command.storeId);
    const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    return retryTransaction(() =>
      databases.get('writer').transaction(async (tx) => {
        if (!fromCourier) await assertCurrentStoreAccess(tx, user.id, command.storeId);
        const now = timestamp();
        await tx
          .insert(fulfillmentCommands)
          .values({
            operatorId: user.id,
            commandId: command.commandId,
            requestHash: hash,
            createdAt: now,
          })
          .onDuplicateKeyUpdate({ set: { commandId: command.commandId } });
        const [reservation] = await tx
          .select()
          .from(fulfillmentCommands)
          .where(
            and(
              eq(fulfillmentCommands.operatorId, user.id),
              eq(fulfillmentCommands.commandId, command.commandId),
            ),
          )
          .for('update');
        if (reservation!.requestHash !== hash)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This command ID was used with different data.',
          );
        if (reservation!.result) return reservation!.result;
        if (command.action === 'REJECT') {
          if (!command.rejectionReasonId)
            throw new AppError(400, 'REJECTION_REASON_REQUIRED', 'Rejection reason is required');
          const [reason] = await tx
            .select({ id: HyperlocalRejectionReason.id })
            .from(HyperlocalRejectionReason)
            .where(
              and(
                eq(HyperlocalRejectionReason.id, BigInt(command.rejectionReasonId)),
                eq(HyperlocalRejectionReason.is_active, true),
              ),
            )
            .limit(1);
          if (!reason)
            throw new AppError(400, 'INVALID_REJECTION_REASON', 'Invalid rejection reason');
        }
        const locked = await tx
          .select({ id: ExpressLineItem.id })
          .from(ExpressLineItem)
          .where(
            and(
              eq(ExpressLineItem.order, BigInt(command.orderId)),
              eq(ExpressLineItem.store_id, integerId(command.storeId)),
            ),
          )
          .for('update');
        if (!locked.length)
          throw new AppError(
            404,
            'FULFILLMENT_ORDER_NOT_FOUND',
            'No line items found for this order and store.',
          );
        const rows = await tx
          .select(lineSelection)
          .from(ExpressLineItem)
          .leftJoin(HasProduct, eq(HasProduct.id, ExpressLineItem.has_product))
          .leftJoin(Product, eq(Product.id, HasProduct.product))
          .where(
            inArray(
              ExpressLineItem.id,
              locked.map((row) => row.id),
            ),
          );
        const selected = actionableLines(command.action, linesToDto(rows), command.lineId);
        if (
          command.sourceReference &&
          command.action === 'SHIP' &&
          !selected.some((line) => line.awb === command.sourceReference)
        )
          throw new AppError(
            409,
            'SHIPMENT_REFERENCE_CHANGED',
            'The shipment reference changed. Check the current order before continuing.',
          );
        const state = actionStates[command.action];
        if (selected.length) {
          await tx
            .update(ExpressLineItem)
            .set({
              status: state.to,
              updated_at: now,
              ...(command.action === 'REJECT'
                ? { rejection_reason_id: integerId(command.rejectionReasonId!) }
                : {}),
            })
            .where(
              inArray(
                ExpressLineItem.id,
                selected.map((line) => integerId(line.id)),
              ),
            );
          if (command.action === 'SHIP') {
            await tx
              .update(HasProduct)
              .set({ status: 'OUT_FOR_DELIVERY', updated_at: now })
              .where(
                inArray(
                  HasProduct.id,
                  selected.map((line) => BigInt(line.hasProductId)),
                ),
              );
            const [ofd] = await tx
              .select({ id: OrderStatus.id })
              .from(OrderStatus)
              .where(eq(OrderStatus.order_status, 'Out For Delivery'))
              .orderBy(asc(OrderStatus.id))
              .limit(1);
            await tx
              .update(Order)
              .set({ order_statuses: ofd?.id || 26n, updated_at: now })
              .where(eq(Order.id, BigInt(command.orderId)));
          }
          await tx.insert(ExpressOrderStatusLog).values({
            order_id: BigInt(command.orderId),
            store_id: integerId(command.storeId),
            old_status: selected[0]!.status || '',
            new_status: state.to,
            changed_at: now,
          });
        }
        const effects = planEffects(
          command.action,
          command.orderId,
          command.storeId,
          selected,
          command.rejectionReasonId,
        );
        const effectIds = effects.map(() => randomUUID());
        if (effects.length)
          await tx.insert(fulfillmentEffects).values(
            effects.map((effect, index) => ({
              id: effectIds[index]!,
              commandId: command.commandId,
              operatorId: user.id,
              requestId,
              storeId: command.storeId,
              orderId: command.orderId,
              kind: effect.kind,
              payload: effect.payload,
              status: 'PENDING',
              attempts: 0,
              sequence: index,
              createdAt: now,
            })),
          );
        const result: ActionReceipt = {
          commandId: command.commandId,
          action: command.action,
          storeId: command.storeId,
          orderId: command.orderId,
          updatedCount:
            command.action === 'SHIP'
              ? new Set(
                  selected
                    .filter((line) => line.productId !== null)
                    .map((line) => line.hasProductId),
                ).size
              : selected.length,
          integrationState: effects.length ? 'pending' : 'not-required',
          effectIds,
        };
        await tx
          .update(fulfillmentCommands)
          .set({ result })
          .where(
            and(
              eq(fulfillmentCommands.operatorId, user.id),
              eq(fulfillmentCommands.commandId, command.commandId),
            ),
          );
        return result;
      }),
    );
  }
  return {
    async summary(user: Principal, storeId: string) {
      requireStore(user, storeId);
      const bounds = calendarBounds(clock(), config.BUSINESS_TIMEZONE);
      const rows = await databases
        .get('primary')
        .selectDistinct({ orderId: ExpressLineItem.order, status: ExpressLineItem.status })
        .from(ExpressLineItem)
        .where(
          and(
            eq(ExpressLineItem.store_id, integerId(storeId)),
            or(
              and(
                eq(ExpressLineItem.status, 'PENDING'),
                gte(ExpressLineItem.pending_expires_at, bounds.start),
                lt(ExpressLineItem.pending_expires_at, bounds.end),
              ),
              and(
                inArray(ExpressLineItem.status, [
                  'ACCEPTED',
                  'PACKED',
                  'OUT_FOR_DELIVERY',
                  'DELIVERED',
                  'RTO',
                ]),
                gte(ExpressLineItem.accepted_expires_at, bounds.start),
                lt(ExpressLineItem.accepted_expires_at, bounds.end),
              ),
            ),
          ),
        );
      const sets: Record<FulfillmentTab, Set<string>> = {
        in_queue: new Set(),
        not_packed: new Set(),
        packed: new Set(),
        shipped: new Set(),
      };
      for (const row of rows)
        for (const tab of Object.keys(sets) as FulfillmentTab[])
          if (tabStatuses[tab].includes(row.status as 'PENDING'))
            sets[tab].add(String(row.orderId));
      return {
        tabCounts: Object.fromEntries(Object.entries(sets).map(([tab, ids]) => [tab, ids.size])),
        orderIds: Object.fromEntries(
          Object.entries(sets).map(([tab, ids]) => [
            tab,
            [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)),
          ]),
        ),
      };
    },
    async orders(user: Principal, storeId: string, tab: FulfillmentTab, offset = 0, limit = 20) {
      requireStore(user, storeId);
      const db = databases.get('primary');
      const eligible = db
        .selectDistinct({ orderId: ExpressLineItem.order })
        .from(ExpressLineItem)
        .where(todayFilter(tab, storeId));
      const expires =
        tab === 'in_queue'
          ? ExpressLineItem.pending_expires_at
          : ExpressLineItem.accepted_expires_at;
      // Count/filter on qualifying statuses, but compute the minimum expiry over
      // every store line, matching the original annotate() on mixed-status orders.
      const rows = await db
        .select({
          id: Order.id,
          reference: Order.order_ref_no,
          createdAt: Order.created_at,
          firstName: Order.first_name,
          lastName: Order.last_name,
          phone: Order.phone_no,
          address1: Order.address1,
          address2: Order.address2,
          city: Order.city,
          postalCode: Order.postal_code,
          expiresAt: min(expires),
        })
        .from(Order)
        .innerJoin(ExpressLineItem, eq(ExpressLineItem.order, Order.id))
        .where(and(eq(ExpressLineItem.store_id, integerId(storeId)), inArray(Order.id, eligible)))
        .groupBy(Order.id)
        .orderBy(asc(min(expires)), asc(Order.id))
        .limit(limit + 1)
        .offset(offset);
      const page = rows.slice(0, limit);
      const lineRows = page.length
        ? await db
            .select(lineSelection)
            .from(ExpressLineItem)
            .leftJoin(HasProduct, eq(HasProduct.id, ExpressLineItem.has_product))
            .leftJoin(Product, eq(Product.id, HasProduct.product))
            .where(
              and(
                eq(ExpressLineItem.store_id, integerId(storeId)),
                inArray(
                  ExpressLineItem.order,
                  page.map((row) => row.id),
                ),
              ),
            )
            .orderBy(asc(ExpressLineItem.id))
        : [];
      const lines = linesToDto(lineRows);
      return {
        data: page.map((row) => {
          const orderLines = lines.filter((line) => line.orderId === String(row.id));
          return {
            id: String(row.id),
            reference: row.reference,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            customer: {
              name: `${row.firstName} ${row.lastName}`.trim(),
              phone: row.phone,
              address1: row.address1,
              address2: row.address2,
              city: row.city,
              postalCode: row.postalCode,
            },
            lines: orderLines,
            ...fulfillmentOrderFacts(orderLines),
          };
        }),
        hasMore: rows.length > limit,
        nextOffset: offset + page.length,
      };
    },
    async expiryAlerts(user: Principal, storeId: string) {
      requireStore(user, storeId);
      const start = timestamp(),
        end = localTimestamp(clock().add({ minutes: 35 }), config.BUSINESS_TIMEZONE);
      const db = databases.get('primary');
      const result: { orderId: string; type: 'pending' | 'accepted'; expiresAt: string }[] = [];
      for (const type of ['pending', 'accepted'] as const) {
        const expiry =
          type === 'pending'
            ? ExpressLineItem.pending_expires_at
            : ExpressLineItem.accepted_expires_at;
        const rows = await db
          .select({ orderId: ExpressLineItem.order, expiresAt: min(expiry) })
          .from(ExpressLineItem)
          .where(
            and(
              eq(ExpressLineItem.store_id, integerId(storeId)),
              eq(ExpressLineItem.status, type === 'pending' ? 'PENDING' : 'ACCEPTED'),
              gte(expiry, start),
              lte(expiry, end),
            ),
          )
          .groupBy(ExpressLineItem.order)
          .orderBy(asc(min(expiry)));
        result.push(
          ...rows.flatMap((row) =>
            row.expiresAt ? [{ orderId: String(row.orderId), type, expiresAt: row.expiresAt }] : [],
          ),
        );
      }
      const counts = await this.summary(user, storeId);
      return {
        expiringSoon: result,
        bannerCounts: {
          unaccepted: counts.tabCounts.in_queue || 0,
          unpacked: counts.tabCounts.not_packed || 0,
          packed: counts.tabCounts.packed || 0,
        },
      };
    },
    async rejectionReasons() {
      const rows = await databases
        .get('primary')
        .select({ id: HyperlocalRejectionReason.id, reason: HyperlocalRejectionReason.reason })
        .from(HyperlocalRejectionReason)
        .where(eq(HyperlocalRejectionReason.is_active, true))
        .orderBy(asc(HyperlocalRejectionReason.id));
      return { data: rows.map((row) => ({ ...row, id: String(row.id) })) };
    },
    execute(
      user: Principal,
      command: FulfillmentCommand,
      requestId: string | null = null,
    ): Promise<ActionReceipt> {
      return executeCommand(user, command, requestId);
    },
    async edit(user: Principal, storeId: string, orderId: string, edit: AdminFulfillmentEdit) {
      requireRole(user, [1]);
      requireStore(user, storeId);
      return retryTransaction(() =>
        databases.get('writer').transaction(async (tx) => {
          await assertCurrentStoreAccess(tx, user.id, storeId, [1]);
          const rows = await tx
            .select({ id: ExpressLineItem.id, status: ExpressLineItem.status })
            .from(ExpressLineItem)
            .where(
              and(
                eq(ExpressLineItem.order, BigInt(orderId)),
                eq(ExpressLineItem.store_id, integerId(storeId)),
              ),
            )
            .for('update');
          if (!rows.length)
            throw new AppError(
              404,
              'FULFILLMENT_ORDER_NOT_FOUND',
              'No line items found for this order',
            );
          const now = timestamp();
          const changed = rows.filter((row) => edit.status && row.status !== edit.status);
          if (changed.length)
            await tx.insert(ExpressOrderStatusLog).values(
              changed.map((row) => ({
                order_id: BigInt(orderId),
                store_id: integerId(storeId),
                old_status: row.status || '',
                new_status: edit.status!,
                changed_at: now,
              })),
            );
          await tx
            .update(ExpressLineItem)
            .set({
              updated_at: now,
              ...(edit.status ? { status: edit.status } : {}),
              ...(edit.pendingExpiresAt
                ? { pending_expires_at: edit.pendingExpiresAt.replace('T', ' ') + ':00' }
                : {}),
              ...(edit.acceptedExpiresAt
                ? { accepted_expires_at: edit.acceptedExpiresAt.replace('T', ' ') + ':00' }
                : {}),
            })
            .where(
              inArray(
                ExpressLineItem.id,
                rows.map((row) => row.id),
              ),
            );
          return { updatedCount: rows.length };
        }),
      );
    },
    async shipFromCourier(
      commandId: string,
      orderId: string,
      awb: string,
      requestId: string | null = null,
    ) {
      const db = databases.get('writer'),
        operatorId = 'service-courier';
      const [prior] = await db
        .select({ result: fulfillmentCommands.result })
        .from(fulfillmentCommands)
        .where(
          and(
            eq(fulfillmentCommands.operatorId, operatorId),
            eq(fulfillmentCommands.commandId, commandId),
          ),
        )
        .limit(1);
      let storeId = prior?.result?.storeId;
      if (!storeId) {
        const matches = await db
          .selectDistinct({ storeId: ExpressLineItem.store_id })
          .from(ExpressLineItem)
          .innerJoin(HasProduct, eq(HasProduct.id, ExpressLineItem.has_product))
          .where(
            and(
              eq(ExpressLineItem.order, BigInt(orderId)),
              eq(HasProduct.awb, awb),
              eq(ExpressLineItem.status, 'PACKED'),
            ),
          )
          .limit(2);
        if (matches.length !== 1)
          throw new AppError(
            409,
            'SHIPMENT_STORE_UNRESOLVED',
            'Could not resolve store for order/awb',
          );
        storeId = String(matches[0]!.storeId);
      }
      const actor: Principal = {
        id: operatorId,
        name: 'Courier integration',
        email: '',
        role: 4,
        userType: 1,
        storeIds: [storeId],
      };
      return executeCommand(
        actor,
        {
          commandId,
          action: 'SHIP',
          storeId,
          orderId,
          sourceReference: awb,
        },
        requestId,
        true,
      );
    },
    async receipt(user: Principal, commandId: string) {
      return retryTransaction(() =>
        databases.get('writer').transaction(async (tx) => {
          const [command] = await tx
            .select({ result: fulfillmentCommands.result })
            .from(fulfillmentCommands)
            .where(
              and(
                eq(fulfillmentCommands.operatorId, user.id),
                eq(fulfillmentCommands.commandId, commandId),
              ),
            )
            .limit(1);
          if (!command?.result) throw new AppError(404, 'COMMAND_NOT_FOUND', 'Command not found.');
          requireStore(user, command.result.storeId);
          await assertCurrentStoreAccess(tx, user.id, command.result.storeId);
          const effects = await tx
            .select({
              id: fulfillmentEffects.id,
              kind: fulfillmentEffects.kind,
              status: fulfillmentEffects.status,
              lastErrorCode: fulfillmentEffects.lastErrorCode,
            })
            .from(fulfillmentEffects)
            .where(
              and(
                eq(fulfillmentEffects.operatorId, user.id),
                eq(fulfillmentEffects.commandId, commandId),
              ),
            );
          return { ...command.result, effects };
        }),
      );
    },
    async notifications(user: Principal, storeId: string, after = '0', limit = 30) {
      requireStore(user, storeId);
      const db = databases.get('primary');
      const where = and(
        eq(UsersNotification.pos_admin_id, integerId(user.id)),
        eq(Notification.store_id, integerId(storeId)),
      );
      const rows = await db
        .select({
          id: Notification.id,
          title: Notification.title,
          url: Notification.url_key,
          orderId: Notification.order_id,
          isViewed: UsersNotification.is_viewed,
          createdAt: Notification.created_at,
        })
        .from(UsersNotification)
        .innerJoin(Notification, eq(UsersNotification.notification, sql`${Notification.id}`))
        .where(and(where, after !== '0' ? gt(Notification.id, BigInt(after)) : undefined))
        .orderBy(desc(Notification.id))
        .limit(limit + 1);
      const [count] = await db
        .select({ count: sql<number>`count(*)` })
        .from(UsersNotification)
        .innerJoin(Notification, eq(UsersNotification.notification, sql`${Notification.id}`))
        .where(and(where, eq(UsersNotification.is_viewed, 0)));
      return {
        data: rows.slice(0, limit).map((row) => ({
          ...row,
          id: String(row.id),
          orderId: row.orderId === null ? null : String(row.orderId),
          isViewed: row.isViewed === 1,
          url: safeNotificationUrl(row.url),
        })),
        unreadCount: Number(count?.count || 0),
        hasMore: rows.length > limit,
      };
    },
    async markNotificationRead(user: Principal, storeId: string, notificationId: string) {
      requireStore(user, storeId);
      return retryTransaction(() =>
        databases.get('writer').transaction(async (db) => {
          // Lock current actor/store/check-in authority before touching read state.
          // A concurrent checkout or assignment revocation cannot cross this write.
          await checkins.assertCheckIn(user.id, storeId, undefined, db);
          const [notice] = await db
            .select({ id: Notification.id })
            .from(Notification)
            .where(
              and(
                eq(Notification.id, BigInt(notificationId)),
                eq(Notification.store_id, integerId(storeId)),
              ),
            )
            .limit(1);
          if (notice)
            await db
              .update(UsersNotification)
              .set({ is_viewed: 1, updated_at: timestamp() })
              .where(
                and(
                  eq(UsersNotification.notification, BigInt(notificationId)),
                  eq(UsersNotification.pos_admin_id, integerId(user.id)),
                ),
              );
          return { status: 'success', message: 'Recorded' };
        }),
      );
    },
  };
}
export type FulfillmentService = ReturnType<typeof fulfillmentService>;
