import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { Store, Order } from '../../src/db/legacy-schema.js';
import { returnRepository } from '../../src/modules/checkout/return-workflow/repository.js';
import {
  returnOperationSchema,
  type ReturnOperation,
} from '../../src/modules/checkout/return-workflow/contracts.js';
import { returnOperations } from '../../src/modules/checkout/return-workflow/schema.js';
import { wholeOrderStatusService } from '../../src/modules/legacy-order-status/service.js';
import { registerWholeOrderStatus } from '../../src/modules/legacy-order-status/index.js';
import { wholeOrderStatusCommands } from '../../src/modules/legacy-order-status/schema.js';
import {
  returnRepairObligations,
  returnRepairRecoveries,
} from '../../src/modules/legacy-order-status/repair-schema.js';
import {
  assertNoActiveWholeOrderHandover,
  type AssertHandoverAvailable,
} from '../../src/modules/legacy-order-status/handover.js';
import { wholeStatusFixture } from './mysql-fixture.js';
import { acceptInbound } from '../../src/modules/checkout/return-workflow/service.js';
import { CheckoutGatewayError } from '../../src/modules/checkout/gateway.js';
import { snapshot, options, queuedReceipt } from './fixtures.js';
import type {
  WholeOrderStatusTransport,
  StatusCommand,
} from '../../src/modules/legacy-order-status/transport.js';
const template = process.env.WHOLE_ORDER_STATUS_MYSQL_TEST_URL,
  actor: Principal = {
    id: '1',
    role: 2,
    userType: 1,
    storeIds: ['1'],
    name: 'Synthetic',
    email: '',
  },
  manager: Principal = {
    id: '2',
    role: 3,
    userType: 1,
    storeIds: ['1'],
    name: 'Synthetic manager',
    email: '',
  };
