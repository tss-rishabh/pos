import { randomUUID } from 'node:crypto';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { checkoutGateway } from '../../src/modules/checkout/gateway.js';
import { checkoutService } from '../../src/modules/checkout/service.js';
import { quotePayable } from '../../src/modules/checkout/service-public.js';
import {
  offlineSaleUploadSchema,
  type OfflineSaleUpload,
} from '../../src/modules/offline-sync/contracts.js';
import type {
  DeviceSale,
  OfflineSyncCoordinator,
  SaleRecord,
} from '../../src/modules/offline-sync/locks.js';
import {
  offlineSyncRepository,
  type OfflineOrder,
  type OfflineSyncRepository,
} from '../../src/modules/offline-sync/repository.js';
import { offlineSyncService } from '../../src/modules/offline-sync/service.js';
import { goldenStdout } from '../golden/load.js';
import { createProductionSchema } from '../helpers/production-schema.js';
import { MemoryCheckoutRepository, operator, signingEnvironment } from '../checkout/fixtures.js';
import {
  legacyCart,
  legacyOrderInput,
  legacyOrderReply,
  legacyTabId,
} from './legacy-order-input.js';

/**
 * Desktop offline sale versus the legacy counter path, against tests/golden/offline-sync/
 * legacy-order.json (pinned order/views.py AjaxOrderView and the Comments model; backend-pos-web
 * 78d5b63). AGENTS.md: "Order submission calls API-v2 pos/order exactly as legacy does", and
 * an offline sale syncs through the ordinary checkout path. The sale's `tab_id` is a per-sale
 * identifier, so the legacy fixed value is substituted after checking its type.
 *
 * The provisional-reference comment text ("Offline bill <ref> billed at <ISO time>") has no
 * legacy counterpart: desktop offline billing is a user-approved addition (AGENTS.md, 18-19 Nov).
 * Only the row it is written into is compared with the legacy Comments rows.
 */
const request = z.object({
  url: z.string(),
  json: z.record(z.string(), z.unknown()),
  headerKeys: z.array(z.string()),
});
const golden = z
  .object({
    sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
    sourceSha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    cases: z.array(
      z.object({
        requests: z.array(request).length(2),
        reply: z.object({ status: z.literal(200), message: z.string() }).passthrough(),
        redisDeleted: z.array(z.string()),
      }),
    ),
    comments: z
      .array(
        z.object({
          source: z.string(),
          fields: z.record(z.string(), z.union([z.string(), z.number()])),
        }),
      )
      .length(2),
  })
  .strict()
  .parse(
    JSON.parse(goldenStdout('offline-sync', 'legacy-order', JSON.stringify(legacyOrderInput))),
  );
const legacy = golden.cases[0]!;

/** An unpatched API-v2 and payment service: every cart read returns the golden's cart. */
function fakeApiV2() {
  const requests: { path: string; headers: Record<string, string>; body: unknown; raw: string }[] =
    [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const raw = init?.body ? String(init.body) : '';
    requests.push({
      path: url.pathname,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: raw ? (JSON.parse(raw) as unknown) : null,
      raw,
    });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (url.pathname === '/api/v2/pos/order') return json(legacyOrderReply);
    if (url.pathname === '/api/v2/validatecheckout') return json({ valid: true });
    if (url.pathname === '/payments/order') return json({ ok: true }, 201);
    if (url.pathname.startsWith('/api/v2/')) return json(legacyCart);
    return json({ title: 'Not found' }, 404);
  };
  return { requests, fetcher };
}

function counterCheckout() {
  const config = readConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'offline-legacy-order-session-'.repeat(2),
    MYSQL_PRIMARY_READER_URL: 'mysql://user:pass@127.0.0.1:3306/db',
    TSS_API_BASE_URL: 'http://127.0.0.1:9/api/v2/',
  });
  const api = fakeApiV2();
  const environment = {
    ...signingEnvironment,
    paymentOrderUrl: 'http://127.0.0.1:9/payments/order',
  };
  const repository = new MemoryCheckoutRepository();
  const payments: { orderId: string; channel: string }[] = [];
  const service = checkoutService(
    repository,
    checkoutGateway(config, environment, api.fetcher),
    environment,
    {
      migrationV2: true,
      assertCheckIn: async () => {},
      recordLineSalespersons: async () => {},
      startPayment: async (_user, _store, orderId, input) => {
        payments.push({ orderId, channel: input.channel });
        return { orderId, status: 'paid' };
      },
      finalizeOrder: async (_state, orderId) => ({
        transactionId: orderId,
        invoice: 'S0012627INV00001',
      }),
    },
  );
  return { api, repository, service, payments };
}

