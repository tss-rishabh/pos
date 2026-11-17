import { and, asc, eq, isNull, lt, notExists, notInArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import { utcMediaTimestamp } from './media-domain.js';
import { settingsEffects } from './settings-schema.js';
import { settingsEffectSchema, type SettingsEffectDelivery } from './settings-domain.js';

export interface SettingsDispatchResult {
  id: string;
  sequence: string;
  actorId: string | null;
  requestId: string | null;
  storeId: string | null;
  status: 'delivered' | 'failed' | 'blocked' | 'pending';
  errorCode?: string;
}
/** Per-resource ordering prevents a retry from overwriting a later cache value. */
export function settingsOutbox(db: Databases, delivery: SettingsEffectDelivery) {
  const older = alias(settingsEffects, 'earlier_settings_effect');
  return {
    async dispatchNext(
      signal?: AbortSignal,
      excludedIds: string[] = [],
    ): Promise<SettingsDispatchResult | null> {
      return db.get('writer').transaction(async (transaction) => {
        const [row] = await transaction
          .select()
          .from(settingsEffects)
          .where(
            and(
              isNull(settingsEffects.deliveredAt),
              excludedIds.length ? notInArray(settingsEffects.id, excludedIds) : undefined,
              lt(settingsEffects.attempts, 10),
              notExists(
                transaction
                  .select({ sequence: older.sequence })
                  .from(older)
                  .where(
                    and(
                      eq(older.partitionKey, settingsEffects.partitionKey),
                      isNull(older.deliveredAt),
                      lt(older.sequence, settingsEffects.sequence),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(settingsEffects.sequence))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!row) return null;
        const parsed = settingsEffectSchema.safeParse(row.payload);
        const effect = parsed.success ? parsed.data : null;
        const result = {
          id: row.id,
          sequence: String(row.sequence),
          actorId: effect?.actorId || null,
          requestId: effect?.requestId || null,
          storeId: effect && 'storeId' in effect ? effect.storeId : null,
        };
        try {
          if (!effect || row.kind !== effect.kind)
            throw new AppError(503, 'SETTINGS_EFFECT_INVALID', 'Settings effects require review.');
          if (!delivery.supports(effect.kind))
            throw new AppError(
              503,
              'SETTINGS_EFFECT_UNAVAILABLE',
              'Settings delivery is unavailable.',
            );
          const outcome = await delivery.deliver(row.id, effect, signal);
          // A durable asynchronous job is still processing, not another failed send.
          if (outcome === 'pending') return { ...result, status: 'pending' };
          await transaction
            .update(settingsEffects)
            .set({ attempts: row.attempts + 1, deliveredAt: utcMediaTimestamp() })
            .where(eq(settingsEffects.sequence, row.sequence));
          return { ...result, status: 'delivered' };
        } catch (error) {
          await transaction
            .update(settingsEffects)
            .set({ attempts: row.attempts + 1 })
            .where(eq(settingsEffects.sequence, row.sequence));
          return {
            ...result,
            status: row.attempts + 1 >= 10 ? 'blocked' : 'failed',
            errorCode: error instanceof AppError ? error.code : 'SETTINGS_EFFECT_UNAVAILABLE',
          };
        }
      });
    },
    async retry(id: string): Promise<void> {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
        throw new AppError(400, 'SETTINGS_EFFECT_ID_INVALID', 'Choose a settings delivery.');
      await db.get('writer').transaction(async (transaction) => {
        const [row] = await transaction
          .select()
          .from(settingsEffects)
          .where(eq(settingsEffects.id, id))
          .limit(1)
          .for('update');
        if (!row || row.deliveredAt)
          throw new AppError(
            409,
            'SETTINGS_EFFECT_NOT_PENDING',
            'Settings delivery is not pending.',
          );
        await transaction
          .update(settingsEffects)
          .set({ attempts: 0 })
          .where(eq(settingsEffects.id, id));
      });
    },
  };
}
