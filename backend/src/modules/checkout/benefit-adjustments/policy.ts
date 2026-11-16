import { AppError } from '../../../domain/errors.js';
import {
  walletAdjustmentFieldsSchema,
  walletIdentifier as identifier,
  walletAdjustmentContract,
  walletCorrectionPatchHash,
  type WalletAdjustmentFields,
} from './fields.js';
export {
  walletAdjustmentFieldsSchema,
  walletAdjustmentContract,
  walletCorrectionPatchHash,
  moneyPlatforms,
  pointPlatforms,
  benefitReasons,
  type WalletAdjustmentFields,
} from './fields.js';

export interface WalletBalances {
  money: number;
  points: number;
  cashback: number;
}
export interface WalletEarningHistory {
  id: string;
  addedAmount: number;
  usedAmount: number;
  isExpired: boolean;
  createdAt: string;
}
export interface WalletConsumption {
  historyId: string;
  usedBefore: number;
  usedAmount: number;
}

/** Source uses round(binaryFloat *100)/100, distinct from round(binaryFloat,2). */
function sourceCents(value: number) {
  const scaled = value * 100;
  if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER)
    throw new AppError(
      409,
      'WALLET_HISTORY_REPAIR_REQUIRED',
      'The wallet history requires review.',
    );
  const below = Math.floor(scaled),
    remainder = scaled - below;
  return (
    (remainder < 0.5 ? below : remainder > 0.5 ? below + 1 : below % 2 === 0 ? below : below + 1) /
    100
  );
}

/** Pure approved plan; its writer holds the customer row lock while applying every change. */
export function planWalletAdjustment(
  supplied: WalletAdjustmentFields,
  balances: WalletBalances,
  histories: readonly WalletEarningHistory[],
) {
  const input = walletAdjustmentFieldsSchema.parse(supplied),
    before = balances[input.asset],
    delta = Number(input.amount) * (input.direction === 'subtract' ? -1 : 1),
    after = before + delta;
  if (
    [balances.money, balances.points, balances.cashback].some(
      (amount) => !Number.isFinite(amount) || amount < 0,
    )
  )
    throw new AppError(
      409,
      'WALLET_BALANCE_REPAIR_REQUIRED',
      'The wallet balance requires review.',
    );
  if (Math.abs(before * 100 - Math.round(before * 100)) > 0.000001)
    throw new AppError(
      409,
      'WALLET_BALANCE_REPAIR_REQUIRED',
      'The wallet balance requires review.',
    );
  if (after < 0)
    throw new AppError(
      409,
      'INSUFFICIENT_WALLET_BALANCE',
      'This adjustment exceeds the available wallet balance.',
    );
  if (!Number.isFinite(after) || Math.abs(Math.fround(after) - after) >= 0.005)
    throw new AppError(
      409,
      'WALLET_FLOAT_PRECISION_UNSAFE',
      'The legacy wallet cannot safely store this amount.',
    );
  const consumed: WalletConsumption[] = [];
  let remaining = -delta;
  if (input.direction === 'subtract') {
    if (histories.length > 10000)
      throw new AppError(
        409,
        'WALLET_HISTORY_REPAIR_REQUIRED',
        'The wallet history requires review.',
      );
    const ids = new Set<string>();
    const selected = histories
      .filter((row) => {
        identifier.parse(row.id);
        if (
          ids.has(row.id) ||
          !Number.isFinite(row.addedAmount) ||
          !Number.isFinite(row.usedAmount) ||
          row.usedAmount < 0 ||
          !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.createdAt)
        )
          throw new AppError(
            409,
            'WALLET_HISTORY_REPAIR_REQUIRED',
            'The wallet history requires review.',
          );
        ids.add(row.id);
        return !row.isExpired && row.addedAmount > 0;
      })
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
      );
    for (const row of selected) {
      const available = sourceCents(row.addedAmount - row.usedAmount);
      if (available < 0)
        throw new AppError(
          409,
          'WALLET_HISTORY_REPAIR_REQUIRED',
          'The wallet history requires review.',
        );
      if (available === 0) continue;
      const difference = sourceCents(remaining - available),
        usedAmount = row.usedAmount + (difference <= 0 ? remaining : available);
      consumed.push({ historyId: row.id, usedBefore: row.usedAmount, usedAmount });
      remaining = difference;
      if (remaining <= 0) break;
    }
    if (remaining > 0)
      throw new AppError(
        409,
        'WALLET_HISTORY_REPAIR_REQUIRED',
        'The earning histories do not cover this adjustment.',
      );
  }
  return {
    contract: walletAdjustmentContract,
    patchHash: walletCorrectionPatchHash,
    asset: input.asset,
    before,
    after,
    storedAfter: Math.fround(after),
    delta,
    cashbackAfter: balances.cashback,
    ledger: input.asset === 'money' ? 'tss_money_history' : 'tss_point_history',
    orderId: input.orderId,
    productId: input.productId,
    platform: input.platform,
    comment: input.reason,
    expiry: input.expiry,
    consumed,
  };
}
