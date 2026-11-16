import { z } from 'zod';
import { pythonRound2 } from '../../domain/python-round.js';
import { reportCsvCell } from './export-domain.js';
import { scalarId } from './report-inputs.js';
import { pythonFloatString, pythonRoundInteger } from './number-format.js';
const numeric = z.union([
    z.number().finite(),
    z.string().regex(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i),
  ]),
  float = numeric.transform(Number).refine(Number.isFinite),
  integer = z.union([z.number().int().refine(Number.isSafeInteger), z.string().regex(/^-?\d+$/)]),
  value = z.union([z.string(), z.number().finite()]).nullable(),
  text = z.string().nullable(),
  date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/)
    .nullable()
    .transform((value) =>
      value === null || value.startsWith('0000-00-00')
        ? null
        : value.slice(0, 19).replace(' ', 'T'),
    );
export const orderReportLineSchema = z.object({
  id: scalarId,
  order_ref_no: z.string(),
  LocationCode: text,
  transaction_status: z.enum(['SALE', 'RETURN']),
  OrderDate: date,
  transaction_date: date,
  StoreName: text,
  PaymentStatus: text,
  OrderAmount: numeric.nullable(),
  PayAmount: numeric.nullable(),
  Message: text,
  IsOfflineOrder: z
    .union([integer, z.boolean()])
    .nullable()
    .transform((value) => (value === null ? null : Number(value)))
    .refine((value) => value === null || Number.isFinite(value)),
  IsShopifyOrder: z
    .union([integer, z.boolean()])
    .nullable()
    .transform((value) => (value === null ? null : Number(value)))
    .refine((value) => value === null || Number.isFinite(value)),
  PaymentMode: text,
  CASH: numeric.nullable(),
  DistrictAmount: numeric.nullable(),
  DistrictOrder: text,
  CreditPincodeAmount: numeric.nullable(),
  PincodeOrder: text,
  OnlineOther: numeric.nullable(),
  PinelabCardUpi: numeric.nullable(),
  PinelabTxnId: text,
  PinelabPlutusId: value,
  PaytmCardUpi: numeric.nullable(),
  TssMoneyUsed: numeric.nullable(),
  TssPointsUsed: numeric.nullable(),
  CouponAmountUsed: numeric.nullable(),
  VoucherAmountUsed: numeric.nullable(),
  PgDisc: numeric.nullable(),
  PgDiscComment: text,
  LineItemQty: integer,
  LineItemSubTotal: float,
  TotalOrderQty: integer,
  TaxRate: float,
  LineItemPgDisc: float,
  StoreDiscPG: numeric.nullable(),
  StoreDiscPGComment: text,
  StoreDiscPGReason: text,
  LineItemStoreDiscPG: float,
  IndividualDisc: float,
  IndividualPointsUsed: float,
  LineItemTssMoneyUsed: numeric.nullable(),
  LineItemVoucherAmountUsed: numeric.nullable(),
  LineItemSubTotalWoTax: float,
  ProductCategory: text,
  HSNCode: value,
  ParentProductId: scalarId.nullable(),
  ParentProduct: text,
  ErpProduct: text,
  VariantProductId: scalarId.nullable(),
  VariantProduct: text,
  SalespersonEmpID: text,
  SalespersonName: text,
  counter_name: text,
  Pricelist: z.string(),
  CustomerID: scalarId.nullable(),
  OrderType: z.string(),
  PayAmountRefunded: numeric.nullable(),
  PayAmountRefundedMode: text,
  ReturnRequestDatetime: text,
  ReturnProductDays: value,
  transaction_id: text,
  otp_provided_by_name: text,
  otp_applied_by_name: text,
  customer_type: value,
  gstin: text,
  CreditNoteNo: text,
  InvoiceNo: text,
  OriginalOrderId: scalarId.nullable(),
});
export type OrderReportLine = z.infer<typeof orderReportLineSchema>;
export function preparedOrderRecords(rows: OrderReportLine[]) {
  return rows.map((line) => {
    const sign = line.transaction_status === 'RETURN' ? '-' : '',
      base = line.LineItemSubTotalWoTax,
      gstFactor = 1 + line.TaxRate / 100,
      discountNet = line.LineItemPgDisc / gstFactor;
    let taxable: number, gst: number, actualGst: number, totalSale: string | number;
    const rounded = (value: number) => sign + pythonFloatString(pythonRound2(value));
    if (line.LineItemStoreDiscPG === 0) {
      taxable = base - discountNet - line.LineItemStoreDiscPG;
      gst = ((base - discountNet) * line.TaxRate) / 100;
      actualGst = ((base - line.LineItemStoreDiscPG) * line.TaxRate) / 100;
      totalSale = rounded(
        base -
          discountNet -
          line.LineItemStoreDiscPG +
          ((base - line.LineItemStoreDiscPG - discountNet) * line.TaxRate) / 100,
      );
    } else if (line.IndividualPointsUsed >= 0) {
      taxable = base;
      gst = (base * line.TaxRate) / 100;
      actualGst = (base * line.TaxRate) / 100;
      totalSale = rounded(base * (1 + line.TaxRate / 100));
    } else {
      const value =
        (line.LineItemSubTotal - discountNet - (line.LineItemStoreDiscPG + line.IndividualDisc)) /
        gstFactor;
      taxable = value;
      gst = (value * line.TaxRate) / 100;
      actualGst = (value * line.TaxRate) / 100;
      totalSale = value + (value * line.TaxRate) / 100;
    }
    return {
      id: line.id,
      order_id: line.id,
      order_ref_no: line.order_ref_no,
      location_code: line.LocationCode,
      transaction_status: line.transaction_status,
      order_date: line.OrderDate,
      date: line.transaction_date,
      store_name: line.StoreName,
      payment_status: line.PaymentStatus,
      order_amount: line.OrderAmount,
      pay_amount: line.PayAmount,
      message: line.Message,
      order_mode: line.IsOfflineOrder ? 'Offline ' : line.IsShopifyOrder ? 'Shopify' : 'Online',
      payment_mode: line.PaymentMode,
      cash: line.CASH,
      district_amt: line.DistrictAmount,
      district_id: line.DistrictOrder,
      credit_pincode: line.CreditPincodeAmount,
      pincode_id: line.PincodeOrder,
      online_other: line.OnlineOther,
      paytm_card_upi: line.PaytmCardUpi,
      paytm_txn_id: line.transaction_id,
      pinelab_card_upi: line.PinelabCardUpi,
      pinelab_txn_id: line.PinelabTxnId,
      pinelab_plutus_id: line.PinelabPlutusId,
      tss_money_used: line.TssMoneyUsed,
      tss_points_used: line.TssPointsUsed,
      coupon_amount_used: line.CouponAmountUsed,
      voucher_amount_used: line.VoucherAmountUsed,
      pg_disc: line.PgDisc,
      pg_disc_comment: line.PgDiscComment,
      pg_disc_approved_by: line.otp_provided_by_name,
      pg_disc_applied_by: line.otp_applied_by_name,
      line_item_qty: sign + String(line.LineItemQty),
      line_item_sub_total: sign + pythonFloatString(line.LineItemSubTotal),
      line_item_sub_total_Wo_tax: sign + pythonFloatString(line.LineItemSubTotalWoTax),
      product_category: line.ProductCategory,
      hsn_code: line.HSNCode,
      parent_productId: line.ParentProductId,
      parent_product: line.ParentProduct,
      erp_product: line.ErpProduct,
      variant_productId: line.VariantProductId,
      variant_product: line.VariantProduct,
      salesperson_emp_id: line.SalespersonEmpID,
      salesperson_name: line.SalespersonName,
      pricelist: line.Pricelist,
      customer_id: line.CustomerID,
      order_type: line.OrderType,
      pay_amount_refunded: line.PayAmountRefunded,
      paya_mount_refunded_mode: line.PayAmountRefundedMode,
      return_request_datetime: line.ReturnRequestDatetime,
      return_product_days: line.ReturnProductDays,
      order_id_product_id:
        line.id.trim() + (line.VariantProductId === null ? 'None' : line.VariantProductId).trim(),
      line_item_pg_discount: rounded(line.LineItemPgDisc),
      line_item_pg_discount_net_off_gst: rounded(discountNet),
      store_disc_pg: line.StoreDiscPG,
      store_disc_pg_comment: line.StoreDiscPGComment,
      store_disc_pg_reason: line.StoreDiscPGReason,
      line_item_store_discount_pg: rounded(line.LineItemStoreDiscPG),
      total_order_qty: Number(line.TotalOrderQty),
      product_price_revised:
        sign + BigInt(pythonRoundInteger(line.LineItemSubTotalWoTax)).toString(),
      individual_discount: sign + pythonFloatString(line.IndividualDisc),
      individual_point_used: sign + pythonFloatString(line.IndividualPointsUsed),
      taxable_value_minus_pg: rounded(taxable),
      tax_rate: line.TaxRate,
      gst: rounded(gst),
      actual_gst: rounded(actualGst),
      total_sale: totalSale,
      line_item_tss_money_used: line.LineItemTssMoneyUsed,
      line_item_voucher_amount_used: line.LineItemVoucherAmountUsed,
      counter_name: line.counter_name,
      customer_type: line.customer_type,
      gstin: line.gstin,
      credit_note_no: line.CreditNoteNo,
      invoice_no: line.InvoiceNo,
      original_order_id: line.OriginalOrderId,
    };
  });
}
export type PreparedOrderRecord = ReturnType<typeof preparedOrderRecords>[number];
export const orderReportHeaders = [
  ['order_id', 'Order ID'],
  ['order_ref_no', 'Order Ref No'],
  ['location_code', 'Location Code'],
  ['transaction_status', 'Transaction Type'],
  ['date', 'Transaction Date'],
  ['order_date', 'OrderDate'],
  ['order_id_product_id', 'Concatenate'],
  ['store_name', 'StoreName'],
  ['counter_name', 'CounterName'],
  ['payment_status', 'PaymentStatus'],
  ['order_amount', 'OrderAmount'],
  ['pay_amount', 'PayAmount'],
  ['message', 'Message'],
  ['order_mode', 'Order Mode'],
  ['payment_mode', 'PaymentMode'],
  ['cash', 'CASH'],
  ['district_amt', 'District Amt'],
  ['district_id', 'District ID'],
  ['credit_pincode', 'Credit-Pincode Amt'],
  ['pincode_id', 'Pincode ID'],
  ['online_other', 'Online(Other)'],
  ['paytm_card_upi', 'Paytm(Card/Upi)'],
  ['paytm_txn_id', 'Paytm TXN ID'],
  ['pinelab_card_upi', 'Pinelab(Card/Upi)'],
  ['pinelab_txn_id', 'Pinelab TXN ID'],
  ['pinelab_plutus_id', 'Pinelab Plutus ID'],
  ['tss_money_used', 'TssMoneyUsed'],
  ['tss_points_used', 'TssPointsUsed'],
  ['coupon_amount_used', 'CouponAmountUsed'],
  ['voucher_amount_used', 'VoucherAmountUsed'],
  ['pg_disc', 'PGDiscount'],
  ['line_item_pg_discount', 'LineItemPGDiscount'],
  ['line_item_pg_discount_net_off_gst', 'LineItemPGDiscountNetOffGST'],
  ['pg_disc_comment', 'PGDiscountComment'],
  ['store_disc_pg', 'StoreDiscount(PG)'],
  ['line_item_store_discount_pg', 'LineItemStoreDiscount(PG)'],
  ['store_disc_pg_comment', 'StoreDiscount(PG)Comment'],
  ['store_disc_pg_reason', 'StoreDiscount(PG)Reason'],
  ['pg_disc_applied_by', 'StoreDiscount(PG)AppliedBy'],
  ['pg_disc_approved_by', 'StoreDiscount(PG)ApprovedBy'],
  ['line_item_qty', 'LineItemQty'],
  ['total_order_qty', 'TotalOrderQty'],
  ['product_price_revised', 'ProductPriceRevised'],
  ['line_item_sub_total', 'LineItemSubTotal'],
  ['line_item_sub_total_Wo_tax', 'LineItemSubTotalWoTax'],
  ['individual_discount', 'IndividualDiscount'],
  ['individual_point_used', 'IndividualPointUsed'],
  ['taxable_value_minus_pg', 'Taxable Value(Minus PG)'],
  ['tax_rate', 'Tax Rate'],
  ['gst', 'GST'],
  ['actual_gst', 'ActualGST (Paid By Cx)'],
  ['total_sale', 'Total Sale'],
  ['line_item_tss_money_used', 'LineItemTssMoneyUsed'],
  ['line_item_voucher_amount_used', 'LineItemVoucherAmountUsed'],
  ['product_category', 'ProductCategory'],
  ['hsn_code', 'HSNCode'],
  ['parent_productId', 'ParentProductId'],
  ['parent_product', 'ParentProduct'],
  ['erp_product', 'ErpProduct'],
  ['variant_productId', 'VariantProductId'],
  ['variant_product', 'VariantProduct'],
  ['salesperson_emp_id', 'SalespersonEmpID'],
  ['salesperson_name', 'SalespersonName'],
  ['pricelist', 'Pricelist'],
  ['customer_id', 'CustomerID'],
  ['order_type', 'OrderType'],
  ['pay_amount_refunded', 'PayAmountRefunded'],
  ['paya_mount_refunded_mode', 'PayAmountRefundedMode'],
  ['return_request_datetime', 'ReturnRequestDatetime'],
  ['return_product_days', 'ReturnProductDays'],
  ['customer_type', 'CustomerType'],
  ['gstin', 'GSTIN'],
  ['credit_note_no', 'CreditNoteNo'],
  ['invoice_no', 'InvoiceNo'],
  ['original_order_id', 'OriginalOrderId'],
] as const satisfies readonly (readonly [keyof PreparedOrderRecord, string])[];
export function orderReportCsv(rows: PreparedOrderRecord[]) {
  return (
    '\uFEFF' +
    [
      orderReportHeaders.map(([, label]) => label),
      ...rows.map((row) =>
        orderReportHeaders.map(([field]) =>
          field === 'date' || field === 'order_date'
            ? row[field]?.replace('T', ' ') || ''
            : row[field],
        ),
      ),
    ]
      .map((row) => row.map(reportCsvCell).join(','))
      .join('\r\n')
  );
}
