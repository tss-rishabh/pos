import { and, eq } from 'drizzle-orm';
import { Notification, Store, UsersNotification } from '../../../db/legacy-schema.js';
import { generatedId } from '../../../db/generated-id.js';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { notificationEvents } from '../../fulfillment/schema.js';
import { sourceIntId } from '../../fulfillment/source-id.js';
import { hash, reconciliation } from './domain.js';
export function deliveryNotice(config: Config, db: Databases) {
  const checkins = checkInService(db, config);
  return async (
    tx: AdministrationTransaction,
    input: {
      eventId: string;
      orderId: string;
      storeId: string;
      title: string;
      reason: string;
      newOrder: boolean;
      timestamp: string;
      requestId: string;
    },
  ) => {
    const [store] = await tx
      .select({ name: Store.store_name, active: Store.is_active })
      .from(Store)
      .where(eq(Store.id, BigInt(input.storeId)))
      .limit(1)
      .for('share');
    if (!store?.active) throw reconciliation();
    const title =
      input.title + ` to ${store.name}` + (input.reason ? ` | Reason: ${input.reason}` : '');
    if ([...title].length > 255) throw reconciliation();
    const users = await checkins.checkedInUsers(input.storeId),
      requestHash = hash([input.orderId, input.storeId, title, input.newOrder]);
    await tx
      .insert(notificationEvents)
      .values({
        eventId: input.eventId,
        storeId: input.storeId,
        requestHash,
        requestId: input.requestId,
        createdAt: input.timestamp,
      })
      .onDuplicateKeyUpdate({ set: { eventId: input.eventId } });
    const [existing] = await tx
      .select()
      .from(notificationEvents)
      .where(
        and(
          eq(notificationEvents.eventId, input.eventId),
          eq(notificationEvents.storeId, input.storeId),
        ),
      )
      .limit(1)
      .for('update');
    if (!existing || existing.requestHash !== requestHash) throw reconciliation();
    if (existing.notice) return existing.notice;
    const id = generatedId(
      await tx.insert(Notification).values({
        title,
        order_id: BigInt(input.orderId),
        store_id: sourceIntId(input.storeId),
        created_at: input.timestamp,
        updated_at: input.timestamp,
      }),
    );
    if (users.length)
      await tx.insert(UsersNotification).values(
        users.map((userId) => ({
          notification: id,
          pos_admin_id: sourceIntId(userId),
          is_viewed: 0,
          created_at: input.timestamp,
          updated_at: input.timestamp,
        })),
      );
    const notice = {
      event: 'notification.created' as const,
      notificationId: String(id),
      storeId: input.storeId,
      userIds: users,
      isNewOrder: input.newOrder,
    };
    await tx
      .update(notificationEvents)
      .set({ notice })
      .where(
        and(
          eq(notificationEvents.eventId, input.eventId),
          eq(notificationEvents.storeId, input.storeId),
        ),
      );
    return notice;
  };
}
