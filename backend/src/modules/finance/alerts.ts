import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { Store, StoreDayClose } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import { parseStoreRollout } from '../../domain/rollout.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { slackText } from '../fulfillment/slack-text.js';
import { postSlackText, type SlackPoster } from '../operational-reports/slack.js';
import { lastExpiredDate } from './domain.js';

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
export function financeAlertOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      REPORTS_API_KEY: optional(z.string().min(16).max(1024)),
      SLACK_URL: optional(z.url()),
      /**
       * Legacy `int(ENV.get("COMMON_GROUP_ALERT_ON", 0))` (settings.py:515): any non-zero
       * integer turns the copy on. `true`/`false` stay accepted, as in fulfillment/options.ts.
       */
      COMMON_GROUP_ALERT_ON: z.preprocess(
        (value) =>
          value === undefined || value === ''
            ? false
            : typeof value === 'string' && /^-?\d+$/.test(value.trim())
              ? Number(value) !== 0
              : value === 'true'
                ? true
                : value === 'false'
                  ? false
                  : value,
        z.boolean(),
      ),
    })
    .parse(env);
}
export type FinanceAlertOptions = ReturnType<typeof financeAlertOptions>;
export interface PendingAlertReceipt {
  commandId: string;
  closeDate: string;
  pending: number;
}
const receiptSchema = z.object({
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  result: z
    .object({ commandId: z.string(), closeDate: z.string(), pending: z.number() })
    .nullable(),
});
/**
 * Legacy `DayClosePendingAlertView` (report/views.py:2557-2581): every enabled active store
 * without a valid close for the day gets a Slack post to its own channel, synchronously, through
 * `Helpers.slack_text_notification(..., store_id=...)` (helpers/helpers.py:1093-1131).
 *
 * The scheduler's command id is kept as a one-day Redis receipt
 * (`pos:finance_day_close_alert_cmd:{commandId}`) so a transport retry does not post twice.
 */
export function financePendingAlerts(
  config: Config,
  db: Databases,
  ephemeral: EphemeralStore,
  options: FinanceAlertOptions = financeAlertOptions(),
  post: SlackPoster = postSlackText,
  clock = () => Temporal.Now.instant(),
) {
  const ttl = 86400,
    key = (commandId: string) => `pos:finance_day_close_alert_cmd:${commandId}`;
  async function receipt(commandId: string, requestHash: string) {
    const raw = await ephemeral.get(key(commandId));
    if (raw === null) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
    const parsed = receiptSchema.safeParse(value);
    if (!parsed.success)
      throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', 'The alert receipt is unavailable.');
    if (parsed.data.requestHash !== requestHash)
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This alert command was used with another date.',
      );
    if (!parsed.data.result)
      throw new AppError(409, 'ALERT_IN_PROGRESS', 'This alert command is still being processed.');
    return parsed.data.result;
  }
  async function missingStores(selected: string) {
    const {
      ids: numeric,
      categories,
      all: allStores,
    } = parseStoreRollout(config.DAY_CLOSE_ENABLED_STORE_IDS);
    if (!(numeric.length || categories.length || allStores)) return [];
    const writer = db.get('writer'),
      stores = await writer
        .select({ id: Store.id, name: Store.store_name, url: Store.slack_group_url })
        .from(Store)
        .where(
          and(
            eq(Store.is_active, true),
            eq(Store.type, 'STORE'),
            allStores
              ? undefined
              : or(
                  numeric.length ? inArray(Store.id, numeric) : undefined,
                  categories.length ? inArray(Store.category, categories) : undefined,
                ),
          ),
        )
        .orderBy(asc(Store.id));
    if (!stores.length) return [];
    const rows = await writer
        .select({ storeId: StoreDayClose.store_id, status: StoreDayClose.status })
        .from(StoreDayClose)
        .where(eq(StoreDayClose.close_date, selected))
        .orderBy(asc(StoreDayClose.store_id), desc(StoreDayClose.version)),
      latest = new Map<string, string>();
    for (const row of rows)
      if (!latest.has(String(row.storeId))) latest.set(String(row.storeId), row.status);
    return stores.flatMap((store) => {
      const status = latest.get(String(store.id));
      return status === 'CLOSED' ? [] : [{ ...store, status: status || 'NOT_CLOSED' }];
    });
  }
  return {
    async send(commandId: string, date?: string): Promise<PendingAlertReceipt> {
      const requestHash = createHash('sha256')
          .update(JSON.stringify({ date: date || null }))
          .digest('hex'),
        reservation = JSON.stringify({ requestHash, result: null });
      const replay = await receipt(commandId, requestHash);
      if (replay) return replay;
      if (!(await ephemeral.set(key(commandId), reservation, { NX: true, EX: ttl }))) {
        const raced = await receipt(commandId, requestHash);
        if (raced) return raced;
      }
      let result: PendingAlertReceipt;
      try {
        // Legacy `DayClosePendingAlertView` (`report/views.py:2557-2581`) alerts any requested
        // `close_date` (default: the last expired day) with no window check.
        const selected = date || lastExpiredDate(clock(), config);
        const missing = await missingStores(selected),
          [year, month, day] = selected.split('-');
        for (const store of missing) {
          const label =
              store.status === 'NOT_CLOSED'
                ? 'was never closed'
                : 'was closed but is no longer valid',
            text = `Day Close pending — ${slackText(store.name || String(store.id))} — ${day}-${month}-${year} ${label}. The window has passed, so an OPM or above must now file it.`,
            target = store.url || options.SLACK_URL;
          await post(target, text);
          if (options.COMMON_GROUP_ALERT_ON && target !== options.SLACK_URL)
            await post(options.SLACK_URL, text);
        }
        result = { commandId, closeDate: selected, pending: missing.length };
      } catch (error) {
        await ephemeral.delIfEquals(key(commandId), reservation).catch(() => false);
        throw error;
      }
      await ephemeral.set(key(commandId), JSON.stringify({ requestHash, result }), { EX: ttl });
      return result;
    },
  };
}
