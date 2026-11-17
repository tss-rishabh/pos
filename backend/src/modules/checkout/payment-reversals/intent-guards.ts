import { asc, inArray } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import type { Databases } from '../../../db/pools.js';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import {
  cashReturnControls,
  cashReturnIntents,
  cashReturnPartitionControls,
} from './intent-schema.js';
import {
  emptyControl,
  verifiedControl,
  verifiedIntent,
  verifiedPartitionControl,
  verifyPartitionSet,
  intentReview,
} from './intent-evidence.js';
import { operationHash } from '../crypto.js';
import { paymentCorrectionOrders } from './schema.js';
import type { CashReturnControl } from './intent-contracts.js';

import { cashReturnClaims, cashReturnClaimResolutions } from './intent-claim-schema.js';
import { verifiedClaim, verifiedClaimResolution } from './intent-claim-evidence.js';

type Reader = Pick<ReturnType<Databases['get']>, 'select'>;
export const pendingCashReturn = () =>
  new AppError(
    409,
    'CASH_RETURN_RECONCILIATION_REQUIRED',
    'Cash may already have been returned. Resolve the store’s pending cash-return intents before final financial figures or another payment. Do not return cash again.',
  );
/** Current operational control metadata only, never a historical MySQL amount fallback.
 * All state changes serialize on Store; financial close holds that same lock.
 */
