import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Principal } from '../../src/domain/access.js';
import {
  wholeOrderStatusReceiver,
  authenticateStatusReceiver,
  type StatusWorkerEvent,
} from '../../src/modules/legacy-order-status/receiver.js';
import { readStatusReceiverOptions } from '../../src/modules/legacy-order-status/receiver-options.js';
import { wholeOrderStatusService } from '../../src/modules/legacy-order-status/service.js';
import { wholeOrderStatusTransport } from '../../src/modules/legacy-order-status/transport.js';
import { receiptSignature } from '../../src/modules/legacy-order-status/domain.js';
import { wholeOrderStatusCommands } from '../../src/modules/legacy-order-status/schema.js';
import {
  statusAttempts,
  statusNotificationAttempts,
  statusVendorCalls,
} from '../../src/modules/legacy-order-status/receiver-schema.js';
import { returnOperations } from '../../src/modules/checkout/return-workflow/schema.js';
import { returnOperationSchema } from '../../src/modules/checkout/return-workflow/contracts.js';
import { options, snapshot, capabilityResponse } from './fixtures.js';
import { wholeStatusFixture } from './mysql-fixture.js';
const template = process.env.WHOLE_ORDER_STATUS_MYSQL_TEST_URL,
  actor: Principal = {
    id: '1',
    role: 2,
    userType: 1,
    storeIds: ['1'],
    name: 'Synthetic',
    email: '',
  };
