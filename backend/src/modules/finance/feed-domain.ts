import { z } from 'zod';
import { pythonRound2 } from '../../domain/python-compat.js';
const number = z.coerce.number().finite();
const decimal = z.union([z.string().regex(/^-?\d+(?:\.\d+)?$/), z.number().finite()]).nullable();
export const feedLineSchema = z.object({
  id: z
    .union([z.string().regex(/^\d+$/), z.number().int().refine(Number.isSafeInteger), z.bigint()])
    .transform(String),
  transaction_date: z
    .string()
    .nullable()
    .transform((value) => value?.slice(0, 10) || null),
  LocationCode: z.string().nullable(),
  PaymentMode: z.string().nullable(),
  PayAmount: number,
  PaymentStatus: z.string().nullable(),
  OrderAmount: number,
  order_ref_no: z.string(),
  counter_name: z.string().nullable(),
  TaxRate: number.nullable(),
  LineItemSubTotalWoTax: number.nullable(),
  PayAmountRefunded: number.nullable(),
  PayAmountRefundedMode: z.string().nullable(),
  CASH: decimal.optional(),
  PaytmCardUpi: decimal.optional(),
  PinelabCardUpi: decimal.optional(),
  OnlineOther: decimal.optional(),
  DistrictAmount: decimal.optional(),
  TssMoneyUsed: number.nullable().optional(),
  CreditPincodeAmount: decimal.optional(),
  VoucherAmountUsed: number.nullable().optional(),
  CouponAmountUsed: number.nullable().optional(),
  TssPointsUsed: number.nullable().optional(),
  PgDisc: number.nullable().optional(),
});
export type FeedLine = z.infer<typeof feedLineSchema>;
export const feedSaleLineSchema = feedLineSchema.required({
  CASH: true,
  PaytmCardUpi: true,
  PinelabCardUpi: true,
  OnlineOther: true,
  DistrictAmount: true,
  TssMoneyUsed: true,
  CreditPincodeAmount: true,
  VoucherAmountUsed: true,
  CouponAmountUsed: true,
  TssPointsUsed: true,
  PgDisc: true,
});
const sourceZero = (value: string | number | null | undefined): string | number =>
  value === null || value === undefined || Number(value) === 0 ? 0 : value;
function splitRefund(mode: string | null, amount: number) {
  const normal = (mode || '').toLowerCase();
  return {
    mode: normal ? normal.toUpperCase() : null,
    tss: normal === 'tss_money' ? amount : 0,
    cash: normal === 'cash' ? amount : 0,
  };
}
function base(line: FeedLine) {
  return {
    order_id: line.id,
    transaction_date: line.transaction_date,
    store_code: line.LocationCode,
    payment_mode: line.PaymentMode,
    pay_amount: line.PayAmount,
    order_ref_no: line.order_ref_no,
    counter_name: line.counter_name,
    payment_status: line.PaymentStatus,
    order_amount: line.OrderAmount,
  };
}
function sale(line: FeedLine) {
  return {
    ...base(line),
    transaction_type: 'SALE' as const,
    cash_amount: sourceZero(line.CASH),
    paytm_amount: sourceZero(line.PaytmCardUpi),
    pinelab_amount: sourceZero(line.PinelabCardUpi),
    online_other_amount: sourceZero(line.OnlineOther),
    district_amount: sourceZero(line.DistrictAmount),
    tss_money_used: line.TssMoneyUsed || 0,
    tss_money_refunded: 0,
    cash_refunded: 0,
    cashgram_refund: 0,
    refund_amount: 0,
    refund_mode: null as string | null,
    credit_pincode_amount: sourceZero(line.CreditPincodeAmount),
    voucher_amount: line.VoucherAmountUsed || 0,
    coupon_amount: line.CouponAmountUsed || 0,
    tss_points_used: line.TssPointsUsed || 0,
    pg_discount: line.PgDisc || 0,
    taxable_value: 0,
    gst_amount: 0,
  };
}
function returned(line: FeedLine) {
  const taxable = line.LineItemSubTotalWoTax || 0,
    refunded = line.PayAmountRefunded || 0,
    split = splitRefund(line.PayAmountRefundedMode, refunded);
  return {
    ...base(line),
    transaction_type: 'RETURN' as const,
    refund_amount: refunded,
    refund_mode: split.mode,
    tss_money_refunded: split.tss,
    cash_refunded: split.cash,
    cashgram_refund: 0,
    taxable_value: pythonRound2(taxable),
    gst_amount: pythonRound2(taxable * ((line.TaxRate || 0) / 100)),
  };
}
export function reconciliationRecords(sales: FeedLine[], returns: FeedLine[]) {
  const orders = new Map<string, ReturnType<typeof sale>>();
  for (const line of sales) {
    let order = orders.get(line.id);
    if (!order) {
      order = sale(line);
      orders.set(line.id, order);
    }
    const taxable = line.LineItemSubTotalWoTax || 0;
    order.taxable_value += taxable;
    order.gst_amount += taxable * ((line.TaxRate || 0) / 100);
    const refunded = line.PayAmountRefunded || 0;
    if (refunded) {
      const split = splitRefund(line.PayAmountRefundedMode, refunded);
      order.refund_amount += refunded;
      if (split.mode) order.refund_mode = split.mode;
      order.tss_money_refunded += split.tss;
      order.cash_refunded += split.cash;
    }
  }
  for (const order of orders.values()) {
    order.taxable_value = pythonRound2(order.taxable_value);
    order.gst_amount = pythonRound2(order.gst_amount);
  }
  return [...orders.values(), ...returns.map(returned)].sort((a, b) => {
    for (const [left, right] of [
      [a.transaction_date || '', b.transaction_date || ''],
      [a.order_id, b.order_id],
      [a.transaction_type, b.transaction_type],
    ]) {
      if (left! < right!) return -1;
      if (left! > right!) return 1;
    }
    return 0;
  });
}
export function reconciliationPage(
  records: ReturnType<typeof reconciliationRecords>,
  page: number,
  pageSize: number,
) {
  return {
    success: true as const,
    data: records.slice((page - 1) * pageSize, page * pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total_records: records.length,
      total_pages: Math.ceil(records.length / pageSize),
    },
  };
}
