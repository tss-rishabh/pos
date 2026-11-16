import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { walletMoneyHistory } from '../checkout/benefit-adjustments/schema.js';
import { voucherReceiptSchema } from './contracts.js';
import { pinErrorCodes, voucherPinError } from './errors.js';
import { globalCoupons, globalVoucherHistory, globalVouchers } from './legacy-schema.js';
import { storedVoucherMinorUnits, voucherAmountString } from './policy.js';
import { voucherOperations } from './schema.js';

export type VoucherOperation = typeof voucherOperations.$inferSelect;
export function voucherEvidenceUnavailable(): never {
  throw new AppError(
    503,
    'VOUCHER_OPERATION_UNCONFIRMED',
    'The saved voucher evidence requires reconciliation.',
  );
}
/** Current locking reads: a prior REPEATABLE READ snapshot cannot reject a just-committed replay. */
export async function verifiedVoucherReceipt(
  tx: AdministrationTransaction,
  operation: VoucherOperation,
) {
  if (operation.errorCode !== null)
    throw voucherPinError(z.enum(pinErrorCodes).parse(operation.errorCode));
  try {
    const result = voucherReceiptSchema.parse(operation.result);
    if (
      result.operationId !== operation.id ||
      result.operatorId !== operation.operatorId ||
      result.customerId !== operation.customerId ||
      result.kind !== operation.kind ||
      result.checkoutId !== operation.checkoutId
    )
      voucherEvidenceUnavailable();
    const [voucher] = await tx
      .select()
      .from(globalVouchers)
      .where(eq(globalVouchers.id, BigInt(result.voucherId)))
      .limit(1)
      .for('share');
    const [history] = await tx
      .select()
      .from(globalVoucherHistory)
      .where(eq(globalVoucherHistory.id, BigInt(result.voucherHistoryId)))
      .limit(1)
      .for('share');
    const amount = Number(result.amount);
    if (
      !voucher ||
      !history ||
      voucher.code !== result.voucherCode ||
      String(voucher.couponId) !== result.couponId ||
      history.userId !== BigInt(result.customerId) ||
      history.voucherId !== voucher.id ||
      history.orderId !== 0n ||
      history.operatorId !== BigInt(result.operatorId) ||
      history.createdAt !== result.createdAt ||
      history.amount !== (result.kind === 'issuance' ? amount : -amount) ||
      history.before !== (result.kind === 'issuance' ? 0 : amount) ||
      history.after !== (result.kind === 'issuance' ? amount : 0) ||
      history.platform !== (result.kind === 'issuance' ? 'GV_ADD' : 'MISC_COMPENSATION')
    )
      voucherEvidenceUnavailable();
    if (result.kind === 'issuance') {
      if (
        BigInt(result.couponId) > 2147483647n ||
        voucher.customerId !== BigInt(result.customerId) ||
        voucherAmountString(storedVoucherMinorUnits(voucher.initialValue)) !== result.amount ||
        voucher.kind !== 'GIFT_VOUCHER' ||
        result.moneyHistoryId !== null ||
        result.walletBefore !== null ||
        result.walletAfter !== null
      )
        voucherEvidenceUnavailable();
      const [coupon] = await tx
        .select()
        .from(globalCoupons)
        .where(
          and(
            eq(globalCoupons.id, Number(result.couponId)),
            eq(globalCoupons.userId, BigInt(result.customerId)),
          ),
        )
        .limit(1)
        .for('share');
      if (
        !coupon ||
        coupon.code !== result.voucherCode ||
        coupon.type !== '3' ||
        coupon.initialValue !== amount
      )
        voucherEvidenceUnavailable();
    } else {
      if (!result.moneyHistoryId || !result.walletBefore || !result.walletAfter)
        voucherEvidenceUnavailable();
      const [money] = await tx
        .select()
        .from(walletMoneyHistory)
        .where(eq(walletMoneyHistory.id, BigInt(result.moneyHistoryId)))
        .limit(1)
        .for('share');
      if (
        !money ||
        money.userId !== BigInt(result.customerId) ||
        money.orderId !== 0n ||
        money.productId !== 0n ||
        money.addedUser !== BigInt(result.operatorId) ||
        money.addedAmount !== amount ||
        money.platform !== 'MISC_COMPENSATION' ||
        money.createdAt !== result.createdAt ||
        voucherAmountString(storedVoucherMinorUnits(money.balanceBefore)) !== result.walletBefore ||
        voucherAmountString(storedVoucherMinorUnits(money.balanceAfter)) !== result.walletAfter
      )
        voucherEvidenceUnavailable();
    }
    return result;
  } catch (error) {
    if (error instanceof AppError && error.code === 'VOUCHER_OPERATION_UNCONFIRMED') throw error;
    voucherEvidenceUnavailable();
  }
}