/** The legacy request with the per-sale tab id replaced by the rewrite sale's own. */
function sentLikeLegacy(
  sent: { path: string; headers: Record<string, string>; body: unknown; raw: string },
  expected: z.infer<typeof request>,
  tabId: number,
) {
  // Same endpoint: API-v2 `pos/order`, or the payment service's order route.
  expect(sent.path.endsWith(new URL(expected.url).pathname.split('/').slice(-2).join('/'))).toBe(
    true,
  );
  expect(Object.keys(sent.headers).sort()).toEqual(
    expected.headerKeys.map((key) => key.toLowerCase()).sort(),
  );
  const body = sent.body as Record<string, unknown>;
  if ('tab_id' in expected.json) {
    expect(typeof body.tab_id).toBe(typeof expected.json.tab_id);
    expect(expected.json.tab_id).toBe(legacyTabId);
  }
  const wanted = 'tab_id' in expected.json ? { ...expected.json, tab_id: tabId } : expected.json;
  // Same keys in the same order (json.dumps keeps the dict order) and the same values.
  expect(Object.keys(body)).toEqual(Object.keys(wanted));
  expect(body).toEqual(wanted);
}

describe('offline sale pos/order payload against the pinned legacy counter checkout', () => {
  it('pins the executed source', () => {
    expect(Object.keys(golden.sourceSha256).sort()).toEqual([
      'helpers/helpers.py',
      'order/models.py',
      'order/views.py',
    ]);
    expect(legacy.reply).toMatchObject({ status: 200, message: 'Order Created' });
  });

  it('the counter path sends the legacy pos/order and payment confirmation', async () => {
    const { api, repository, service } = counterCheckout();
    const created = await service.create(operator, '1', '3');
    await service.salesperson(
      operator,
      '1',
      created.id,
      { operationId: randomUUID(), expectedVersion: 0 },
      '5',
    );
    const quoted = await service.quote(operator, '1', created.id, {
      operationId: randomUUID(),
      expectedVersion: 1,
    });
    expect(quoted.status).toBe('succeeded');
    const done = await service.submit(
      operator,
      '1',
      created.id,
      { operationId: randomUUID(), expectedVersion: 2 },
      {
        operationId: randomUUID(),
        channel: 'cash',
        cashAmount: '499.00',
        onlineAmount: '0.00',
        cashReceived: '500.00',
        message: '#Cash Received:500',
      },
    );
    expect(done.status).toBe('succeeded');
    const tabId = repository.states.get(created.id)!.tabId;
    const order = api.requests.filter((sent) => sent.path === '/api/v2/pos/order');
    const confirmation = api.requests.filter((sent) => sent.path === '/payments/order');
    expect(order).toHaveLength(1);
    expect(confirmation).toHaveLength(1);
    sentLikeLegacy(order[0]!, legacy.requests[0]!, tabId);
    sentLikeLegacy(confirmation[0]!, legacy.requests[1]!, tabId);
  });

  it('an offline cash sale synced through offline-sync sends the same requests', async () => {
    const { api, repository: checkoutRepository, service: checkout, payments } = counterCheckout();
    const reference = 'OFF-1-3-ABCDEF01-1';
    const billedAt = Date.UTC(2026, 10, 19, 9);
    const sale: OfflineSaleUpload = offlineSaleUploadSchema.parse({
      saleId: randomUUID(),
      provisionalRef: reference,
      deviceId: 'abcdef0123456789abcdef0123456789',
      billedBy: operator.id,
      billedAt,
      lines: [{ productId: '10', quantity: 1, unitPrice: '499.00' }],
      salespersonId: '5',
      payable: '499.00',
      tender: { mode: 'cash', received: '500.00' },
      resolution: null,
    });
    const comments: { orderId: string; reference: string; userId: string }[] = [];
    const orders = new Map<string, OfflineOrder>([
      [
        String(legacyOrderReply.order),
        {
          orderId: String(legacyOrderReply.order),
          storeId: '1',
          counterId: '3',
          invoiceNumber: 'S0012627INV00001',
          paid: false,
          payable: '499.00',
        },
      ],
    ]);
    const repository: OfflineSyncRepository = {
      order: async (orderId) => orders.get(orderId) ?? null,
      findByComment: async () => null,
      commentExists: async (orderId, ref) =>
        comments.some((row) => row.orderId === orderId && row.reference === ref),
      recordReference: async (input) => {
        comments.push({ orderId: input.orderId, reference: input.reference, userId: input.userId });
      },
      tenderMatch: async () => 'missing',
      reconciliationFlagged: async () => false,
      flagReconciliation: async () => {},
      unconfirmedOrder: async () => null,
      linkCandidate: async () => null,
    };
    const records = new Map<string, SaleRecord>(),
      devices = new Map<string, Map<string, DeviceSale>>(),
      locks = new Map<string, string>();
    const coordinator: OfflineSyncCoordinator = {
      lock: async (ref, owner) => (locks.has(ref) ? false : (locks.set(ref, owner), true)),
      unlock: async (ref) => void locks.delete(ref),
      record: async (ref) => records.get(ref) ?? null,
      saveRecord: async (ref, value) => void records.set(ref, value),
      clearRecord: async (ref) => void records.delete(ref),
      deviceSales: async (deviceId) => new Map(devices.get(deviceId) ?? []),
      saveDeviceSale: async (deviceId, ref, value) => {
        const sales = devices.get(deviceId) ?? new Map<string, DeviceSale>();
        sales.set(ref, value);
        devices.set(deviceId, sales);
      },
      close: async () => {},
    };
    const sync = offlineSyncService({
      repository,
      coordinator,
      checkout,
      payments: {
        start: async (_user, _store, orderId, input) => {
          payments.push({ orderId, channel: input.channel });
          orders.get(orderId)!.paid = true;
          return {};
        },
      },
      operators: { get: async (id) => (id === operator.id ? operator : null) },
      operationSecret: 'offline-legacy-order-secret',
      quotePayable,
      limits: { maxMinutes: 120, maxOrders: 10 },
      now: () => billedAt + 3600_000,
    });
    const result = await sync.sync(operator, '1', '3', sale);
    expect(result).toMatchObject({ status: 'created', orderId: String(legacyOrderReply.order) });
    const [state] = [...checkoutRepository.states.values()];
    const order = api.requests.filter((sent) => sent.path === '/api/v2/pos/order');
    const confirmation = api.requests.filter((sent) => sent.path === '/payments/order');
    expect(order).toHaveLength(1);
    expect(confirmation).toHaveLength(1);
    sentLikeLegacy(order[0]!, legacy.requests[0]!, state!.tabId);
    sentLikeLegacy(confirmation[0]!, legacy.requests[1]!, state!.tabId);
    // The tender is the ordinary cash payment, taken after the order exists.
    expect(payments).toEqual([{ orderId: String(legacyOrderReply.order), channel: 'cash' }]);
    expect(comments).toEqual([
      { orderId: String(legacyOrderReply.order), reference, userId: operator.id },
    ]);
  });
});

