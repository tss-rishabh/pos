import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { ExpressLineItem, ExpressOrderStatusLog } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { sourceIntId } from './source-id.js';
import { localTimestamp } from './domain.js';
import type { FulfillmentEffects, FulfillmentLogger } from './effects.js';
import { pythonIdList } from './effects.js';
import type { FulfillmentOptions } from './options.js';
import type { OrderRedis } from './order-redis.js';
import { slackText } from './slack-text.js';

export const expressRejectLockKey = (storeId: string) => `express_reject_lock:${storeId}`;

interface ExpiringLine {
  orderId: string;
  hasProductId: string;
  vincStatus: string;
}
export interface ExpiryDependencies {
  config: Pick<Config, 'BUSINESS_TIMEZONE'>;
  db: Databases;
  options: Pick<
    FulfillmentOptions,
    'HL_REJECT_LOCK_TTL_SECONDS' | 'HL_TIMED_OUT_REASON_ID' | 'VINC_ALLOCATED_STATUSES'
  >;
  redis: Pick<OrderRedis, 'set' | 'compareAndDelete'>;
  effects: Pick<
    FulfillmentEffects,
    'slack' | 'rejectionApi' | 'callStatusApi' | 'concurrencySync' | 'skuIds' | 'store'
  >;
  log?: FulfillmentLogger;
  clock?: () => Temporal.Instant;
}
/** Groups line items by order in first-seen order, like `defaultdict(list)` over the queryset. */
function byOrder(lines: ExpiringLine[]) {
  const groups = new Map<string, string[]>();
  for (const line of lines) {
    const group = groups.get(line.orderId) ?? [];
    group.push(line.hasProductId);
    groups.set(line.orderId, group);
  }
  return groups;
}

/**
 * Job O1 `order.tasks.auto_reject_timed_out_for_store` (`order/tasks.py:149-221`), enqueued by
 * the three hyperlocal progress views. Runs under the legacy Redis lock
 * `express_reject_lock:{store}` (`SET NX EX HL_REJECT_LOCK_TTL_SECONDS`); a held lock skips
 * the run. The lock is released by token compare instead of a plain DEL, so a run that
 * outlived its TTL never releases a newer run's lock.
 */
export async function autoRejectTimedOutForStore(
  deps: ExpiryDependencies,
  storeId: string,
): Promise<'skipped-locked' | 'completed'> {
  const token = randomUUID(),
    key = expressRejectLockKey(storeId);
  if (
    !(await deps.redis.set(key, token, { NX: true, EX: deps.options.HL_REJECT_LOCK_TTL_SECONDS }))
  )
    return 'skipped-locked';
  try {
    await processStore(deps, storeId);
    return 'completed';
  } finally {
    await deps.redis.compareAndDelete(key, token).catch(() => false);
  }
}

