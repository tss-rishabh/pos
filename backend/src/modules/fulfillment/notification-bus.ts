import { createClient } from 'redis';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError, unavailable } from '../../domain/errors.js';

const noticeEventSchema = z
  .object({
    event: z.enum(['notification.created', 'notification.read']),
    notificationId: z.string().regex(/^\d+$/),
    storeId: z.string().regex(/^\d+$/),
    userIds: z.array(z.string().regex(/^\d+$/)).max(2000),
    isNewOrder: z.boolean(),
  })
  .strict();
export type NoticeEvent = z.infer<typeof noticeEventSchema>;
type Listener = (event: Omit<NoticeEvent, 'userIds'>) => void;
const makeClient = (url: string) =>
  createClient({ url, socket: { connectTimeout: 5000, reconnectStrategy: false } });
type NotificationRedis = ReturnType<typeof makeClient>;
export function notificationBus(config: Config, onConnectionError: () => void = () => {}) {
  let publisher: NotificationRedis | undefined, subscriber: NotificationRedis | undefined;
  let publisherReady: Promise<NotificationRedis> | undefined,
    subscriberReady: Promise<NotificationRedis> | undefined;
  const channels = new Map<
    string,
    { listeners: Map<string, { userId: string; receive: Listener }>; ready: Promise<void> }
  >();
  const url = () => {
    if (!config.REDIS_URL) return unavailable('Notification Redis');
    const parsed = new URL(config.REDIS_URL),
      local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
    if (
      !['redis:', 'rediss:'].includes(parsed.protocol) ||
      (config.NODE_ENV === 'production' && !local && parsed.protocol !== 'rediss:')
    )
      throw new AppError(
        503,
        'INVALID_REDIS_CONFIGURATION',
        'Remote notification Redis requires TLS.',
      );
    return config.REDIS_URL;
  };
  async function connection(kind: 'publisher' | 'subscriber') {
    const existing = kind === 'publisher' ? publisherReady : subscriberReady;
    if (existing) return existing;
    const client = makeClient(url());
    client.on('error', onConnectionError);
    const ready = client
      .connect()
      .then(() => client)
      .catch(() => {
        if (kind === 'publisher') publisherReady = undefined;
        else subscriberReady = undefined;
        throw new AppError(
          503,
          'NOTIFICATIONS_UNAVAILABLE',
          'Live notifications are temporarily unavailable.',
        );
      });
    if (kind === 'publisher') {
      publisher = client;
      publisherReady = ready;
    } else {
      subscriber = client;
      subscriberReady = ready;
    }
    return ready;
  }
  return {
    async publish(event: NoticeEvent) {
      const client = await connection('publisher');
      const safe = noticeEventSchema.parse(event);
      await client.publish(`pos-rewrite:notifications:${safe.storeId}`, JSON.stringify(safe));
    },
    async subscribe(storeId: string, userId: string, id: string, receive: Listener) {
      const client = await connection('subscriber'),
        channel = `pos-rewrite:notifications:${storeId}`;
      let entry = channels.get(channel);
      if (!entry) {
        const listeners = new Map<string, { userId: string; receive: Listener }>();
        const ready = client
          .subscribe(channel, (message) => {
            const parsed = noticeEventSchema.safeParse(
              (() => {
                try {
                  return JSON.parse(message) as unknown;
                } catch {
                  return null;
                }
              })(),
            );
            if (!parsed.success || parsed.data.storeId !== storeId) return;
            const { userIds, ...event } = parsed.data;
            for (const listener of listeners.values())
              if (userIds.includes(listener.userId)) listener.receive(event);
          })
          .then(() => {});
        entry = { listeners, ready };
        channels.set(channel, entry);
      }
      entry.listeners.set(id, { userId, receive });
      try {
        await entry.ready;
      } catch {
        entry.listeners.delete(id);
        channels.delete(channel);
        throw new AppError(
          503,
          'NOTIFICATIONS_UNAVAILABLE',
          'Live notifications are temporarily unavailable.',
        );
      }
      return async () => {
        const current = channels.get(channel);
        if (!current) return;
        current.listeners.delete(id);
        if (!current.listeners.size) {
          channels.delete(channel);
          await client.unsubscribe(channel);
        }
      };
    },
    async close() {
      channels.clear();
      await Promise.all(
        [publisher, subscriber]
          .filter((client): client is NotificationRedis => Boolean(client))
          .map(async (client) => {
            if (client.isOpen) await client.quit();
          }),
      );
    },
  };
}
export type NotificationBus = ReturnType<typeof notificationBus>;
