import { Temporal } from '@js-temporal/polyfill';
import { createClient } from 'redis';
import { eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { outboundAllowlistEnabled, outboundPermitted } from '../../outbound/allowlist.js';
import { PosUser, Store } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import type { SettingsEffect, SettingsEffectDelivery } from './settings-domain.js';
import type { SettingsOptionsEnvironment } from './settings-options.js';

export interface SettingsCache {
  set(key: string, value: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
const makeRedis = (url: string) =>
  createClient({
    url,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 10,
    socket: { connectTimeout: 1000, reconnectStrategy: false },
  });
function commonCache(config: Config, connectionUrl: string): SettingsCache {
  const url = new URL(connectionUrl);
  if (
    !['redis:', 'rediss:'].includes(url.protocol) ||
    url.hash ||
    url.search ||
    (config.NODE_ENV === 'production' && url.protocol !== 'rediss:')
  )
    throw new AppError(
      503,
      'COMMON_CACHE_CONFIGURATION_INVALID',
      'Configure the approved common cache with TLS.',
    );
  let client: ReturnType<typeof makeRedis> | undefined;
  let ready: Promise<ReturnType<typeof makeRedis>> | undefined;
  function reset() {
    if (client?.isOpen) client.destroy();
    client = undefined;
    ready = undefined;
  }
  return {
    async set(key, value, outerSignal) {
      const signal = outerSignal
        ? AbortSignal.any([outerSignal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000);
      const abort = () => reset();
      signal.throwIfAborted();
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (!ready) {
          client = makeRedis(connectionUrl);
          client.on('error', () => {});
          ready = client
            .connect()
            .then(() => client!)
            .catch(() => {
              reset();
              throw new AppError(
                503,
                'COMMON_CACHE_UNAVAILABLE',
                'The common cache is unavailable.',
              );
            });
        }
        const connection = await ready;
        await connection.withCommandOptions({ abortSignal: signal, timeout: 5000 }).set(key, value);
      } catch {
        reset();
        throw new AppError(503, 'COMMON_CACHE_UNAVAILABLE', 'The common cache is unavailable.');
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
    async close() {
      reset();
    },
  };
}
const slackText = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function settingsNotice(
  effect: SettingsEffect,
  actor: string,
  store: string,
  timezone: string,
): string | null {
  const local = Temporal.PlainDateTime.from(effect.occurredAt.replace(' ', 'T'))
    .toZonedDateTime('UTC')
    .withTimeZone(timezone);
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][local.month - 1];
  const timestamp = `${String(local.day).padStart(2, '0')} ${month} ${local.year} ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}:${String(local.second).padStart(2, '0')}`;
  const by = `by ${slackText(actor)} at ${timestamp}`;
  const name = slackText(store);
  switch (effect.kind) {
    case 'buffer.notice':
      return `🔺 Buffer time is updated to ${effect.value} ${by}`;
    case 'slot.timing.notice':
      return `🔺 ${slackText(effect.weekday)} slot timing of ${name} is changed from ${effect.previous} to ${effect.current} ${by}`;
    case 'slot.availability.notice':
      return `🔺 ${effect.weekday === null ? 'All slots' : `${slackText(effect.weekday)} slot`} of ${name} marked as ${effect.active ? 'Open' : 'Closed'} ${by}`;
    case 'ecommerce.threshold.notice':
      return `🔺 Ecom delivery stock threshold of ${name} has been changed from ${effect.previous} to ${effect.current} ${by}`;
    case 'ecommerce.availability.notice':
      return `🔺 Ecom delivery of ${name} marked as ${effect.active ? 'Open' : 'Closed'} ${by}`;
    default:
      return null;
  }
}
export function createSettingsDelivery(
  config: Config,
  db: Databases,
  options: SettingsOptionsEnvironment,
  injected: { cache?: SettingsCache; fetcher?: typeof fetch } = {},
): SettingsEffectDelivery {
  const fetcher = injected.fetcher || fetch;
  const cache =
    injected.cache ||
    (options.COMMON_REDIS_URL ? commonCache(config, options.COMMON_REDIS_URL) : undefined);
  const webhook = options.SLACK_URL ? new URL(options.SLACK_URL) : undefined;
  if (
    webhook &&
    (webhook.protocol !== 'https:' ||
      !['hooks.slack.com', 'hooks.slack-gov.com'].includes(webhook.hostname) ||
      webhook.username ||
      webhook.password ||
      webhook.search ||
      webhook.hash ||
      !webhook.pathname.startsWith('/services/'))
  )
    throw new AppError(
      503,
      'SETTINGS_NOTICE_CONFIGURATION_INVALID',
      'Configure an approved settings notification webhook.',
    );
  return {
    supports(kind) {
      return kind === 'setting.cache' ? !!cache : !!webhook;
    },
    async deliver(effect, signal) {
      if (effect.kind === 'setting.cache') {
        if (!cache)
          throw new AppError(503, 'COMMON_CACHE_UNAVAILABLE', 'The common cache is unavailable.');
        await cache.set(effect.key, String(effect.value), signal);
        return;
      }
      if (!webhook)
        throw new AppError(
          503,
          'SETTINGS_NOTICE_UNAVAILABLE',
          'Settings notifications are unavailable.',
        );
      const [actor] = await db
        .get('primary')
        .select({ first: PosUser.first_name, last: PosUser.last_name })
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(effect.actorId)))
        .limit(1);
      const [store] =
        'storeId' in effect
          ? await db
              .get('primary')
              .select({ name: Store.store_name })
              .from(Store)
              .where(eq(Store.id, BigInt(effect.storeId)))
              .limit(1)
          : [];
      const text = settingsNotice(
        effect,
        actor ? `${actor.first} ${actor.last}`.trim() : `Operator ${effect.actorId}`,
        store?.name || ('storeId' in effect ? `Store ${effect.storeId}` : ''),
        config.BUSINESS_TIMEZONE,
      );
      if (!text)
        throw new AppError(503, 'SETTINGS_EFFECT_INVALID', 'Settings effects require review.');
      // Allowlist guard (w25): a suppressed notice completes like a posted one.
      if (
        outboundAllowlistEnabled() &&
        !(await outboundPermitted({
          channel: 'slack',
          module: 'administration',
          flow: 'settings-slack-notice',
          targets: [{ kind: 'slack-webhook', value: webhook }],
        }))
      )
        return;
      try {
        const response = await fetcher(webhook, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
            : AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
        if (!response.ok)
          throw new AppError(
            503,
            'SETTINGS_NOTICE_UNAVAILABLE',
            'Settings notifications are unavailable.',
          );
      } catch {
        throw new AppError(
          503,
          'SETTINGS_NOTICE_UNAVAILABLE',
          'Settings notifications are unavailable.',
        );
      }
    },
    async close() {
      await cache?.close();
    },
  };
}
