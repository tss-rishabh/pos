// Generated from source plus verified physical decoder overrides. Never auto-migrate legacy tables.
import {
  mysqlTable,
  bigint,
  int,
  smallint,
  boolean,
  varchar,
  text,
  decimal,
  double,
  float,
  datetime,
  date,
  time,
  json,
} from 'drizzle-orm/mysql-core';

export const Product = mysqlTable('products', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  product: varchar('product', { length: 255 }).notNull(),
  erp_product: varchar('erp_product', { length: 255 }).notNull(),
  short_desc: varchar('short_desc', { length: 200 }).notNull(),
  long_desc: varchar('long_desc', { length: 300 }).notNull(),
  add_desc: varchar('add_desc', { length: 400 }).notNull(),
  add_desc_id: int('add_desc_id').notNull(),
  measurement: varchar('measurement', { length: 255 }).notNull(),
  images: varchar('images', { length: 300 }).notNull(),
  images_new: varchar('images_new', { length: 300 }).notNull(),
  prod_type: bigint('prod_type', { mode: 'bigint' }).notNull(),
  attr_set: bigint('attr_set', { mode: 'bigint' }).notNull(),
  url_key: varchar('url_key', { length: 255 }).notNull(),
  is_avail: smallint('is_avail').notNull(),
  is_listing: smallint('is_listing').notNull(),
  processing: bigint('processing', { mode: 'bigint' }).notNull(),
  price: decimal('price', { precision: 10, scale: 2 }).notNull(),
  spl_price: decimal('spl_price', { precision: 10, scale: 2 }).notNull(),
  gst: int('gst').notNull(),
  is_crowd_funded: smallint('is_crowd_funded').notNull(),
  target_date: datetime('target_date', { mode: 'string' }).notNull(),
  target_qty: bigint('target_qty', { mode: 'bigint' }).notNull(),
  parent_prod_id: bigint('parent_prod_id', { mode: 'bigint' }).notNull(),
  meta_title: varchar('meta_title', { length: 100 }).notNull(),
  meta_keys: varchar('meta_keys', { length: 200 }).notNull(),
  meta_desc: varchar('meta_desc', { length: 200 }).notNull(),
  art_cut: float('art_cut'),
  is_cod: smallint('is_cod').notNull(),
  added_by: bigint('added_by', { mode: 'bigint' }).notNull(),
  updated_by: bigint('updated_by', { mode: 'bigint' }).notNull(),
  is_individual: smallint('is_individual').notNull(),
  is_notification: int('is_notification').notNull(),
  sort_order: bigint('sort_order', { mode: 'bigint' }).notNull(),
  search_sort: int('search_sort').notNull(),
  wwe_sort: int('wwe_sort').notNull(),
  wwe_prod_sort: int('wwe_prod_sort').notNull(),
  official_merch_sort_order: bigint('official_merch_sort_order', { mode: 'bigint' }).notNull(),
  is_shipped_international: int('is_shipped_international').notNull(),
  is_referal_discount: int('is_referal_discount').notNull(),
  warehouse_code: varchar('warehouse_code', { length: 50 }).notNull(),
  is_del: int('is_del').notNull(),
  is_jit: int('is_jit').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const PriceListMeta = mysqlTable('pricelist_meta', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  name: varchar('name', { length: 225 }).notNull(),
});

export const PriceList = mysqlTable('pricelist', {
  product_id: bigint('product_id', { mode: 'bigint' }).primaryKey().notNull(),
  pricelist_id: int('pricelist_id').notNull(),
  price: decimal('price', { precision: 10, scale: 2 }).notNull(),
});

export const ProductStore = mysqlTable('product_store', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  product: bigint('product_id', { mode: 'bigint' }).notNull(),
  store: bigint('store_id', { mode: 'bigint' }).notNull(),
  stock: int('stock').notNull(),
  is_avail: boolean('is_avail').notNull(),
  is_del: boolean('is_del').notNull(),
});

export const Attributes = mysqlTable('attributes', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  attr: varchar('attr', { length: 50 }).notNull(),
});

export const HasOptions = mysqlTable('has_options', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  prod_id: bigint('prod_id', { mode: 'bigint' }).notNull(),
  attr: bigint('attr_id', { mode: 'bigint' }).notNull(),
  attr_val: varchar('attr_val', { length: 255 }).notNull(),
});

export const ProductBarcode = mysqlTable('products_gs1', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  product: bigint('product_id', { mode: 'bigint' }).notNull(),
  gtin: bigint('gtin', { mode: 'bigint' }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const ProductDescription = mysqlTable('add_desc', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  name: varchar('name', { length: 500 }).notNull(),
  desc: varchar('desc', { length: 500 }).notNull(),
  material: varchar('material', { length: 500 }).notNull(),
});

export const CsvUpload = mysqlTable('pos_csv_upload', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  upload_type: varchar('upload_type', { length: 100 }),
  uploaded_by: bigint('uploaded_by', { mode: 'bigint' }),
  message: varchar('message', { length: 255 }),
  failed_data: text('failed_data'),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
  is_imported: boolean('is_imported').notNull(),
  filename: varchar('filename', { length: 254 }),
});

export const ProductInventoryLog = mysqlTable('pos_product_inventory_logs', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  store_id: bigint('store_id', { mode: 'bigint' }).notNull(),
  product_id: bigint('product_id', { mode: 'bigint' }).notNull(),
  stock_before: varchar('stock_before', { length: 255 }),
  stock_after: varchar('stock_after', { length: 255 }),
  type: int('type').notNull(),
  user_id: bigint('user_id', { mode: 'bigint' }).notNull(),
  pos_user_id: bigint('pos_user_id', { mode: 'bigint' }).notNull(),
  comment: varchar('comment', { length: 255 }),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const HoldStockStore = mysqlTable('hold_stock_store', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  product: bigint('product_id', { mode: 'bigint' }).notNull(),
  store: bigint('store_id', { mode: 'bigint' }).notNull(),
  stock: int('stock').notNull(),
});

