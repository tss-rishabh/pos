import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import mysql from 'mysql2/promise';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { buildApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { migrationPlan } from '../../src/db/migrations.js';
import { PosUser } from '../../src/db/legacy-schema.js';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { seal } from '../../src/auth/crypto.js';
import { checkoutStateSchema } from '../../src/modules/checkout/contracts.js';
import { checkoutSessions } from '../../src/modules/checkout/schema.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { verifiedMysqlFixture } from '../operational-reports/verified-mysql-fixture.js';

export const feedbackOrder = '9007199254740993';
export const feedbackProduct = '10';
export const feedbackCheckout = 'a53b9ec4-76ce-4641-95d5-7d3f4f073ab4';
export const feedbackApi = `/api/v1/stores/1/checkout-sessions/${feedbackCheckout}/customers/777/orders/${feedbackOrder}/product-feedback`;
export const feedbackPath = `/stores/1/checkout-sessions/${feedbackCheckout}/customers/777/orders/${feedbackOrder}/feedback`;
export const feedbackComment =
  'synthetic-private-feedback café € <script>window.feedbackPwned=true</script>';
export const feedbackCommand = {
  operationId: '60982623-a981-491b-9f1a-e94af6d21a75',
  expectedVersion: 1,
  productId: feedbackProduct,
  overall: 4.5,
  fit: 0,
  size: 3.2,
  quality: 0,
  comment: feedbackComment,
};
const sourceFeedback = z.object({
  optionId: z.string().nullable(),
  rating: z.number().nullable(),
  platform: z.string().nullable(),
  comment: z.string().nullable(),
});
export const sourceRead = z.object({
  orders: z.array(
    z.object({
      id: z.string(),
      orderAmount: z.number(),
      items: z.array(
        z.object({
          productId: z.string(),
          name: z.string(),
          feedback: z.array(sourceFeedback),
        }),
      ),
    }),
  ),
  mainHtml: z.string(),
  queries: z.number().int().positive(),
  sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
const sourceWrite = z.object({
  responses: z.array(z.object({ message: z.string(), status: z.string() })),
  queries: z.number().int().nonnegative(),
  nativeInserts: z.number().int().nonnegative(),
  sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
const exactNativeId = z.union([z.string(), z.number().int().safe()]).transform(String);
const nativeRows = z.array(
  z
    .object({
      user_id: exactNativeId,
      order_id: exactNativeId,
      prod_id: exactNativeId,
      product_rating_option_id: exactNativeId.nullable(),
      rating: z.number().nullable(),
      platform: z.string().nullable(),
      comment: z.string().nullable(),
      is_default: z.number().nullable(),
      parent_prod_id: exactNativeId.nullable(),
      is_bot: z.number().nullable(),
      has_product_id: exactNativeId.nullable(),
    })
    .strict(),
);

export async function nativeFeedbackFixture(output: string) {
  const base = new URL(process.env.PRODUCT_FEEDBACK_WORKFLOW_MYSQL_URL ?? '');
  if (
    base.protocol !== 'mysql:' ||
    base.hostname !== '127.0.0.1' ||
    !base.port ||
    base.pathname !== '/pos_rewrite_feedback_workflow' ||
    base.search ||
    base.hash
  )
    throw new Error('Only the owned localhost feedback fixture is permitted.');
  const schema = 'pos_rewrite_feedback_workflow_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const connection = await mysql.createConnection({
    host: base.hostname,
    port: Number(base.port),
    user: decodeURIComponent(base.username),
    password: decodeURIComponent(base.password),
    database: base.pathname.slice(1),
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
  await connection.changeUser({ database: schema });
  const physical = verifiedMysqlFixture(connection, [
    'evidence/mysql-product-feedback-schema.json',
    'evidence/mysql-customer-benefit-schema.json',
  ]);
  await physical.create([
    'users',
    'pos_user',
    'stores',
    'store_counters',
    'user_stores',
    'orders',
    'has_products',
    'products',
    'product_rating_user',
  ]);
  for (const [id, store] of [
    [7, 1],
    [8, 2],
  ] as const) {
    await physical.insert('pos_user', {
      id,
      role: 4,
      user_type: 1,
      username: 'synthetic-operator-' + id,
      is_active: 1,
      is_staff: 1,
    });
    await physical.insert('stores', { id: store, type: 'STORE', is_active: 1 });
    await physical.insert('store_counters', { id: store + 1, store_id: store, is_active: 1 });
    await physical.insert('user_stores', { django_user_id: id, store_id: store });
  }
  for (const id of [777, 778])
    await physical.insert('users', {
      id,
      firstname: 'Synthetic',
      lastname: 'Guest',
      email: `guest-${id}@example.test`,
      telephone: '9876543210',
      status: 1,
      is_block: 0,
      is_disabled: 0,
    });
  await physical.insert('orders', {
    id: feedbackOrder,
    user_id: 777,
    order_amt: 125.5,
    order_status: 3,
  });
  await physical.insert('orders', {
    id: '9007199254740994',
    user_id: 778,
    order_amt: 50,
    order_status: 3,
  });
  await physical.insert('products', { id: 10, product: '<Synthetic feedback product>' });
  await physical.insert('products', { id: 11, product: 'Another product' });
  for (const id of ['9007199254740997', '9007199254740998'])
    await physical.insert('has_products', {
      id,
      order_id: feedbackOrder,
      prod_id: feedbackProduct,
    });
  for (const migration of migrationPlan())
    for (const statement of migration.statements) await connection.query(statement);

  let backendOrigin = '',
    dropNextPost = false;
  const traffic: { method: string; path: string; status: number }[] = [];
  const gateway = createServer(async (request, response) => {
    const path = request.url ?? '/';
    if (path.startsWith('/api/v1/')) {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      try {
        const upstream = await fetch(backendOrigin + path, {
          method: request.method,
          headers: Object.fromEntries(
            Object.entries(request.headers)
              .filter(
                ([name, value]) =>
                  name !== 'host' && name !== 'connection' && typeof value === 'string',
              )
              .map(([name, value]) => [name, String(value)]),
          ),
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        traffic.push({ method: request.method ?? '', path, status: upstream.status });
        if (request.method === 'POST' && path === feedbackApi && dropNextPost) {
          dropNextPost = false;
          // Deliver headers and one byte, then lose the committed result. A
          // pre-header socket reset can be retried automatically by Chromium;
          // truncating the response body exercises the unknown-result path.
          response.writeHead(upstream.status, {
            'content-type': 'application/json',
            'content-length': String(bytes.length),
          });
          response.flushHeaders();
          response.write(bytes.subarray(0, 1), () => response.destroy());
          return;
        }
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
        response.end(bytes);
      } catch {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'SYNTHETIC_PROXY_UNAVAILABLE' } }));
      }
      return;
    }
    try {
      const pathname = new URL(path, 'http://127.0.0.1').pathname;
      const file = pathname.startsWith('/assets/')
        ? resolve(output, '.' + pathname)
        : resolve(output, 'tests/product-feedback/native-workflow.html');
      if (!file.startsWith(resolve(output) + sep)) throw new Error('Invalid fixture path');
      response.writeHead(200, {
        'content-type': file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/html',
      });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
  const address = gateway.address();
  if (!address || typeof address === 'string') throw new Error('Fixture gateway unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  base.pathname = '/' + schema;
  const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'false',
    WEB_ORIGIN: origin,
    SESSION_SECRET: 'synthetic-native-feedback-secret-'.repeat(3),
    MYSQL_WRITER_URL: base.href,
    MYSQL_PRIMARY_READER_URL: base.href,
    MYSQL_DATA_READER_URL: base.href,
    MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
  });
  const db = createDatabases(config),
    app = await buildApp(config, { logger: false });
  backendOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
  const principal = {
    id: '7',
    role: 4 as const,
    userType: 1 as const,
    name: 'Synthetic operator',
    email: 'operator@example.test',
    storeIds: ['1'],
  };
  const state = checkoutStateSchema.parse({
    id: feedbackCheckout,
    operatorId: '7',
    operatorCustomerId: '700',
    storeId: '1',
    counterId: '2',
    tabId: 1,
    customerId: '777',
    verifiedCustomerUntil: null,
    version: 1,
    phase: 'open',
    cart: { products: { items: [] } },
    quote: null,
    orderId: null,
    paymentConfirmation: null,
    salespersonId: null,
    lineSalespersons: {},
    giftCards: {},
    busyOperationId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await db
    .get('writer')
    .insert(checkoutSessions)
    .values({ id: feedbackCheckout, operatorId: '7', storeId: '1', version: 1, state });
  await checkInService(db, config).set(principal, '1', '2');

  function original(raw: Record<string, unknown>) {
    const python = process.env.PRODUCT_FEEDBACK_SOURCE_PYTHON;
    const root = process.env.PRODUCT_FEEDBACK_SOURCE_ROOT;
    if (!python || !root) throw new Error('Pinned native source environment is required');
    const result = spawnSync(python, ['-B', 'tools/product-feedback/native-workflow-source.py'], {
      input: JSON.stringify({ url: base.href, ...raw }),
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, TZ: 'Asia/Kolkata', PRODUCT_FEEDBACK_SOURCE_ROOT: root },
    });
    if (result.status !== 0)
      throw new Error('Native source execution failed without exposing diagnostics');
    return JSON.parse(result.stdout) as unknown;
  }
  return {
    origin,
    path: feedbackPath,
    api: feedbackApi,
    traffic,
    async cookie(id = '7') {
      const credential = await mysqlSessions(db).create(id, Date.now() + 300000);
      return {
        name: 'pos_session',
        value: seal({ id, ...credential }, config.SESSION_SECRET),
        url: origin,
        httpOnly: true,
        sameSite: 'Lax' as const,
      };
    },
    async reset() {
      await connection.query('DELETE FROM product_rating_user');
      await connection.query('DELETE FROM pos_rewrite_product_feedback_receipts');
      traffic.length = 0;
      dropNextPost = false;
    },
    loseNextCommittedResponse() {
      dropNextPost = true;
    },
    async rows() {
      const [rows] = await connection.query(
        'SELECT user_id,order_id,prod_id,product_rating_option_id,rating,platform,comment,is_default,parent_prod_id,is_bot,has_product_id FROM product_rating_user ORDER BY product_rating_option_id,id',
      );
      return nativeRows.parse(rows);
    },
    originalRead(customerId = '777') {
      return sourceRead.parse(original({ action: 'read', customerId, orderId: feedbackOrder }));
    },
    originalWrite() {
      return sourceWrite.parse(
        original({
          action: 'write',
          submissions: [0, 1, 2, 3].map((option) => ({
            user_id: '777',
            order_id: feedbackOrder,
            prod_id: feedbackProduct,
            product_rating_option: String(option),
            rating: String([4.5, 0, 3.2, 0][option]),
            comment: option === 0 ? feedbackComment : '',
          })),
        }),
      );
    },
    async setRole(role: number) {
      await db.get('writer').update(PosUser).set({ role }).where(eq(PosUser.id, 7n));
    },
    async archiveOperator(active: boolean) {
      await db.get('writer').update(PosUser).set({ is_active: active }).where(eq(PosUser.id, 7n));
    },
    async seedPartial() {
      for (const [option, rating] of [
        [null, null],
        [0, null],
        [2, 3],
        [7, 1],
      ] as const)
        await physical.insert('product_rating_user', {
          user_id: 778,
          order_id: feedbackOrder,
          prod_id: feedbackProduct,
          product_rating_option_id: option,
          rating,
          platform: 'IOS',
          comment: option === 0 ? '<script>source-comment</script>' : null,
        });
    },
    async close() {
      await app.close();
      await db.close();
      await new Promise<void>((done) => gateway.close(() => done()));
      await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      await connection.end();
    },
  };
}
