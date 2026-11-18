import { z } from 'zod';

const identifierPattern = /^[1-9]\d{0,18}$/;
export const notificationIdentifier = z
  .string()
  .regex(identifierPattern)
  .refine((value) => identifierPattern.test(value) && BigInt(value) <= 9223372036854775807n);

export const storeNoticeSchema = z.object({
  id: notificationIdentifier,
  title: z.string().max(1024),
  url: z.string().max(2048).nullable(),
  orderId: z.string().max(20).nullable(),
  isViewed: z.boolean(),
  createdAt: z.string().max(64),
});
export const storeNoticesSchema = z.object({
  data: z.array(storeNoticeSchema).max(100),
  unreadCount: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export const notificationEventSchema = z
  .object({
    event: z.enum(['notification.created', 'notification.read']),
    notificationId: notificationIdentifier,
    storeId: notificationIdentifier,
    isNewOrder: z.boolean(),
  })
  .strict();

export type StoreNotice = z.infer<typeof storeNoticeSchema>;
export type NotificationEvent = z.infer<typeof notificationEventSchema>;
export interface IncomingNotificationAlert {
  notice: StoreNotice;
  isNewOrder: boolean;
}
