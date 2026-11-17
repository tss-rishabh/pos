import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { Order, OrderStore } from '../../../db/legacy-schema.js';
import { identifier } from '../../../domain/validation.js';
import { amount, minorUnits } from '../../../domain/money.js';
import { storedPaymentAttemptSchema } from '../payments/contracts.js';
import { paymentAttempts } from '../payments/schema.js';
import { paymentCorrectionCash, paymentCorrectionOrders, paymentReversals } from './schema.js';
import {
  cashMovementHash,
  correctionReview,
  managedOrderHash,
  originalPaymentHash,
  verifiedReversal,
  reversalCashActor,
  reversalCashTime,
} from './evidence.js';
import { financialScopeHash } from './intent-evidence.js';
import { cashReturnFinancialScopes } from './intent-guards.js';

type Reader = Pick<ReturnType<Databases['get']>, 'select'>;
const scopeSchema = z
  .object({ storeIds: z.array(identifier).min(1).max(1000), from: z.iso.date(), to: z.iso.date() })
  .strict();
export interface PaymentCorrectionCashProjection {
  storeId: string;
  date: string;
  /** Add to source cash collection; source OrderStore is removed once, immutable incoming cash added. */
  cashAdjustment: string;
  /** Add to cash refund/outflow, separately from product returns. */
  cashOut: string;
  /** Retain one logical order when the current source mapping is zero. */
  orderCountAdjustment: number;
}
/** Writer-consistent financial projection. Historical BQ must publish these rewrite ledgers too.
 * Unproved/truncated rows fail closed; mutable current paid/status/price cannot erase historical cash.
 * Call in the same consistent snapshot as source collection, not as a later independent read. */
