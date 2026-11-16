package poscheckout

// Native MySQL values are hashed after source mutations. These expressions are
// shared verbatim with the rewrite proof reader; no Go/JavaScript numeric or
// JSON reserialization is permitted at this boundary.
const HeaderHashSQL = `LOWER(SHA2(CAST(JSON_OBJECT('order_id',orders.id,'user_id',orders.user_id,'payment_method',orders.payment_method,'pay_amt',orders.pay_amt,'cashback_used',orders.cashback_used,'tss_money_used',orders.tss_money_used,'tss_points_used',orders.tss_points_used,'voucher_used',orders.voucher_used,'voucher_amt_used',orders.voucher_amt_used,'coupon_used',orders.coupon_used,'coupon_amt_used',orders.coupon_amt_used) AS CHAR CHARACTER SET utf8mb4),256))`
const LineHashSQL = `LOWER(SHA2(CAST(JSON_OBJECT('has_product_id',has_products.id,'product_id',has_products.prod_id,'quantity',has_products.qty,'price',has_products.price) AS CHAR CHARACTER SET utf8mb4),256))`

var DefaultHashes = HashContract{HeaderSQL: HeaderHashSQL, LineSQL: LineHashSQL}