async function readControls(
  db: Reader,
  storeIds: readonly string[],
  secret: string,
  assertSettled = true,
  range?: { from: string; to: string },
) {
  const ids = [...new Set(storeIds.map((value) => identifier.parse(value)))].sort();
  if (!ids.length || ids.length > 1000) throw pendingCashReturn();
  const rows = await db
    .select()
    .from(cashReturnControls)
    .where(inArray(cashReturnControls.storeId, ids))
    .orderBy(asc(cashReturnControls.storeId));
  const found = new Map(rows.map((row) => [row.storeId, verifiedControl(row, secret)]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    const old = await db
      .select()
      .from(cashReturnIntents)
      .where(inArray(cashReturnIntents.storeId, missing))
      .limit(1001);
    if (
      old.length > 1000 ||
      old.some((row) => !['PREPARED', 'CANCELLED'].includes(verifiedIntent(row, secret).phase))
    )
      throw intentReview();
    const [claim] = await db
      .select({ id: cashReturnClaims.id })
      .from(cashReturnClaims)
      .where(inArray(cashReturnClaims.storeId, missing))
      .limit(1);
    const [financial] = await db
      .select({ id: paymentCorrectionOrders.orderId })
      .from(paymentCorrectionOrders)
      .where(inArray(paymentCorrectionOrders.storeId, missing))
      .limit(1);
    if (claim || financial) throw intentReview();
  }
  const partitions = await db
    .select()
    .from(cashReturnPartitionControls)
    .where(inArray(cashReturnPartitionControls.storeId, ids))
    .orderBy(
      asc(cashReturnPartitionControls.storeId),
      asc(cashReturnPartitionControls.businessDate),
    )
    .limit(70001);
  if (partitions.length > 70000)
    throw new AppError(422, 'REPORT_TOO_LARGE', 'The cash-return control set is too large.');
  const groups = new Map<string, typeof partitions>();
  for (const row of partitions) {
    const group = groups.get(row.storeId) || [];
    group.push(row);
    groups.set(row.storeId, group);
  }
  const controls = new Map(rows.map((row) => [row.storeId, row]));
  for (const storeId of ids)
    verifyPartitionSet(groups.get(storeId) || [], controls.get(storeId), secret);
  const result = new Map<string, CashReturnControl>(
    ids.map((id) => [id, found.get(id) || emptyControl(id)]),
  );
  if (
    assertSettled &&
    rows.some(
      (row) =>
        row.unresolvedCount > 0 &&
        (!range || (row.pendingFrom !== null && row.pendingFrom <= range.to)),
    )
  )
    throw pendingCashReturn();
  return { result, partitions };
}
export async function cashReturnControlHeads(
  db: Reader,
  storeIds: readonly string[],
  secret: string,
  assertSettled = true,
  range?: { from: string; to: string },
) {
  return (await readControls(db, storeIds, secret, assertSettled, range)).result;
}
/** Per-day current publication fences contain no historical amount/customer facts.
 * Daily uses only changed dates; ledger uses the ordered prefix up to each day.
 * Unrelated immutable report data may be reused under a fresh qualified seal.
 */
export async function cashReturnPartitionHeads(
  db: Reader,
  storeIds: readonly string[],
  from: string,
  to: string,
  kind: 'daily' | 'cash-ledger',
  secret: string,
) {
  const stores = [...new Set(storeIds.map((value) => identifier.parse(value)))].sort();
  const controls = await readControls(db, stores, secret, true, { from, to });
  const start = Temporal.PlainDate.from(from),
    end = Temporal.PlainDate.from(to),
    days: string[] = [];
  if (Temporal.PlainDate.compare(start, end) > 0) throw pendingCashReturn();
  for (let day = start; Temporal.PlainDate.compare(day, end) <= 0; day = day.add({ days: 1 })) {
    days.push(day.toString());
    if (days.length * stores.length > 70000)
      throw new AppError(422, 'REPORT_TOO_LARGE', 'Select a smaller cash-return financial range.');
  }
  const rows = controls.partitions.filter(
    (row) => row.businessDate <= to && (kind === 'cash-ledger' || row.businessDate >= from),
  );
  const grouped = new Map<string, ReturnType<typeof verifiedPartitionControl>[]>();
  for (const row of rows) {
    const value = verifiedPartitionControl(row, secret);
    const group = grouped.get(value.storeId) || [];
    group.push(value);
    grouped.set(value.storeId, group);
  }
  const result = new Map<string, CashReturnControl>();
  for (const storeId of stores) {
    const group = grouped.get(storeId) || [],
      byDate = new Map(group.map((row) => [row.date, row]));
    let index = 0,
      manifestHash = '0'.repeat(64);
    for (const date of days) {
      if (kind === 'daily') {
        const row = byDate.get(date);
        result.set(storeId + '\0' + date, {
          storeId,
          revision: row?.revision ?? '0',
          manifestHash: row?.manifestHash ?? '0'.repeat(64),
          unresolvedCount: 0,
        });
      } else {
        while (group[index] && group[index]!.date <= date) {
          const row = group[index++]!;
          manifestHash = operationHash(
            'cash-return.ledger-prefix.v1',
            {
              previous: manifestHash,
              date: row.date,
              revision: row.revision,
              manifestHash: row.manifestHash,
            },
            secret,
          );
        }
        result.set(storeId + '\0' + date, {
          storeId,
          revision: String(index),
          manifestHash,
          unresolvedCount: 0,
        });
      }
    }
  }
  return result;
}
export function assertSameCashReturnHeads(
  expected: ReadonlyMap<string, CashReturnControl>,
  observed: ReadonlyMap<string, CashReturnControl>,
) {
  if (
    expected.size !== observed.size ||
    [...expected].some(([id, value]) => JSON.stringify(value) !== JSON.stringify(observed.get(id)))
  )
    throw new AppError(
      409,
      'CASH_RETURN_FINANCIAL_STATE_CHANGED',
      'Cash-return financial state changed. Refresh the qualified figures before continuing.',
    );
}
export async function assertNoPendingCashReturnForOrders(
  db: Reader,
  orderIds: readonly string[],
  secret: string,
  exceptIntentId?: string,
  exceptClaimId?: string,
) {
  const ids = [...new Set(orderIds.map((value) => identifier.parse(value)))];
  if (!ids.length) return;
  if (ids.length > 1000) throw pendingCashReturn();
  const rows = await db
    .select()
    .from(cashReturnIntents)
    .where(inArray(cashReturnIntents.orderId, ids))
    .limit(1001)
    .for('update');
  if (rows.length > 1000) throw pendingCashReturn();
  const claims = await db
    .select()
    .from(cashReturnClaims)
    .where(inArray(cashReturnClaims.orderId, ids))
    .limit(1001)
    .for('update');
  if (claims.length > 1000) throw pendingCashReturn();
  const resolutions = claims.length
    ? await db
        .select()
        .from(cashReturnClaimResolutions)
        .where(
          inArray(
            cashReturnClaimResolutions.id,
            claims.map((row) => row.id),
          ),
        )
        .for('update')
    : [];
  const resolved = new Set(resolutions.map((row) => verifiedClaimResolution(row, secret).id));
  for (const row of claims) {
    const body = verifiedClaim(row, secret);
    if (body.id !== exceptClaimId && !resolved.has(body.id)) throw pendingCashReturn();
  }
  for (const row of rows) {
    const body = verifiedIntent(row, secret);
    if (body.id !== exceptIntentId && ['RETURN_PENDING', 'ATTESTED'].includes(body.phase))
      throw pendingCashReturn();
  }
}

/** The signed native membership identifies expected proof rows, never report amounts. */
export async function cashReturnFinancialScopes(
  db: Reader,
  storeIds: readonly string[],
  from: string,
  to: string,
  secret: string,
) {
  const controls = await readControls(db, storeIds, secret, true, { from, to });
  return new Map(
    controls.partitions
      .filter((row) => row.businessDate >= from && row.businessDate <= to)
      .map((row) => [
        row.storeId + '\0' + row.businessDate,
        {
          storeId: row.storeId,
          date: row.businessDate,
          count: row.financialFactCount,
          hash: row.financialFactHash,
        },
      ]),
  );
}
