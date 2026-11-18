import { sourceIntId as sourceInt } from './source-id.js';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gt, inArray, isNotNull, lt } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  ExpressLineItem,
  ExpressOrderStatusLog,
  HasProduct,
  Product,
  Store,
} from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { AppError } from '../../domain/errors.js';
import { localTimestamp, type FulfillmentEffect, type FulfillmentLine } from './domain.js';
import { lineSelection, linesToDto } from './service.js';
import type { FulfillmentOptions } from './options.js';
import { fulfillmentEffects } from './schema.js';

export type MaintenancePhase = 'pending-expiry' | 'accepted-expiry' | 'allocation-retry';
export interface ExpiryTransition {
  orderId: string;
  from: 'PENDING' | 'ACCEPTED' | 'TIMED_OUT';
  to: 'REJECTED' | 'TIMED_OUT' | 'PACKED';
  lines: FulfillmentLine[];
}
/** Allocation is a set of HP IDs across the phase, exactly as order/tasks.py. */
export function expiryTransitions(
  phase: MaintenancePhase,
  lines: FulfillmentLine[],
  allocatedStatuses: readonly string[],
): ExpiryTransition[] {
  const statuses = new Set(allocatedStatuses),
    allocated = new Set(
      lines.filter((line) => statuses.has(line.vincStatus)).map((line) => line.hasProductId),
    );
  const groups = new Map<string, FulfillmentLine[]>();
  for (const line of lines) {
    const group = groups.get(line.orderId) || [];
    group.push(line);
    groups.set(line.orderId, group);
  }
  return [...groups.entries()].flatMap(([orderId, items]) => {
    const ready = items.every((item) => allocated.has(item.hasProductId));
    if (phase === 'allocation-retry' && !ready) return [];
    return [
      {
        orderId,
        from:
          phase === 'accepted-expiry'
            ? 'ACCEPTED'
            : phase === 'pending-expiry'
              ? 'PENDING'
              : 'TIMED_OUT',
        to: phase === 'accepted-expiry' ? 'PACKED' : ready ? 'REJECTED' : 'TIMED_OUT',
        lines: items,
      },
    ];
  });
}

