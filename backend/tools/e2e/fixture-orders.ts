import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { HasProduct, Order, OrderStore } from '../../src/db/legacy-schema.js';
import { legacyHasProductDefaults, legacyOrderDefaults } from './legacy-row-defaults.js';
import { e2eDatabaseUrl, e2eProducts } from './seed.js';

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
  const part = (type: string) => parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

/**
 * Adds one new unpaid counter order at store 1, counter 1 to the schema the running e2e stack
 * seeded, shaped like the seeded unpaid orders 6001/6002 (legacy ajax-order leaves payment
 * method 14, payment status 1, order status 1 and no recorded amounts). A spec that records a
 * payment creates its own order this way, so repeating the suite on the same stack never finds
 * the order already paid. The id comes from the table's auto-increment and is returned.
 */
export async function createUnpaidCounterOrder(
  rawUrl: string | undefined,
  timeZone = 'Asia/Kolkata',
): Promise<string> {
  const url = e2eDatabaseUrl(rawUrl),
    connection = await mysql.createConnection({
      uri: url.href,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
  try {
    await connection.query("SET SESSION sql_mode = ''");
    const db = drizzle(connection),
      product = e2eProducts[0]!,
      created = businessLocal(Date.now() - 60_000, timeZone);
    return await db.transaction(async (tx) => {
      const [inserted] = await tx.insert(Order).values({
        ...legacyOrderDefaults,
        order_ref_no: '',
        user: 700001n,
        order_amt: Number(product.price),
        pay_amt: Number(product.price),
        payment_methods: 14n,
        payment_statuses: 1n,
        transaction_id: '',
        transaction_status: '',
        description: '',
        reward_points_cron: '0',
        shiplabel_tracking_id: '',
        referal_code_used: '',
        order_statuses: 1n,
        ship_date: created,
        ship_flag: '0',
        order_comment: '',
        first_name: 'Walk-in',
        last_name: 'customer',
        address1: '',
        address2: '',
        phone_no: '9000000110',
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
      const id = BigInt(inserted.insertId);
      await tx
        .update(Order)
        .set({ order_ref_no: `SYN-${id}` })
        .where(eq(Order.id, id));
      await tx.insert(OrderStore).values({
        order: id,
        store: 1n,
        counter: 1n,
        is_manually_paid: false,
        transaction_id: '',
        message: '',
        performance_json: '',
        offline_payment: '0',
        offline_payment_recieved: '0',
        online_payment: '0',
        online_other_payment: '0',
        is_offline_order: false,
        is_shopify_order: false,
      });
      await tx.insert(HasProduct).values({
        ...legacyHasProductDefaults,
        order: id,
        product: product.id,
        sub_prod_id: 0n,
        return_status: 0,
        status: 'DELIVERED',
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
      return String(id);
    });
  } finally {
    await connection.end();
  }
}
