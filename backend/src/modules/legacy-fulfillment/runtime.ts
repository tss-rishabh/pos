import { Temporal } from '@js-temporal/polyfill';
import { asc, eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  HyperlocalOrderLog,
  Notification,
  Order,
  PosTransactionLog,
  Store,
  TssSetting,
  UsersNotification,
} from '../../db/legacy-schema.js';
import { generatedId } from '../../db/generated-id.js';
import { legacyZeroDateTime } from '../../db/legacy-columns.js';
import type { JobProducer } from '../../jobs/contract.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { ProductSyncAdapter } from '../administration/product-sync.js';
import type { StockProcedure } from '../administration/stock-procedure.js';
import type { OrderRedis } from '../fulfillment/order-redis.js';
import type { HyperlocalGateway } from './gateway.js';
import type { LegacyFulfillmentEnvironment } from './options.js';

export type Writer = AdministrationTransaction | ReturnType<Databases['get']>;
/** Live notification fan-out (legacy Channels `group_send("notification_order")`). */
export interface NoticePublication {
  event: 'notification.created';
  notificationId: string;
  storeId: string;
  userIds: string[];
  isNewOrder: boolean;
}
/** Registered resource events only: ids and outcome codes, never bodies or PII. */
export type LifecycleLog = (event: {
  eventId: string;
  orderId?: string;
  storeId?: string;
  outcome: string;
  status?: number;
}) => void;
export interface LegacyFulfillmentDependencies {
  config: Config;
  db: Databases;
  env: LegacyFulfillmentEnvironment;
  gateway: HyperlocalGateway;
  /** Legacy `redis_instance` (db 0): `check_in_list_{store}`. */
  redis: OrderRedis;
  /** Legacy `common_redis_instance`: `ORDER_CREATION_BUFFER_TIME_IN_SEC`. Optional. */
  commonRedis?: OrderRedis;
  jobs?: JobProducer;
  /** `pos_stock_syncer` equivalent for an operator (legacy `sync_pos_inventory`). */
  stockProcedure?: StockProcedure;
  /** Same for the legacy system actor 0. */
  systemStockProcedure?: StockProcedure;
  /** Legacy `Helpers.sync_pos_product`. */
  syncProducts?: ProductSyncAdapter;
  publish?: (event: NoticePublication) => Promise<void>;
  clock?: () => Temporal.Instant;
  log?: LifecycleLog;
}

