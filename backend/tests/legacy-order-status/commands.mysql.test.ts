import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Principal } from '../../src/domain/access.js';
import { wholeOrderStatusService } from '../../src/modules/legacy-order-status/service.js';
import { wholeOrderStatusCommands } from '../../src/modules/legacy-order-status/schema.js';
import { returnOperations } from '../../src/modules/checkout/return-workflow/schema.js';
import { returnOperationSchema } from '../../src/modules/checkout/return-workflow/contracts.js';
import type {
  WholeOrderStatusTransport,
  StatusCommand,
} from '../../src/modules/legacy-order-status/transport.js';
import { wholeStatusFixture } from './mysql-fixture.js';
import { options, snapshot, queuedReceipt } from './fixtures.js';
import { goldenSourceStatusOracle } from './source-helper.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';
const template = process.env.WHOLE_ORDER_STATUS_MYSQL_TEST_URL,
  actor: Principal = {
    id: '1',
    role: 2,
    userType: 1,
    storeIds: ['1'],
    name: 'Synthetic',
    email: '',
  };
describe.skipIf(!template)('durable whole-order status commands on isolated native MySQL', () => {
  let native: Awaited<ReturnType<typeof wholeStatusFixture>>,
    service: ReturnType<typeof wholeOrderStatusService>,
    transport: WholeOrderStatusTransport,
    scopeHash: string,
    records: StatusCommand[],
    operationId: string;
  beforeAll(async () => {
    native = await wholeStatusFixture(template!);
  });
  beforeEach(async () => {
    await native.reset();
    records = [];
    operationId = randomUUID();
    await native.fixture.insert('pos_user', {
      id: '1',
      username: 'synthetic',
      password: 'synthetic-password-hash',
      role: 2,
      user_type: 1,
      is_active: 1,
    });
    await native.fixture.insert('user_stores', { id: '1', django_user_id: '1', store_id: '1' });
    for (const id of ['1', '2']) {
      await native.fixture.insert('stores', {
        id,
        store_name: 'Synthetic ' + id,
        location_code: id === '1' ? 'SYN' : 'OTHER',
        is_active: 1,
        type: 'STORE',
        category: 'IN_HOUSE',
      });
      await native.fixture.insert('store_counters', {
        id,
        store_id: id,
        counter_name: 'Synthetic counter',
        is_active: 1,
      });
    }
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
      user_id: '7',
      order_ref_no: snapshot.reference,
      payment_status: '4',
      order_status: '3',
      order_amt: 100,
      pay_amt: 100,
      location_id: null,
      is_split_order: 0,
    });
    await native.fixture.insert('order_stores', {
      id: '11',
      order_id: snapshot.orderId,
      store_id: '1',
      counter_id: '1',
      offline_payment: 100,
      is_manually_paid: 1,
    });
    for (const row of snapshot.lines)
      await native.fixture.insert('has_products', {
        id: row.id,
        order_id: snapshot.orderId,
        prod_id: row.productId,
        sub_prod_id: row.subProductId,
        qty: row.quantity,
        status: row.quantity === '0' ? 'CANCELLED' : 'DELIVERED',
      });
    transport = {
      configured() {},
      async send(row) {
        records.push(row);
        return queuedReceipt(row);
      },
      async read(row) {
        return queuedReceipt(row);
      },
    };
    service = wholeOrderStatusService(native.config, native.db, options, {
      transport,
      assertHandoverAvailable: async () => {},
    });
    scopeHash = (await service.status(actor, '1', snapshot.orderId)).scopeHash;
  });
  afterAll(async () => {
    await native?.close();
  });
  const input = (id: string, scopeHash: string) => ({
    operationId: id,
    platform: 'PACK' as const,
    scopeHash,
  });
  it('matches real Django ALL HP selection including duplicate SKU, zero quantity and unavailable catalog IDs', async () => {
    const source = goldenSourceStatusOracle(
      'commands',
      { url: native.url, cases: [{ orderId: snapshot.orderId, platform: 'PACK' }] },
      fixturePlaceholders(native.url),
    );
    expect(source[0]!.requests[0]!.body.has_product_ids).toEqual(
      snapshot.lines.map((row) => row.id),
    );
    const result = await service.submit(
      actor,
      '1',
      snapshot.orderId,
      input(operationId, scopeHash),
      'r'.repeat(128),
    );
    expect(result).toMatchObject({ operationId, lineCount: 3, state: 'PENDING' });
    expect(records).toHaveLength(0);
    expect(await service.worker.runOnce()).toMatchObject({
      state: 'QUEUED',
      requestId: 'r'.repeat(128),
      userId: '1',
    });
    expect(records[0]!.snapshot.lines).toEqual(snapshot.lines);
  });
  it('serializes20 same-UUID retries and20 worker claims into one durable effect and one outbound call', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.submit(actor, '1', snapshot.orderId, input(operationId, scopeHash)),
      ),
    );
    expect(new Set(outcomes.map((row) => row.operationId)).size).toBe(1);
    await Promise.all(Array.from({ length: 20 }, () => service.worker.runOnce()));
    expect(records).toHaveLength(1);
    expect(await native.db.get('writer').select().from(wholeOrderStatusCommands)).toHaveLength(1);
  }, 20000);
  it('freezes lost outbound outcomes and resolves only by GET without another send', async () => {
    transport.send = async (row) => {
      records.push(row);
      throw new Error('synthetic-private-provider-error');
    };
    await service.submit(actor, '1', snapshot.orderId, input(operationId, scopeHash));
    expect(await service.worker.runOnce()).toMatchObject({ state: 'UNCERTAIN' });
    await service.submit(actor, '1', snapshot.orderId, input(operationId, scopeHash));
    expect(await service.worker.runOnce()).toBeNull();
    expect((await service.read(actor, '1', snapshot.orderId, operationId)).state).toBe('QUEUED');
    expect(records).toHaveLength(1);
    transport.read = async () => null;
    await service.read(actor, '1', snapshot.orderId, operationId);
    expect(records).toHaveLength(1);
  });
  it('binds immutable expected line scope, blocks overlapping platform chains and cross-user UUIDs', async () => {
    await expect(
      service.submit(actor, '1', snapshot.orderId, input(operationId, 'a'.repeat(64))),
    ).rejects.toMatchObject({ code: 'WHOLE_ORDER_STATUS_SCOPE_CHANGED' });
    await service.submit(actor, '1', snapshot.orderId, input(operationId, scopeHash));
    await expect(
      service.submit(actor, '1', snapshot.orderId, {
        operationId: randomUUID(),
        platform: 'SHIP',
        scopeHash,
      }),
    ).rejects.toMatchObject({ code: 'WHOLE_ORDER_STATUS_REQUEST_EXISTS' });
    await expect(
      service.submit(actor, '1', snapshot.orderId, { operationId, platform: 'DELIVER', scopeHash }),
    ).rejects.toMatchObject({ code: 'WHOLE_ORDER_STATUS_COMMAND_CONFLICT' });
  });
  it('refuses mixed store, split/Express whole-order expansion and source partial SUCCESS evidence', async () => {
    await native.fixture.insert('order_stores', {
      id: '12',
      order_id: snapshot.orderId,
      store_id: '2',
      counter_id: '2',
    });
    await expect(
      service.submit(actor, '1', snapshot.orderId, input(operationId, scopeHash)),
    ).rejects.toMatchObject({ code: 'WHOLE_ORDER_STATUS_RECONCILIATION_REQUIRED' });
    await native.connection.query('DELETE FROM order_stores WHERE id=12');
    await native.fixture.insert('orders', {
      id: '101',
      user_id: '7',
      order_ref_no: 'SYNTHETIC-EXPRESS',
      payment_status: '4',
      order_status: '3',
      location_id: null,
      is_split_order: 0,
    });
    await native.fixture.insert('order_stores', {
      id: '12',
      order_id: '101',
      store_id: '1',
      counter_id: '1',
    });
    await native.fixture.insert('has_products', {
      id: '123',
      order_id: '101',
      prod_id: '501',
      qty: 1,
      status: 'DELIVERED',
    });
    await native.fixture.insert('express_line_item', {
      id: '1',
      order_id: '101',
      store_id: '1',
      has_product_id: '123',
    });
    await expect(
      service.submit(actor, '1', '101', input(operationId, scopeHash)),
    ).rejects.toMatchObject({ code: 'WHOLE_ORDER_STATUS_RECONCILIATION_REQUIRED' });
    await native.connection.query('DELETE FROM express_line_item');
    await native.fixture.insert('vinculum_auto_delivered_logs', {
      id: '1',
      order_id: snapshot.orderId,
      platform: 'SHIP',
      status: 'SUCCESS',
      request: JSON.stringify({
        externalOrderno: snapshot.orderId,
        status: 'SHIP',
        items: [{ extLineno: snapshot.lines[0]!.id, sku: '501', qty: '3' }],
      }),
    });
    await expect(
      service.submit(actor, '1', snapshot.orderId, input(operationId, scopeHash)),
    ).rejects.toMatchObject({ code: 'WHOLE_ORDER_STATUS_RECONCILIATION_REQUIRED' });
    expect(records).toHaveLength(0);
  });
  it('blocks fresh dispatch after operator revocation or native HP mutation while retaining accepted intent', async () => {
    await service.submit(actor, '1', snapshot.orderId, input(operationId, scopeHash));
    await native.connection.query('UPDATE has_products SET qty=qty+1 WHERE id=?', [
      snapshot.lines[0]!.id,
    ]);
    expect(await service.worker.runOnce()).toMatchObject({ state: 'BLOCKED' });
    expect(records).toHaveLength(0);
    expect((await service.read(actor, '1', snapshot.orderId, operationId)).state).toBe('BLOCKED');
    await native.connection.query('DELETE FROM user_stores');
    await expect(service.read(actor, '1', snapshot.orderId, operationId)).rejects.toMatchObject({
      status: 403,
    });
  });
  it('records a definite rejected inbound repair once and never changes the original return, cash or stock', async () => {
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
    operationId = returnId;
    await service.repair(actor, '1', snapshot.orderId, {
      operationId,
      returnOperationId: returnId,
    });
    await service.repair(actor, '1', snapshot.orderId, {
      operationId,
      returnOperationId: returnId,
    });
    await service.worker.runOnce();
    expect(records).toHaveLength(1);
    expect(records[0]!.platform).toBe('PACK');
    const [stored] = await native.db
      .get('writer')
      .select()
      .from(returnOperations)
      .where(eq(returnOperations.id, returnId));
    expect(stored!.state).toEqual(operation);
    expect(stored!.phase).toBe('rejected');
    await native.db
      .get('writer')
      .update(returnOperations)
      .set({
        phase: 'uncertain',
        state: {
          ...operation,
          phase: 'uncertain',
          uncertainStage: 'inbound',
          errorCode: 'RETURN_OUTCOME_UNCERTAIN',
        },
      })
      .where(eq(returnOperations.id, returnId));
    await expect(
      service.repair(actor, '1', snapshot.orderId, {
        operationId: returnId,
        returnOperationId: returnId,
      }),
    ).rejects.toMatchObject({ code: 'WHOLE_ORDER_RETURN_REPAIR_NOT_PROVEN' });
  });
  it('does not claim any durable command when the qualified adapter is not ready', async () => {
    await service.repository.submit(actor, '1', snapshot.orderId, input(operationId, scopeHash));
    transport.configured = () => {
      throw new Error('synthetic configuration unavailable');
    };
    await expect(service.worker.runOnce()).rejects.toThrow('synthetic configuration');
    const [row] = await native.db.get('writer').select().from(wholeOrderStatusCommands);
    expect(row!.state).toBe('PENDING');
    expect(row!.attempts).toBe(0);
  });
});