interface PlannedEffect extends FulfillmentEffect {
  orderId: string;
  commandId: string;
}
/** The scheduler calls this explicitly; registration never contacts external services. */
export function fulfillmentMaintenance(
  config: Config,
  db: Databases,
  options: FulfillmentOptions,
  clock = () => Temporal.Now.instant(),
) {
  return {
    async runStore(
      storeId: string,
      maxOrders = 100,
      cursor: Partial<Record<MaintenancePhase, string>> = {},
      requestId: string | null = null,
    ) {
      if (!Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > 500)
        throw new AppError(400, 'INVALID_BATCH_SIZE', 'Use a batch size from 1 to 500.');
      const storeNumber = sourceInt(storeId);
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          // One SQL authority replaces the expiring Redis lock, and remains held
          // until all row transitions and their external-effect records commit.
          const [store] = await tx
            .select({ id: Store.id })
            .from(Store)
            .where(eq(Store.id, BigInt(storeId)))
            .for('update');
          if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found.');
          const now = localTimestamp(clock(), config.BUSINESS_TIMEZONE),
            counts = { rejected: 0, timedOut: 0, packed: 0 },
            effects: PlannedEffect[] = [],
            nextCursor: Partial<Record<MaintenancePhase, string>> = {};
          let hasMore = false;
          for (const phase of ['pending-expiry', 'accepted-expiry', 'allocation-retry'] as const) {
            const status =
              phase === 'pending-expiry'
                ? 'PENDING'
                : phase === 'accepted-expiry'
                  ? 'ACCEPTED'
                  : 'TIMED_OUT';
            const after = cursor[phase];
            if (after) sourceInt(after);
            const condition = and(
              eq(ExpressLineItem.store_id, storeNumber),
              eq(ExpressLineItem.status, status),
              after ? gt(ExpressLineItem.order, BigInt(after)) : undefined,
              phase === 'pending-expiry'
                ? lt(ExpressLineItem.pending_expires_at, now)
                : phase === 'accepted-expiry'
                  ? lt(ExpressLineItem.accepted_expires_at, now)
                  : undefined,
            );
            // express_line_item.order_id is nullable; a row without an order cannot be
            // locked by order below (order_id IN (...) never matches NULL), so skip it.
            const orders = (
              await tx
                .selectDistinct({ id: ExpressLineItem.order })
                .from(ExpressLineItem)
                .where(and(condition, isNotNull(ExpressLineItem.order)))
                .orderBy(asc(ExpressLineItem.order))
                .limit(maxOrders + 1)
            ).flatMap((row) => (row.id === null ? [] : [{ id: row.id }]));
            hasMore ||= orders.length > maxOrders;
            if (orders.length > maxOrders) nextCursor[phase] = String(orders[maxOrders - 1]!.id);
            if (!orders.length) continue;
            const locked = await tx
              .select({ id: ExpressLineItem.id })
              .from(ExpressLineItem)
              .where(
                and(
                  condition,
                  inArray(
                    ExpressLineItem.order,
                    orders.slice(0, maxOrders).map((order) => order.id),
                  ),
                ),
              )
              .orderBy(asc(ExpressLineItem.id))
              .for('update');
            if (!locked.length) continue;
            const rows = await tx
              .select(lineSelection)
              .from(ExpressLineItem)
              .leftJoin(HasProduct, eq(HasProduct.id, ExpressLineItem.has_product))
              .leftJoin(Product, eq(Product.id, HasProduct.product))
              .where(
                inArray(
                  ExpressLineItem.id,
                  locked.map((line) => line.id),
                ),
              )
              .orderBy(asc(ExpressLineItem.id));
            const transitions = expiryTransitions(
              phase,
              linesToDto(rows),
              options.VINC_ALLOCATED_STATUSES,
            );
            let packedCount = 0;
            const packedAlerts: PlannedEffect[] = [],
              phaseCommandId = randomUUID();
            for (const transition of transitions) {
              const commandId = phase === 'accepted-expiry' ? phaseCommandId : randomUUID();
              await tx
                .update(ExpressLineItem)
                .set({
                  status: transition.to,
                  updated_at: now,
                  ...(transition.to !== 'PACKED'
                    ? { rejection_reason_id: options.HL_TIMED_OUT_REASON_ID }
                    : {}),
                })
                .where(
                  inArray(
                    ExpressLineItem.id,
                    transition.lines.map((line) => sourceInt(line.id)),
                  ),
                );
              await tx.insert(ExpressOrderStatusLog).values({
                order_id: BigInt(transition.orderId),
                store_id: storeNumber,
                old_status: transition.from,
                new_status: transition.to,
                changed_at: now,
              });
              const base = {
                  orderId: transition.orderId,
                  storeId,
                  hasProductIds: transition.lines.map((line) => line.hasProductId),
                },
                products = transition.lines.flatMap((line) =>
                  line.productId ? [line.productId] : [],
                );
              const alert = (action: string): PlannedEffect => ({
                kind: 'store-notification',
                commandId,
                orderId: transition.orderId,
                payload: {
                  action,
                  orderId: transition.orderId,
                  storeId,
                  productIds: products,
                  commonChannel: true,
                },
              });
              if (transition.to === 'PACKED') {
                counts.packed += transition.lines.length;
                packedCount += transition.lines.length;
                effects.push({
                  kind: 'status-api',
                  commandId,
                  orderId: transition.orderId,
                  payload: { ...base, status: 'PACK', isHyperlocal: true },
                });
                packedAlerts.push(alert('AUTO_PACK'));
              } else if (transition.to === 'TIMED_OUT') {
                counts.timedOut += transition.lines.length;
                effects.push(alert('WAIT_TIMEOUT'));
              } else {
                counts.rejected += transition.lines.length;
                if (transition.from === 'TIMED_OUT') effects.push(alert('ALLOCATION_READY'));
                effects.push(
                  {
                    kind: 'rejection-api',
                    commandId,
                    orderId: transition.orderId,
                    payload: { ...base, rejectionReasonId: String(options.HL_TIMED_OUT_REASON_ID) },
                  },
                  alert('TIMEOUT_CONVERSION'),
                );
                if (transition.from === 'PENDING') effects.push(alert('WAIT_REJECTION'));
              }
            }
            if (packedCount) {
              effects.push(
                {
                  kind: 'concurrency-sync',
                  commandId: phaseCommandId,
                  orderId: transitions[0]!.orderId,
                  payload: { storeId, pending: 0, accepted: -packedCount },
                },
                ...packedAlerts,
              );
            }
          }
          const sequences = new Map<string, number>();
          if (effects.length)
            await tx.insert(fulfillmentEffects).values(
              effects.map((effect) => {
                const sequence = sequences.get(effect.commandId) || 0;
                sequences.set(effect.commandId, sequence + 1);
                return {
                  id: randomUUID(),
                  commandId: effect.commandId,
                  operatorId: 'service',
                  requestId,
                  storeId,
                  orderId: effect.orderId,
                  kind: effect.kind,
                  payload: effect.payload,
                  status: 'PENDING',
                  attempts: 0,
                  sequence,
                  createdAt: now,
                };
              }),
            );
          return { storeId, ...counts, hasMore, nextCursor, effectCount: effects.length };
        }),
      );
    },
  };
}