export function lifecycleRuntime(deps: LegacyFulfillmentDependencies) {
  const clock = deps.clock ?? (() => Temporal.Now.instant()),
    zone = deps.config.BUSINESS_TIMEZONE,
    log: LifecycleLog = deps.log ?? (() => {});
  /** `datetime.datetime.now()` on the legacy server (TZ Asia/Kolkata). */
  const now = () => clock().toZonedDateTimeISO(zone).toPlainDateTime();
  const timestamp = (value: Temporal.PlainDateTime = now()) =>
    value.toString({ smallestUnit: 'second' }).replace('T', ' ');
  const writer = () => deps.db.get('writer');

  /** Legacy `Helpers.transaction_logger` (`helpers/helpers.py:421`); `pay_dict` is `str(dict)`. */
  async function transactionLog(
    tx: Writer,
    input: {
      orderId: string;
      storeId: string;
      userId?: string;
      posUserId: string;
      payDict?: string;
      comment: string;
    },
  ) {
    const [order] = await tx
      .select({ orderStatus: Order.order_statuses, paymentStatus: Order.payment_statuses })
      .from(Order)
      .where(eq(Order.id, BigInt(input.orderId)))
      .limit(1);
    if (!order) return null;
    const at = timestamp();
    return generatedId(
      await tx.insert(PosTransactionLog).values({
        order_id: BigInt(input.orderId),
        store_id: BigInt(input.storeId),
        order_status: order.orderStatus,
        payment_status: order.paymentStatus,
        user_id: BigInt(input.userId ?? '0'),
        pos_user_id: BigInt(input.posUserId),
        pay_dict: input.payDict ?? '{}',
        // CharField(255): MySQL under the production (non-strict) sql_mode truncates.
        comment: [...input.comment].slice(0, 255).join(''),
        created_at: at,
        updated_at: at,
      }),
    ).toString();
  }

  /**
   * `HyperlocalOrderLog.objects.update_or_create(order_id=…, defaults=…)`. The row normally
   * exists (API-v2 creates it with the order). If it does not, the insert omits
   * `delivery_exception_date` as the Django model does; MySQL stores the zero date under the
   * production sql_mode, written explicitly here.
   */
  async function upsertCourierLog(
    tx: Writer,
    orderId: string,
    values: Partial<typeof HyperlocalOrderLog.$inferInsert>,
  ) {
    const at = timestamp();
    const [existing] = await tx
      .select({ id: HyperlocalOrderLog.id })
      .from(HyperlocalOrderLog)
      .where(eq(HyperlocalOrderLog.order_id, BigInt(orderId)))
      .orderBy(asc(HyperlocalOrderLog.id))
      .limit(1);
    if (existing) {
      await tx
        .update(HyperlocalOrderLog)
        .set({ ...values, updated_at: at })
        .where(eq(HyperlocalOrderLog.id, existing.id));
      return;
    }
    await tx.insert(HyperlocalOrderLog).values({
      order_id: BigInt(orderId),
      borzo_id: 0n,
      action: 'NO_ACTION',
      main_location_id: 0,
      is_created_in_borzo: 0,
      rto_recieved: 0,
      is_pack: 0,
      is_rto: 0,
      is_refunded: 0,
      delivery_exception_msg: '',
      pos_admin_id: 0,
      ...values,
      delivery_exception_date: legacyZeroDateTime,
      created_at: at,
      updated_at: at,
    });
  }

  /** Legacy `Helpers.slack_text_notification` (`helpers/helpers.py:1093-1130`). Never throws. */
  async function slackText(
    message: string,
    input: {
      flag?: string;
      staffUser?: string;
      storeId?: string | null;
      sendToCommon?: boolean;
    } = {},
  ) {
    let text = input.flag ? `${input.flag} ${message}` : message;
    if (input.staffUser) text += ` | Staff User : ${input.staffUser}`;
    const common = deps.gateway.commonSlackUrl;
    let target = common;
    if (input.storeId) {
      const [store] = await writer()
        .select({ url: Store.slack_group_url })
        .from(Store)
        .where(eq(Store.id, BigInt(input.storeId)))
        .limit(1);
      if (store?.url) target = store.url;
    }
    const sendToCommon = input.sendToCommon ?? true;
    if (!sendToCommon && (!target || target === common)) {
      log({ eventId: 'legacy-fulfillment.slack.skipped', outcome: 'no-store-channel' });
      return;
    }
    if (target) {
      const response = await deps.gateway.slack({ url: target }, text);
      log({ eventId: 'legacy-fulfillment.slack.sent', outcome: 'posted', status: response.status });
    }
    if (sendToCommon && deps.gateway.commonAlertOn && common && target !== common) {
      const response = await deps.gateway.slack({ url: common }, text);
      log({
        eventId: 'legacy-fulfillment.slack.sent',
        outcome: 'common-copy',
        status: response.status,
      });
    }
  }

  /** Legacy `Helpers.get_checked_in_user` (`helpers/helpers.py:815`): Redis `check_in_list_{store}`. */
  async function checkedInUsers(storeId: string): Promise<string[]> {
    if (!/^[1-9]\d*$/.test(storeId)) return [];
    const values = await deps.redis.lRange(`check_in_list_${storeId}`, 0, -1);
    return values.flatMap((value) =>
      /^\d{1,10}$/.test(value.trim()) ? [String(Number(value.trim()))] : [],
    );
  }

  /**
   * Legacy `create_order_notification_sync` (`helpers/notification_helpers.py:40-57`): Slack,
   * one `pos_notifications` row, `pos_user_notifications` for the checked-in users, then the
   * live fan-out. Store id 0 or a missing store keeps the bare title, as legacy does.
   */
  async function orderNotification(
    title: string,
    orderId: string,
    storeId: string,
    input: {
      isSlack?: boolean;
      isNewOrder?: boolean;
      flag?: string;
      staffUser?: string;
      reason?: string;
      sendToCommon?: boolean;
    } = {},
  ) {
    if (!/^\d+$/.test(orderId) || BigInt(orderId) <= 0n) return;
    let text = title;
    const [store] = /^\d+$/.test(storeId)
      ? await writer()
          .select({ name: Store.store_name })
          .from(Store)
          .where(eq(Store.id, BigInt(storeId)))
          .limit(1)
      : [];
    if (store) text += ` to ${store.name}`;
    if (input.reason) text += ` | Reason: ${input.reason}`;
    if (input.isSlack)
      await slackText(`🛵 Order Id: ${orderId}, ${text}`, {
        flag: input.flag,
        staffUser: input.staffUser,
        storeId,
        sendToCommon: input.sendToCommon,
      });
    const users = await checkedInUsers(storeId).catch(() => [] as string[]);
    const at = timestamp();
    const notificationId = await writer().transaction(async (tx) => {
      const id = generatedId(
        await tx.insert(Notification).values({
          title: [...text].slice(0, 255).join(''),
          order_id: BigInt(orderId),
          store_id: Number(storeId),
          created_at: at,
          updated_at: at,
        }),
      );
      if (users.length)
        await tx.insert(UsersNotification).values(
          users.map((userId) => ({
            notification: id,
            is_viewed: 0,
            pos_admin_id: Number(userId),
            created_at: at,
            updated_at: at,
          })),
        );
      return id;
    });
    if (deps.publish)
      await deps
        .publish({
          event: 'notification.created',
          notificationId: String(notificationId),
          storeId,
          userIds: users,
          isNewOrder: input.isNewOrder === true,
        })
        .catch(() =>
          log({
            eventId: 'legacy-fulfillment.notification.publish-failed',
            orderId,
            storeId,
            outcome: 'dropped',
          }),
        );
  }

  /** Python `datetime.combine(date, time) - now` in whole seconds (`int(total_seconds())`). */
  function secondsUntil(target: Temporal.PlainDateTime) {
    const current = now();
    const nanoseconds =
      target.toZonedDateTime(zone).epochNanoseconds -
      current.toZonedDateTime(zone).epochNanoseconds;
    return Number(nanoseconds / 1_000_000_000n);
  }
  /** Legacy `Helpers.get_order_creation_buffer_time` (`helpers/helpers.py:1212-1232`). */
  async function orderCreationBufferSeconds(): Promise<number> {
    let value: string | number = 3600;
    try {
      const cached = deps.commonRedis
        ? await deps.commonRedis.get('ORDER_CREATION_BUFFER_TIME_IN_SEC')
        : null;
      if (cached !== null) value = cached;
      else {
        const [setting] = await writer()
          .select({ value: TssSetting.value })
          .from(TssSetting)
          .where(eq(TssSetting.platform, 'ORDER_CREATION_BUFFER_TIME_IN_SEC'))
          .orderBy(asc(TssSetting.id))
          .limit(1);
        const first = setting ? String(setting.value) : undefined;
        if (first !== undefined) {
          value = first;
          if (deps.commonRedis)
            await deps.commonRedis.set('ORDER_CREATION_BUFFER_TIME_IN_SEC', String(first));
        }
      }
      const parsed = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isInteger(parsed)) return 3600;
      return parsed;
    } catch {
      log({ eventId: 'legacy-fulfillment.buffer-time.failed', outcome: 'default' });
      return 3600;
    }
  }
  return {
    deps,
    clock,
    now,
    timestamp,
    writer,
    log,
    transactionLog,
    upsertCourierLog,
    slackText,
    orderNotification,
    checkedInUsers,
    secondsUntil,
    orderCreationBufferSeconds,
  };
}
export type LifecycleRuntime = ReturnType<typeof lifecycleRuntime>;