/**
 * The comments row the rewrite writes for the provisional reference, on an isolated loopback
 * MySQL (OFFLINE_SYNC_MYSQL_TEST_URL=mysql://root@127.0.0.1:<port>/), against the two legacy
 * operator-comment statements on an existing order.
 */
const template = process.env.OFFLINE_SYNC_MYSQL_TEST_URL;
describe.skipIf(!template)('offline provisional-reference comment row on legacy tables', () => {
  let connection: Connection, db: Databases, repository: OfflineSyncRepository, schema: string;
  beforeAll(async () => {
    const url = new URL(template!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Isolated loopback MySQL required.');
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    schema = await createProductionSchema(
      connection,
      'pos_v2_offline_' + randomUUID().replaceAll('-', '').slice(0, 12),
      ['orders', 'order_stores', 'comments'],
    );
    url.pathname = '/' + schema;
    db = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'offline-legacy-order-session-'.repeat(2),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
      }),
    );
    repository = offlineSyncRepository(db, 'Asia/Kolkata');
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      await connection.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(schema));
      await connection.end();
    }
  });
  it('writes the legacy operator-comment row shape', async () => {
    const spec = legacyOrderInput.comment;
    await connection.query(
      'INSERT INTO orders (id, user_id, payment_status, order_status, created_at, updated_at) VALUES (?, 1, 0, ?, NOW(), NOW())',
      [spec.orderId, spec.orderStatus],
    );
    await connection.query(
      'INSERT INTO order_stores (order_id, store_id, counter_id, salesperson_id, order_invoice) VALUES (?, 1, 3, 5, ?)',
      [spec.orderId, 'S0012627INV00001'],
    );
    const reference = 'OFF-1-3-ABCDEF01-1';
    await repository.recordReference({
      orderId: String(spec.orderId),
      reference,
      billedAt: Date.UTC(2026, 10, 19, 9),
      userId: String(spec.userId),
    });
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT order_id, status_id, comment, notify, user_id, package_details, has_product_id, prod_id, created_at, updated_at FROM comments',
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const [complete, statusView] = golden.comments;
    expect(complete!.source).toBe('helpers/helpers.py:667');
    expect(statusView!.source).toBe('order/views.py:725');
    for (const column of [
      'order_id',
      'notify',
      'user_id',
      'package_details',
      'has_product_id',
      'prod_id',
    ])
      for (const source of [complete!, statusView!])
        expect(String(row[column]), `${column} vs ${source.source}`).toBe(
          String(source.fields[column]),
        );
    // status_id: the order's current status, as order/views.py:725 writes it (helpers.py:667
    // writes the fixed paid status 3 because it runs at payment completion).
    expect(String(row.status_id)).toBe(String(statusView!.fields.status_id));
    expect([complete!.fields.created_at, complete!.fields.updated_at]).toEqual([
      'auto_now_add',
      'auto_now',
    ]);
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.updated_at).toBe(row.created_at);
    // Rewrite-only text (no legacy counterpart); its prefix is the lookup key of the sync fallback.
    expect(String(row.comment).startsWith(`Offline bill ${reference} billed at `)).toBe(true);
  });
});
