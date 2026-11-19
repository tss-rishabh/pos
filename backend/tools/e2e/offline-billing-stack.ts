import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { createConnection, createServer, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import {
  Comments,
  MUser,
  Order,
  OrderStore,
  PosTerminalPaymentModes,
  PosTerminalTransaction,
  SalesPerson,
  StoreSalesPerson,
} from '../../src/db/legacy-schema.js';
import { privateRedisFixture } from '../../tests/helpers/private-redis.js';
import { startFakeAdapters } from './fakes.js';
import { startOrderApiFake } from './order-api.js';
import { createE2eDatabase, e2eOperator, e2eDatabaseUrl } from './seed.js';

/**
 * Desktop offline-billing e2e stack (W17). Same real pieces as `stack.ts` (seeded loopback MySQL
 * from the production snapshot, private redis-server, the real backend) plus:
 *   - a stateful API-v2 cart/order stand-in (`order-api.ts`) so sync creates real order rows;
 *   - TCP gates in front of the web origin (4173 -> vite preview on 4174) and the backend (4410,
 *     which vite proxies to -> 4411), so a test can cut and restore the device's network;
 *   - a loopback control API (E2E_CONTROL_PORT, default 4499) to toggle the gate, restart the
 *     backend with other offline limits (MySQL and Redis keep their state), switch the order
 *     stand-in to an uncertain outcome and read back the synced rows.
 * Synthetic data only; SIGTERM stops everything and drops the schema.
 */
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publicPort = Number(process.env.E2E_BACKEND_PORT ?? '4410'),
  privatePort = Number(process.env.E2E_BACKEND_PRIVATE_PORT ?? '4411'),
  controlPort = Number(process.env.E2E_CONTROL_PORT ?? '4499'),
  webPort = Number(process.env.E2E_WEB_PORT ?? '4173'),
  webPrivatePort = Number(process.env.E2E_WEB_PRIVATE_PORT ?? '4174'),
  webOrigin = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:4173',
  timeZone = 'Asia/Kolkata';
const log = (message: string) => process.stdout.write(`[offline-e2e-stack] ${message}\n`);
const cleanups: (() => Promise<void>)[] = [];
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => log('cleanup step failed'));
  process.exit(code);
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
  process.on(signal, () => void stop(0));

function json(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(text);
}

