import type { Databases } from '../../../db/pools.js';

/**
 * Legacy semantics (table-disposition.md, `pos_rewrite_payment_correction_cash` DELETE):
 * a payment-status change overwrites `order_stores`/`orders` in place and finance reads cash
 * from `order_stores` on the order date. There is no correction cash ledger, so these readers
 * return no overlay rows. They remain only for finance/payment-corrections.ts, reports.ts and
 * daily-report-corrections.ts until their owners remove the overlay.
 */
type Reader = Pick<ReturnType<Databases['get']>, 'select'>;
interface Scope {
  storeIds: string[];
  from: string;
  to: string;
}
export interface PaymentCorrectionCashProjection {
  storeId: string;
  date: string;
  cashAdjustment: string;
  cashOut: string;
  orderCountAdjustment: number;
}
export interface PaymentCorrectionCashDetails extends PaymentCorrectionCashProjection {
  cashIn: string;
  logicalOrderCount: number;
}
export async function readPaymentCorrectionCash(
  _db: Reader,
  _scope: Scope,
  _secret?: string,
): Promise<{ rows: PaymentCorrectionCashDetails[]; managedOrderIds: string[] }> {
  return { rows: [], managedOrderIds: [] };
}
export async function paymentCorrectionCashDetails(
  _db: Reader,
  _scope: Scope,
  _secret?: string,
): Promise<PaymentCorrectionCashDetails[]> {
  return [];
}
export async function paymentCorrectionCashProjection(
  _db: Reader,
  _scope: Scope,
  _secret?: string,
): Promise<PaymentCorrectionCashProjection[]> {
  return [];
}
