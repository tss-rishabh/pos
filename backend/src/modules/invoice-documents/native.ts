import { createHash } from 'node:crypto';
/** Pinned native MySQL expressions; the additive Python worker imports generated identical SQL. */
export const invoiceHeaderNativeSql =
  "LOWER(SHA2(CAST(JSON_OBJECT('id',orders.id,'customer',orders.user_id,'payment_method',orders.payment_method,'payment_status',orders.payment_status,'order_status',orders.order_status,'order_amt',orders.order_amt,'pay_amt',orders.pay_amt,'cashback_used',orders.cashback_used,'tss_money_used',orders.tss_money_used,'tss_points_used',orders.tss_points_used,'voucher_used',orders.voucher_used,'voucher_amt_used',orders.voucher_amt_used,'coupon_used',orders.coupon_used,'coupon_amt_used',orders.coupon_amt_used,'calculation',orders.is_new_calculation,'store_disc_pg',orders.store_disc_pg,'fraction_value',orders.fraction_value,'cod_charges',orders.cod_charges,'gifting_charges',orders.gifting_charges,'shipping_amt',orders.shipping_amt,'hl_charges',orders.hl_charges,'express_charges',orders.express_charges,'ref_flag',orders.ref_flag,'address_id',orders.has_address_id,'resolved_address',(SELECT JSON_OBJECT('id',has_addresses.id,'user_id',has_addresses.user_id,'firstname',has_addresses.firstname,'lastname',has_addresses.lastname,'address',has_addresses.address,'address1',has_addresses.address1,'address2',has_addresses.address2,'address3',has_addresses.address3,'address4',has_addresses.address4,'flat',has_addresses.flat,'city',has_addresses.city,'postcode',has_addresses.postcode,'country_id',has_addresses.country_id,'country_code',has_addresses.country_code,'zone_id',has_addresses.zone_id,'phone_no',has_addresses.phone_no,'is_active',has_addresses.is_active,'updated_at',CAST(has_addresses.updated_at AS CHAR)) FROM has_addresses WHERE has_addresses.id=orders.has_address_id AND has_addresses.user_id=orders.user_id LIMIT 1),'first_name',orders.first_name,'last_name',orders.last_name,'address1',orders.address1,'address2',orders.address2,'address3',orders.address3,'city',orders.city,'postal_code',orders.postal_code,'phone_no',orders.phone_no,'zone_id',orders.zone_id,'country_id',orders.country_id,'courier',orders.courier,'created_at',CAST(orders.created_at AS CHAR),'updated_at',CAST(orders.updated_at AS CHAR)) AS CHAR CHARACTER SET utf8mb4),256))";
export const invoiceLineNativeSql =
  "LOWER(SHA2(CAST(JSON_OBJECT('id',has_products.id,'order',has_products.order_id,'product',has_products.prod_id,'variant',has_products.sub_prod_id,'quantity',has_products.qty,'price',has_products.price,'gst',has_products.gst,'prod_gst',has_products.prod_gst,'pre_gst_amt',has_products.pre_gst_amt,'disc',has_products.disc,'hp_tss_points_used',has_products.hp_tss_points_used,'store_disc_pg',has_products.store_disc_pg,'wallet_disc',has_products.wallet_disc,'voucher_disc',has_products.voucher_disc,'normal_price',has_products.normal_price,'special_price',has_products.special_price,'exclusive_price',has_products.exclusive_price,'is_exclusive_order',has_products.is_exclusive_order,'exclusive_saving',has_products.exclusive_saving,'gift_voucher_id',has_products.gift_voucher_id,'status',has_products.status) AS CHAR CHARACTER SET utf8mb4),256))";
export type InvoiceNativeParts = [
  string,
  string,
  string,
  string | null,
  string,
  string,
  string | null,
  boolean,
  string[][],
  string[][],
  (string | null)[][],
];
export function invoiceNativeBinding(parts: InvoiceNativeParts) {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}