describe.skipIf(!template)('executable pinned STORE chain with native attempt fences', () => {
  let native: Awaited<ReturnType<typeof wholeStatusFixture>>,
    service: ReturnType<typeof wholeOrderStatusService>,
    receiver: ReturnType<typeof wholeOrderStatusReceiver>,
    receiverOptions: ReturnType<typeof readStatusReceiverOptions>,
    now: number,
    operationId: string,
    requests: { url: string; body: string; headers: Headers }[],
    events: StatusWorkerEvent[],
    reply: unknown,
    scopeHash: string,
    networkFailure: boolean,
    failContact: boolean;
  beforeAll(async () => {
    native = await wholeStatusFixture(template!);
  });
  afterAll(async () => {
    await native?.close();
  });
  beforeEach(async () => {
    await native.reset();
    now = Date.parse('2026-11-17T06:00:00Z');
    operationId = randomUUID();
    requests = [];
    events = [];
    reply = { responseCode: 0, responseMessage: 'Success' };
    networkFailure = false;
    failContact = false;
    await native.fixture.insert('pos_user', {
      id: '1',
      username: 'synthetic',
      password: 'synthetic-password-hash',
      role: 2,
      user_type: 1,
      is_active: 1,
    });
    await native.fixture.insert('user_stores', { id: '1', django_user_id: '1', store_id: '1' });
    await native.fixture.insert('stores', {
      id: '1',
      store_name: 'Synthetic',
      location_code: 'SYN',
      is_active: 1,
      type: 'STORE',
      category: 'IN_HOUSE',
    });
    await native.fixture.insert('store_counters', {
      id: '1',
      store_id: '1',
      counter_name: 'Synthetic',
      is_active: 1,
    });
    await native.connection.query(
      "INSERT INTO pos_rewrite_operator_checkins(operator_id,store_id,counter_id,expires_at,checked_in_at) VALUES('1',1,1,'2099-01-01 00:00:00','2026-11-17 06:00:00')",
    );
    await native.fixture.insert('order_status', {
      id: '3',
      order_status: 'Delivered',
      display_name: 'Delivered',
    });
    await native.fixture.insert('orders', {
      id: snapshot.orderId,
      user_id: snapshot.customerId,
      order_ref_no: snapshot.reference,
      payment_status: '4',
      order_status: '3',
      location_id: null,
      is_split_order: 0,
    });
    await native.fixture.insert('order_stores', {
      id: '11',
      order_id: snapshot.orderId,
      store_id: '1',
      counter_id: '1',
    });
    for (const row of snapshot.lines)
      await native.fixture.insert('has_products', {
        id: row.id,
        order_id: snapshot.orderId,
        prod_id: row.productId,
        sub_prod_id: row.subProductId,
        qty: row.quantity,
        status: row.quantity === '0' ? 'CANCELLED' : 'DELIVERED',
        price: 12.5,
        gender_type: 1,
      });
    // Missing catalog ID999 remains in the source payload, with nullable catalog enrichment.
    await native.fixture.insert('products', {
      id: '501',
      parent_prod_id: '500',
      url_key: 'synthetic-child',
    });
    await native.fixture.insert('products', {
      id: '500',
      parent_prod_id: '0',
      url_key: 'synthetic-parent',
    });
    receiverOptions = readStatusReceiverOptions({
      WHOLE_ORDER_STATUS_RECEIVER_ENABLED: 'true',
      WHOLE_ORDER_STATUS_VENDOR_SHIPPED_URL: 'https://vendor.synthetic.invalid/status',
      WHOLE_ORDER_STATUS_VENDOR_DELIVERED_URL: 'https://vendor.synthetic.invalid/deliver',
      WHOLE_ORDER_STATUS_VENDOR_API_OWNER: 'synthetic-owner',
      WHOLE_ORDER_STATUS_VENDOR_API_KEY: 'synthetic-vendor-key',
      TSS_EVENTS_URL: 'https://events.synthetic.invalid',
      TSS_EVENTS_APP_ID: 'synthetic-app',
      TSS_EVENTS_APP_KEY: 'synthetic-events-key',
    });
    receiver = wholeOrderStatusReceiver(native.config, native.db, options, receiverOptions, {
      clock: () => now,
      event: (value) => events.push(value),
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({ url, body: String(init?.body), headers: new Headers(init?.headers) });
        if (networkFailure || (failContact && url.endsWith('/update-netcore-user-contact')))
          throw {
            headers: { Authorization: 'Bearer SYNTHETIC_PRIVATE_TOKEN' },
            body: { private: 'SYNTHETIC_PRIVATE_BODY' },
          };
        return Response.json(reply);
      },
    });
    const transport = wholeOrderStatusTransport(native.config, options, async (input, init) => {
      const proof = authenticateStatusReceiver(
        Object.fromEntries(new Headers(init?.headers)),
        options,
      );
      if (String(input).endsWith('/capabilities')) {
        const [row] = await native.db
          .get('writer')
          .select()
          .from(wholeOrderStatusCommands)
          .where(eq(wholeOrderStatusCommands.id, proof.operationId));
        return capabilityResponse(input, init, row!)!;
      }
      const value =
        init?.method === 'GET'
          ? await receiver.read(proof)
          : await receiver.accept(proof, JSON.parse(String(init?.body)) as unknown);
      return value
        ? Response.json(value, {
            headers: {
              'x-pos-status-receipt': receiptSignature(
                options.WHOLE_ORDER_STATUS_RECEIPT_KEY!,
                value,
              ),
            },
          })
        : new Response(null, { status: 404 });
    });
    service = wholeOrderStatusService(native.config, native.db, options, {
      clock: () => now,
      transport,
    });
    scopeHash = (await service.status(actor, '1', snapshot.orderId)).scopeHash;
  });
  async function accepted(stage: 'PACK' | 'SHIP' | 'DELIVER' = 'PACK') {
    await service.submit(
      actor,
      '1',
      snapshot.orderId,
      { operationId, platform: stage, scopeHash },
      'r'.repeat(128),
    );
    expect(await service.worker.runOnce()).toMatchObject({ state: 'QUEUED' });
  }
  it('executes full-width PACK→SHIP→DELIVER and exact Netcore calls once across20 concurrent claims per stage', async () => {
    await accepted();
    expect(requests).toHaveLength(0);
    expect(await receiver.runOnce()).toBeNull();
    now += 300000;
    for (let stage = 0; stage < 3; stage++) {
      await Promise.all(Array.from({ length: 20 }, () => receiver.runOnce()));
      now += 60000;
    }
    expect(requests).toHaveLength(5);
    const packed = JSON.parse(requests[0]!.body) as { externalOrderno: string; items: unknown[] };
    expect(packed.externalOrderno).toBe(snapshot.orderId);
    expect(packed.items).toEqual(
      snapshot.lines.map((row, index) => ({
        lineno: String(index + 1),
        extLineno: row.id,
        sku: row.productId,
        tagLoopCode: '',
        qty: row.quantity,
        serialNos: [],
      })),
    );
    expect(JSON.parse(requests[2]!.body)).toEqual({
      orders: [
        {
          orderNo: snapshot.orderId,
          siteCode: '',
          status: 'DELIVERED',
          deliveryNo: '',
          pod: '',
          deliveryDate: '',
          awbNo: '',
        },
      ],
    });
    const netcore = JSON.parse(requests[3]!.body) as {
      order_id: string;
      user_id: number;
      total_products_quantity: number;
      product_data: unknown[];
    };
    expect(netcore).toEqual({
      order_id: snapshot.orderId,
      user_id: 7,
      product_data: [
        {
          parent_prod_id: 500,
          prod_id: 501,
          quantity: 3,
          url_key: 'synthetic-parent',
          amount: 12.5,
          gender_type: 1,
        },
        {
          parent_prod_id: 500,
          prod_id: 501,
          quantity: 1,
          url_key: 'synthetic-parent',
          amount: 12.5,
          gender_type: 1,
        },
        {
          parent_prod_id: null,
          prod_id: 999,
          quantity: 0,
          url_key: null,
          amount: 12.5,
          gender_type: 1,
        },
      ],
      order_line_item_status: 'DELIVERED',
      total_products_quantity: 4,
    });
    expect(JSON.parse(requests[4]!.body)).toEqual({ user_id: 7, fields_to_syn: ['include_all'] });
    expect(requests[0]!.headers.get('ApiKey')).toBe('synthetic-vendor-key');
    expect(requests[3]!.headers.get('app_key')).toBe('synthetic-events-key');
    expect(await receiver.runOnce()).toBeNull();
    await receiver.continueSucceeded();
    expect(requests).toHaveLength(5);
    const result = await service.read(actor, '1', snapshot.orderId, operationId);
    expect(result.state).toBe('SUCCEEDED');
    expect(result.receipt?.stages.map((row) => row.status)).toEqual([
      'SUCCESS',
      'SUCCESS',
      'SUCCESS',
    ]);
    const [logs] = await native.connection.query(
      'SELECT CAST(order_id AS CHAR) AS order_id,CAST(has_product_id AS CHAR) AS hp,platform,status FROM vinculum_auto_delivered_logs ORDER BY id',
    );
    expect(logs).toEqual(
      ['PACK', 'SHIP', 'DELIVER'].map((platform) => ({
        order_id: snapshot.orderId,
        hp: snapshot.lines[0]!.id,
        platform,
        status: 'SUCCESS',
      })),
    );
    expect(events.every((row) => row.requestId === 'r'.repeat(128) && row.userId === '1')).toBe(
      true,
    );
    expect(JSON.stringify(events)).not.toMatch(
      /ApiKey|app_key|PRIVATE|product_data|synthetic-parent/,
    );
  }, 30000);
  it.each([
    { responseCode: 13, responseMessage: 'API Hit Quota Exceeded', log: 'QUOTA_EXCEEDED' },
    { responseCode: 2, responseMessage: 'Not created', log: 'FAILED' },
    { responseCode: 1, responseMessage: 'Already processed', log: 'UNEXPECTED' },
    { responseCode: 0, responseMessage: 'Not successful', log: 'UNEXPECTED' },
  ])('records the original terminal classification without blind retry: $log', async (scenario) => {
    reply = { responseCode: scenario.responseCode, responseMessage: scenario.responseMessage };
    await accepted();
    now += 300000;
    expect(await receiver.runOnce()).toMatchObject({ state: 'rejected' });
    await receiver.runOnce();
    expect(requests).toHaveLength(1);
    expect((await service.read(actor, '1', snapshot.orderId, operationId)).state).toBe('REJECTED');
    const [logs] = await native.connection.query('SELECT status FROM vinculum_auto_delivered_logs');
    expect(logs).toEqual([{ status: scenario.log }]);
  });
  it.each(['network', 'malformed'] as const)(
    'freezes unknown %s outcomes and GET recovery never resends',
    async (scenario) => {
      if (scenario === 'network') networkFailure = true;
      else reply = { unverified: true };
      await accepted();
      now += 300000;
      expect(await receiver.runOnce()).toMatchObject({ state: 'unknown' });
      now += 600000;
      await receiver.expireClaims();
      for (let i = 0; i < 3; i++) {
        expect((await service.read(actor, '1', snapshot.orderId, operationId)).state).toBe(
          'UNCERTAIN',
        );
        expect(await receiver.runOnce()).toBeNull();
      }
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(events)).not.toMatch(/SYNTHETIC_PRIVATE|Bearer|headers|body/);
    },
  );
  it('recovers a missing next-stage enqueue using source ALREADY_SUCCEEDED without repeating the completed vendor effect', async () => {
    await accepted();
    now += 300000;
    await receiver.runOnce();
    await native.connection.query(
      "DELETE FROM pos_rewrite_whole_order_status_attempts WHERE platform='SHIP'",
    );
    await receiver.continueSucceeded();
    expect(requests).toHaveLength(1);
    const pending = await native.db.get('writer').select().from(statusAttempts);
    expect(pending.map((row) => [row.platform, row.state])).toEqual(
      expect.arrayContaining([
        ['PACK', 'SUCCESS'],
        ['SHIP', 'QUEUED'],
      ]),
    );
    now += 60000;
    await receiver.runOnce();
    expect(requests).toHaveLength(2);
  });
  it('expires a crashed dispatch to UNKNOWN and blocks stale native scope before any provider request', async () => {
    await accepted();
    await native.db
      .get('writer')
      .update(statusAttempts)
      .set({ state: 'SENDING', claimedAt: now })
      .where(eq(statusAttempts.operationId, operationId));
    now += 600000;
    await receiver.expireClaims();
    expect(await receiver.runOnce()).toBeNull();
    expect(requests).toHaveLength(0);
    expect((await service.read(actor, '1', snapshot.orderId, operationId)).state).toBe('UNCERTAIN');
  });
  it('keeps DELIVER success separate from an uncertain Netcore contact attempt and never repeats either event', async () => {
    await accepted('DELIVER');
    failContact = true;
    now += 60000;
    expect(await receiver.runOnce()).toMatchObject({ state: 'succeeded' });
    for (let i = 0; i < 3; i++) await receiver.continueSucceeded();
    expect(requests).toHaveLength(3);
    const notifications = await native.db.get('writer').select().from(statusNotificationAttempts);
    expect(notifications.map((row) => [row.kind, row.state])).toEqual(
      expect.arrayContaining([
        ['activity', 'SUCCESS'],
        ['contact', 'UNKNOWN'],
      ]),
    );
    expect(events.some((row) => row.state === 'NETCORE_OUTCOME_UNKNOWN')).toBe(true);
    expect((await service.read(actor, '1', snapshot.orderId, operationId)).state).toBe('SUCCEEDED');
  });
  it.each([
    { responseCode: 13, responseMessage: 'API Hit Quota Exceeded' },
    { responseCode: 2, responseMessage: 'Not created' },
  ])(
    'uses bounded source delay only for verified no-effect rejection $responseCode',
    async (rejected) => {
      receiverOptions.WHOLE_ORDER_STATUS_DEFINITE_REJECTION_CONTRACT =
        'vinculum-status-no-effect-v1';
      receiverOptions.WHOLE_ORDER_STATUS_RETRY_RESPONSE_CODES = [rejected.responseCode];
      reply = rejected;
      await accepted();
      now += 300000;
      expect(await receiver.runOnce()).toMatchObject({ state: 'queued' });
      expect(await receiver.runOnce()).toBeNull();
      expect(requests).toHaveLength(1);
      expect((await service.read(actor, '1', snapshot.orderId, operationId)).state).toBe('QUEUED');
      now += 60000;
      reply = { responseCode: 0, responseMessage: 'Success' };
      expect(await receiver.runOnce()).toMatchObject({ state: 'queued' });
      expect(requests).toHaveLength(2);
      const calls = await native.db.get('writer').select().from(statusVendorCalls);
      expect(calls.map((row) => [row.attempt, row.state])).toEqual(
        expect.arrayContaining([
          [1, 'REJECTED'],
          [2, 'SUCCESS'],
        ]),
      );
      expect(calls.every((row) => row.bodyHash !== null)).toBe(true);
      const [logs] = await native.connection.query(
        'SELECT retries,status,updated_at FROM vinculum_auto_delivered_logs',
      );
      expect(logs).toEqual([{ retries: 2, status: 'SUCCESS', updated_at: '2026-11-17 11:36:00' }]);
    },
  );
  it('stops at the stage retry budget and freezes ambiguous outcomes even when a rejection profile is configured', async () => {
    receiverOptions.WHOLE_ORDER_STATUS_DEFINITE_REJECTION_CONTRACT = 'vinculum-status-no-effect-v1';
    receiverOptions.WHOLE_ORDER_STATUS_RETRY_RESPONSE_CODES = [13];
    receiverOptions.WHOLE_ORDER_STATUS_MAX_STAGE_ATTEMPTS = 2;
    reply = { responseCode: 13, responseMessage: 'API Hit Quota Exceeded' };
    await accepted();
    now += 300000;
    await receiver.runOnce();
    now += 60000;
    expect(await receiver.runOnce()).toMatchObject({ state: 'rejected' });
    now += 600000;
    expect(await receiver.runOnce()).toBeNull();
    expect(requests).toHaveLength(2);
  });
  it('continues an exact source-proven PACK/SHIP repair without replaying either successful vendor stage', async () => {
    const returnId = randomUUID(),
      operation = returnOperationSchema.parse({
        id: returnId,
        operatorId: '1',
        storeId: '1',
        orderId: snapshot.orderId,
        lineId: snapshot.lines[0]!.id,
        productId: '501',
        customerId: '7',
        quantity: 3,
        input: {
          operationId: returnId,
          counterId: '1',
          verificationId: randomUUID(),
          reasonId: '1',
          qualityConfirmed: true,
          tagConfirmed: true,
          saleable: true,
        },
        requestHash: 'a'.repeat(64),
        phase: 'rejected',
        uncertainStage: null,
        creditNote: null,
        returnAmount: null,
        errorCode: 'RETURN_INBOUND_REJECTED',
        createdAt: '2026-11-17 06:00:00',
        updatedAt: '2026-11-17 06:00:00',
      });
    await native.db.get('writer').insert(returnOperations).values({
      id: returnId,
      lineId: operation.lineId,
      storeId: '1',
      phase: 'rejected',
      state: operation,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    });
    for (const stage of ['PACK', 'SHIP'])
      await native.fixture.insert('vinculum_auto_delivered_logs', {
        order_id: snapshot.orderId,
        has_product_id: snapshot.lines[0]!.id,
        platform: stage,
        status: 'SUCCESS',
        request: JSON.stringify({
          externalOrderno: snapshot.orderId,
          status: stage,
          items: snapshot.lines.map((row) => ({
            extLineno: row.id,
            sku: row.productId,
            qty: row.quantity,
          })),
        }),
      });
    await service.repair(actor, '1', snapshot.orderId, {
      operationId,
      returnOperationId: returnId,
    });
    await service.worker.runOnce();
    await receiver.runOnce();
    now += 60000;
    expect(await receiver.runOnce()).toMatchObject({ state: 'succeeded' });
    expect(
      requests.filter((row) => row.url.includes('vendor.synthetic.invalid')).map((row) => row.url),
    ).toEqual(['https://vendor.synthetic.invalid/deliver']);
    const [unchanged] = await native.db.get('writer').select().from(returnOperations);
    expect(unchanged!.state).toEqual(operation);
  });
  it('preserves full-width SKU and customer IDs in source payload strings and Netcore JSON integer tokens', async () => {
    const productId = '9007199254740995',
      customerId = '9007199254740997';
    await native.connection.query('UPDATE has_products SET prod_id=? WHERE id=?', [
      productId,
      snapshot.lines[2]!.id,
    ]);
    await native.connection.query('UPDATE orders SET user_id=? WHERE id=?', [
      customerId,
      snapshot.orderId,
    ]);
    scopeHash = (await service.status(actor, '1', snapshot.orderId)).scopeHash;
    await accepted();
    now += 300000;
    await receiver.runOnce();
    now += 60000;
    await receiver.runOnce();
    now += 60000;
    await receiver.runOnce();
    expect(requests).toHaveLength(5);
    expect(requests[0]!.body).toContain('"sku":"' + productId + '"');
    expect(requests[3]!.body).toContain('"user_id":' + customerId);
    expect(requests[3]!.body).toContain('"prod_id":' + productId);
    expect((await service.read(actor, '1', snapshot.orderId, operationId)).state).toBe('SUCCEEDED');
  });
  it('keeps untrusted vendor message text out of new source logs and resource events', async () => {
    reply = {
      responseCode: 1,
      responseMessage: 'synthetic@example.invalid Bearer SYNTHETIC_PRIVATE',
    };
    await accepted();
    now += 300000;
    await receiver.runOnce();
    const [rows] = await native.connection.query(
      'SELECT response,message FROM vinculum_auto_delivered_logs',
    );
    expect(JSON.stringify(rows)).not.toMatch(/synthetic@example|Bearer|SYNTHETIC_PRIVATE/);
    expect(JSON.stringify(events)).not.toMatch(/synthetic@example|Bearer|SYNTHETIC_PRIVATE/);
  });
});