async function processStore(deps: ExpiryDependencies, storeId: string) {
  const clock = deps.clock ?? (() => Temporal.Now.instant()),
    stamp = () => localTimestamp(clock(), deps.config.BUSINESS_TIMEZONE),
    now = stamp(),
    storeNumber = sourceIntId(storeId),
    db = deps.db.get('writer'),
    allocated = new Set(deps.options.VINC_ALLOCATED_STATUSES),
    reasonId = deps.options.HL_TIMED_OUT_REASON_ID;
  const storeRow = await deps.effects.store(storeId);
  const storeName = slackText(storeRow ? (storeRow.name ?? 'None') : `Store ${storeId}`);
  const select = (status: 'PENDING' | 'ACCEPTED' | 'TIMED_OUT') =>
    db
      .select({
        orderId: ExpressLineItem.order,
        hasProductId: ExpressLineItem.has_product,
        vincStatus: ExpressLineItem.vinc_status,
      })
      .from(ExpressLineItem)
      .where(
        and(
          eq(ExpressLineItem.store_id, storeNumber),
          eq(ExpressLineItem.status, status),
          status === 'PENDING'
            ? and(
                isNotNull(ExpressLineItem.pending_expires_at),
                lt(ExpressLineItem.pending_expires_at, now),
              )
            : status === 'ACCEPTED'
              ? and(
                  isNotNull(ExpressLineItem.accepted_expires_at),
                  lt(ExpressLineItem.accepted_expires_at, now),
                )
              : undefined,
        ),
      )
      .orderBy(asc(ExpressLineItem.id))
      .then((rows) =>
        rows
          .filter((row) => row.orderId !== null)
          .map((row) => ({
            orderId: String(row.orderId),
            hasProductId: String(row.hasProductId),
            vincStatus: row.vincStatus,
          })),
      );
  /** State-filtered transition, re-evaluating the original filter as the legacy queryset does. */
  async function transition(
    from: 'PENDING' | 'ACCEPTED' | 'TIMED_OUT',
    to: 'REJECTED' | 'TIMED_OUT' | 'PACKED',
    orderIds: string[],
  ) {
    await retryTransaction(() =>
      db.transaction(async (tx) => {
        const changedAt = stamp();
        await tx
          .update(ExpressLineItem)
          .set({
            status: to,
            updated_at: changedAt,
            ...(to === 'PACKED' ? {} : { rejection_reason_id: reasonId }),
          })
          .where(
            and(
              eq(ExpressLineItem.store_id, storeNumber),
              eq(ExpressLineItem.status, from),
              inArray(ExpressLineItem.order, orderIds.map(BigInt)),
              from === 'PENDING'
                ? and(
                    isNotNull(ExpressLineItem.pending_expires_at),
                    lt(ExpressLineItem.pending_expires_at, now),
                  )
                : from === 'ACCEPTED'
                  ? and(
                      isNotNull(ExpressLineItem.accepted_expires_at),
                      lt(ExpressLineItem.accepted_expires_at, now),
                    )
                  : undefined,
            ),
          );
        await tx.insert(ExpressOrderStatusLog).values(
          orderIds.map((orderId) => ({
            order_id: BigInt(orderId),
            store_id: storeNumber,
            old_status: from,
            new_status: to,
            changed_at: changedAt,
          })),
        );
      }),
    );
  }
  const skuText = async (ids: string[]) => pythonIdList(await deps.effects.skuIds(ids));

  // 1. Newly expired PENDING items (`_split_and_process`, `order/tasks.py:89-146`).
  const pending = await select('PENDING');
  if (pending.length) {
    const groups = byOrder(pending),
      allocatedIds = new Set(
        pending.filter((line) => allocated.has(line.vincStatus)).map((line) => line.hasProductId),
      ),
      toReject: string[] = [],
      toTimeout: string[] = [];
    for (const [orderId, ids] of groups)
      (ids.every((id) => allocatedIds.has(id)) ? toReject : toTimeout).push(orderId);
    if (toReject.length) {
      for (const orderId of toReject)
        await deps.effects.rejectionApi(orderId, groups.get(orderId)!, {
          kind: 'timed-out',
          storeId,
        });
      await transition('PENDING', 'REJECTED', toReject);
      for (const orderId of toReject)
        await deps.effects.slack(
          `❌ Order wait time exceeded for ID: ${orderId} | Store: ${storeName} | SKUs: ${await skuText(groups.get(orderId)!)}`,
          { storeId },
        );
    }
    if (toTimeout.length) {
      await transition('PENDING', 'TIMED_OUT', toTimeout);
      for (const orderId of toTimeout)
        await deps.effects.slack(
          `⏱️ Order wait time exceeded for ID: ${orderId} | Store: ${storeName} | SKUs: ${await skuText(groups.get(orderId)!)}`,
          { storeId },
        );
    }
  }

  // 2. Newly expired ACCEPTED items are auto-packed (`_auto_pack_accepted`, `:57-86`).
  const accepted = await select('ACCEPTED');
  if (accepted.length) {
    const groups = byOrder(accepted),
      orderIds = [...groups.keys()];
    for (const [orderId, ids] of groups)
      await deps.effects.callStatusApi(orderId, ids, 'PACK', true);
    await transition('ACCEPTED', 'PACKED', orderIds);
    deps.effects.concurrencySync(storeId, { accepted: -accepted.length });
    for (const [orderId, ids] of groups)
      await deps.effects.slack(
        `📦 Hyperlocal Order ID: ${orderId} auto-packed at ${storeName} — acceptance window expired | SKUs: ${await skuText(ids)}`,
        { storeId },
      );
  }

  // 3. TIMED_OUT orders whose items Vinculum has since allocated are rejected (`:177-218`).
  const timedOut = await select('TIMED_OUT');
  if (!timedOut.length) return;
  const groups = byOrder(timedOut),
    allocatedIds = new Set(
      timedOut.filter((line) => allocated.has(line.vincStatus)).map((line) => line.hasProductId),
    ),
    ready = [...groups.entries()]
      .filter(([, ids]) => ids.every((id) => allocatedIds.has(id)))
      .map(([orderId]) => orderId);
  deps.log?.('info', {
    eventId: 'fulfillment.auto-reject.allocation-check',
    resource: 'express-expiry',
    outcome: 'checked',
    storeId,
    count: ready.length,
  });
  if (!ready.length) return;
  await transition('TIMED_OUT', 'REJECTED', ready);
  for (const orderId of ready)
    await deps.effects.slack(
      `🔺 Order ID: ${orderId} | Store: ${storeName} | Order was Timed Out earlier — Vinculum has now allocated the items, proceeding with conversion to online order | SKUs: ${await skuText(groups.get(orderId)!)}`,
      { storeId },
    );
  // Legacy defers these calls with `transaction.on_commit` (`:217`).
  for (const orderId of ready)
    await deps.effects.rejectionApi(orderId, groups.get(orderId)!, { kind: 'timed-out', storeId });
}
