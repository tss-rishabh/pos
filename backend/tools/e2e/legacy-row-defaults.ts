import type { HasProduct, MUser, Order, Product } from '../../src/db/legacy-schema.js';

/**
 * The values production MySQL stores today for NOT NULL columns that the e2e/harness inserts do
 * not set themselves.
 *
 * Production runs with an empty (non-strict) `sql_mode`, so an omitted NOT NULL column takes its
 * DDL `DEFAULT`, or, without one, the implicit default for its type (`0`, `''`, the zero date).
 * AGENTS.md asks for that stored value to be written explicitly, so the rows are the same in any
 * mode and the Drizzle insert types are complete. Each value below comes from the column's DDL in
 * `tests/golden/schema/production-schema.json`; the comment names the source. Callers spread one
 * of these first and then set their own columns, which take precedence.
 *
 * Only NOT NULL columns without a Drizzle default appear here, and only those some e2e insert
 * leaves out. Nullable and Drizzle-defaulted columns stay omitted, as before.
 */

/** `orders`. */
export const legacyOrderDefaults = {
  cod_charges: 0, // int, implicit
  hl_charges: 0, // int DEFAULT 0
  gifting_charges: 0, // int, implicit
  payment_id: 0, // int, implicit
  tss_money_used: 0, // float DEFAULT 0
  tss_points_used: 0, // float DEFAULT 0
  tss_points_earned: 0, // float DEFAULT 0
  tss_points_credited: 0, // int, implicit
  voucher_used: 0n, // bigint, implicit
  coupon_used: 0n, // bigint, implicit
  shipping_amt: 0, // int, implicit
  coupon_amt_used: 0, // double, implicit
  referal_code_amt: 0, // float, implicit
  print_invoice: 0, // int, implicit
  ref_flag: 0, // int, implicit
  user_ref_points: 0, // double, implicit
  cart_rec_notify1: 0, // int, implicit
  cart_rec_notify2: 0, // int, implicit
  incomplete_order: 0, // int, implicit
  flag: 0n, // flag_id bigint, implicit
  intern_added: 0, // int, implicit
  intern_amt: 0, // float(10,2), implicit
  is_stock_reduced: 0, // tinyint, implicit
  is_split_order: 0, // tinyint DEFAULT 0
  is_global_order: 0, // tinyint DEFAULT 0
  cashback_used: 0, // float, implicit
} satisfies Partial<typeof Order.$inferInsert>;

/** `has_products`. */
export const legacyHasProductDefaults = {
  return_mode: 0, // int DEFAULT 0
  amount_refunded_mode: 0, // int DEFAULT 0
  cashback_refunded: 0, // int DEFAULT 0
  amount_to_be_refunded: 0, // float DEFAULT 0
  reverse_send_sms: 0, // int DEFAULT 0
  reverse_send_mail: 0, // int DEFAULT 0
  refund_send_mail: 0, // int DEFAULT 0
  refund_send_sms: 0, // int DEFAULT 0
  disc: 0, // float, implicit
  disc_qty: 0n, // bigint, implicit
  wallet_disc: 0, // float DEFAULT 0
  voucher_disc: 0, // float DEFAULT 0
  referal_disc: 0, // float DEFAULT 0
  salesperson_id: 0, // int DEFAULT 0
  gift_voucher_id: 0, // int DEFAULT 0
} satisfies Partial<typeof HasProduct.$inferInsert>;

/** `products`. */
export const legacyProductDefaults = {
  add_desc_id: 0, // int DEFAULT 0
  is_crowd_funded: 0, // tinyint(1), implicit
  art_cut: 0, // float, implicit
  is_cod: 1, // tinyint(1) DEFAULT 1
  added_by: 0n, // bigint, implicit
  updated_by: 0n, // bigint, implicit
  is_individual: 0, // tinyint(1), implicit
  is_notification: 0, // int, implicit
  sort_order: 99n, // bigint DEFAULT 99
  search_sort: 500, // int DEFAULT 500
  official_merch_sort_order: 1000n, // bigint DEFAULT 1000
  is_shipped_international: 1, // int DEFAULT 1
  is_referal_discount: 1, // int DEFAULT 1
  is_jit: 0, // int DEFAULT 0
} satisfies Partial<typeof Product.$inferInsert>;

/** `users` (`MUser`). */
export const legacyUserDefaults = {
  newsletter: 0, // tinyint(1) DEFAULT 0
  desc: '', // text, implicit
  remember_token: '', // varchar(255), implicit
  loyalty_group: 1, // int DEFAULT 1
  cashback: 0, // float, implicit
  tss_money: 0, // float DEFAULT 0
  tss_points: 0, // float DEFAULT 0
  referal_code: '', // varchar(20), implicit
  platform: '', // varchar(20), implicit
  pos_admin_id: 0n, // bigint DEFAULT 0
  fb_id: '', // varchar(20), implicit
  plus_id: '', // varchar(20), implicit
  apple_id: '', // varchar(255), implicit
  sort_order: 100n, // bigint DEFAULT 100
  es_search_order: 1000, // int DEFAULT 1000
  is_merch: 0, // tinyint, implicit
  meta_title: '', // text, implicit
  meta_keys: '', // text, implicit
  meta_desc: '', // text, implicit
  art_bank_details: '', // text, implicit
  art_status: 0, // int, implicit
  is_featured: 0, // tinyint DEFAULT 0
  es_search_keywords: '', // varchar(255), implicit
  og_title: '', // varchar(255), implicit
  og_description: '', // text, implicit
  twitter_title: '', // varchar(255), implicit
  twitter_description: '', // text, implicit
  breadcrum_title: '', // varchar(255), implicit
  breadcrum_name: '', // varchar(255), implicit
  popular_search: '', // longtext, implicit
  shop_now: '', // longtext, implicit
  is_from_megento: 0, // tinyint DEFAULT 0
  is_two_fa: 0, // tinyint, implicit
  // datetime, implicit: the zero date, which the empty production sql_mode accepts.
  created_at: '0000-00-00 00:00:00',
  updated_at: '0000-00-00 00:00:00',
  order_gender: '', // varchar(10), implicit
  artist_alias_name: '', // varchar(45), implicit
} satisfies Partial<typeof MUser.$inferInsert>;