export const PosHoldStockLog = mysqlTable('pos_hold_stock_logs', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  store_id: bigint('store_id', { mode: 'bigint' }).notNull(),
  product_id: bigint('product_id', { mode: 'bigint' }).notNull(),
  stock_before: varchar('stock_before', { length: 255 }),
  stock_after: varchar('stock_after', { length: 255 }),
  pos_user_id: bigint('pos_user_id', { mode: 'bigint' }).notNull(),
  comment: varchar('comment', { length: 255 }),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const PosTransactionLog = mysqlTable('pos_transaction_logs', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
  store_id: bigint('store_id', { mode: 'bigint' }).notNull(),
  order_status: bigint('order_status', { mode: 'bigint' }).notNull(),
  payment_status: bigint('payment_status', { mode: 'bigint' }).notNull(),
  user_id: bigint('user_id', { mode: 'bigint' }).notNull(),
  pos_user_id: bigint('pos_user_id', { mode: 'bigint' }).notNull(),
  pay_dict: text('pay_dict').notNull(),
  comment: varchar('comment', { length: 255 }),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const PosTerminalTransaction = mysqlTable('pos_terminal_transactions', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
  store_id: bigint('store_id', { mode: 'bigint' }).notNull(),
  transaction_id: varchar('transaction_id', { length: 255 }).notNull(),
  plutus_id: varchar('plutus_id', { length: 255 }).notNull(),
  store_pos_code: varchar('store_pos_code', { length: 255 }).notNull(),
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  cash_amount: decimal('cash_amount', { precision: 10, scale: 2 }).notNull(),
  cash_recieved: decimal('cash_recieved', { precision: 10, scale: 2 }).notNull(),
  total_amount: decimal('total_amount', { precision: 10, scale: 2 }).notNull(),
  payment_mode: int('payment_mode').notNull(),
  pos_admin_id: bigint('pos_admin_id', { mode: 'bigint' }).notNull(),
  imei: varchar('imei', { length: 255 }).notNull(),
  platform: varchar('platform', { length: 255 }).notNull(),
  api_response: text('api_response'),
  is_active: boolean('is_active').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const PosMachine = mysqlTable('pos_machines', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  store_id: int('store_id').notNull(),
  counter_id: int('counter_id').notNull(),
  machine_name: varchar('machine_name', { length: 255 }).notNull(),
  merchant_name: varchar('merchant_name', { length: 255 }).notNull(),
  store_name: varchar('store_name', { length: 255 }).notNull(),
  client_id: varchar('client_id', { length: 45 }).notNull(),
  hardware_id: varchar('hardware_id', { length: 255 }).notNull(),
  imei_no: varchar('imei_no', { length: 45 }).notNull(),
  tid: varchar('tid', { length: 45 }).notNull(),
  merchant_id: varchar('merchant_id', { length: 45 }).notNull(),
  merchant_store_pos_code: varchar('merchant_store_pos_code', { length: 45 }).notNull(),
  security_token: varchar('security_token', { length: 255 }).notNull(),
  is_active: int('is_active').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const SalesPerson = mysqlTable('salespersons', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  employee_id: varchar('employee_id', { length: 45 }).notNull(),
  first_name: varchar('first_name', { length: 45 }).notNull(),
  last_name: varchar('last_name', { length: 45 }).notNull(),
  email: varchar('email', { length: 45 }).notNull(),
  phone: varchar('phone', { length: 45 }).notNull(),
  is_active: int('is_active').notNull(),
  user_type: smallint('user_type').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const StoreSalesPerson = mysqlTable('store_salesperson', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  salesperson: bigint('salesperson_id', { mode: 'bigint' }).notNull(),
  store: bigint('store_id', { mode: 'bigint' }).notNull(),
  is_active: int('is_active').notNull(),
});

export const PosSpecialPermissionActivityLog = mysqlTable('pos_special_permission_activity_log', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  pos_user_id: bigint('pos_user_id', { mode: 'bigint' }).notNull(),
  platform: varchar('platform', { length: 255 }).notNull(),
  comment: varchar('comment', { length: 255 }),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
  recipient: varchar('recipient', { length: 45 }),
});

export const TssMoneyHistory = mysqlTable('tss_money_history', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  user_id: bigint('user_id', { mode: 'bigint' }).notNull(),
  platform: varchar('platform', { length: 255 }).notNull(),
  comment: varchar('comment', { length: 255 }),
  added_user: bigint('added_user', { mode: 'bigint' }),
  order_id: bigint('order_id', { mode: 'bigint' }),
  added_amt: double('added_amt').notNull(),
  used_amt: double('used_amt').notNull(),
  amt_before_update: double('amt_before_update').notNull(),
  amt_after_update: double('amt_after_update').notNull(),
  is_expired: int('is_expired').notNull(),
  expiry: datetime('expiry', { mode: 'string' }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const TssPointHistory = mysqlTable('tss_point_history', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  user_id: bigint('user_id', { mode: 'bigint' }).notNull(),
  platform: varchar('platform', { length: 255 }).notNull(),
  comment: varchar('comment', { length: 255 }),
  added_user: bigint('added_user', { mode: 'bigint' }),
  order_id: bigint('order_id', { mode: 'bigint' }),
  added_amt: double('added_amt').notNull(),
  used_amt: double('used_amt').notNull(),
  amt_before_update: double('amt_before_update').notNull(),
  amt_after_update: double('amt_after_update').notNull(),
  game_category_id: bigint('game_category_id', { mode: 'bigint' }),
  is_expired: int('is_expired').notNull(),
  expiry: datetime('expiry', { mode: 'string' }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const PullProductInventoryRef = mysqlTable('pull_product_Inventory_ref', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  product_id: bigint('product_id', { mode: 'bigint' }).notNull(),
  is_active: int('is_active').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const PosHyperlocalSlot = mysqlTable('pos_hyperlocal_slots', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  store_id: bigint('store_id', { mode: 'bigint' }).notNull(),
  weekday: varchar('weekday', { length: 255 }).notNull(),
  is_avail: bigint('is_avail', { mode: 'bigint' }).notNull(),
  start_timeslot: time('start_timeslot').notNull(),
  end_timeslot: time('end_timeslot').notNull(),
  pos_admin_id: bigint('pos_admin_id', { mode: 'bigint' }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const StockStorage = mysqlTable('stock_storages', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  product: bigint('product_id', { mode: 'bigint' }).notNull(),
  store: bigint('store_id', { mode: 'bigint' }).notNull(),
  storage: bigint('storage_id', { mode: 'bigint' }).notNull(),
  stock: int('stock').notNull(),
});

export const StorageStockLog = mysqlTable('stock_storage_logs', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  store: bigint('store_id', { mode: 'bigint' }).notNull(),
  storage: bigint('storage_id', { mode: 'bigint' }).notNull(),
  product: bigint('product_id', { mode: 'bigint' }).notNull(),
  stock_before: varchar('stock_before', { length: 255 }),
  stock_after: varchar('stock_after', { length: 255 }),
  pos_user_id: bigint('pos_user_id', { mode: 'bigint' }).notNull(),
  comment: varchar('comment', { length: 255 }),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const PosPaytmMachine = mysqlTable('pos_paytm_machines', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  store_id: int('store_id').notNull(),
  counter_id: int('counter_id').notNull(),
  machine_name: varchar('machine_name', { length: 255 }).notNull(),
  merchant_name: varchar('merchant_name', { length: 255 }).notNull(),
  store_name: varchar('store_name', { length: 255 }).notNull(),
  merchant_key: varchar('merchant_key', { length: 255 }).notNull(),
  paytm_mid: varchar('paytm_mid', { length: 255 }).notNull(),
  device_serial_no: bigint('device_serial_no', { mode: 'bigint' }).notNull(),
  paytm_tid: varchar('paytm_tid', { length: 255 }).notNull(),
  channel_id: varchar('channel_id', { length: 255 }).notNull(),
  is_active: int('is_active').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const PosPaytmTransaction = mysqlTable('pos_paytm_transactions', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
  store_id: bigint('store_id', { mode: 'bigint' }).notNull(),
  transaction_id: varchar('transaction_id', { length: 255 }).notNull(),
  paytm_mid: varchar('paytm_mid', { length: 255 }).notNull(),
  paytm_tid: varchar('paytm_tid', { length: 255 }).notNull(),
  transaction_date_time: datetime('transaction_date_time', { mode: 'string' }).notNull(),
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  cash_amount: decimal('cash_amount', { precision: 10, scale: 2 }).notNull(),
  cash_recieved: decimal('cash_recieved', { precision: 10, scale: 2 }).notNull(),
  total_amount: decimal('total_amount', { precision: 10, scale: 2 }).notNull(),
  payment_mode: int('payment_mode').notNull(),
  pos_admin_id: bigint('pos_admin_id', { mode: 'bigint' }).notNull(),
  platform: varchar('platform', { length: 255 }).notNull(),
  api_response: text('api_response'),
  is_active: boolean('is_active').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const PosTerminalPaymentModes = mysqlTable('pos_terminal_payment_modes', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  mode_id: int('mode_id').notNull(),
  is_active: int('is_active').notNull(),
  platform: varchar('platform', { length: 255 }).notNull(),
});

export const GiftVoucher = mysqlTable('gift_vouchers', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
  voucher_code: varchar('voucher_code', { length: 255 }).notNull(),
  voucher_initial_value: int('voucher_initial_value').notNull(),
  status: int('status').notNull(),
  gift_card_srno: bigint('gift_card_srno', { mode: 'bigint' }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const GiftCardCollection = mysqlTable('gift_card_collection', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  size: int('size').notNull(),
  message: varchar('message', { length: 255 }).notNull(),
  is_completed: int('is_completed').notNull(),
  is_block: int('is_block').notNull(),
  is_printed: int('is_printed').notNull(),
  created_by: bigint('created_by', { mode: 'bigint' }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  filename: varchar('filename', { length: 255 }).notNull(),
});

export const PosTutorial = mysqlTable('pos_tutorial', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  title: varchar('title', { length: 100 }).notNull(),
  short_discription: varchar('short_discription', { length: 500 }).notNull(),
  discription: varchar('discription', { length: 1000 }).notNull(),
  cover_image: varchar('cover_image', { length: 1000 }).notNull(),
  image_link: varchar('image_link', { length: 1000 }).notNull(),
  video_link: varchar('video_link', { length: 1000 }).notNull(),
  doc_link: varchar('doc_link', { length: 1000 }).notNull(),
  search_keyword: varchar('search_keyword', { length: 1000 }).notNull(),
  is_active: int('is_active').notNull(),
  sort_value: int('sort_value').notNull(),
  created_by: int('created_by').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const PosInternetSpeedLog = mysqlTable('pos_internet_speed_logs', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  store_id: bigint('store_id', { mode: 'bigint' }).notNull(),
  pos_admin_id: bigint('pos_admin_id', { mode: 'bigint' }).notNull(),
  user_id: bigint('user_id', { mode: 'bigint' }).notNull(),
  speed: varchar('speed', { length: 45 }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const Notification = mysqlTable('pos_notifications', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  url_key: varchar('url_key', { length: 255 }),
  order_id: bigint('order_id', { mode: 'bigint' }),
  store_id: int('store_id'),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const UsersNotification = mysqlTable('pos_user_notifications', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  notification: bigint('notification_id', { mode: 'bigint' }).notNull(),
  is_viewed: int('is_viewed').notNull(),
  pos_admin_id: int('pos_admin_id').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const MUser = mysqlTable('users', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  firstname: varchar('firstname', { length: 32 }).notNull(),
  lastname: varchar('lastname', { length: 32 }).notNull(),
  company_name: varchar('company_name', { length: 255 }).notNull(),
  email: varchar('email', { length: 96 }).notNull(),
  telephone: varchar('telephone', { length: 32 }).notNull(),
  password: text('password').notNull(),
  plain_password: text('plain_password').notNull(),
  birthdate: date('birthdate', { mode: 'string' }).notNull(),
  gender: varchar('gender', { length: 20 }),
  anniversary: date('anniversary', { mode: 'string' }),
  salt: varchar('salt', { length: 9 }).notNull(),
  cart: text('cart'),
  wishlist: text('wishlist'),
  newsletter: int('newsletter').notNull(),
  ip: varchar('ip', { length: 40 }).notNull(),
  status: int('status').notNull(),
  approved: int('approved').notNull(),
  user_type: varchar('user_type', { length: 255 }).notNull(),
  profile_pic: text('profile_pic').notNull(),
  cover_pic: text('cover_pic').notNull(),
  mobile_cover_pic: text('mobile_cover_pic').notNull(),
  size_chart: text('size_chart').notNull(),
  logo: text('logo').notNull(),
  url_key: varchar('url_key', { length: 200 }).notNull(),
  desc: text('desc').notNull(),
  remember_token: varchar('remember_token', { length: 255 }).notNull(),
  loyalty_group: int('loyalty_group').notNull(),
  cashback: float('cashback').notNull(),
  tss_money: float('tss_money').notNull(),
  tss_points: float('tss_points').notNull(),
  referal_code: varchar('referal_code', { length: 20 }).notNull(),
  platform: varchar('platform', { length: 20 }).notNull(),
  user_platform: varchar('user_platform', { length: 255 }).notNull(),
  pos_admin_id: bigint('pos_admin_id', { mode: 'bigint' }).notNull(),
  fb_id: varchar('fb_id', { length: 20 }).notNull(),
  plus_id: varchar('plus_id', { length: 20 }).notNull(),
  apple_id: varchar('apple_id', { length: 20 }).notNull(),
  sort_order: bigint('sort_order', { mode: 'bigint' }).notNull(),
  es_search_order: int('es_search_order').notNull(),
  is_merch: int('is_merch').notNull(),
  meta_title: text('meta_title').notNull(),
  meta_keys: text('meta_keys').notNull(),
  meta_desc: text('meta_desc').notNull(),
  art_bank_details: text('art_bank_details').notNull(),
  art_status: int('art_status').notNull(),
  is_featured: int('is_featured').notNull(),
  es_search_keywords: text('es_search_keywords').notNull(),
  og_title: text('og_title').notNull(),
  og_description: text('og_description').notNull(),
  twitter_title: text('twitter_title').notNull(),
  twitter_description: text('twitter_description').notNull(),
  breadcrum_title: text('breadcrum_title').notNull(),
  breadcrum_name: text('breadcrum_name').notNull(),
  popular_search: text('popular_search').notNull(),
  shop_now: text('shop_now').notNull(),
  is_from_megento: int('is_from_megento').notNull(),
  is_cod_enable: int('is_cod_enable').notNull(),
  is_two_fa: int('is_two_fa').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
  customer_type: varchar('customer_type', { length: 50 }).notNull(),
  gstin: varchar('gstin', { length: 50 }).notNull(),
  order_gender: varchar('order_gender', { length: 50 }).notNull(),
  artist_alias_name: varchar('artist_alias_name', { length: 255 }).notNull(),
  is_block: smallint('is_block'),
  is_disabled: smallint('is_disabled'),
});

export const PaymentStatus = mysqlTable('payment_status', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  payment_status: varchar('payment_status', { length: 255 }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const PaymentMethod = mysqlTable('payment_method', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  name: varchar('name', { length: 255 }),
  image: varchar('image', { length: 255 }).notNull(),
  value: varchar('value', { length: 255 }).notNull(),
  status: int('status').notNull(),
  payment_discount: int('payment_discount').notNull(),
  payment_discount_type: int('payment_discount_type').notNull(),
  sort_order: int('sort_order').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const OrderStatus = mysqlTable('order_status', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_status: varchar('order_status', { length: 255 }).notNull(),
  display_name: varchar('display_name', { length: 255 }).notNull(),
  cat: int('cat').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const OrderFlag = mysqlTable('flags', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  flag_name: varchar('flag_name', { length: 255 }).notNull(),
  flag_value: varchar('flag_value', { length: 255 }).notNull(),
  desc: text('desc'),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const Courier = mysqlTable('courier_companies', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  domain: varchar('domain', { length: 100 }).notNull(),
  tracking_url: varchar('tracking_url', { length: 100 }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const Order = mysqlTable('orders', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_ref_no: varchar('order_ref_no', { length: 255 }).notNull(),
  user: bigint('user_id', { mode: 'bigint' }).notNull(),
  order_amt: double('order_amt').notNull(),
  pay_amt: double('pay_amt').notNull(),
  cod_charges: int('cod_charges').notNull(),
  hl_charges: int('hl_charges').notNull(),
  gifting_charges: int('gifting_charges').notNull(),
  payment_methods: bigint('payment_method', { mode: 'bigint' }),
  payment_statuses: bigint('payment_status', { mode: 'bigint' }),
  payment_id: int('payment_id').notNull(),
  transaction_id: varchar('transaction_id', { length: 255 }).notNull(),
  transaction_status: text('transaction_status').notNull(),
  description: text('description').notNull(),
  tss_money_used: float('tss_money_used').notNull(),
  tss_points_used: float('tss_points_used').notNull(),
  tss_points_earned: float('tss_points_earned').notNull(),
  tss_points_credited: int('tss_points_credited').notNull(),
  reward_points_cron: varchar('reward_points_cron', { length: 1 }).notNull(),
  voucher_used: bigint('voucher_used', { mode: 'bigint' }).notNull(),
  coupon_used: bigint('coupon_used', { mode: 'bigint' }).notNull(),
  shipping_amt: int('shipping_amt').notNull(),
  voucher_amt_used: double('voucher_amt_used'),
  coupon_amt_used: double('coupon_amt_used').notNull(),
  pg_disc: float('pg_disc').notNull(),
  pg_disc_platform: varchar('pg_disc_platform', { length: 255 }).notNull(),
  pg_disc_comment: varchar('pg_disc_comment', { length: 255 }).notNull(),
  shiplabel_tracking_id: varchar('shiplabel_tracking_id', { length: 255 }).notNull(),
  referal_code_used: varchar('referal_code_used', { length: 255 }).notNull(),
  referal_code_amt: float('referal_code_amt').notNull(),
  order_statuses: bigint('order_status', { mode: 'bigint' }),
  ship_date: datetime('ship_date', { mode: 'string' }),
  ship_flag: varchar('ship_flag', { length: 1 }).notNull(),
  order_comment: varchar('order_comment', { length: 255 }).notNull(),
  first_name: varchar('first_name', { length: 255 }).notNull(),
  last_name: varchar('last_name', { length: 255 }).notNull(),
  address1: varchar('address1', { length: 35 }).notNull(),
  address2: varchar('address2', { length: 35 }).notNull(),
  address3: varchar('address3', { length: 35 }),
  phone_no: varchar('phone_no', { length: 20 }).notNull(),
  country_id: text('country_id').notNull(),
  zone_id: text('zone_id').notNull(),
  postal_code: varchar('postal_code', { length: 20 }).notNull(),
  city: varchar('city', { length: 255 }).notNull(),
  print_invoice: int('print_invoice').notNull(),
  ref_flag: int('ref_flag').notNull(),
  user_ref_points: double('user_ref_points').notNull(),
  cart_rec_notify1: int('cart_rec_notify1').notNull(),
  cart_rec_notify2: int('cart_rec_notify2').notNull(),
  incomplete_order: int('incomplete_order').notNull(),
  flag: bigint('flag_id', { mode: 'bigint' }).notNull(),
  flag_comment: text('flag_comment').notNull(),
  courier: bigint('courier', { mode: 'bigint' }).notNull(),
  courier_service_name: varchar('courier_service_name', { length: 255 }).notNull(),
  waybill_img: text('waybill_img').notNull(),
  waybill_data: text('waybill_data'),
  intern_added: int('intern_added').notNull(),
  intern_amt: float('intern_amt').notNull(),
  ret_ex_request_date: datetime('ret_ex_request_date', { mode: 'string' }),
  is_stock_reduced: int('is_stock_reduced').notNull(),
  location_id: int('location_id'),
  location_type: varchar('location_type', { length: 255 }).notNull(),
  next_location_ids: varchar('next_location_ids', { length: 255 }).notNull(),
  is_transfer: int('is_transfer').notNull(),
  start_timeslot: datetime('start_timeslot', { mode: 'string' }),
  end_timeslot: datetime('end_timeslot', { mode: 'string' }),
  hl_parent_order_id: bigint('hl_parent_order_id', { mode: 'bigint' }).notNull(),
  parent_order_id: bigint('parent_order_id', { mode: 'bigint' }).notNull(),
  is_parent_express: smallint('is_parent_express').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
  is_split_order: int('is_split_order').notNull(),
  is_global_order: int('is_global_order').notNull(),
  store_disc_pg_comment: varchar('store_disc_pg_comment', { length: 255 }).notNull(),
  store_disc_pg_reason: varchar('store_disc_pg_reason', { length: 45 }).notNull(),
  cashback_used: float('cashback_used').notNull(),
  original_order_id: bigint('original_order_id', { mode: 'bigint' }).notNull(),
});

export const OrderPlatform = mysqlTable('order_platform', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  platform: varchar('platform', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  vinc_udf_name: varchar('vinc_udf_name', { length: 255 }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const HasProduct = mysqlTable('has_products', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order: bigint('order_id', { mode: 'bigint' }).notNull(),
  product: bigint('prod_id', { mode: 'bigint' }).notNull(),
  sub_prod_id: bigint('sub_prod_id', { mode: 'bigint' }).notNull(),
  return_status: int('return_status').notNull(),
  status: varchar('status', { length: 255 }).notNull(),
  qty: bigint('qty', { mode: 'bigint' }).notNull(),
  price: double('price').notNull(),
  return_request_date_time: datetime('return_request_date_time', { mode: 'string' }).notNull(),
  is_notified_for_return: boolean('is_notified_for_return').notNull(),
  return_mode: int('return_mode').notNull(),
  amount_refunded_mode: int('amount_refunded_mode').notNull(),
  cashback_refunded: int('cashback_refunded').notNull(),
  amount_to_be_refunded: float('amount_to_be_refunded').notNull(),
  awb: varchar('awb', { length: 255 }).notNull(),
  shipment_id: varchar('shipment_id', { length: 255 }),
  return_qty: varchar('return_qty', { length: 10 }),
  return_reason: varchar('return_reason', { length: 500 }),
  reverse_send_sms: int('reverse_send_sms').notNull(),
  reverse_send_mail: int('reverse_send_mail').notNull(),
  refund_send_mail: int('refund_send_mail').notNull(),
  refund_send_sms: int('refund_send_sms').notNull(),
  disc: float('disc').notNull(),
  disc_qty: bigint('disc_qty', { mode: 'bigint' }).notNull(),
  wallet_disc: float('wallet_disc').notNull(),
  voucher_disc: float('voucher_disc').notNull(),
  referal_disc: float('referal_disc').notNull(),
  gst: float('gst').notNull(),
  pre_gst_amt: double('pre_gst_amt'),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
  salesperson_id: int('salesperson_id').notNull(),
  gift_voucher_id: int('gift_voucher_id').notNull(),
  order_platform: bigint('order_platform_id', { mode: 'bigint' }).notNull(),
});

export const OrderStore = mysqlTable('order_stores', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order: bigint('order_id', { mode: 'bigint' }).notNull(),
  store: bigint('store_id', { mode: 'bigint' }).notNull(),
  counter: bigint('counter_id', { mode: 'bigint' }).notNull(),
  is_manually_paid: boolean('is_manually_paid').notNull(),
  transaction_id: varchar('transaction_id', { length: 255 }).notNull(),
  message: varchar('message', { length: 255 }).notNull(),
  performance_json: varchar('performance_json', { length: 255 }).notNull(),
  offline_payment: decimal('offline_payment', { precision: 12, scale: 2 }).notNull(),
  offline_payment_recieved: decimal('offline_payment_recieved', {
    precision: 12,
    scale: 2,
  }).notNull(),
  online_payment: decimal('online_payment', { precision: 12, scale: 2 }).notNull(),
  online_other_payment: decimal('online_other_payment', { precision: 12, scale: 2 }).notNull(),
  is_offline_order: boolean('is_offline_order').notNull(),
  is_shopify_order: boolean('is_shopify_order').notNull(),
  district_transaction_id: varchar('district_transaction_id', { length: 255 }).notNull(),
  credit_pincode_id: varchar('credit_pincode_id', { length: 255 }).notNull(),
  order_invoice: varchar('order_invoice', { length: 255 }).notNull(),
});

export const ExclusiveUser = mysqlTable('user_eav', {
  entity: varchar('entity', { length: 254 }).primaryKey().notNull(),
  attribute: varchar('attribute', { length: 100 }).notNull(),
  value: text('value').notNull(),
  is_active: int('is_active').notNull(),
});

export const Comments = mysqlTable('comments', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
  status_id: bigint('status_id', { mode: 'bigint' }).notNull(),
  comment: text('comment').notNull(),
  notify: int('notify').notNull(),
  user_id: bigint('user_id', { mode: 'bigint' }).notNull(),
  package_details: text('package_details').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
  has_product_id: bigint('has_product_id', { mode: 'bigint' }).notNull(),
  prod_id: bigint('prod_id', { mode: 'bigint' }).notNull(),
});

export const ReversePickupReason = mysqlTable('reverse_pickup_reason', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  reason: varchar('reason', { length: 50 }).notNull(),
  type: int('type').notNull(),
});

export const SubReason = mysqlTable('sub_reasons', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  reason: int('reason').notNull(),
  sub_reason: varchar('sub_reason', { length: 100 }).notNull(),
  cat_id: varchar('cat_id', { length: 255 }).notNull(),
});

export const ReturnOrder = mysqlTable('return_orders', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_status: int('order_status').notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
  prod_id: bigint('prod_id', { mode: 'bigint' }).notNull(),
  sub_prod_id: bigint('sub_prod_id', { mode: 'bigint' }).notNull(),
  qty: int('qty').notNull(),
  received: int('received').notNull(),
  reason_id: int('reason_id').notNull(),
  sub_reason_id: int('sub_reason_id').notNull(),
  store_id: int('store_id').notNull(),
  other_reason: varchar('other_reason', { length: 100 }).notNull(),
  comment: varchar('comment', { length: 100 }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
  has_product_id: bigint('has_product_id', { mode: 'bigint' }).notNull(),
  credit_note_no: varchar('credit_note_no', { length: 255 }).notNull(),
});

export const AmountToBeRefundedLog = mysqlTable('amount_to_be_refunded_log', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
  prod_id: bigint('prod_id', { mode: 'bigint' }).notNull(),
  tss_point_used: float('tss_point_used').notNull(),
  tss_money_used: float('tss_money_used').notNull(),
  gift_voucher_amount: float('gift_voucher_amount').notNull(),
  coupon_amt_used: float('coupon_amt_used').notNull(),
  amount_to_be_refunded: float('amount_to_be_refunded').notNull(),
  comment: varchar('comment', { length: 127 }).notNull(),
  is_refunded: boolean('is_refunded').notNull(),
  refunded_amt: float('refunded_amt').notNull(),
  refund_mode: varchar('refund_mode', { length: 255 }),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
  has_product_id: bigint('has_product_id', { mode: 'bigint' }).notNull(),
});

export const HasCategories = mysqlTable('has_categories', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  cat_id: bigint('cat_id', { mode: 'bigint' }).notNull(),
  prod_id: bigint('prod_id', { mode: 'bigint' }).notNull(),
});

export const OrderAddon = mysqlTable('order_addons', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
  shipped_location: varchar('shipped_location', { length: 55 }).notNull(),
  is_nps_mail_sent: int('is_nps_mail_sent'),
  is_nps_notification_checked: int('is_nps_notification_checked'),
  order_success_timestamp: datetime('order_success_timestamp', { mode: 'string' }).notNull(),
  order_transferred_timestamp: datetime('order_transferred_timestamp', { mode: 'string' }),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
  hl_charges_refunded: smallint('hl_charges_refunded').notNull(),
});

export const ProductRatingOption = mysqlTable('product_rating_options', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  option_name: varchar('option_name', { length: 255 }).notNull(),
  is_shown: smallint('is_shown'),
});

export const UserProductRating = mysqlTable('product_rating_user', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  user: bigint('user_id', { mode: 'bigint' }).notNull(),
  order: bigint('order_id', { mode: 'bigint' }).notNull(),
  prod: bigint('prod_id', { mode: 'bigint' }).notNull(),
  product_rating_option_id: bigint('product_rating_option_id', { mode: 'bigint' }),
  rating: float('rating'),
  platform: varchar('platform', { length: 8 }),
  comment: varchar('comment', { length: 255 }),
  is_default: smallint('is_default'),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const HyperlocalOrderLog = mysqlTable('hyperlocal_order_log', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
  borzo_id: bigint('borzo_id', { mode: 'bigint' }).notNull(),
  action: varchar('action', { length: 255 }).notNull(),
  main_location_id: int('main_location_id'),
  is_created_in_borzo: smallint('is_created_in_borzo').notNull(),
  borzo_resp: text('borzo_resp'),
  error_msg: text('error_msg'),
  rto_recieved: text('rto_recieved').notNull(),
  is_pack: smallint('is_pack').notNull(),
  is_rto: smallint('is_rto').notNull(),
  is_refunded: smallint('is_refunded').notNull(),
  delivery_exception_msg: varchar('delivery_exception_msg', { length: 255 }),
  source_tracking_url: varchar('source_tracking_url', { length: 255 }),
  destination_tracking_url: varchar('destination_tracking_url', { length: 255 }),
  pos_admin_id: int('pos_admin_id').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const HyperlocalFdLog = mysqlTable('hyperlocal_fd_logs', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }),
  platform: varchar('platform', { length: 255 }).notNull(),
  fd_ticket_id: varchar('fd_ticket_id', { length: 255 }),
  fd_ticket_status: varchar('fd_ticket_status', { length: 255 }),
  comment: varchar('comment', { length: 255 }),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const HyperlocalToOnlineOrderLog = mysqlTable('hyperlocal_to_online_order_logs', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
  new_order_id: bigint('new_order_id', { mode: 'bigint' }).notNull(),
  platform: varchar('platform', { length: 255 }).notNull(),
  location_type: varchar('location_type', { length: 255 }),
  location_id: bigint('location_id', { mode: 'bigint' }).notNull(),
  location_ids: varchar('location_ids', { length: 255 }).notNull(),
  reason: varchar('reason', { length: 255 }).notNull(),
  remark: varchar('remark', { length: 255 }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const PosExchangeLog = mysqlTable('pos_exchange_log', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: int('order_id').notNull(),
  has_prod_id: int('has_prod_id').notNull(),
  old_prod_id: int('old_prod_id').notNull(),
  old_size: varchar('old_size', { length: 50 }),
  new_prod_id: int('new_prod_id').notNull(),
  new_size: varchar('new_size', { length: 50 }),
  exchange_parent_prod_id: int('exchange_parent_prod_id').notNull(),
  store_id: int('store_id').notNull(),
  counter_id: int('counter_id'),
  staff_user_id: int('staff_user_id').notNull(),
  reason_id: int('reason_id').notNull(),
  sub_reason_id: int('sub_reason_id'),
  comment: varchar('comment', { length: 255 }),
  saleable: boolean('saleable').notNull(),
  new_order_id: int('new_order_id'),
  status: varchar('status', { length: 30 }).notNull(),
  retry_count: smallint('retry_count').notNull(),
  last_error: text('last_error'),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const VinculumAutoDeliveredLog = mysqlTable('vinculum_auto_delivered_logs', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
  product_id: bigint('product_id', { mode: 'bigint' }).notNull(),
  platform: varchar('platform', { length: 255 }),
  retries: int('retries').notNull(),
  request: text('request'),
  response: text('response'),
  status: varchar('status', { length: 255 }),
  message: varchar('message', { length: 255 }),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const ExtendApplicabilityForReturnExchange = mysqlTable(
  'extend_applicability_for_return_exchange',
  {
    id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
    order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
    prod_id: bigint('prod_id', { mode: 'bigint' }).notNull(),
    extended_date: datetime('extended_date', { mode: 'string' }).notNull(),
    created_by: bigint('created_by', { mode: 'bigint' }).notNull(),
    updated_by: bigint('updated_by', { mode: 'bigint' }).notNull(),
    is_active: boolean('is_active').notNull(),
    created_at: datetime('created_at', { mode: 'string' }).notNull(),
    updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
    has_product_id: bigint('has_product_id', { mode: 'bigint' }).notNull(),
  },
);

export const Coupon = mysqlTable('coupons', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  voucher_code: varchar('voucher_code', { length: 255 }).notNull(),
  is_employee_coupon: int('is_employee_coupon').notNull(),
});

export const PosOnlineOrder = mysqlTable('pos_online_orders', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
  store_id: bigint('store_id', { mode: 'bigint' }).notNull(),
  created_by: varchar('created_by', { length: 55 }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const HyperlocalRejectionReason = mysqlTable('hyperlocal_rejection_reasons', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  reason: varchar('reason', { length: 255 }).notNull(),
  is_active: boolean('is_active').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
});

export const ExpressLineItem = mysqlTable('express_line_item', {
  id: int('id').autoincrement().primaryKey().notNull(),
  order: bigint('order_id', { mode: 'bigint' }).notNull(),
  has_product: bigint('has_product_id', { mode: 'bigint' }).notNull(),
  pending_expires_at: datetime('pending_expires_at', { mode: 'string' }),
  store_id: int('store_id'),
  status: varchar('status', { length: 20 }),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }),
  cancellation_reason: varchar('cancellation_reason', { length: 255 }),
  accepted_expires_at: datetime('accepted_expires_at', { mode: 'string' }),
  rejection_reason_id: int('rejection_reason_id'),
  vinc_status: varchar('vinc_status', { length: 64 }).notNull(),
});

export const VincOrderStatusWebhookLog = mysqlTable('vinc_order_status_webhook_log', {
  id: int('id').autoincrement().primaryKey().notNull(),
  order_id: int('order_id').notNull(),
  product_id: int('product_id').notNull(),
  has_product_id: int('has_product_id').notNull(),
  vinc_status: varchar('vinc_status', { length: 64 }),
  transid: varchar('transid', { length: 32 }),
  reference_no: varchar('reference_no', { length: 64 }),
  tracking_number: varchar('tracking_number', { length: 64 }),
  transporter: varchar('transporter', { length: 64 }),
  created_at: datetime('created_at', { mode: 'string' }),
});

export const ExpressOrderStatusLog = mysqlTable('express_order_status_log', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  order_id: bigint('order_id', { mode: 'bigint' }).notNull(),
  store_id: int('store_id'),
  old_status: varchar('old_status', { length: 20 }).notNull(),
  new_status: varchar('new_status', { length: 20 }).notNull(),
  changed_at: datetime('changed_at', { mode: 'string' }).notNull(),
});

export const ReportExport = mysqlTable('report_exports', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  report_name: varchar('report_name', { length: 255 }).notNull(),
  report_type: varchar('report_type', { length: 255 }).notNull(),
  time_period: varchar('time_period', { length: 55 }),
  is_completed: boolean('is_completed').notNull(),
  export_status: varchar('export_status', { length: 55 }).notNull(),
  message: varchar('message', { length: 255 }).notNull(),
  export_requested_by: int('export_requested_by').notNull(),
  export_requested_at: datetime('export_requested_at', { mode: 'string' }).notNull(),
  export_completed_at: datetime('export_completed_at', { mode: 'string' }),
  export_file_url: varchar('export_file_url', { length: 255 }).notNull(),
  export_format: varchar('export_format', { length: 10 }).notNull(),
  export_size: int('export_size').notNull(),
  export_rows_count: int('export_rows_count').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const StoreDayClose = mysqlTable('store_day_close', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  store_id: int('store_id').notNull(),
  close_date: date('close_date', { mode: 'string' }).notNull(),
  version: smallint('version').notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  closed_by_id: bigint('closed_by_id', { mode: 'bigint' }).notNull(),
  closed_at: datetime('closed_at', { mode: 'string' }).notNull(),
  cash_system: decimal('cash_system', { precision: 14, scale: 2 }).notNull(),
  cash_refund_system: decimal('cash_refund_system', { precision: 14, scale: 2 }).notNull(),
  cash_actual: decimal('cash_actual', { precision: 14, scale: 2 }).notNull(),
  cash_manual_punched: decimal('cash_manual_punched', { precision: 14, scale: 2 }).notNull(),
  cash_manual_created: decimal('cash_manual_created', { precision: 14, scale: 2 }).notNull(),
  cash_difference: decimal('cash_difference', { precision: 14, scale: 2 }).notNull(),
  cash_reason: varchar('cash_reason', { length: 32 }).notNull(),
  cash_comment: varchar('cash_comment', { length: 255 }).notNull(),
  card_system: decimal('card_system', { precision: 14, scale: 2 }).notNull(),
  card_actual: decimal('card_actual', { precision: 14, scale: 2 }).notNull(),
  card_manual_punched: decimal('card_manual_punched', { precision: 14, scale: 2 }).notNull(),
  card_manual_created: decimal('card_manual_created', { precision: 14, scale: 2 }).notNull(),
  card_difference: decimal('card_difference', { precision: 14, scale: 2 }).notNull(),
  card_reason: varchar('card_reason', { length: 32 }).notNull(),
  card_comment: varchar('card_comment', { length: 255 }).notNull(),
  district_system: decimal('district_system', { precision: 14, scale: 2 }).notNull(),
  banking_amount: decimal('banking_amount', { precision: 14, scale: 2 }).notNull(),
  snap_order_count: int('snap_order_count').notNull(),
  stale_at: datetime('stale_at', { mode: 'string' }),
  stale_reason: varchar('stale_reason', { length: 64 }),
  stale_trigger_ref: varchar('stale_trigger_ref', { length: 64 }),
  last_verified_at: datetime('last_verified_at', { mode: 'string' }),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const StoreDayBanking = mysqlTable('store_day_banking', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  store_id: int('store_id').notNull(),
  banking_date: date('banking_date', { mode: 'string' }).notNull(),
  amount: decimal('amount', { precision: 14, scale: 2 }).notNull(),
  updated_by_id: bigint('updated_by_id', { mode: 'bigint' }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const StoreCashOpeningBalance = mysqlTable('store_cash_opening_balance', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  store_id: int('store_id').notNull(),
  balance_date: date('balance_date', { mode: 'string' }).notNull(),
  amount: decimal('amount', { precision: 14, scale: 2 }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const TssSetting = mysqlTable('tss_settings', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  name: varchar('name', { length: 255 }),
  platform: varchar('platform', { length: 255 }),
  value: varchar('value', { length: 255 }),
  status: boolean('status'),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const Country = mysqlTable('countries', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  iso_code_2: varchar('iso_code_2', { length: 255 }).notNull(),
  iso_code_3: varchar('iso_code_3', { length: 255 }).notNull(),
  address_format: varchar('address_format', { length: 255 }).notNull(),
  postcode_required: int('postcode_required').notNull(),
  status: int('status').notNull(),
  sec_status: int('sec_status').notNull(),
});

export const POSFranchise = mysqlTable('pos_franchise', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  name: varchar('name', { length: 255 }),
  description: varchar('description', { length: 255 }),
  cin_number: varchar('cin_number', { length: 100 }),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const Store = mysqlTable('stores', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  store_name: varchar('store_name', { length: 100 }),
  type: varchar('type', { length: 255 }).notNull(),
  category: varchar('category', { length: 255 }).notNull(),
  location_code: varchar('location_code', { length: 255 }).notNull(),
  latitude: decimal('latitude', { precision: 22, scale: 16 }),
  longitude: decimal('longitude', { precision: 22, scale: 16 }),
  email: varchar('email', { length: 55 }),
  address: text('address'),
  alt_address: text('alt_address'),
  city_id: int('city_id').notNull(),
  country_id: int('country_id').notNull(),
  phone: varchar('phone', { length: 10 }),
  url_key: varchar('url_key', { length: 255 }).notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
  is_active: boolean('is_active').notNull(),
  store_image: varchar('store_image', { length: 254 }).notNull(),
  pincode: varchar('pincode', { length: 10 }),
  per_day_threshold: int('per_day_threshold').notNull(),
  per_hour_threshold: int('per_hour_threshold').notNull(),
  ecom_delivery: int('ecom_delivery').notNull(),
  ecom_threshold: int('ecom_threshold').notNull(),
  franchise_id: int('franchise_id').notNull(),
  gstin: varchar('gstin', { length: 15 }),
  short_name: varchar('short_name', { length: 100 }),
  slack_group_url: text('slack_group_url'),
  city_name: varchar('city_name', { length: 255 }),
  state_name: varchar('state_name', { length: 255 }),
  state_id: int('state_id').notNull(),
});

export const HyperlocalLocation = mysqlTable('hyperlocal_locations', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  location_code: varchar('location_code', { length: 255 }),
  db_column_name: varchar('db_column_name', { length: 255 }),
  store_id: int('store_id').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const StoreStorage = mysqlTable('store_storages', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  store: bigint('store_id', { mode: 'bigint' }).notNull(),
  storage_name: varchar('storage_name', { length: 100 }),
  storage_type: varchar('storage_type', { length: 255 }).notNull(),
  storage_desc: varchar('storage_desc', { length: 255 }),
  is_active: boolean('is_active').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const StoreCounter = mysqlTable('store_counters', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  store: bigint('store_id', { mode: 'bigint' }).notNull(),
  counter_name: varchar('counter_name', { length: 100 }),
  counter_type: varchar('counter_type', { length: 255 }).notNull(),
  counter_desc: varchar('counter_desc', { length: 255 }),
  is_active: boolean('is_active').notNull(),
  created_at: datetime('created_at', { mode: 'string' }).notNull(),
  updated_at: datetime('updated_at', { mode: 'string' }).notNull(),
});

export const PosUser = mysqlTable('pos_user', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  username: varchar('username', { length: 150 }).notNull(),
  password: varchar('password', { length: 128 }).notNull(),
  first_name: varchar('first_name', { length: 150 }).notNull(),
  last_name: varchar('last_name', { length: 150 }).notNull(),
  is_active: boolean('is_active').notNull(),
  is_staff: boolean('is_staff').notNull(),
  is_superuser: boolean('is_superuser').notNull(),
  last_login: datetime('last_login', { mode: 'string' }),
  date_joined: datetime('date_joined', { mode: 'string' }).notNull(),
  role: smallint('role').notNull(),
  gender: varchar('gender', { length: 1 }),
  age: int('age'),
  phone: varchar('phone', { length: 10 }),
  email: varchar('email', { length: 254 }),
  is_mfa: boolean('is_mfa'),
  mfa_hash: varchar('mfa_hash', { length: 255 }),
  profile_image: varchar('profile_image', { length: 254 }).notNull(),
  cover_image: varchar('cover_image', { length: 254 }).notNull(),
  contact_email: varchar('contact_email', { length: 254 }),
  otp_method: smallint('otp_method').notNull(),
  user_type: smallint('user_type').notNull(),
});

export const UserStore = mysqlTable('user_stores', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  django_user_id: bigint('django_user_id', { mode: 'bigint' }).notNull(),
  store_id: bigint('store_id', { mode: 'bigint' }).notNull(),
});
