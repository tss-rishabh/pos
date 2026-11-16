import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { ExpressLineItem, Notification, Store, UsersNotification } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { AppError } from '../../domain/errors.js';
import { generatedId } from '../../db/generated-id.js';
import { sourceIntId } from './source-id.js';
import { checkInService } from '../administration/checkins.js';
import type { NoticeEvent, NotificationBus } from './notification-bus.js';
import { localTimestamp } from './domain.js';
import { notificationEvents, fulfillmentEffects } from './schema.js';

export interface ExpressNoticeCommand {
  eventId: string;
  orderId: string;
  storeIds: string[];
}
export function notificationDelivery(
  config: Config,
  db: Databases,
  bus: NotificationBus,
  checkins: Pick<ReturnType<typeof checkInService>, 'checkedInUsers'> = checkInService(db, config),
) {
  const now = () => localTimestamp(Temporal.Now.instant(), config.BUSINESS_TIMEZONE);
  async function publish(eventId: string, storeId: string, notice: NoticeEvent) {
    const active = new Set(await checkins.checkedInUsers(storeId));
    await bus.publish({
      ...notice,
      userIds: notice.userIds.filter((userId) => active.has(userId)),
    });
    await db
      .get('writer')
      .update(notificationEvents)
      .set({ publishedAt: now() })
      .where(and(eq(notificationEvents.eventId, eventId), eq(notificationEvents.storeId, storeId)));
  }
  return {
    async receive(command: ExpressNoticeCommand, requestId: string | null = null) {
      const data = [];
      for (const storeId of [...new Set(command.storeIds)]) {
        const storeNumber = sourceIntId(storeId);
        const hash = createHash('sha256')
          .update(JSON.stringify({ orderId: command.orderId, storeId }))
          .digest('hex');
        const users = await checkins.checkedInUsers(storeId);
        const notice = await retryTransaction(() =>
          db.get('writer').transaction(async (tx) => {
            await tx
              .insert(notificationEvents)
              .values({
                eventId: command.eventId,
                storeId,
                requestHash: hash,
                requestId,
                createdAt: now(),
              })
              .onDuplicateKeyUpdate({ set: { eventId: command.eventId } });
            const [reservation] = await tx
              .select()
              .from(notificationEvents)
              .where(
                and(
                  eq(notificationEvents.eventId, command.eventId),
                  eq(notificationEvents.storeId, storeId),
                ),
              )
              .for('update');
            if (reservation!.requestHash !== hash)
              throw new AppError(
                409,
                'IDEMPOTENCY_CONFLICT',
                'This event ID was used with different data.',
              );
            if (reservation!.notice) return reservation!.notice;
            const [line] = await tx
              .select({ id: ExpressLineItem.id })
              .from(ExpressLineItem)
              .where(
                and(
                  eq(ExpressLineItem.order, BigInt(command.orderId)),
                  eq(ExpressLineItem.store_id, storeNumber),
                ),
              )
              .limit(1);
            if (!line)
              throw new AppError(
                404,
                'FULFILLMENT_ORDER_NOT_FOUND',
                'Express order not found in the requested store.',
              );
            const [store] = await tx
              .select({ name: Store.store_name })
              .from(Store)
              .where(eq(Store.id, BigInt(storeId)))
              .limit(1);
            const timestamp = now();
            const inserted = {
              id: generatedId(
                await tx.insert(Notification).values({
                  title: `Hyperlocal Order to ${store?.name || `Store ${storeId}`}`,
                  order_id: BigInt(command.orderId),
                  store_id: storeNumber,
                  created_at: timestamp,
                  updated_at: timestamp,
                }),
              ),
            };
            if (users.length)
              await tx.insert(UsersNotification).values(
                users.map((userId) => ({
                  notification: BigInt(inserted.id),
                  pos_admin_id: sourceIntId(userId),
                  is_viewed: 0,
                  created_at: timestamp,
                  updated_at: timestamp,
                })),
              );
            const result: NoticeEvent = {
              event: 'notification.created',
              notificationId: String(inserted.id),
              storeId,
              userIds: users,
              isNewOrder: true,
            };
            await tx.insert(fulfillmentEffects).values({
              id: randomUUID(),
              commandId: command.eventId,
              operatorId: 'service',
              requestId,
              storeId,
              orderId: command.orderId,
              kind: 'store-notification',
              payload: { action: 'NEW_ORDER', commonChannel: false, productIds: [] },
              status: 'PENDING',
              attempts: 0,
              sequence: 0,
              createdAt: timestamp,
            });
            await tx
              .update(notificationEvents)
              .set({ notice: result })
              .where(
                and(
                  eq(notificationEvents.eventId, command.eventId),
                  eq(notificationEvents.storeId, storeId),
                ),
              );
            return result;
          }),
        );
        // Duplicate event IDs cannot insert duplicate DB notices. Publication is
        // at-least-once; consumers deduplicate the stable notification ID.
        let publication: 'published' | 'pending' = 'published';
        try {
          await publish(command.eventId, storeId, notice);
        } catch {
          publication = 'pending';
        }
        data.push({ storeId, notificationId: notice.notificationId, publication });
      }
      return { eventId: command.eventId, data };
    },
    async publishPending(limit = 100) {
      const rows = await db
        .get('writer')
        .select()
        .from(notificationEvents)
        .where(isNull(notificationEvents.publishedAt))
        .orderBy(asc(notificationEvents.createdAt))
        .limit(limit);
      let completed = 0;
      for (const row of rows) {
        if (!row.notice) continue;
        try {
          await publish(row.eventId, row.storeId, row.notice);
          completed++;
        } catch {
          break;
        }
      }
      return { completed };
    },
  };
}
