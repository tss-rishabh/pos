import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import type mysql from 'mysql2/promise';
import {
  HasProduct,
  Order,
  OrderStore,
  Product,
  ProductBarcode,
  ProductStore,
} from '../../src/db/legacy-schema.js';
import { legacyHasProductDefaults, legacyOrderDefaults } from './legacy-row-defaults.js';

/**
 * Stateful loopback stand-in for the API-v2 cart/order endpoints and the payment-order
 * confirmation, for desktop offline-billing e2e (W17). It keeps carts in memory per customer
 * token subject and tab, and `pos/order` writes the order rows that API-v2 would write
 * (`orders`, `order_stores`, `has_products`) into the seeded synthetic schema, so the real backend
 * finalizer assigns a real invoice number. Synthetic data only; it never talks to a live service.
 *
 * `orderMode = 'uncertain'` makes the next `pos/order` create the order and then answer a 200
 * without the order keys (legacy KeyError), which the backend treats as an unknown outcome.
 * Recorded calls hold the path only.
 */
interface CartLine {
  prod_id: number;
  quantity: number;
  prod_type: number;
  price: number;
  product: string;
}
type OrderMode = 'normal' | 'uncertain';

function decodeSubject(token: string | undefined): string {
  const raw = (token ?? '').split('.')[1];
  if (!raw) return 'anonymous';
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && 'sub' in parsed
      ? String((parsed as { sub: unknown }).sub)
      : 'anonymous';
  } catch {
    return 'anonymous';
  }
}
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return record(JSON.parse(text));
  } catch {
    return {};
  }
}
function respond(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
}
function localStamp(epochMs: number, timeZone: string) {
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

export async function startOrderApiFake(connection: mysql.Connection, timeZone = 'Asia/Kolkata') {
  const db = drizzle(connection);
  const carts = new Map<string, CartLine[]>();
  const calls: string[] = [];
  let orderMode: OrderMode = 'normal';
  const cartOf = (key: string) => carts.get(key) ?? [];
  const view = (lines: CartLine[]) => {
    const gross = lines.reduce(
      (sum, line) => sum + Math.round(line.price * 100) * line.quantity,
      0,
    );
    return {
      products: { items: lines.map((line) => ({ ...line })) },
      giftvouchers: { items: [] },
      complementary_products: { items: [] },
      meta: { items: [{ name: 'calculations', total: Math.floor(gross / 100) }] },
    };
  };
  async function stockOf(storeId: number, productId: number) {
    const [row] = await db
      .select({ stock: ProductStore.stock })
      .from(ProductStore)
      .where(
        and(eq(ProductStore.store, BigInt(storeId)), eq(ProductStore.product, BigInt(productId))),
      )
      .limit(1);
    return Number(row?.stock ?? 0);
  }
  async function handle(path: string, payload: Record<string, unknown>, token: string | undefined) {
    const storeId = Number(payload.store_id ?? 0),
      key = `${decodeSubject(token)}:${String(payload.tab_id ?? 'customer')}`,
      operation = record(payload.payload),
      lines = cartOf(key);
    if (path === 'validatecheckout') return { status: 200, body: { valid: true } };
    if (path === 'pos/product') {
      const [product] = await db
        .select({
          id: Product.id,
          name: Product.product,
          price: Product.price,
          type: Product.prod_type,
        })
        .from(ProductBarcode)
        .innerJoin(Product, eq(Product.id, ProductBarcode.product))
        .where(eq(ProductBarcode.gtin, BigInt(String(payload.barcode ?? '0'))))
        .limit(1);
      if (!product) return { status: 422, body: { title: 'Product not found.' } };
      const id = Number(product.id),
        existing = lines.find((line) => line.prod_id === id),
        wanted = (existing?.quantity ?? 0) + 1;
      if ((await stockOf(storeId, id)) < wanted)
        return { status: 422, body: { title: 'This product is out of stock in this store.' } };
      const next = existing
        ? lines.map((line) => (line === existing ? { ...line, quantity: wanted } : line))
        : [
            ...lines,
            {
              prod_id: id,
              quantity: 1,
              prod_type: Number(product.type),
              price: Number(product.price),
              product: product.name,
            },
          ];
      carts.set(key, next);
      return { status: 200, body: view(next) };
    }
    if (path === 'pos/cart' || path === 'cart') {
      const data = record(operation.data);
      if (operation.operation === 'set') {
        const id = Number(data.prod_id),
          quantity = Number(data.quantity);
        if ((await stockOf(storeId, id)) < quantity)
          return {
            status: 422,
            body: { title: 'Requested quantity is not available in this store.' },
          };
        carts.set(
          key,
          lines.map((line) => (line.prod_id === id ? { ...line, quantity } : line)),
        );
      } else if (operation.operation === 'delete')
        carts.set(
          key,
          lines.filter((line) => line.prod_id !== Number(data.prod_id)),
        );
      else if (operation.operation === 'clear') carts.set(key, []);
      return { status: 200, body: view(cartOf(key)) };
    }
    if (path === 'processorder') return { status: 200, body: view(lines) };
    if (path === 'pos/order') {
      if (!lines.length) return { status: 422, body: { title: 'The cart is empty.' } };
      const now = Date.now(),
        stamp = localStamp(now, timeZone),
        payable = view(lines).meta.items[0]!.total;
      const [inserted] = await db.insert(Order).values({
        ...legacyOrderDefaults,
        order_ref_no: '',
        user: BigInt(String(payload.admin_user_id ?? '0')),
        order_amt: payable,
        pay_amt: payable,
        // API-v2 creates a POS "coc" order as method 14, payment status 1 (pending).
        payment_methods: 14n,
        payment_statuses: 1n,
        transaction_id: '',
        transaction_status: '',
        description: '',
        reward_points_cron: '0',
        shiplabel_tracking_id: '',
        referal_code_used: '',
        order_statuses: 1n,
        ship_date: stamp,
        ship_flag: '0',
        order_comment: '',
        first_name: 'Synthetic',
        last_name: 'walk-in',
        address1: '',
        address2: '',
        phone_no: '9000000199',
        country_id: '99',
        zone_id: '',
        postal_code: '400001',
        city: 'Mumbai',
        flag_comment: '',
        courier: 0n,
        courier_service_name: '',
        waybill_img: '',
        ret_ex_request_date: stamp,
        location_id: storeId,
        location_type: 'ST',
        parent_order_id: 0n,
        created_at: stamp,
        updated_at: stamp,
        original_order_id: 0n,
      });
      const orderId = BigInt(inserted.insertId);
      // API-v2 owns the order reference (shipment/finance tracking number).
      await db
        .update(Order)
        .set({ order_ref_no: `API2-${orderId}` })
        .where(eq(Order.id, orderId));
      await db.insert(OrderStore).values({
        order: orderId,
        store: BigInt(storeId),
        counter: BigInt(String(payload.counter_id ?? '0')),
        // API-v2 writes the payload's master salesperson, else 0 (OrderController.py:10901).
        salesperson: BigInt(String(payload.salesperson_id || '0')),
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
      for (const line of lines) {
        await db.insert(HasProduct).values({
          ...legacyHasProductDefaults,
          order: orderId,
          product: BigInt(line.prod_id),
          sub_prod_id: 0n,
          return_status: 0,
          status: 'PROCESSING',
          qty: BigInt(line.quantity),
          price: line.price,
          is_notified_for_return: false,
          awb: '',
          shipment_id: '',
          return_qty: '',
          return_reason: '',
          gst: 5,
          pre_gst_amt: Math.round((line.price / 1.05) * 100) / 100,
          created_at: stamp,
          updated_at: stamp,
          order_platform: 0n,
        });
        await db
          .update(ProductStore)
          .set({ stock: (await stockOf(storeId, line.prod_id)) - line.quantity })
          .where(
            and(
              eq(ProductStore.store, BigInt(storeId)),
              eq(ProductStore.product, BigInt(line.prod_id)),
            ),
          );
      }
      carts.set(key, []);
      if (orderMode === 'uncertain') {
        orderMode = 'normal';
        // Legacy: a 200 without the order keys; the order exists but the caller cannot know it.
        return { status: 200, body: { status: 'success' } };
      }
      return {
        status: 200,
        body: { order: Number(orderId), method: 'coc', isValid: true, name: 'Synthetic walk-in' },
      };
    }
    return { status: 200, body: view(lines) };
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/__calls') return respond(response, 200, { calls });
      if (url.pathname === '/__mode' && request.method === 'POST') {
        const body = await readJson(request);
        orderMode = body.order === 'uncertain' ? 'uncertain' : 'normal';
        return respond(response, 200, { orderMode });
      }
      const body = await readJson(request);
      if (url.pathname === '/payment-order') {
        calls.push('payment-order');
        return respond(response, 200, { status: 'success' });
      }
      const path = url.pathname.replace(/^\/api-v2\//, '');
      calls.push(path);
      try {
        const result = await handle(path, body, request.headers.authorization);
        respond(response, result.status, result.body);
      } catch {
        respond(response, 500, { title: 'Synthetic API-v2 failure.' });
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    apiBase: `${origin}/api-v2/`,
    paymentOrderUrl: `${origin}/payment-order`,
    calls,
    setOrderMode(mode: OrderMode) {
      orderMode = mode;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
