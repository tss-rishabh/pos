import { z } from 'zod';
import { orderReportHeaders } from './order-report-columns.js';

// Finite source screen columns. These select presentation only; no SQL identifiers
// or customer/store authority can be supplied through an export column request.
export const reportScreenColumns = {
  'order-transactions': orderReportHeaders,
  'salesperson-performance': [
    ['store_name', 'Store Name'],
    ['salesperson_name', 'Salesperson Name'],
    ['total_sales', 'Total Sales'],
    ['rating', 'Rating'],
  ],
  'cashier-performance': [
    ['cashier_name', 'Staff Name'],
    ['product_sold', 'Total Product Sold'],
    ['time_taken', 'Total Time Taken'],
    ['score', 'Fastest Finger Score'],
  ],
  'hyperlocal-acceptance': [
    ['order_id', 'Order Id'],
    ['store_name', 'Store Name'],
    ['staff_name', 'Staff Name'],
    ['time_taken', 'Time Taken'],
    ['created_at', 'Created At'],
  ],
  'returned-orders': [
    ['store_name', 'Store Name'],
    ['order_id', 'Order ID'],
    ['prod_id', 'Product ID'],
    ['qty', 'Qty'],
    ['pay_amount_refunded', 'Pay Amount Refunded'],
    ['pay_amount_refunded_mode', 'Pay Amount Refunded Mode'],
    ['reason', 'Reason'],
    ['sub_reason', 'Sub Reason'],
    ['comment', 'Comment'],
    ['order_date', 'Order Date'],
    ['created_at', 'Return Date'],
    ['original_order_id', 'Original Order ID'],
  ],
  'flash-sales': [
    ['StoreName', 'Store Name'],
    ['date', 'Date'],
    ['total_number_of_bills', 'Total Number Of Bills'],
    ['total_number_of_qty_sold', 'Total Number Of Qty Sold'],
    ['tss_money', 'Money Used'],
    ['tss_points', 'Points Used'],
    ['coupon', 'Coupon Used'],
    ['gift_voucher', 'Voucher Used'],
    ['pg_disc', 'PG Discount'],
    ['cash', 'Cash Recieved (c)'],
    ['online', 'Online Payment Recieved (op)'],
    ['online_others', 'Online Other Payment Recieved (oop)'],
    ['total_paytm_card_amount', 'Total Paytm Card Amount (pca)'],
    ['total_paytm_upi_amount', 'Total Paytm UPI Amount (pua)'],
    ['district_transation_amt', 'Total District Amount (da)'],
    ['credit_pincode_amt', 'Total Credit-Pincode Amount(cpa)'],
    ['cash_return', 'Return Cash (rc)'],
    ['tss_money_return', 'Return Tss Money'],
    ['tss_point_return', 'Return Tss Points'],
    ['other_online_return', 'Return Other Online'],
    ['net_cash', 'Net Cash (nc = c-rc)'],
    ['total_sales', 'Total Sales (ts = c+oop+pca+pua+da+cpa)'],
  ],
} as const;
export type ReportScreenKind = keyof typeof reportScreenColumns;

export function reportColumnSelection(kind: ReportScreenKind) {
  const allowed = new Set<string>(reportScreenColumns[kind].map(([key]) => key));
  return z
    .array(z.string().refine((value) => allowed.has(value), 'Select a report column.'))
    .min(1)
    .max(allowed.size)
    .refine((values) => new Set(values).size === values.length, 'Select each column once.')
    .optional();
}

export const managerReportExportKinds = [
  'salesperson-performance',
  'cashier-performance',
  'hyperlocal-acceptance',
] as const;
export function managerReportExport(kind: string): boolean {
  return managerReportExportKinds.some((value) => value === kind);
}
