import { pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/mysql2';
import { inArray } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import {
  ExpressLineItem,
  HasProduct,
  Order,
  OrderStore,
  PosOnlineOrder,
  PosTerminalTransaction,
} from '../../src/db/legacy-schema.js';
import { e2eDatabaseUrl } from './seed.js';

/**
 * Synthetic fixtures for the verify-project browser harnesses (frontend/tests/harness), added to
 * the schema the e2e stack has just seeded. Rows are written through the ORM into existing
 * production tables only; ids 6101-6299 never collide with the stack seed (6001-6008).
 *
 * `orders`: order-search and order-history scenarios (every order type, split payment label,
 * legacy reverse-join multiplicity, an order outside the default five-day window).
 * `reports`: today's India store/online orders and two that the legacy report must exclude.
 *
 * Prints a JSON manifest that the harness turns into independent expectations.
 */
export type HarnessFixtureSet = 'orders' | 'reports';

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
  const part = (type: string) => parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

interface FixtureOrder {
  id: bigint;
  reference: string;
  customer: bigint;
  amount: number;
  created: string;
  method: bigint;
  payment: bigint;
  status: bigint;
  country: string;
  locationId: number | null;
  locationType: string;
  line: { product: bigint; qty: bigint; price: number; status: 'DELIVERED' | 'CANCELLED' };
  stores: { store: bigint; counter: bigint; cash: string; other: string }[];
}

const database = (connection: mysql.Connection) => drizzle(connection);
async function insertOrder(db: ReturnType<typeof database>, order: FixtureOrder) {
  await db.insert(Order).values({
    id: order.id,
    order_ref_no: order.reference,
    user: order.customer,
    order_amt: order.amount,
    pay_amt: order.amount,
    payment_methods: order.method,
    payment_statuses: order.payment,
    transaction_id: '',
    transaction_status: '',
    description: '',
    reward_points_cron: '0',
    shiplabel_tracking_id: '',
    referal_code_used: '',
    order_statuses: order.status,
    ship_date: order.created,
    ship_flag: '0',
    order_comment: '',
    first_name: 'Synthetic',
    last_name: 'customer',
    address1: '',
    address2: '',
    phone_no: '9000000199',
    country_id: order.country,
    zone_id: '',
    postal_code: '400001',
    city: 'Mumbai',
    flag_comment: '',
    courier: 0n,
    courier_service_name: '',
    waybill_img: '',
    ret_ex_request_date: order.created,
    location_id: order.locationId,
    location_type: order.locationType,
    parent_order_id: 0n,
    created_at: order.created,
    updated_at: order.created,
    original_order_id: 0n,
    is_global_order: 0,
  });
  for (const store of order.stores)
    await db.insert(OrderStore).values({
      order: order.id,
      store: store.store,
      counter: store.counter,
      is_manually_paid: false,
      transaction_id: '',
      message: '',
      performance_json: '',
      offline_payment: store.cash,
      offline_payment_recieved: store.cash,
      online_payment: '0',
      online_other_payment: store.other,
      is_offline_order: false,
      is_shopify_order: false,
    });
  await db.insert(HasProduct).values({
    order: order.id,
    product: order.line.product,
    sub_prod_id: 0n,
    return_status: 0,
    status: order.line.status,
    qty: order.line.qty,
    price: order.line.price,
    is_notified_for_return: false,
    awb: '',
    shipment_id: '',
    return_qty: '',
    return_reason: '',
    gst: 5,
    pre_gst_amt: Math.round((order.line.price / 1.05) * 100) / 100,
    created_at: order.created,
    updated_at: order.created,
    order_platform: 0n,
  });
}

const base = {
  customer: 700002n,
  method: 0n,
  payment: 4n,
  status: 3n,
  country: '99',
  locationId: 1,
  locationType: 'ST',
} as const;

export async function seedHarnessFixtures(
  connection: mysql.Connection,
  set: HarnessFixtureSet,
  options: { now?: number; timeZone?: string } = {},
) {
  const now = options.now ?? Date.now(),
    timeZone = options.timeZone ?? 'Asia/Kolkata',
    at = (offsetMs: number) => businessLocal(now - offsetMs, timeZone),
    db = database(connection);
  await connection.query("SET SESSION sql_mode = ''");
  const existing = await db
    .select({ id: Order.id })
    .from(Order)
    .where(inArray(Order.id, [6101n, 6201n]));
  if (existing.length) throw new Error('Harness fixtures were already applied to this schema.');
  const line = (product: bigint, qty: bigint, price: number) => ({
    product,
    qty,
    price,
    status: 'DELIVERED' as const,
  });
  if (set === 'orders') {
    const orders: FixtureOrder[] = [
      {
        // Online (N): no order_store and no location.
        ...base,
        id: 6101n,
        reference: 'SYN-6101-ONLINE',
        amount: 1499,
        created: at(60 * 60_000),
        method: 14n,
        payment: 1n,
        status: 1n,
        locationId: null,
        locationType: '',
        line: line(1004n, 1n, 1499),
        stores: [],
      },
      {
        // Local delivery (HL) for the checked-in store, still in its queue (status 1, SW 1).
        ...base,
        id: 6102n,
        reference: 'SYN-6102-LOCAL',
        amount: 799,
        created: at(2 * 60 * 60_000),
        method: 14n,
        payment: 1n,
        status: 1n,
        locationId: 1,
        locationType: 'SW',
        line: line(1003n, 1n, 799),
        stores: [],
      },
      {
        // Express (HE) fulfilled by store 2.
        ...base,
        id: 6103n,
        reference: 'SYN-6103-EXPRESS',
        amount: 2499,
        created: at(3 * 60 * 60_000),
        locationId: 2,
        locationType: 'SW',
        line: line(1006n, 1n, 2499),
        stores: [],
      },
      {
        // Store order paid cash + Online (Other) with a completed UPI terminal payment.
        ...base,
        id: 6104n,
        reference: 'SYN-6104-SPLIT',
        customer: 700003n,
        amount: 999,
        created: at(90 * 60_000),
        method: 14n,
        line: line(1001n, 1n, 999),
        stores: [{ store: 1n, counter: 1n, cash: '500', other: '499' }],
      },
      {
        // Two order_store rows (stores 1 and 2): the legacy double reverse join multiplies rows.
        ...base,
        id: 6105n,
        reference: 'SYN-6105-SHARED',
        amount: 1899,
        created: at(150 * 60_000),
        line: line(1002n, 1n, 1899),
        stores: [
          { store: 1n, counter: 1n, cash: '1899', other: '0' },
          { store: 2n, counter: 2n, cash: '0', other: '0' },
        ],
      },
      {
        // Ten days old: outside the default five-day window, reachable by explicit dates/link.
        ...base,
        id: 6106n,
        reference: 'SYN-6106-HISTORY',
        customer: 700003n,
        amount: 2499,
        created: at(10 * 86_400_000),
        line: line(1004n, 1n, 2499),
        stores: [{ store: 1n, counter: 1n, cash: '2499', other: '0' }],
      },
    ];
    for (const order of orders) await insertOrder(db, order);
    await db.insert(ExpressLineItem).values({
      order: 6103n,
      store_id: 2,
      status: 'ACCEPTED',
      created_at: orders[2]!.created,
      updated_at: orders[2]!.created,
      vinc_status: '',
    });
    await db.insert(PosTerminalTransaction).values({
      order_id: 6104n,
      store_id: 1n,
      transaction_id: 'SYN-TERMINAL-6104',
      plutus_id: 'SYN-PLUTUS-6104',
      store_pos_code: 'SYN',
      amount: '0',
      cash_amount: '0',
      cash_recieved: '0',
      total_amount: '0',
      payment_mode: 10,
      pos_admin_id: 900001n,
      imei: '',
      platform: 'txn_completed',
      api_response: '',
      is_active: true,
      created_at: orders[3]!.created,
      updated_at: orders[3]!.created,
    });
    return {
      set,
      orders: orders.map((order) => ({
        id: String(order.id),
        reference: order.reference,
        amount: order.amount,
        created: order.created,
        stores: order.stores.map((store) => String(store.store)),
      })),
    };
  }
  // Today's business date is taken from one instant so every row agrees with the manifest.
  const created = at(5_000),
    today = created.slice(0, 10),
    yesterday = businessLocal(Date.parse(today + 'T12:00:00Z') - 86_400_000, 'UTC').slice(0, 10);
  const india = { ...base, country: 'India' };
  const orders: FixtureOrder[] = [
    {
      ...india,
      id: 6201n,
      reference: 'SYN-6201-REPORT',
      amount: 2100,
      created,
      line: line(1001n, 2n, 2100),
      stores: [{ store: 1n, counter: 1n, cash: '2100', other: '0' }],
    },
    {
      ...india,
      id: 6202n,
      reference: 'SYN-6202-REPORT',
      amount: 1050,
      created,
      line: line(1002n, 1n, 1050),
      stores: [{ store: 1n, counter: 1n, cash: '0', other: '0' }],
    },
    {
      ...india,
      id: 6203n,
      reference: 'SYN-6203-REPORT',
      amount: 525,
      created,
      line: line(1003n, 1n, 525),
      stores: [{ store: 2n, counter: 2n, cash: '525', other: '0' }],
    },
    {
      // Online order attributed to store 2 through pos_online_orders.
      ...india,
      id: 6204n,
      reference: 'SYN-6204-REPORT',
      amount: 840,
      created,
      locationId: null,
      locationType: '',
      line: line(1004n, 1n, 840),
      stores: [],
    },
    {
      // Excluded: yesterday.
      ...india,
      id: 6205n,
      reference: 'SYN-6205-REPORT',
      amount: 4200,
      created: yesterday + ' 12:00:00',
      line: line(1001n, 4n, 4200),
      stores: [{ store: 1n, counter: 1n, cash: '4200', other: '0' }],
    },
    {
      // Excluded: cancelled line status.
      ...india,
      id: 6206n,
      reference: 'SYN-6206-REPORT',
      amount: 3150,
      created,
      line: { ...line(1002n, 3n, 3150), status: 'CANCELLED' },
      stores: [{ store: 2n, counter: 2n, cash: '3150', other: '0' }],
    },
  ];
  for (const order of orders) await insertOrder(db, order);
  await db.insert(PosOnlineOrder).values({
    order_id: 6204n,
    store_id: 2n,
    created_by: 'synthetic',
    created_at: created,
    updated_at: created,
  });
  return {
    set,
    today,
    orders: orders.map((order) => ({
      id: String(order.id),
      reference: order.reference,
      amount: order.amount,
      created: order.created,
      stores: order.stores.map((store) => String(store.store)),
    })),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const set = process.argv[2];
  if (set !== 'orders' && set !== 'reports')
    throw new Error('Select the orders or reports harness fixtures.');
  const url = e2eDatabaseUrl(process.env.E2E_MYSQL_URL);
  const connection = await mysql.createConnection({
    uri: url.href,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  try {
    const manifest = await seedHarnessFixtures(connection, set);
    process.stdout.write(JSON.stringify(manifest) + '\n');
  } finally {
    await connection.end();
  }
}
