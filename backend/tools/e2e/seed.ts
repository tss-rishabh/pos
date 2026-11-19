import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { djangoPasswordHash } from '../../src/auth/crypto.js';
import {
  HasProduct,
  MUser,
  Order,
  OrderStatus,
  OrderStore,
  PaymentStatus,
  PosUser,
  Product,
  ProductBarcode,
  ProductStore,
  Store,
  StoreCounter,
  UserStore,
} from '../../src/db/legacy-schema.js';
import {
  createProductionTables,
  productionTableNames,
} from '../../tests/helpers/production-schema.js';

/**
 * Synthetic seed for the Playwright/e2e and container stacks (W10, replaces demo mode).
 *
 * Builds a disposable schema on a loopback MySQL from the committed production snapshot (every
 * production table, no added DDL) and fills it with synthetic rows only: example.test emails,
 * 90000000xx phones, invented store/product names. Seed rows are written through the ORM.
 */

/** The synthetic store operator the specs sign in as (id kept from the former fixtures). */
export const e2eOperator = {
  id: '900001',
  username: 'e2e-operator',
  password: 'Synthetic-e2e-password-2026',
  /** Legacy fixed login OTP for this user only (LOGIN_FIXED_OTP_*), never a production value. */
  otp: '246810',
  name: 'Synthetic operator',
  role: 4,
  storeIds: ['1', '2'],
} as const;

export const e2eStores = [
  { id: 1n, name: 'Bandra Flagship', code: 'SYN-BDR', city: 'Mumbai' },
  { id: 2n, name: 'Indiranagar', code: 'SYN-IDR', city: 'Bengaluru' },
] as const;
/** An active store the operator is NOT assigned to (store-scope checks). */
export const e2eUnassignedStore = {
  id: 3n,
  name: 'Colaba Unassigned',
  code: 'SYN-CLB',
  city: 'Mumbai',
} as const;

const productNames = [
  'Classic: Oversized T-shirt',
  'Urban: Utility Cargo',
  'Everyday: Crew Neck',
  'Signature: Denim Jacket',
  'Essential: Joggers',
  'Retro: Varsity Polo',
  'Explorer: Graphic Tee',
  'Sunday: Relaxed Shirt',
  'Street: Cargo Shorts',
  'Cloud: Cotton Hoodie',
  'Everyday: Sneakers',
  'Essential: Tote Bag',
];
export const e2eProducts = productNames.map((name, index) => ({
  id: BigInt(1001 + index),
  name,
  erp: `TSS-SYN-${index + 1}`,
  barcode: BigInt(8900000001001 + index),
  price: ['999.00', '1899.00', '799.00', '2499.00'][index % 4]!,
  stock: [24, 12, 8, 3, 0, 19][index % 6]!,
}));
/** Synthetic orders 6001-6008 at store 1, newest first in the default 5-day window. */
export const e2eOrderIds = Array.from({ length: 8 }, (_, index) => BigInt(6008 - index));
/**
 * The two oldest seeded orders are unpaid counter orders awaiting payment, as legacy leaves them
 * after ajax-order: payment method 14, payment status 1, order status 1, no recorded amounts
 * (the payable check in modules/checkout/payments/repository.ts).
 */
export const e2eUnpaidOrderIds: readonly bigint[] = [6001n, 6002n];

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** Refuses anything that is not a plain loopback MySQL URL with an owned `pos_rewrite_e2e*` schema. */
export function e2eDatabaseUrl(raw: string | undefined, schema = 'pos_rewrite_e2e'): URL {
  if (!raw) throw new Error('Set E2E_MYSQL_URL to an isolated loopback MySQL server.');
  const url = new URL(raw);
  if (url.protocol !== 'mysql:' || !loopbackHosts.has(url.hostname) || url.search || url.hash)
    throw new Error('The e2e seed only runs against a loopback MySQL server.');
  const name = url.pathname.slice(1) || schema;
  if (!/^pos_rewrite_e2e[a-z0-9_]{0,40}$/.test(name))
    throw new Error('The e2e schema name must start with pos_rewrite_e2e.');
  url.pathname = '/' + name;
  return url;
}

