import { randomUUID } from 'node:crypto';
import { and, asc, gt, gte, isNull } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import { settingsEffects } from './settings-schema.js';
import { settingsEffectSchema, type SettingsEffectDelivery } from './settings-domain.js';
import { settingsOutbox } from './settings-outbox.js';
import type { SettingsWorkerOptions } from './settings-options.js';

export interface SettingsWorkerEvent {
  module: 'administration';
  resource: 'settings-delivery' | 'settings-delivery-worker';
  eventId: string;
  eventInstanceId: string;
  requestId: string | null;
  userId: string | null;
  effectId?: string;
  storeId?: string | null;
  errorCode?: string;
}
export type SettingsWorkerLogger = (
  level: 'info' | 'warn',
  event: SettingsWorkerEvent,
  message: string,
) => void;
const event = (
  resource: SettingsWorkerEvent['resource'],
  action: string,
  requestId: string | null = null,
  userId: string | null = null,
): SettingsWorkerEvent => ({
  module: 'administration',
  resource,
  eventId: `administration.${resource}.${action}`,
  eventInstanceId: randomUUID(),
  requestId,
  userId,
});
export function settingsWorker(
  db: Databases,
  delivery: SettingsEffectDelivery,
  options: SettingsWorkerOptions,
  log: SettingsWorkerLogger,
) {
  const outbox = settingsOutbox(db, delivery),
    alerted = new Set<string>();
  function rememberBlocked(id: string) {
    alerted.add(id);
    if (alerted.size > 1000) alerted.delete(alerted.values().next().value!);
  }
  let afterBlocked = 0n;
  async function alertBlocked(runId: string) {
    const rows = await db
      .get('writer')
      .select()
      .from(settingsEffects)
      .where(
        and(
          isNull(settingsEffects.deliveredAt),
          gte(settingsEffects.attempts, 10),
          gt(settingsEffects.sequence, afterBlocked),
        ),
      )
      .orderBy(asc(settingsEffects.sequence))
      .limit(options.SETTINGS_WORKER_BATCH_SIZE);
    afterBlocked = rows.length === options.SETTINGS_WORKER_BATCH_SIZE ? rows.at(-1)!.sequence : 0n;
    for (const row of rows) {
      if (alerted.has(row.id)) continue;
      rememberBlocked(row.id);
      const parsed = settingsEffectSchema.safeParse(row.payload);
      log(
        'warn',
        {
          ...event(
            'settings-delivery',
            'blocked',
            parsed.success ? parsed.data.requestId || runId : runId,
            parsed.success ? parsed.data.actorId : null,
          ),
          effectId: row.id,
          errorCode: 'SETTINGS_DELIVERY_BLOCKED',
        },
        'Settings delivery requires operator recovery',
      );
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined,
    active: Promise<void> | undefined,
    abort: AbortController | undefined,
    stopping = false,
    backoff = options.SETTINGS_WORKER_INTERVAL_MS;
  const runOnce = () => {
    if (stopping || !options.SETTINGS_WORKER_ENABLED) return Promise.resolve();
    if (active) return active;
    const runId = randomUUID(),
      seen: string[] = [];
    let failed = false;
    abort = new AbortController();
    const deadline = setTimeout(() => abort?.abort(), 20000);
    deadline.unref();
    active = (async () => {
      try {
        for (
          let index = 0;
          index < options.SETTINGS_WORKER_BATCH_SIZE && !stopping && !abort?.signal.aborted;
          index++
        ) {
          const result = await outbox.dispatchNext(abort?.signal, seen);
          if (!result) break;
          seen.push(result.id);
          failed ||= result.status !== 'delivered';
          if (result.status === 'blocked') rememberBlocked(result.id);
          else alerted.delete(result.id);
          log(
            result.status === 'delivered' ? 'info' : 'warn',
            {
              ...event(
                'settings-delivery',
                result.status,
                result.requestId || runId,
                result.actorId,
              ),
              effectId: result.id,
              storeId: result.storeId,
              ...(result.errorCode ? { errorCode: result.errorCode } : {}),
            },
            result.status === 'delivered'
              ? 'Settings delivery acknowledged'
              : 'Settings delivery requires retry or recovery',
          );
        }
        await alertBlocked(runId);
      } catch {
        failed = true;
        log(
          'warn',
          {
            ...event('settings-delivery-worker', 'batch-failed', runId),
            errorCode: 'SETTINGS_DELIVERY_UNAVAILABLE',
          },
          'Settings delivery could not complete this batch',
        );
      } finally {
        backoff = failed ? Math.min(60000, backoff * 2) : options.SETTINGS_WORKER_INTERVAL_MS;
        clearTimeout(deadline);
        active = undefined;
        abort = undefined;
      }
    })();
    return active;
  };
  async function tick() {
    await runOnce();
    if (!stopping) timer = setTimeout(() => void tick(), backoff);
  }
  return {
    runOnce,
    start() {
      if (timer || active || stopping) return;
      if (!options.SETTINGS_WORKER_ENABLED) {
        log('info', event('settings-delivery-worker', 'disabled'), 'Settings delivery is disabled');
        return;
      }
      log('info', event('settings-delivery-worker', 'started'), 'Settings delivery started');
      void tick();
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      abort?.abort();
      await active;
      log('info', event('settings-delivery-worker', 'stopped'), 'Settings delivery stopped');
    },
  };
}