describe.skipIf(!template)('original failed-return producer and durable repair dispatcher', () => {
  let native: Awaited<ReturnType<typeof wholeStatusFixture>>,
    operation: ReturnOperation,
    service: ReturnType<typeof wholeOrderStatusService>,
    transport: WholeOrderStatusTransport,
    calls: StatusCommand[],
    fenced: boolean,
    barrier: AssertHandoverAvailable;
  beforeAll(async () => {
    native = await wholeStatusFixture(template!);
    await native.fixture.create(['reverse_pickup_reason']);
    await native.connection.query(
      'CREATE TABLE synthetic_pending_handover(order_id VARCHAR(32) PRIMARY KEY)',
    );
  });
  afterAll(async () => {
    await native?.close();
  });
  beforeEach(async () => {
    await native.reset();
    fenced = false;
    calls = [];
    await native.fixture.insert('reverse_pickup_reason', {
      id: '1',
      reason: 'Synthetic return',
      type: 1,
    });
    for (const user of [actor, manager]) {
      await native.fixture.insert('pos_user', {
        id: user.id,
        username: 'synthetic-' + user.id,
        password: 'synthetic-password',
        role: user.role,
        user_type: 1,
        is_active: 1,
      });
      await native.fixture.insert('user_stores', {
        id: user.id,
        django_user_id: user.id,
        store_id: '1',
      });
    }
    for (const id of ['1', '2']) {
      await native.fixture.insert('stores', {
        id,
        store_name: 'Synthetic',
        location_code: id === '1' ? 'SYN' : 'OTHER',
        is_active: 1,
        type: 'STORE',
        category: 'IN_HOUSE',
      });
      await native.fixture.insert('store_counters', {
        id,
        store_id: id,
        counter_name: 'Synthetic',
        is_active: 1,
      });
    }
    for (const user of [actor, manager])
      await native.connection.query(
        "INSERT INTO pos_rewrite_operator_checkins(operator_id,store_id,counter_id,checked_in_at,expires_at) VALUES(?,1,1,'2026-11-17 06:00:00','2099-01-01 00:00:00')",
        [user.id],
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
      location_id: null,
      is_split_order: 0,
      order_amt: 100,
      pay_amt: 100,
    });
    await native.fixture.insert('order_stores', {
      id: '11',
      order_id: snapshot.orderId,
      store_id: '1',
      counter_id: '1',
      offline_payment: 100,
    });
    for (const line of snapshot.lines)
      await native.fixture.insert('has_products', {
        id: line.id,
        order_id: snapshot.orderId,
        prod_id: line.productId,
        sub_prod_id: line.subProductId,
        qty: line.quantity,
        status: 'DELIVERED',
      });
    const id = randomUUID();
    operation = returnOperationSchema.parse({
      id,
      operatorId: '1',
      storeId: '1',
      orderId: snapshot.orderId,
      lineId: snapshot.lines[0]!.id,
      productId: '501',
      customerId: '7',
      quantity: 3,
      input: {
        operationId: id,
        counterId: '1',
        verificationId: randomUUID(),
        reasonId: '1',
        qualityConfirmed: true,
        tagConfirmed: true,
        saleable: true,
      },
      requestHash: 'a'.repeat(64),
      phase: 'inbound-dispatching',
      uncertainStage: null,
      creditNote: null,
      returnAmount: null,
      errorCode: null,
      createdAt: '2026-11-17 06:00:00',
      updatedAt: '2026-11-17 06:00:00',
    });
    await native.db.get('writer').insert(returnOperations).values({
      id,
      lineId: operation.lineId,
      storeId: '1',
      phase: operation.phase,
      state: operation,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    });
    barrier = async (tx, ids) => {
      if (fenced)
        throw new AppError(409, 'SYNTHETIC_HANDOVER_HELD', 'A current handover barrier is armed.');
      const [result] = await tx.execute(
        sql`SELECT order_id FROM synthetic_pending_handover WHERE order_id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`,`,
        )}) FOR SHARE`,
      );
      if (Array.isArray(result) && result.length)
        throw new AppError(409, 'SYNTHETIC_HANDOVER_HELD', 'A current handover barrier is armed.');
    };
    transport = {
      configured() {},
      async send(row) {
        calls.push(row);
        return queuedReceipt(row);
      },
      async read(row) {
        return queuedReceipt(row);
      },
    };
    service = wholeOrderStatusService(
      native.config,
      native.db,
      { ...options, WHOLE_ORDER_STATUS_WORKER_ENABLED: true },
      { transport, assertHandoverAvailable: barrier },
    );
  });
  function returns(enabled = true) {
    return returnRepository(native.db, native.config, {
      hashSecret: 'synthetic-return-key-'.repeat(3),
      returnPeriodDays: undefined,
      rejectedInboundRepairDispatcherEnabled: enabled,
    });
  }
  async function fail(enabled = true) {
    return returns(enabled).failure(
      actor,
      '1',
      operation.id,
      'inbound',
      false,
      'RETURN_INBOUND_REJECTED',
    );
  }
  it('atomically retains original rejection plus an explicit disabled obligation without a phantom PACK', async () => {
    const rejected = await fail(false);
    expect(rejected).toMatchObject({ phase: 'rejected', errorCode: 'RETURN_INBOUND_REJECTED' });
    const [row] = await native.db.get('writer').select().from(returnRepairObligations);
    expect(row).toMatchObject({
      returnId: operation.id,
      commandId: operation.id,
      state: 'BLOCKED',
      errorCode: 'RETURN_REPAIR_DISPATCHER_DISABLED',
    });
    expect(await native.db.get('writer').select().from(wholeOrderStatusCommands)).toEqual([]);
    expect(calls).toEqual([]);
    const [started] = await native.connection.query('SELECT offline_payment FROM order_stores');
    expect(started).toEqual([{ offline_payment: 100 }]);
  });
  it('serializes20 producer retries and20 dispatchers into one original-UUID command and one qualified send', async () => {
    await Promise.all([
      ...Array.from({ length: 20 }, () => fail()),
      ...Array.from({ length: 20 }, () => service.repairs.runOnce()),
    ]);
    expect(await native.db.get('writer').select().from(returnRepairObligations)).toHaveLength(1);
    await Promise.all(Array.from({ length: 20 }, () => service.repairs.runOnce()));
    const commands = await native.db.get('writer').select().from(wholeOrderStatusCommands);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      id: operation.id,
      returnOperationId: operation.id,
      source: 'return-failure',
      platform: 'PACK',
    });
    await Promise.all(Array.from({ length: 20 }, () => service.worker.runOnce()));
    expect(calls).toHaveLength(1);
    expect((await returns().read(actor, '1', operation.id)).errorCode).toBe(
      'RETURN_INBOUND_REJECTED',
    );
  }, 20000);
  it.each(['unsupported-store', 'handover-held', 'revoked-operator'] as const)(
    'records a blocked %s repair without rolling back or replacing rejection',
    async (mode) => {
      const original = await fail();
      if (mode === 'unsupported-store')
        await native.fixture.insert('order_stores', {
          id: '12',
          order_id: snapshot.orderId,
          store_id: '2',
          counter_id: '2',
        });
      if (mode === 'handover-held') fenced = true;
      if (mode === 'revoked-operator')
        await native.connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
      expect(await service.repairs.runOnce()).toMatchObject({ state: 'BLOCKED' });
      const [row] = await native.db.get('writer').select().from(returnOperations);
      expect(row!.state).toEqual(original);
      expect(await native.db.get('writer').select().from(wholeOrderStatusCommands)).toEqual([]);
      expect(calls).toHaveLength(0);
    },
  );
  it('retains a definite negative acknowledgment even if the original operator is archived after dispatch', async () => {
    await native.connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
    const rejected = await fail();
    expect(rejected.errorCode).toBe('RETURN_INBOUND_REJECTED');
    const [row] = await native.db.get('writer').select().from(returnRepairObligations);
    expect(row).toMatchObject({ state: 'BLOCKED', errorCode: 'RETURN_REPAIR_ACTOR_CHANGED' });
    expect(calls).toHaveLength(0);
  });
  it.each([
    { stage: 'inbound', uncertain: true, code: 'RETURN_OUTCOME_UNCERTAIN' },
    { stage: 'refund', uncertain: false, code: 'RETURN_INBOUND_REJECTED' },
    { stage: 'inbound', uncertain: false, code: 'EXCHANGE_REPLACEMENT_REJECTED' },
  ] as const)('never arms repair for $stage/$code', async (value) => {
    await returns().failure(actor, '1', operation.id, value.stage, value.uncertain, value.code);
    expect(await native.db.get('writer').select().from(returnRepairObligations)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
  it('lets a current checked-in manager recover a blocked obligation idempotently, retaining original actor/UUID', async () => {
    await fail(false);
    const before = await service.repairs.read(manager, '1', snapshot.orderId, operation.id),
      recovery = { operationId: randomUUID(), expectedVersion: before.version };
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.repairs.recover(manager, '1', snapshot.orderId, operation.id, recovery),
      ),
    );
    expect(
      results.every((row) => row.operationId === operation.id && row.state === 'PENDING'),
    ).toBe(true);
    expect(await native.db.get('writer').select().from(returnRepairRecoveries)).toHaveLength(1);
    await service.repairs.runOnce();
    await service.worker.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.operatorId).toBe('1');
    expect(
      (await service.repairs.read(manager, '1', snapshot.orderId, operation.id)).command?.state,
    ).toBe('QUEUED');
  }, 20000);
  it('recovers a lost effect response through manager GET only and never creates or sends another command', async () => {
    transport.send = async (row) => {
      calls.push(row);
      throw new AppError(502, 'WHOLE_ORDER_STATUS_OUTCOME_UNKNOWN', 'Unknown synthetic outcome.');
    };
    await fail();
    await service.repairs.runOnce();
    await service.worker.runOnce();
    expect(calls).toHaveLength(1);
    const viewed = await service.repairs.read(manager, '1', snapshot.orderId, operation.id);
    expect(viewed.command?.state).toBe('QUEUED');
    await service.repairs.recover(manager, '1', snapshot.orderId, operation.id, {
      operationId: randomUUID(),
      expectedVersion: viewed.version,
    });
    await service.repairs.runOnce();
    await service.worker.runOnce();
    expect(calls).toHaveLength(1);
    expect(await native.db.get('writer').select().from(wholeOrderStatusCommands)).toHaveLength(1);
  });
  it('fails closed without a mutation barrier and preserves a pending-intent/whole-order race under Store→Order locks', async () => {
    const missing = wholeOrderStatusService(native.config, native.db, options, { transport });
    const scope = (await service.status(actor, '1', snapshot.orderId)).scopeHash;
    await expect(
      missing.submit(actor, '1', snapshot.orderId, {
        operationId: randomUUID(),
        platform: 'PACK',
        scopeHash: scope,
      }),
    ).rejects.toMatchObject({ code: 'WHOLE_ORDER_HANDOVER_FENCE_REQUIRED' });
    const commandId = randomUUID(),
      prepare = () =>
        native.db.get('writer').transaction(async (tx) => {
          await tx.select({ id: Store.id }).from(Store).where(eq(Store.id, 1n)).for('update');
          await tx
            .select({ id: Order.id })
            .from(Order)
            .where(eq(Order.id, BigInt(snapshot.orderId)))
            .for('update');
          await assertNoActiveWholeOrderHandover(tx, [snapshot.orderId]);
          await tx.execute(
            sql`INSERT INTO synthetic_pending_handover(order_id) VALUES(${snapshot.orderId})`,
          );
        });
    const result = await Promise.allSettled([
      service.submit(actor, '1', snapshot.orderId, {
        operationId: commandId,
        platform: 'PACK',
        scopeHash: scope,
      }),
      prepare(),
    ]);
    expect(result.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    await service.worker.runOnce();
    expect(calls.length).toBeLessThanOrEqual(1);
  });
  it('serves scoped manager status/recovery over HTTP and rejects stale or foreign scope before requeue', async () => {
    await fail(false);
    const app = Fastify({ logger: false });
    app.decorateRequest('principal', null);
    app.decorateRequest('authSessionValid', null);
    app.addHook('onRequest', async (request) => {
      request.principal = manager;
      request.authSessionValid = async () => true;
    });
    app.setErrorHandler((error, _req, reply) =>
      reply
        .code(error instanceof AppError ? error.status : 500)
        .send({ error: { code: error instanceof AppError ? error.code : 'INTERNAL' } }),
    );
    await registerWholeOrderStatus(app, native.config, native.db, options, { service });
    try {
      const base = '/api/v1/stores/1/orders/' + snapshot.orderId + '/status-repair-obligations';
      const listed = await app.inject({ url: base });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().obligations).toHaveLength(1);
      const response = await app.inject({
        method: 'POST',
        url: base + '/' + operation.id + '/recoveries',
        payload: { operationId: randomUUID(), expectedVersion: 1 },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ operationId: operation.id, state: 'PENDING' });
      await native.connection.query('DELETE FROM user_stores WHERE django_user_id=2');
      expect((await app.inject({ url: base + '/' + operation.id })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
  it('preserves the actual inbound gateway rejection through the full service even when dispatch is disabled', async () => {
    const rejection = new CheckoutGatewayError(
      'RETURN_INBOUND_REJECTED',
      'The warehouse did not confirm receipt of this return.',
      false,
      422,
    );
    const customer = {
      id: '7',
      email: '',
      firstName: 'Synthetic',
      lastName: '',
      telephone: '',
      twoFactor: false,
      exclusive: false,
      active: true,
    };
    const gateway = {
      configured() {},
      async sendOtp() {
        throw new Error('Unexpected OTP');
      },
      async verifyOtp() {
        return false;
      },
      async eligibility() {
        return { allowed: true, until: null };
      },
      async inbound() {
        throw rejection;
      },
      async refund() {
        throw new Error('Unexpected refund');
      },
    };
    await expect(
      acceptInbound(
        actor,
        operation,
        returns(false),
        { customer: async () => customer },
        gateway,
        { hs256: 'synthetic-customer-signing-'.repeat(3) },
        'Asia/Kolkata',
      ),
    ).rejects.toBe(rejection);
    const [row] = await native.db.get('writer').select().from(returnOperations);
    expect(row!.state).toMatchObject({ phase: 'rejected', errorCode: 'RETURN_INBOUND_REJECTED' });
    expect(await native.db.get('writer').select().from(returnRepairObligations)).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
  it('runs the registered production worker entry from obligation linkage through one qualified dispatch', async () => {
    await fail();
    const app = Fastify({ logger: false });
    await registerWholeOrderStatus(
      app,
      native.config,
      native.db,
      { ...options, WHOLE_ORDER_STATUS_WORKER_ENABLED: true },
      { service },
    );
    try {
      await app.ready();
      await expect.poll(() => calls.length).toBe(1);
      const [row] = await native.db.get('writer').select().from(returnRepairObligations);
      expect(row).toMatchObject({ state: 'LINKED', commandId: operation.id });
    } finally {
      await app.close();
    }
  });
  it.each(['customer', 'quantity'] as const)(
    'rolls back the enqueue savepoint when the original rejected %s proof changed',
    async (field) => {
      const original = await fail();
      if (field === 'customer')
        await native.connection.query('UPDATE orders SET user_id=8 WHERE id=?', [snapshot.orderId]);
      else
        await native.connection.query('UPDATE has_products SET qty=4 WHERE id=?', [
          operation.lineId,
        ]);
      expect(await service.repairs.runOnce()).toMatchObject({
        state: 'BLOCKED',
        errorCode: 'RETURN_REPAIR_SOURCE_CHANGED',
      });
      expect(await native.db.get('writer').select().from(wholeOrderStatusCommands)).toEqual([]);
      const [row] = await native.db.get('writer').select().from(returnOperations);
      expect(row!.state).toEqual(original);
      expect(calls).toHaveLength(0);
    },
  );
  it('does not let a mutated terminal command flag hide an unproved handover', async () => {
    const scopeHash = (await service.status(actor, '1', snapshot.orderId)).scopeHash;
    await service.submit(actor, '1', snapshot.orderId, {
      operationId: randomUUID(),
      platform: 'PACK',
      scopeHash,
    });
    await native.connection.query(
      "UPDATE pos_rewrite_whole_order_status_commands SET state='SUCCEEDED'",
    );
    await expect(
      native.db
        .get('writer')
        .transaction((tx) => assertNoActiveWholeOrderHandover(tx, [snapshot.orderId])),
    ).rejects.toMatchObject({ code: 'WHOLE_ORDER_HANDOVER_RECONCILIATION_REQUIRED' });
  });
});
