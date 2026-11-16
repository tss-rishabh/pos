import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { Store, StoreDayClose } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { AppError } from '../../domain/errors.js';
import { localTimestamp } from '../fulfillment/domain.js';
import { fulfillmentEffects } from '../fulfillment/schema.js';
import { lastExpiredDate, windowState } from './domain.js';
import { financeAlertCommands, type PendingAlertReceipt } from './schema.js';
import { parseStoreRollout } from '../../domain/rollout.js';

export function financeAlertOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      REPORTS_API_KEY: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.string().min(16).max(1024).optional(),
      ),
    })
    .parse(env);
}
export function financePendingAlerts(
  config: Config,
  db: Databases,
  clock = () => Temporal.Now.instant(),
) {
  return {
    async queue(
      commandId: string,
      date?: string,
      requestId: string | null = null,
    ): Promise<PendingAlertReceipt> {
      const requestHash = createHash('sha256')
        .update(JSON.stringify({ date: date || null }))
        .digest('hex');
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          const now = clock(),
            timestamp = localTimestamp(now, config.BUSINESS_TIMEZONE);
          await tx
            .insert(financeAlertCommands)
            .values({ commandId, requestHash, createdAt: timestamp })
            .onDuplicateKeyUpdate({ set: { commandId } });
          const [reservation] = await tx
            .select()
            .from(financeAlertCommands)
            .where(eq(financeAlertCommands.commandId, commandId))
            .for('update');
          if (reservation!.requestHash !== requestHash)
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This alert command was used with another date.',
            );
          if (reservation!.result) return reservation!.result;
          const selected = date || lastExpiredDate(now, config);
          if (windowState(selected, now, config) !== 'EXPIRED')
            throw new AppError(
              409,
              'DAY_CLOSE_WINDOW_ACTIVE',
              'Pending-close alerts require an expired close window.',
            );
          const {
            ids: numeric,
            categories,
            all: allStores,
          } = parseStoreRollout(config.DAY_CLOSE_ENABLED_STORE_IDS);
          const enabled = numeric.length || categories.length || allStores;
          const stores = enabled
            ? await tx
                .select({ id: Store.id })
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
                .orderBy(asc(Store.id))
                .limit(2001)
                .for('update')
            : [];
          if (stores.length > 2000)
            throw new AppError(
              422,
              'REPORT_TOO_LARGE',
              'Configure a smaller store group for pending alerts.',
            );
          const rows =
            enabled && stores.length
              ? await tx
                  .select({
                    storeId: StoreDayClose.store_id,
                    status: StoreDayClose.status,
                    version: StoreDayClose.version,
                  })
                  .from(StoreDayClose)
                  .where(
                    and(
                      eq(StoreDayClose.close_date, selected),
                      inArray(
                        StoreDayClose.store_id,
                        stores.map((store) => Number(store.id)),
                      ),
                    ),
                  )
                  .orderBy(asc(StoreDayClose.store_id), desc(StoreDayClose.version))
              : [];
          const latest = new Map<string, string>();
          for (const row of rows)
            if (!latest.has(String(row.storeId))) latest.set(String(row.storeId), row.status);
          const missing = enabled
              ? stores.filter((store) => latest.get(String(store.id)) !== 'CLOSED')
              : [],
            effectIds = missing.map(() => randomUUID());
          if (missing.length)
            await tx.insert(fulfillmentEffects).values(
              missing.map((store, index) => ({
                id: effectIds[index]!,
                commandId,
                operatorId: 'service-day-close',
                requestId,
                storeId: String(store.id),
                orderId: '0',
                kind: 'store-notification',
                payload: {
                  action: 'DAY_CLOSE_PENDING',
                  closeDate: selected,
                  status: latest.get(String(store.id)) || 'NOT_CLOSED',
                  productIds: [],
                  commonChannel: true,
                },
                status: 'PENDING',
                attempts: 0,
                sequence: 0,
                createdAt: timestamp,
              })),
            );
          const result: PendingAlertReceipt = {
            commandId,
            closeDate: selected,
            pending: missing.length,
            effectIds,
            delivery: missing.length ? 'pending' : 'not-required',
          };
          await tx
            .update(financeAlertCommands)
            .set({ result })
            .where(eq(financeAlertCommands.commandId, commandId));
          return result;
        }),
      );
    },
  };
}