/** Naive business-local `YYYY-MM-DD HH:MM:SS` (legacy USE_TZ=False datetimes). */
function businessLocal(epochMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

type Session = mysql.Connection;

/** Seeds the synthetic rows into the current database of `connection`. */
export async function seedE2e(
  connection: Session,
  options: { timeZone?: string; now?: number } = {},
) {
  const timeZone = options.timeZone ?? 'Asia/Kolkata',
    now = options.now ?? Date.now(),
    stamp = businessLocal(now, timeZone),
    db = drizzle(connection);
  // Production runs with an empty sql_mode; omitted NOT NULL columns take implicit defaults.
  await connection.query("SET SESSION sql_mode = ''");
  await db.insert(Store).values(
    [...e2eStores, e2eUnassignedStore].map((store, index) => ({
      id: store.id,
      store_name: store.name,
      short_name: store.name,
      type: 'STORE' as const,
      category: 'IN_HOUSE' as const,
      location_code: store.code,
      city_name: store.city,
      latitude: '19.0760',
      longitude: '72.8777',
      address: 'Synthetic address ' + String(index + 1),
      alt_address: '',
      phone: '90000000' + String(10 + index),
      url_key: 'synthetic-store-' + String(store.id),
      gstin: '',
      is_active: true,
      ecom_delivery: 0,
      ecom_threshold: 0,
      franchise_id: 0,
      created_at: stamp,
      updated_at: stamp,
    })),
  );
  await db.insert(StoreCounter).values(
    e2eStores.map((store) => ({
      id: store.id,
      store: store.id,
      counter_name: 'Counter 01',
      counter_type: 'IN_STORE' as const,
      is_active: true,
      created_at: stamp,
      updated_at: stamp,
    })),
  );
  await db.insert(PosUser).values({
    id: BigInt(e2eOperator.id),
    username: e2eOperator.username,
    password: await djangoPasswordHash(e2eOperator.password),
    first_name: 'Synthetic',
    last_name: 'operator',
    is_active: true,
    is_staff: false,
    is_superuser: false,
    date_joined: stamp,
    role: e2eOperator.role,
    phone: '9000000001',
    email: 'operator@example.test',
    contact_email: 'operator@example.test',
    is_mfa: false,
    profile_image: '',
    cover_image: '',
    // 1 = SMS: legacy issues the login OTP only when the user has a phone.
    otp_method: 1,
    user_type: 1,
  });
  await db.insert(UserStore).values(
    e2eOperator.storeIds.map((storeId) => ({
      django_user_id: BigInt(e2eOperator.id),
      store_id: BigInt(storeId),
    })),
  );
  await db.insert(Product).values(
    e2eProducts.map((product) => ({
      id: product.id,
      product: product.name,
      erp_product: product.erp,
      short_desc: '',
      long_desc: '',
      add_desc: '',
      measurement: '',
      images: '',
      images_new: '',
      prod_type: 1n,
      attr_set: 0n,
      url_key: 'synthetic-product-' + String(product.id),
      is_avail: 1,
      is_listing: 1,
      processing: 0n,
      price: product.price,
      spl_price: '0.00',
      gst: 5,
      target_date: stamp,
      target_qty: 0n,
      parent_prod_id: 0n,
      meta_title: '',
      meta_keys: '',
      meta_desc: '',
      warehouse_code: '',
      is_del: 0,
      created_at: stamp,
      updated_at: stamp,
    })),
  );
  await db.insert(ProductStore).values(
    e2eStores.flatMap((store) =>
      e2eProducts.map((product) => ({
        product: product.id,
        store: store.id,
        stock: product.stock,
        is_avail: true,
        is_del: false,
      })),
    ),
  );
  await db.insert(ProductBarcode).values(
    e2eProducts.map((product) => ({
      product: product.id,
      gtin: product.barcode,
      created_at: stamp,
      updated_at: stamp,
    })),
  );
  await db.insert(OrderStatus).values([
    {
      id: 1n,
      order_status: 'PROCESSING',
      display_name: 'Processing',
      cat: 1,
      created_at: stamp,
      updated_at: stamp,
    },
    {
      // Production ids: legacy marks a paid store order payment_statuses=4, order_statuses=3
      // (order/views.py:1225, helpers/helpers.py:633).
      id: 3n,
      order_status: 'DELIVERED',
      display_name: 'Delivered',
      cat: 1,
      created_at: stamp,
      updated_at: stamp,
    },
  ]);
  await db
    .insert(PaymentStatus)
    .values([
      { id: 1n, payment_status: 'Pending', created_at: stamp, updated_at: stamp },
      { id: 4n, payment_status: 'Paid', created_at: stamp, updated_at: stamp },
    ]);
  const customers = [
    ['Walk-in', 'customer'],
    ['Alex', 'Morgan'],
    ['Sam', 'Taylor'],
  ] as const;
  await db.insert(MUser).values(
    customers.map(([first, last], index) => ({
      id: BigInt(700001 + index),
      firstname: first,
      lastname: last,
      company_name: '',
      email: `customer${index + 1}@example.test`,
      telephone: '90000001' + String(10 + index),
      password: '',
      plain_password: '',
      birthdate: '2000-01-01',
      gender: '',
      salt: '',
      ip: '',
      status: 1,
      approved: 1,
      user_type: 'customer',
      profile_pic: '',
      cover_pic: '',
      mobile_cover_pic: '',
      size_chart: '',
      logo: '',
      url_key: 'synthetic-customer-' + String(index + 1),
    })),
  );
  for (const [index, id] of e2eOrderIds.entries()) {
    const unpaid = e2eUnpaidOrderIds.includes(id);
    const [first, last] = customers[index % 3]!,
      product = e2eProducts[index % 3]!,
      created = businessLocal(now - (index + 1) * 1_800_000, timeZone);
    await db.insert(Order).values({
      id,
      order_ref_no: `SYN-${id}`,
      user: BigInt(700001 + (index % 3)),
      order_amt: Number(product.price),
      pay_amt: Number(product.price),
      payment_methods: unpaid ? 14n : 0n,
      payment_statuses: unpaid ? 1n : 4n,
      transaction_id: '',
      transaction_status: '',
      description: '',
      reward_points_cron: '0',
      shiplabel_tracking_id: '',
      referal_code_used: '',
      order_statuses: index === 0 || unpaid ? 1n : 3n,
      ship_date: created,
      ship_flag: '0',
      order_comment: '',
      first_name: first,
      last_name: last,
      address1: '',
      address2: '',
      phone_no: '90000001' + String(10 + (index % 3)),
      country_id: '99',
      zone_id: '',
      postal_code: '400001',
      city: 'Mumbai',
      flag_comment: '',
      courier: 0n,
      courier_service_name: '',
      waybill_img: '',
      ret_ex_request_date: created,
      location_id: 1,
      location_type: 'ST',
      parent_order_id: 0n,
      created_at: created,
      updated_at: created,
      original_order_id: 0n,
    });
    await db.insert(OrderStore).values({
      order: id,
      store: 1n,
      counter: 1n,
      is_manually_paid: false,
      transaction_id: '',
      message: '',
      performance_json: '',
      offline_payment: unpaid ? '0' : product.price,
      offline_payment_recieved: unpaid ? '0' : product.price,
      online_payment: '0',
      online_other_payment: '0',
      is_offline_order: false,
      is_shopify_order: false,
    });
    await db.insert(HasProduct).values({
      order: id,
      product: product.id,
      sub_prod_id: 0n,
      return_status: 0,
      status: index === 0 ? 'PROCESSING' : 'DELIVERED',
      qty: 1n,
      price: Number(product.price),
      is_notified_for_return: false,
      awb: '',
      shipment_id: '',
      return_qty: '',
      return_reason: '',
      gst: 5,
      pre_gst_amt: Math.round((Number(product.price) / 1.05) * 100) / 100,
      created_at: created,
      updated_at: created,
      order_platform: 0n,
    });
  }
}

/**
 * Creates (or recreates) the owned e2e schema on a loopback server with every production table,
 * then seeds it. Returns the schema URL and a `drop` callback.
 */
export async function createE2eDatabase(raw: string | undefined, timeZone = 'Asia/Kolkata') {
  const url = e2eDatabaseUrl(raw),
    schema = url.pathname.slice(1),
    admin = await mysql.createConnection({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
  try {
    await admin.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(schema));
    await admin.query('CREATE DATABASE ' + mysql.escapeId(schema));
    await admin.changeUser({ database: schema });
    await createProductionTables(admin, productionTableNames());
    await seedE2e(admin, { timeZone });
  } finally {
    await admin.end();
  }
  return {
    url: url.href,
    async drop() {
      const connection = await mysql.createConnection({
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      });
      try {
        await connection.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(schema));
      } finally {
        await connection.end();
      }
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const created = await createE2eDatabase(process.env.E2E_MYSQL_URL);
  process.stdout.write(`Seeded synthetic e2e schema ${new URL(created.url).pathname.slice(1)}\n`);
}
