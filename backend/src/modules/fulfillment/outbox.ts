import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, lt, ne, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Databases } from '../../db/pools.js';
import { retryTransaction } from '../../db/retry.js';
import { AppError } from '../../domain/errors.js';
import type { Config } from '../../config.js';
import type { FulfillmentEffect } from './domain.js';
import { localTimestamp } from './domain.js';
import { fulfillmentEffects } from './schema.js';

export interface EffectDelivery {
  effectId: string;
  commandId: string;
  operatorId: string;
  requestId?: string | null;
  storeId: string;
  orderId: string;
  kind: FulfillmentEffect['kind'];
  payload: FulfillmentEffect['payload'];
  priorResults: Record<string, string | number | boolean>[];
}
export type EffectDispatcher = (
  delivery: EffectDelivery,
) => Promise<Record<string, string | number | boolean> | void>;
const effectKind = z.enum([
  'concurrency-sync',
  'status-api',
  'rejection-api',
  'out-for-delivery-api',
  'rto-api',
  'store-notification',
]);
/** Claim once, deliver outside the DB lock, and never blindly retry ambiguous effects. */
export function fulfillmentOutbox(
  config: Config,
  db: Databases,
  dispatch: EffectDispatcher,
  clock = () => Temporal.Now.instant(),
) {
  const now = () => localTimestamp(clock(), config.BUSINESS_TIMEZONE);
  return {
    async dispatchNext() {
      const effect = await retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          const prior = alias(fulfillmentEffects, 'prior_effect');
          const priorCounter = alias(fulfillmentEffects, 'prior_counter');
          const [row] = await tx
            .select()
            .from(fulfillmentEffects)
            .where(
              and(
                eq(fulfillmentEffects.status, 'PENDING'),
                or(
                  ne(fulfillmentEffects.kind, 'concurrency-sync'),
                  notExists(
                    tx
                      .select({ id: priorCounter.id })
                      .from(priorCounter)
                      .where(
                        and(
                          eq(priorCounter.storeId, fulfillmentEffects.storeId),
                          eq(priorCounter.kind, 'concurrency-sync'),
                          lt(priorCounter.dispatchOrder, fulfillmentEffects.dispatchOrder),
                          ne(priorCounter.status, 'COMPLETED'),
                        ),
                      ),
                  ),
                ),
                notExists(
                  tx
                    .select({ id: prior.id })
                    .from(prior)
                    .where(
                      and(
                        eq(prior.commandId, fulfillmentEffects.commandId),
                        eq(prior.operatorId, fulfillmentEffects.operatorId),
                        lt(prior.sequence, fulfillmentEffects.sequence),
                        sql`${prior.status}<>'COMPLETED'`,
                        sql`${prior.kind}<>'store-notification'`,
                      ),
                    ),
                ),
              ),
            )
            .orderBy(asc(fulfillmentEffects.dispatchOrder))
            .limit(1)
            .for('update', { skipLocked: true });
          if (!row) return null;
          await tx
            .update(fulfillmentEffects)
            .set({
              status: 'SENDING',
              attempts: row.attempts + 1,
              claimedAt: now(),
              lastErrorCode: null,
            })
            .where(eq(fulfillmentEffects.id, row.id));
          return row;
        }),
      );
      if (!effect) return null;
      try {
        const previous = await db
          .get('writer')
          .select({ result: fulfillmentEffects.result })
          .from(fulfillmentEffects)
          .where(
            and(
              eq(fulfillmentEffects.commandId, effect.commandId),
              eq(fulfillmentEffects.operatorId, effect.operatorId),
              lt(fulfillmentEffects.sequence, effect.sequence),
              eq(fulfillmentEffects.status, 'COMPLETED'),
            ),
          )
          .orderBy(asc(fulfillmentEffects.sequence));
        const result = await dispatch({
          effectId: effect.id,
          commandId: effect.commandId,
          operatorId: effect.operatorId,
          requestId: effect.requestId,
          storeId: effect.storeId,
          orderId: effect.orderId,
          kind: effectKind.parse(effect.kind),
          payload: effect.payload,
          priorResults: previous.flatMap((row) => (row.result ? [row.result] : [])),
        });
        await db
          .get('writer')
          .update(fulfillmentEffects)
          .set({ status: 'COMPLETED', completedAt: now(), result: result || {} })
          .where(
            and(eq(fulfillmentEffects.id, effect.id), eq(fulfillmentEffects.status, 'SENDING')),
          );
        return {
          effectId: effect.id,
          requestId: effect.requestId,
          userId: effect.operatorId,
          kind: effectKind.parse(effect.kind),
          status: 'COMPLETED' as const,
        };
      } catch (error) {
        const knownNotSent =
          error instanceof AppError &&
          ['DEPENDENCY_UNAVAILABLE', 'UPSTREAM_NOT_SENT'].includes(error.code);
        // A missing local dependency can safely be retried after setup. A remote
        // timeout or lost response needs reconciliation, even if the DB is unchanged.
        const status = knownNotSent ? 'BLOCKED' : 'UNCERTAIN';
        await db
          .get('writer')
          .update(fulfillmentEffects)
          .set({
            status,
            lastErrorCode: knownNotSent ? 'DEPENDENCY_UNAVAILABLE' : 'DELIVERY_OUTCOME_UNKNOWN',
          })
          .where(
            and(eq(fulfillmentEffects.id, effect.id), eq(fulfillmentEffects.status, 'SENDING')),
          );
        return {
          effectId: effect.id,
          requestId: effect.requestId,
          userId: effect.operatorId,
          kind: effectKind.parse(effect.kind),
          status,
        };
      }
    },
    async expireClaims(maxAgeMinutes = 5) {
      const older = localTimestamp(
        clock().subtract({ minutes: maxAgeMinutes }),
        config.BUSINESS_TIMEZONE,
      );
      await db
        .get('writer')
        .update(fulfillmentEffects)
        .set({ status: 'UNCERTAIN', lastErrorCode: 'WORKER_RESULT_UNKNOWN' })
        .where(
          and(eq(fulfillmentEffects.status, 'SENDING'), lt(fulfillmentEffects.claimedAt, older)),
        );
    },
    async reconcile(effectId: string, outcome: 'confirmed' | 'safe-to-retry') {
      return db.get('writer').transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(fulfillmentEffects)
          .where(eq(fulfillmentEffects.id, effectId))
          .for('update');
        if (!row || !['BLOCKED', 'UNCERTAIN'].includes(row.status))
          throw new AppError(
            409,
            'EFFECT_NOT_RECONCILABLE',
            'This effect does not require reconciliation.',
          );
        await tx
          .update(fulfillmentEffects)
          .set({
            status: outcome === 'confirmed' ? 'COMPLETED' : 'PENDING',
            completedAt: outcome === 'confirmed' ? now() : null,
            lastErrorCode: null,
          })
          .where(eq(fulfillmentEffects.id, effectId));
        return { effectId, status: outcome === 'confirmed' ? 'COMPLETED' : 'PENDING' };
      });
    },
  };
}
