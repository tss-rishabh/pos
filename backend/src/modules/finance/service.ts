import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { and, desc, eq, exists, gte, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  AmountToBeRefundedLog,
  Order,
  OrderStore,
  ReturnOrder,
  Store,
  StoreDayBanking,
  StoreDayClose,
} from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { AppError } from '../../domain/errors.js';
import { generatedId } from '../../db/generated-id.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { localTimestamp } from '../fulfillment/domain.js';
import { memoryEphemeralStore, type EphemeralStore } from '../../jobs/ephemeral.js';
import { checkInService } from '../administration/checkins.js';
import { storeRolloutEnabled } from '../../domain/rollout.js';
import { assertCurrentOperatorRole } from '../administration/authorization.js';
import {
  currentPaymentCorrectionCash,
  paymentCorrectionFinanceOptions,
  type PaymentCorrectionFinanceOptions,
} from './payment-corrections.js';
import {
  canClose,
  cashDifference,
  cardDifference,
  closeWindow,
  defaultCloseDate,
  discrepancyErrors,
  money,
  nagTargetDate,
  snapshotDrift,
  windowState,
  type CloseEntries,
  type CollectionSnapshot,
} from './domain.js';

type FinanceExecutor = Pick<ReturnType<Databases['get']>, 'select' | 'insert' | 'update'>;
type CloseRecord = typeof StoreDayClose.$inferSelect;
export function serializeClose(close: CloseRecord | null | undefined) {
  if (!close) return null;
  return {
    version: close.version,
    status: close.status,
    closed_at: close.closed_at.slice(0, 16),
    closed_by_id: String(close.closed_by_id),
    stale_reason: close.stale_reason,
    stale_trigger_ref: close.stale_trigger_ref,
    cash: {
      system: close.cash_system,
      refund: close.cash_refund_system,
      actual: close.cash_actual,
      manual_punched: close.cash_manual_punched,
      manual_created: close.cash_manual_created,
      difference: close.cash_difference,
      reason: close.cash_reason,
      comment: close.cash_comment,
    },
    card: {
      system: close.card_system,
      actual: close.card_actual,
      manual_punched: close.card_manual_punched,
      manual_created: close.card_manual_created,
      difference: close.card_difference,
      reason: close.card_reason,
      comment: close.card_comment,
    },
    banking_amount: close.banking_amount,
  };
}
export async function collectionSnapshot(
  db: FinanceExecutor,
  storeId: string,
  date: string,
  corrections: PaymentCorrectionFinanceOptions = paymentCorrectionFinanceOptions(),
): Promise<CollectionSnapshot> {
  const start = `${date} 00:00:00`,
    end = `${Temporal.PlainDate.from(date).add({ days: 1 })} 00:00:00`;
  const [correction] = await currentPaymentCorrectionCash(db, [storeId], date, date, corrections);
  // Exact source predicates; do not add order-status exclusions to cash collection.
  const district = and(
    sql`${OrderStore.district_transaction_id} is not null`,
    ne(OrderStore.district_transaction_id, ''),
  );
  const [collection] = await db
    .select({
      orderCount: sql<number>`count(*)`,
      cash: sql<string>`coalesce(sum(${OrderStore.offline_payment}),0)`,
      card: sql<string>`coalesce(sum(${OrderStore.online_payment}),0)`,
      district: sql<string>`coalesce(sum(case when ${district} then ${OrderStore.online_other_payment} else 0 end),0)`,
      onlineOther: sql<string>`coalesce(sum(case when ${or(isNull(OrderStore.district_transaction_id), eq(OrderStore.district_transaction_id, ''))} then ${OrderStore.online_other_payment} else 0 end),0)`,
    })
    .from(Order)
    .innerJoin(OrderStore, eq(OrderStore.order, Order.id))
    .where(
      and(
        eq(OrderStore.store, BigInt(storeId)),
        gte(Order.created_at, start),
        lt(Order.created_at, end),
        sql`(${OrderStore.offline_payment}+${OrderStore.online_payment}+${OrderStore.online_other_payment})>0`,
      ),
    );
  const refundedLine = db
    .select({ id: ReturnOrder.id })
    .from(ReturnOrder)
    .where(
      and(
        eq(ReturnOrder.order_id, AmountToBeRefundedLog.order_id),
        eq(ReturnOrder.has_product_id, AmountToBeRefundedLog.has_product_id),
        eq(ReturnOrder.store_id, Number(storeId)),
        gte(ReturnOrder.created_at, start),
        lt(ReturnOrder.created_at, end),
      ),
    );
  const [refund] = await db
    .select({ cashRefund: sql<string>`coalesce(sum(${AmountToBeRefundedLog.refunded_amt}),0)` })
    .from(AmountToBeRefundedLog)
    .where(
      and(
        eq(AmountToBeRefundedLog.refund_mode, 'cash'),
        eq(AmountToBeRefundedLog.is_refunded, true),
        exists(refundedLine),
      ),
    );
  const cash = money(new Decimal(collection?.cash || '0').plus(correction?.cashAdjustment || '0')),
    card = money(collection?.card),
    onlineOther = money(collection?.onlineOther);
  return {
    order_count: Number(collection?.orderCount || 0) + (correction?.orderCountAdjustment || 0),
    cash,
    card_upi: card,
    district: money(collection?.district),
    online_other: onlineOther,
    total_online: money(new Decimal(card).plus(onlineOther)),
    cash_refund: money(new Decimal(refund?.cashRefund || '0').plus(correction?.cashOut || '0')),
  };
}
export function financeService(
  config: Config,
  databases: Databases,
  clock = () => Temporal.Now.instant(),
  checkins: Pick<ReturnType<typeof checkInService>, 'assertCheckIn'> = checkInService(
    databases,
    config,
  ),
  corrections: PaymentCorrectionFinanceOptions = paymentCorrectionFinanceOptions(),
  ephemeral: EphemeralStore = memoryEphemeralStore(),
) {
  /**
   * Day-close replay receipt (table-disposition finance/day-close): Redis
   * `pos:finance_day_close_cmd:{operatorId}:{commandId}` -> {requestHash, closeId}, 7 days. The
   * financial fact itself is the store_day_close/store_day_banking rows.
   */
  const commandKey = (operatorId: string, commandId: string) =>
      `pos:finance_day_close_cmd:${operatorId}:${commandId}`,
    commandTtl = 7 * 86400,
    commandSchema = z.object({
      requestHash: z.string().regex(/^[a-f0-9]{64}$/),
      closeId: z.string().regex(/^\d+$/).nullable(),
    });
  async function readCommand(operatorId: string, commandId: string) {
    const raw = await ephemeral.get(commandKey(operatorId, commandId));
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const result = commandSchema.safeParse(parsed);
    if (!result.success)
      throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', 'The day-close receipt is unavailable.');
    return result.data;
  }
  const nowSql = () => localTimestamp(clock(), config.BUSINESS_TIMEZONE);
  async function enabled(user: Principal, storeId: string, db: FinanceExecutor) {
    return storeRolloutEnabled(() => db, config.DAY_CLOSE_ENABLED_STORE_IDS, user.role, storeId);
  }
  const activeClose = async (db: FinanceExecutor, storeId: string, date: string) => {
    const [record] = await db
      .select()
      .from(StoreDayClose)
      .where(and(eq(StoreDayClose.store_id, Number(storeId)), eq(StoreDayClose.close_date, date)))
      .orderBy(desc(StoreDayClose.version))
      .limit(1);
    return record;
  };
  return {
    async state(user: Principal, storeId: string, date?: string) {
      requireStore(user, storeId);
      await checkins.assertCheckIn(user.id, storeId);
      const selected = date || defaultCloseDate(clock(), config);
      const db = databases.get('writer');
      const { snapshot, close: observedClose } = await db.transaction(
        async (transaction) => ({
          snapshot: await collectionSnapshot(transaction, storeId, selected, corrections),
          close: await activeClose(transaction, storeId, selected),
        }),
        {
          isolationLevel: 'repeatable read',
          accessMode: 'read only',
        },
      );
      let close = observedClose;
      if (close?.status === 'CLOSED') {
        const now = nowSql(),
          drift = snapshotDrift(close, snapshot);
        await db
          .update(StoreDayClose)
          .set({
            last_verified_at: now,
            updated_at: now,
            ...(drift ? { status: 'STALE', stale_at: now, stale_reason: 'DRIFT' } : {}),
          })
          .where(and(eq(StoreDayClose.id, close.id), eq(StoreDayClose.status, 'CLOSED')));
        if (drift) close = { ...close, status: 'STALE', stale_at: now, stale_reason: 'DRIFT' };
      }
      const permission = canClose(
          user.role,
          selected,
          clock(),
          await enabled(user, storeId, db),
          close || null,
          config,
        ),
        window = closeWindow(selected, config);
      return {
        store_id: storeId,
        close_date: selected,
        window: {
          state: windowState(selected, clock(), config),
          ...permission,
          opens_at: window.opensAt
            .toPlainDateTime()
            .toString({ smallestUnit: 'minute' })
            .replace('T', ' '),
          closes_at: window.closesAt
            .toPlainDateTime()
            .toString({ smallestUnit: 'minute' })
            .replace('T', ' '),
        },
        system: {
          ...snapshot,
          total_collection: money(
            new Decimal(snapshot.cash).plus(snapshot.total_online).plus(snapshot.district),
          ),
        },
        close: serializeClose(close),
        tolerance: money(config.DAY_CLOSE_TOLERANCE),
      };
    },
    async close(
      user: Principal,
      storeId: string,
      date: string,
      commandId: string,
      expectedVersion: number,
      entries: CloseEntries,
    ) {
      requireStore(user, storeId);
      if (
        Temporal.PlainDate.compare(
          Temporal.PlainDate.from(date),
          clock().toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate(),
        ) > 0
      )
        throw new AppError(400, 'FUTURE_CLOSE_DATE', 'A future date cannot be closed.');
      const hash = createHash('sha256')
          .update(JSON.stringify({ storeId, date, expectedVersion, entries }))
          .digest('hex'),
        key = commandKey(user.id, commandId),
        reservation = JSON.stringify({ requestHash: hash, closeId: null });
      const replay = async () => {
        let command = await readCommand(user.id, commandId);
        // A concurrent duplicate waits (bounded) for the first submission's outcome.
        for (let waited = 0; command && !command.closeId && waited < 15000; waited += 100) {
          if (command.requestHash !== hash) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
          command = await readCommand(user.id, commandId);
        }
        if (!command) return undefined;
        if (command.requestHash !== hash)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This command ID was used with different close figures.',
          );
        if (!command.closeId)
          throw new AppError(
            409,
            'DAY_CLOSE_IN_PROGRESS',
            'This close is still being saved. Check the close versions before retrying.',
          );
        const [saved] = await databases
          .get('writer')
          .select()
          .from(StoreDayClose)
          .where(eq(StoreDayClose.id, BigInt(command.closeId)));
        return serializeClose(saved);
      };
      const replayed = await replay();
      if (replayed !== undefined) return replayed;
      if (!(await ephemeral.set(key, reservation, { NX: true, EX: commandTtl }))) {
        const raced = await replay();
        if (raced !== undefined) return raced;
      }
      let saved: { id: string; close: ReturnType<typeof serializeClose> };
      try {
        saved = await retryTransaction(() =>
          databases.get('writer').transaction(async (tx) => {
            const now = nowSql();
            await checkins.assertCheckIn(user.id, storeId, undefined, tx);
            const currentRole = await assertCurrentOperatorRole(tx, user.id, [1, 2, 3, 4, 5]),
              currentUser = { ...user, role: currentRole };
            const [store] = await tx
              .select({ id: Store.id })
              .from(Store)
              .where(eq(Store.id, BigInt(storeId)))
              .for('update');
            if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found.');
            const active = await activeClose(tx, storeId, date);
            if ((active?.version || 0) !== expectedVersion)
              throw new AppError(
                409,
                'DAY_CLOSE_VERSION_CONFLICT',
                'The close changed. Refresh the figures before submitting.',
              );
            const permission = canClose(
              currentRole,
              date,
              clock(),
              await enabled(currentUser, storeId, tx),
              active || null,
              config,
            );
            if (!permission.allowed)
              throw new AppError(409, 'DAY_CLOSE_NOT_ALLOWED', permission.message);
            const snapshot = await collectionSnapshot(tx, storeId, date, corrections),
              errors = discrepancyErrors(snapshot, entries, config.DAY_CLOSE_TOLERANCE);
            if (errors.length)
              throw new AppError(400, 'DAY_CLOSE_EXPLANATION_REQUIRED', errors[0]!);
            const version = expectedVersion + 1;
            if (version > 65535)
              throw new AppError(
                409,
                'DAY_CLOSE_VERSION_LIMIT',
                'This day has reached its revision limit.',
              );
            const values = {
              store_id: Number(storeId),
              close_date: date,
              version,
              status: 'CLOSED',
              closed_by_id: BigInt(user.id),
              closed_at: now,
              cash_system: snapshot.cash,
              cash_refund_system: snapshot.cash_refund,
              cash_actual: money(entries.cash_actual),
              cash_manual_punched: money(entries.cash_manual_punched),
              cash_manual_created: money(entries.cash_manual_created),
              cash_difference: cashDifference(
                snapshot.cash,
                snapshot.cash_refund,
                entries.cash_actual,
                entries.cash_manual_punched,
                entries.cash_manual_created,
              ),
              cash_reason: entries.cash_reason,
              cash_comment: entries.cash_comment,
              card_system: snapshot.total_online,
              card_actual: money(entries.card_actual),
              card_manual_punched: money(entries.card_manual_punched),
              card_manual_created: money(entries.card_manual_created),
              card_difference: cardDifference(
                snapshot.total_online,
                entries.card_actual,
                entries.card_manual_punched,
                entries.card_manual_created,
              ),
              card_reason: entries.card_reason,
              card_comment: entries.card_comment,
              district_system: snapshot.district,
              banking_amount: money(entries.banking_amount),
              snap_order_count: snapshot.order_count,
              last_verified_at: now,
              created_at: now,
              updated_at: now,
            };
            const inserted = { id: generatedId(await tx.insert(StoreDayClose).values(values)) };
            await tx
              .insert(StoreDayBanking)
              .values({
                store_id: Number(storeId),
                banking_date: date,
                amount: money(entries.banking_amount),
                updated_by_id: BigInt(user.id),
                created_at: now,
                updated_at: now,
              })
              .onDuplicateKeyUpdate({
                set: {
                  amount: money(entries.banking_amount),
                  updated_by_id: BigInt(user.id),
                  updated_at: now,
                },
              });
            const [row] = await tx
              .select()
              .from(StoreDayClose)
              .where(eq(StoreDayClose.id, BigInt(inserted!.id)));
            return { id: String(inserted!.id), close: serializeClose(row) };
          }),
        );
      } catch (error) {
        await ephemeral.delIfEquals(key, reservation).catch(() => false);
        throw error;
      }
      await ephemeral.set(key, JSON.stringify({ requestHash: hash, closeId: saved.id }), {
        EX: commandTtl,
      });
      return saved.close;
    },
    async versions(user: Principal, storeId: string, date: string, before?: number, limit = 30) {
      requireStore(user, storeId);
      const rows = await databases
        .get('primary')
        .select()
        .from(StoreDayClose)
        .where(
          and(
            eq(StoreDayClose.store_id, Number(storeId)),
            eq(StoreDayClose.close_date, date),
            before ? lt(StoreDayClose.version, before) : undefined,
          ),
        )
        .orderBy(desc(StoreDayClose.version))
        .limit(limit + 1);
      return {
        data: rows.slice(0, limit).map(serializeClose),
        nextVersion: rows.length > limit ? rows[limit - 1]!.version : null,
      };
    },
    async receipt(user: Principal, commandId: string) {
      const command = await readCommand(user.id, commandId);
      if (!command?.closeId)
        throw new AppError(
          404,
          'DAY_CLOSE_COMMAND_NOT_FOUND',
          'No completed day close was found for this command.',
        );
      const [close] = await databases
        .get('writer')
        .select()
        .from(StoreDayClose)
        .where(eq(StoreDayClose.id, BigInt(command.closeId)))
        .limit(1);
      if (!close)
        throw new AppError(
          404,
          'DAY_CLOSE_COMMAND_NOT_FOUND',
          'No completed day close was found for this command.',
        );
      requireStore(user, String(close.store_id));
      return { data: serializeClose(close) };
    },
    async prompt(user: Principal, storeId: string) {
      requireStore(user, storeId);
      await checkins.assertCheckIn(user.id, storeId);
      const date = nagTargetDate(clock(), config);
      if (!date) return { prompt: false };
      const db = databases.get('writer'),
        active = await activeClose(db, storeId, date);
      if (active?.status === 'CLOSED') return { prompt: false };
      const allowed = canClose(
        user.role,
        date,
        clock(),
        await enabled(user, storeId, db),
        active || null,
        config,
      );
      return allowed.allowed
        ? { prompt: true, closeDate: date, status: active?.status || 'NOT_CLOSED' }
        : { prompt: false };
    },
  };
}
export type FinanceService = ReturnType<typeof financeService>;