try {
  const url = e2eDatabaseUrl(process.env.E2E_MYSQL_URL, 'pos_rewrite_e2e_offline');
  if (url.pathname === '/pos_rewrite_e2e') url.pathname = '/pos_rewrite_e2e_offline';
  const database = await createE2eDatabase(url.href, timeZone);
  cleanups.push(() => database.drop());
  const connection = await mysql.createConnection({
    uri: database.url,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  cleanups.push(() => connection.end());
  await connection.query("SET SESSION sql_mode = ''");
  const db = drizzle(connection);
  // The operator's checkout account (legacy user_type 8 linked by pos_admin_id).
  await db.insert(MUser).values({
    id: 700100n,
    firstname: 'Synthetic',
    lastname: 'operator account',
    company_name: '',
    email: 'operator-account@example.test',
    telephone: '9000000150',
    password: '',
    plain_password: '',
    birthdate: '2000-01-01',
    gender: '',
    salt: '',
    ip: '',
    status: 1,
    approved: 1,
    user_type: '8',
    pos_admin_id: BigInt(e2eOperator.id),
    profile_pic: '',
    cover_pic: '',
    mobile_cover_pic: '',
    size_chart: '',
    logo: '',
    url_key: 'synthetic-operator-account',
  });
  // Active synthetic salespeople for both stores (legacy requires one on every order).
  const seededAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await db.insert(SalesPerson).values(
    [
      [810001n, 'SYN-SP-1', 'Riya', 'Synthetic'],
      [810002n, 'SYN-SP-2', 'Kabir', 'Synthetic'],
    ].map(([id, employee, first, last]) => ({
      id: id as bigint,
      employee_id: employee as string,
      first_name: first as string,
      last_name: last as string,
      email: '',
      phone: '',
      is_active: 1,
      user_type: 1,
      created_at: seededAt,
      updated_at: seededAt,
    })),
  );
  await db
    .insert(StoreSalesPerson)
    .values(
      [1n, 2n].flatMap((store) =>
        [810001n, 810002n].map((salesperson) => ({ salesperson, store, is_active: 1 })),
      ),
    );
  // Payment completion reads order status 3 (legacy Helpers.complete_order), which the shared
  // e2e seed provides, and an active operator-recorded "Others" terminal mode (1001) for
  // card/UPI references.
  await db
    .insert(PosTerminalPaymentModes)
    .values({ name: 'Others', mode_id: 1001, is_active: 1, platform: 'OTHERS' });
  log(`seeded ${new URL(database.url).pathname.slice(1)}`);
  const redis = await privateRedisFixture();
  cleanups.push(() => redis.close());
  const fakes = await startFakeAdapters();
  cleanups.push(() => fakes.close());
  const orders = await startOrderApiFake(connection, timeZone);
  cleanups.push(() => orders.close());

  const sessionSecret = randomBytes(32).toString('base64'),
    hs256 = randomBytes(32).toString('hex'),
    hs512 = randomBytes(32).toString('hex');
  function environment(overrides: Record<string, string>): NodeJS.ProcessEnv {
    const value: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      TZ: process.env.TZ ?? 'UTC',
      HOST: '127.0.0.1',
      PORT: String(privatePort),
      WEB_ORIGIN: webOrigin,
      SESSION_SECRET: sessionSecret,
      BUSINESS_TIMEZONE: timeZone,
      MYSQL_WRITER_URL: database.url,
      MYSQL_PRIMARY_READER_URL: database.url,
      MYSQL_DATA_READER_URL: database.url,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      REDIS_URL: redis.url,
      DAY_CLOSE_ENABLED_STORE_IDS: '0',
      LOGIN_OTP_DELIVERY: 'sandbox',
      LOGIN_FIXED_OTP_ENABLED: '1',
      LOGIN_FIXED_OTP: e2eOperator.otp,
      LOGIN_FIXED_OTP_USER_IDS: e2eOperator.id,
      TSS_API_BASE_URL: orders.apiBase,
      TSS_PAYMENT_ORDER_URL: orders.paymentOrderUrl,
      TSS_JWT_HS256_KEY: hs256,
      TSS_JWT_HS512_KEY: hs512,
      TSS_PINELABS_BASE_URL: fakes.url('payments') + 'pinelabs/',
      TSS_PAYTM_BASE_URL: fakes.url('payments') + 'paytm/',
      ...overrides,
    };
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT'])
      if (process.env[name]) value[name] = process.env[name];
    return value;
  }
  let server: ChildProcess | null = null;
  async function stopBackend() {
    const child = server;
    server = null;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    await exited;
    clearTimeout(timer);
  }
  async function startBackend(overrides: Record<string, string>) {
    await stopBackend();
    const child = spawn(process.execPath, ['--import', 'tsx', resolve(backend, 'src/server.ts')], {
      cwd: backend,
      env: environment(overrides),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    server = child;
    child.once('exit', (code) => {
      if (!stopping && server === child) {
        log(`backend exited (${code ?? 'signal'})`);
        void stop(1);
      }
    });
    for (let attempt = 0; attempt < 120; attempt++) {
      const ready = await fetch(`http://127.0.0.1:${privatePort}/health/ready`)
        .then((response) => response.ok)
        .catch(() => false);
      if (ready) return;
      await new Promise((done) => setTimeout(done, 500));
    }
    throw new Error('The backend did not become ready.');
  }
  cleanups.push(stopBackend);

  // TCP gates: the web origin (4173 -> vite preview on its private port) and the backend
  // (4410, which vite proxies /api and /health to -> the backend's private port). "down"
  // refuses and drops connections on both, as a device that lost its network sees it.
  // "dropSaleResponses" lets the next N offline-sale uploads reach the backend but drops the
  // connection instead of returning the reply: the device sees a lost response and re-uploads.
  // "backendUp: false" with the network up cuts only the store service: the web server still
  // answers and proxies /api and /health to a dead upstream (nginx 502 in production).
  let up = true,
    backendUp = true,
    dropSaleResponses = 0,
    droppedSaleResponses = 0;
  const sockets = new Map<Socket, boolean>();
  async function openGate(listenPort: number, targetPort: number, inspectSales: boolean) {
    const gate = createServer((client) => {
      if (!up || (inspectSales && !backendUp)) {
        client.destroy();
        return;
      }
      const upstream = createConnection({ host: '127.0.0.1', port: targetPort });
      sockets.set(client, inspectSales);
      sockets.set(upstream, inspectSales);
      const drop = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on('error', drop).on('close', drop);
      upstream.on('error', drop).on('close', drop);
      let dropReply = false;
      client.on('data', (chunk: Buffer) => {
        if (
          inspectSales &&
          dropSaleResponses > 0 &&
          chunk.includes('POST /api/v1/stores/') &&
          chunk.includes('/offline-sales')
        ) {
          dropSaleResponses--;
          dropReply = true;
        }
        upstream.write(chunk);
      });
      upstream.on('data', (chunk: Buffer) => {
        if (!dropReply) {
          client.write(chunk);
          return;
        }
        droppedSaleResponses++;
        drop();
      });
    });
    await new Promise<void>((done, fail) => {
      gate.once('error', fail);
      gate.listen(listenPort, '127.0.0.1', () => done());
    });
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          for (const socket of sockets.keys()) socket.destroy();
          gate.close(() => done());
        }),
    );
  }
  await openGate(publicPort, privatePort, true);
  await openGate(webPort, webPrivatePort, false);

  let limits: Record<string, string> = {
    OFFLINE_BILLING_MAX_MINUTES: process.env.OFFLINE_BILLING_MAX_MINUTES ?? '120',
    OFFLINE_BILLING_MAX_ORDERS: process.env.OFFLINE_BILLING_MAX_ORDERS ?? '10',
  };
  await startBackend(limits);
  log(`backend ready on ${privatePort}, gated at ${publicPort}`);

  const control = createHttpServer((request, response) => {
    void (async () => {
      try {
        const target = new URL(request.url ?? '/', 'http://127.0.0.1');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const input =
          typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
        if (target.pathname === '/ready') return json(response, server ? 200 : 503, { up });
        if (target.pathname === '/network' && request.method === 'POST') {
          up = input.up === true;
          backendUp = input.backend !== false;
          if (typeof input.dropSaleResponses === 'number')
            dropSaleResponses = input.dropSaleResponses;
          for (const [socket, backendSocket] of sockets)
            if (!up || (backendSocket && !backendUp)) socket.destroy();
          return json(response, 200, { up, backendUp, dropSaleResponses, droppedSaleResponses });
        }
        if (target.pathname === '/backend/restart' && request.method === 'POST') {
          limits = {
            OFFLINE_BILLING_MAX_MINUTES: String(
              input.maxMinutes ?? limits.OFFLINE_BILLING_MAX_MINUTES,
            ),
            OFFLINE_BILLING_MAX_ORDERS: String(
              input.maxOrders ?? limits.OFFLINE_BILLING_MAX_ORDERS,
            ),
          };
          await startBackend(limits);
          return json(response, 200, { limits });
        }
        if (target.pathname === '/order-mode' && request.method === 'POST') {
          orders.setOrderMode(input.order === 'uncertain' ? 'uncertain' : 'normal');
          return json(response, 200, { ok: true });
        }
        if (target.pathname === '/calls') return json(response, 200, { calls: orders.calls });
        if (target.pathname === '/terminal-transaction' && request.method === 'POST') {
          const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
          await db.insert(PosTerminalTransaction).values({
            order_id: 0n,
            store_id: BigInt(String(input.storeId)),
            transaction_id: String(input.reference),
            plutus_id: '',
            store_pos_code: '',
            amount: String(input.amount ?? '0'),
            cash_amount: '0',
            cash_recieved: '0',
            total_amount: String(input.amount ?? '0'),
            payment_mode: 1,
            pos_admin_id: BigInt(e2eOperator.id),
            imei: '',
            platform: 'POS',
            api_response: '',
            is_active: true,
            created_at: stamp,
            updated_at: stamp,
          });
          return json(response, 200, { ok: true });
        }
        if (target.pathname === '/offline-orders') {
          const rows = await db
            .select({
              commentId: Comments.id,
              orderId: Comments.order_id,
              comment: Comments.comment,
              commentUser: Comments.user_id,
              orderRefNo: Order.order_ref_no,
              paymentStatus: Order.payment_statuses,
              invoice: OrderStore.order_invoice,
              isOfflineOrder: OrderStore.is_offline_order,
              paymentMessage: OrderStore.message,
              transactionId: OrderStore.transaction_id,
              manuallyPaid: OrderStore.is_manually_paid,
              onlineOther: OrderStore.online_other_payment,
              storeId: OrderStore.store,
              counterId: OrderStore.counter,
            })
            .from(Comments)
            .innerJoin(Order, eq(Order.id, Comments.order_id))
            .innerJoin(OrderStore, eq(OrderStore.order, Order.id))
            .where(and(like(Comments.comment, 'Offline bill % billed at %')))
            .orderBy(asc(Comments.id));
          const flags = await db
            .select({ orderId: Comments.order_id, comment: Comments.comment })
            .from(Comments)
            .where(like(Comments.comment, 'Offline bill % reconciliation: %'))
            .orderBy(asc(Comments.id));
          const all = await db
            .select({
              id: Order.id,
              orderRefNo: Order.order_ref_no,
              invoice: OrderStore.order_invoice,
            })
            .from(Order)
            .innerJoin(OrderStore, eq(OrderStore.order, Order.id))
            .orderBy(asc(Order.id));
          return json(response, 200, { rows, flags, orders: all });
        }
        return json(response, 404, { error: 'unknown control path' });
      } catch (error) {
        return json(response, 500, { error: error instanceof Error ? error.message : 'failed' });
      }
    })();
  });
  await new Promise<void>((done) => control.listen(controlPort, '127.0.0.1', () => done()));
  cleanups.push(() => new Promise<void>((done) => control.close(() => done())));
  log(`control API on ${controlPort}`);
} catch (error) {
  log(`startup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  await stop(1);
}