export async function readPaymentCorrectionCash(
  db: Reader,
  raw: z.input<typeof scopeSchema>,
  secret: string,
): Promise<{ rows: PaymentCorrectionCashDetails[]; managedOrderIds: string[] }> {
  const scope = scopeSchema.parse(raw);
  if (scope.from > scope.to) throw correctionReview();
  const financialScopes = await cashReturnFinancialScopes(
    db,
    scope.storeIds,
    scope.from,
    scope.to,
    secret,
  );
  const candidates = await db
    .select({
      orderId: paymentCorrectionOrders.orderId,
      storeId: paymentCorrectionOrders.storeId,
      date: paymentCorrectionOrders.orderDate,
    })
    .from(paymentCorrectionOrders)
    .where(
      and(
        inArray(paymentCorrectionOrders.storeId, scope.storeIds),
        gte(paymentCorrectionOrders.orderDate, scope.from),
        lte(paymentCorrectionOrders.orderDate, scope.to),
      ),
    )
    .orderBy(asc(paymentCorrectionOrders.orderId))
    .limit(1001);
  const movementCandidates = await db
    .select({
      recordId: paymentCorrectionCash.id,
      orderId: paymentCorrectionCash.orderId,
      storeId: paymentCorrectionCash.storeId,
      date: paymentCorrectionCash.businessDate,
    })
    .from(paymentCorrectionCash)
    .where(
      and(
        inArray(paymentCorrectionCash.storeId, scope.storeIds),
        gte(paymentCorrectionCash.businessDate, scope.from),
        lte(paymentCorrectionCash.businessDate, scope.to),
      ),
    )
    .orderBy(asc(paymentCorrectionCash.orderId))
    .limit(10001);
  if (candidates.length > 1000 || movementCandidates.length > 10000) throw correctionReview();
  const actual = new Map<string, { storeId: string; date: string; ids: Set<string> }>();
  for (const row of [
    ...candidates.map((row) => ({ ...row, key: 'order:' + row.orderId })),
    ...movementCandidates.map((row) => ({ ...row, key: 'cash:' + row.recordId })),
  ]) {
    const key = row.storeId + '\0' + row.date,
      group = actual.get(key) || { storeId: row.storeId, date: row.date, ids: new Set<string>() };
    group.ids.add(row.key);
    actual.set(key, group);
  }
  for (const key of new Set([...actual.keys(), ...financialScopes.keys()])) {
    const found = actual.get(key),
      expected = financialScopes.get(key);
    if (
      !expected ||
      expected.count !== (found?.ids.size ?? 0) ||
      expected.hash !==
        financialScopeHash(expected.storeId, expected.date, [...(found?.ids || [])], secret)
    )
      throw correctionReview();
  }
  const ids = [...new Set([...candidates, ...movementCandidates].map((row) => row.orderId))];
  if (ids.length > 1000) throw correctionReview();
  if (!ids.length) return { rows: [], managedOrderIds: [] };
  if (secret.length < 32) throw correctionReview();
  const orders = await db
    .select()
    .from(paymentCorrectionOrders)
    .where(inArray(paymentCorrectionOrders.orderId, ids))
    .orderBy(asc(paymentCorrectionOrders.orderId));
  if (orders.length !== ids.length) throw correctionReview();
  const [[fundingBudget], [reversalBudget]] = await Promise.all([
    db
      .select({
        count: sql<string>`count(*)`,
        bytes: sql<string>`coalesce(sum(octet_length(cast(${paymentAttempts.state} as char))),0)`,
        maximum: sql<string>`coalesce(max(octet_length(cast(${paymentAttempts.state} as char))),0)`,
      })
      .from(paymentAttempts)
      .where(inArray(paymentAttempts.orderId, ids)),
    db
      .select({
        count: sql<string>`count(*)`,
        bytes: sql<string>`coalesce(sum(octet_length(cast(${paymentReversals.receipt} as char))),0)`,
        maximum: sql<string>`coalesce(max(octet_length(cast(${paymentReversals.receipt} as char))),0)`,
      })
      .from(paymentReversals)
      .where(inArray(paymentReversals.orderId, ids)),
  ]);
  const budgetSchema = z.object({
      count: z.coerce.number().int().safe().nonnegative(),
      bytes: z.coerce.number().int().safe().nonnegative(),
      maximum: z.coerce.number().int().safe().nonnegative(),
    }),
    fundingBound = budgetSchema.safeParse(fundingBudget),
    reversalBound = budgetSchema.safeParse(reversalBudget);
  if (
    !fundingBound.success ||
    !reversalBound.success ||
    fundingBound.data.count > 10000 ||
    reversalBound.data.count > 5000 ||
    fundingBound.data.maximum > 2000000 ||
    reversalBound.data.maximum > 2000000 ||
    fundingBound.data.bytes + reversalBound.data.bytes > 16000000
  )
    throw correctionReview();
  const movements = await db
      .select()
      .from(paymentCorrectionCash)
      .where(inArray(paymentCorrectionCash.orderId, ids))
      .orderBy(asc(paymentCorrectionCash.id))
      .limit(10001),
    reversals = await db
      .select()
      .from(paymentReversals)
      .where(inArray(paymentReversals.orderId, ids))
      .limit(5001),
    fundingRows = await db
      .select({
        id: paymentAttempts.id,
        orderId: paymentAttempts.orderId,
        state: paymentAttempts.state,
      })
      .from(paymentAttempts)
      .where(inArray(paymentAttempts.orderId, ids))
      .limit(10001),
    mappings = await db
      .select({
        orderId: Order.id,
        createdAt: Order.created_at,
        storeId: OrderStore.store,
        counterId: OrderStore.counter,
        cash: OrderStore.offline_payment,
        online: OrderStore.online_payment,
        other: OrderStore.online_other_payment,
      })
      .from(Order)
      .innerJoin(OrderStore, eq(OrderStore.order, Order.id))
      .where(
        inArray(
          Order.id,
          ids.map((id) => BigInt(id)),
        ),
      );
  if (
    movements.length > 10000 ||
    reversals.length > 5000 ||
    fundingRows.length > 10000 ||
    mappings.length !== orders.length
  )
    throw correctionReview();
  const receipts = new Map(reversals.map((row) => [row.id, verifiedReversal(row, secret)])),
    funding = new Map(
      fundingRows.map((row) => {
        const parsed = storedPaymentAttemptSchema.parse(row.state);
        if (row.id !== parsed.id || row.orderId !== parsed.orderId) throw correctionReview();
        return [row.id, parsed];
      }),
    ),
    mappingsByOrder = new Map(mappings.map((row) => [String(row.orderId), row])),
    managedByOrder = new Map(orders.map((row) => [row.orderId, row])),
    movementById = new Map(movements.map((row) => [row.id, row])),
    totals = new Map<
      string,
      {
        storeId: string;
        date: string;
        cash: bigint;
        incoming: bigint;
        out: bigint;
        count: number;
        logical: number;
      }
    >();
  const selected = (date: string) => date >= scope.from && date <= scope.to;
  function total(storeId: string, date: string) {
    const key = `${storeId}:${date}`;
    let result = totals.get(key);
    if (!result) {
      result = { storeId, date, cash: 0n, incoming: 0n, out: 0n, count: 0, logical: 0 };
      totals.set(key, result);
    }
    return result;
  }
  for (const order of orders) {
    const { inputHash, ...fields } = order,
      mapping = mappingsByOrder.get(order.orderId);
    if (
      !mapping ||
      !scope.storeIds.includes(order.storeId) ||
      inputHash !== managedOrderHash(fields, secret) ||
      String(mapping.storeId) !== order.storeId ||
      String(mapping.counterId) !== order.counterId ||
      mapping.createdAt.slice(0, 10) !== order.orderDate ||
      !movementById.has(`${order.firstPaymentId}:in`)
    )
      throw correctionReview();
    if (selected(order.orderDate)) {
      const value = total(order.storeId, order.orderDate),
        baseline = minorUnits(mapping.cash),
        included = baseline + minorUnits(mapping.online) + minorUnits(mapping.other) > 0n;
      value.cash -= included ? baseline : 0n;
      value.count += included ? 0 : 1;
      value.logical += 1;
    }
  }
  for (const row of movements) {
    const { inputHash, ...fields } = row,
      managed = managedByOrder.get(row.orderId);
    if (
      !managed ||
      inputHash !== cashMovementHash(fields, secret) ||
      !['in', 'out'].includes(row.direction) ||
      minorUnits(row.amount) <= 0n ||
      row.storeId !== managed.storeId ||
      row.counterId !== managed.counterId ||
      row.businessDate !== row.recordedAt.slice(0, 10) ||
      row.id !== `${row.sourceId}:${row.direction}`
    )
      throw correctionReview();
    if (row.direction === 'in') {
      const original = funding.get(row.sourceId);
      if (
        !original ||
        original.status !== 'paid' ||
        original.channel !== 'cash' ||
        original.orderId !== row.orderId ||
        original.storeId !== row.storeId ||
        original.counterId !== row.counterId ||
        original.operatorId !== row.operatorId ||
        original.updatedAt !== row.recordedAt ||
        minorUnits(original.cashAmount) !== minorUnits(row.amount) ||
        minorUnits(original.onlineAmount) !== 0n
      )
        throw correctionReview();
    } else {
      const receipt = receipts.get(row.sourceId),
        original = receipt ? funding.get(receipt.originalPaymentId) : null;
      if (
        !receipt ||
        !original ||
        receipt.orderId !== row.orderId ||
        reversalCashActor(receipt) !== row.operatorId ||
        reversalCashTime(receipt) !== row.recordedAt ||
        receipt.originalPaymentHash !== originalPaymentHash(original, secret) ||
        minorUnits(receipt.returnedCash) !== minorUnits(row.amount)
      )
        throw correctionReview();
    }
    if (selected(row.businessDate)) {
      const value = total(row.storeId, row.businessDate);
      if (row.direction === 'in') {
        value.cash += minorUnits(row.amount);
        value.incoming += minorUnits(row.amount);
      } else value.out += minorUnits(row.amount);
    }
  }
  for (const receipt of receipts.values()) {
    if (
      !movementById.has(`${receipt.id}:out`) ||
      !movementById.has(`${receipt.originalPaymentId}:in`)
    )
      throw correctionReview();
  }
  for (const original of funding.values()) {
    if (
      original.status === 'paid' &&
      managedByOrder.has(original.orderId) &&
      (original.channel !== 'cash' ||
        minorUnits(original.onlineAmount) !== 0n ||
        !movementById.has(`${original.id}:in`))
    )
      throw correctionReview();
  }
  const rows = [...totals.values()]
    .sort((a, b) => a.storeId.localeCompare(b.storeId) || a.date.localeCompare(b.date))
    .map((row) => ({
      storeId: row.storeId,
      date: row.date,
      cashAdjustment: row.cash < 0n ? '-' + amount(-row.cash) : amount(row.cash),
      cashOut: amount(row.out),
      orderCountAdjustment: row.count,
      cashIn: amount(row.incoming),
      logicalOrderCount: row.logical,
    }));
  return { rows, managedOrderIds: orders.map((row) => row.orderId) };
}

/** Daily reporting removes its predicate-dependent source baseline separately. */
export interface PaymentCorrectionCashDetails extends PaymentCorrectionCashProjection {
  cashIn: string;
  logicalOrderCount: number;
}
export async function paymentCorrectionCashDetails(
  db: Reader,
  raw: z.input<typeof scopeSchema>,
  secret: string,
): Promise<PaymentCorrectionCashDetails[]> {
  return (await readPaymentCorrectionCash(db, raw, secret)).rows;
}
export async function paymentCorrectionCashProjection(
  db: Reader,
  raw: z.input<typeof scopeSchema>,
  secret: string,
): Promise<PaymentCorrectionCashProjection[]> {
  return (await paymentCorrectionCashDetails(db, raw, secret)).map(
    ({ cashIn: _cashIn, logicalOrderCount: _logicalOrderCount, ...row }) => row,
  );
}
