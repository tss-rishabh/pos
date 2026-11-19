import { Temporal } from '@js-temporal/polyfill';
import { eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { Notification, Store, UsersNotification } from '../../db/legacy-schema.js';
import { generatedId } from '../../db/generated-id.js';
import { retryTransaction } from '../../db/retry.js';
import { sourceIntId } from './source-id.js';
import type { CheckInReader } from './checkin.js';
import type { FulfillmentEffects, FulfillmentLogger } from './effects.js';
import type { NotificationBus } from './notification-bus.js';
import { localTimestamp } from './domain.js';
import { slackText } from './slack-text.js';

export interface OrderNotificationInput {
  title: string;
  orderId: string;
  storeId: string;
  isSlack?: boolean;
  isNewOrder?: boolean;
  /** Legacy `flag`, prefixed to the Slack text. */
  flag?: string;
  /** Legacy `staff_user`, appended to the Slack text. */
  staffUser?: string;
  reason?: string;
  sendToCommon?: boolean;
}
export interface OrderNotificationDependencies {
  config: Pick<Config, 'BUSINESS_TIMEZONE'>;
  db: Databases;
  checkins: Pick<CheckInReader, 'checkedInUsers'>;
  effects: Pick<FulfillmentEffects, 'slack'>;
  bus?: Pick<NotificationBus, 'publish'>;
  log?: FulfillmentLogger;
  clock?: () => Temporal.Instant;
}
/**
 * Legacy `create_order_notification_sync` (`helpers/notification_helpers.py:40-57`), the body of
 * job O5 `order.views.advance_order_notification` (`order/views.py:4481-4483`) and of the
 * synchronous calls in the hyperlocal transfer flows. Order: Slack, `pos_notifications`,
 * `pos_user_notifications` for the users in `check_in_list_{store}`, then the live push.
 */
export async function createOrderNotification(
  deps: OrderNotificationDependencies,
  input: OrderNotificationInput,
): Promise<{ notificationId: string } | null> {
  if (!/^\d+$/.test(input.orderId) || BigInt(input.orderId) <= 0n) return null;
  const db = deps.db.get('writer'),
    storeNumber = sourceIntId(input.storeId),
    now = localTimestamp(
      (deps.clock ?? (() => Temporal.Now.instant()))(),
      deps.config.BUSINESS_TIMEZONE,
    );
  const [store] = await db
    .select({ name: Store.store_name })
    .from(Store)
    .where(eq(Store.id, BigInt(input.storeId)))
    .limit(1);
  let title = input.title;
  if (store) title += ` to ${store.name ?? 'None'}`;
  if (input.reason) title += ` | Reason: ${input.reason}`;
  if (input.isSlack) {
    let text = `🛵 Order Id: ${input.orderId}, ${slackText(title)}`;
    if (input.flag) text = `${input.flag} ${text}`;
    if (input.staffUser) text += ` | Staff User : ${slackText(input.staffUser)}`;
    await deps.effects.slack(text, {
      storeId: input.storeId,
      sendToCommon: input.sendToCommon ?? true,
    });
  }
  const users = await deps.checkins.checkedInUsers(input.storeId);
  const notificationId = await retryTransaction(() =>
    db.transaction(async (tx) => {
      const id = generatedId(
        await tx.insert(Notification).values({
          title,
          order_id: BigInt(input.orderId),
          store_id: storeNumber,
          created_at: now,
          updated_at: now,
        }),
      );
      if (users.length)
        await tx.insert(UsersNotification).values(
          users.map((userId) => ({
            notification: id,
            pos_admin_id: sourceIntId(userId),
            is_viewed: 0,
            created_at: now,
            updated_at: now,
          })),
        );
      return String(id);
    }),
  );
  // Legacy group_send is best effort (`notification_helpers.py:13-29` swallows errors).
  if (deps.bus)
    await deps.bus
      .publish({
        event: 'notification.created',
        notificationId,
        storeId: input.storeId,
        userIds: users,
        isNewOrder: input.isNewOrder ?? false,
      })
      .catch(() =>
        deps.log?.('warn', {
          eventId: 'fulfillment.notification.publish-failed',
          resource: 'notification',
          outcome: 'failed',
          storeId: input.storeId,
        }),
      );
  return { notificationId };
}
