import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { RowDataPacket } from 'mysql2';
import { Order, Store } from '../../src/db/legacy-schema.js';
import { paymentRepository } from '../../src/modules/checkout/payments/repository.js';
import { paymentService } from '../../src/modules/checkout/payments/service.js';
import { paymentAttempts } from '../../src/modules/checkout/payments/schema.js';
import {
  publicPayment,
  type PaymentGateway,
  type ProviderDecision,
} from '../../src/modules/checkout/payments/contracts.js';
import { pendingCancellationRepository } from '../../src/modules/checkout/cancellations/repository.js';
import { returnRepository } from '../../src/modules/checkout/return-workflow/repository.js';
import { returnOperations } from '../../src/modules/checkout/return-workflow/schema.js';
import { returnInputSchema } from '../../src/modules/checkout/return-workflow/contracts.js';
import { acceptInbound } from '../../src/modules/checkout/return-workflow/service.js';
import { orderFinalizer, prepaidSettlementReader } from '../../src/modules/checkout/finalizer.js';
import { checkoutStateSchema } from '../../src/modules/checkout/contracts.js';
import {
  financialImportOrderBindings,
  financialImportSourceReceipts,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import { sourceOrderReceiptSchema } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import { runtimeImportSecret } from '../legacy-order-imports/runtime-fixture.js';
import { signingEnvironment, identity } from '../checkout/fixtures.js';
import { actor, importHoldFixture, orderId, lineId, productId, projection } from './fixture.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('CSV order holds at native mutation boundaries', () => {
  let f: Awaited<ReturnType<typeof importHoldFixture>>;
  const paymentInput = () => ({
    operationId: randomUUID(),
    channel: 'cash' as const,
    onlineAmount: '0.00',
    cashAmount: '50.00',
    cashReceived: '50.00',
  });
  const state = () => ({
    storeId: '1',
    counterId: '2',
    customerId: '77',
    operatorCustomerId: '77',
    salespersonId: null,
    lineSalespersons: {},
  });
  const payments = () =>
    paymentRepository(f.db, f.config, { hashSecret: runtimeImportSecret, projection });
  const returns = () =>
    returnRepository(f.db, f.config, { hashSecret: runtimeImportSecret, returnPeriodDays: 100000 });
  const cancellation = () =>
    pendingCancellationRepository(f.db, f.config, {
      hashSecret: runtimeImportSecret,
      projection,
      contract: undefined,
      membershipProductIds: undefined,
    });
  beforeAll(async () => {
    f = await importHoldFixture(template!);
  }, 30000);
  afterAll(async () => {
    await f?.close();
    vi.unstubAllEnvs();
  });
  beforeEach(async () => {
    vi.stubEnv('LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1', runtimeImportSecret);
    await f.reset();
  });

  it('blocks payment start/options/context/read/replay and operation-ID reuse before any effect', async () => {
    const held = await f.held(),
      attempt = await f.payment(),
      repository = payments(),
      before = await f.effects();
    const input = { ...paymentInput(), operationId: held.input.operationId };
    for (const run of [
      () => repository.begin(actor, '1', orderId, input),
      () => repository.options(actor, '1', orderId),
      () => repository.paymentContext(actor, '1', orderId),
      () => repository.list(actor, '1', orderId),
      () => repository.get(actor, '1', orderId, attempt.id),
      () => repository.context(actor, '1', orderId, attempt.id),
      () => repository.context(actor, '1', orderId, attempt.id, true),
      () =>
        repository.adoptLegacy(actor, '1', orderId, {
          operationId: held.input.operationId,
          provider: 'pine',
          legacyId: '1',
        }),
    ])
      await expect(run()).rejects.toMatchObject({ code: 'ORDER_IMPORT_ORDER_HELD' });
    const gateway: PaymentGateway = {
        configured: vi.fn(),
        start: vi.fn(),
        status: vi.fn(),
        cancel: vi.fn(),
      },
      service = paymentService(repository, gateway);
    await expect(service.start(actor, '1', orderId, input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_ORDER_HELD',
    });
    await expect(service.reconcile(actor, '1', orderId, attempt.id)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_ORDER_HELD',
    });
    expect(gateway.start).not.toHaveBeenCalled();
    expect(gateway.status).not.toHaveBeenCalled();
    expect(await f.effects()).toEqual(before);
  });
  it('blocks pending cancellation including the matching import operation UUID before stock or ledgers', async () => {
    const held = await f.held(),
      before = await f.effects(),
      repository = cancellation();
    await expect(repository.context(actor, '1', orderId)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_ORDER_HELD',
    });
    await expect(
      repository.create(actor, '1', orderId, {
        operationId: held.input.operationId,
        snapshotHash: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_ORDER_HELD' });
    expect(await f.effects()).toEqual(before);
  });
  it('missing or wrong retained keys never releases an incomplete or completed import', async () => {
    await f.held();
    vi.stubEnv('LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1', '');
    await expect(payments().options(actor, '1', orderId)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_ORDER_HELD',
    });
    await f.reset();
    await legacyOrderImportFinancialAdapter(f.config, f.db, f.options, f.transport()).start(
      f.input(),
    );
    for (const [key, code] of [
      ['', 'ORDER_IMPORT_ORDER_HELD'],
      ['incorrect-retained-proof-key-'.repeat(3), 'ORDER_IMPORT_RECEIPT_INVALID'],
    ] as const) {
      vi.stubEnv('LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1', key);
      await expect(payments().get(actor, '1', orderId, randomUUID())).rejects.toMatchObject({
        code,
      });
    }
  });
  it('a completed sealed import passes its hold check without weakening ordinary payment policy', async () => {
    await legacyOrderImportFinancialAdapter(f.config, f.db, f.options, f.transport()).start(
      f.input(),
    );
    await expect(payments().get(actor, '1', orderId, randomUUID())).rejects.toMatchObject({
      code: 'PAYMENT_ATTEMPT_NOT_FOUND',
    });
    await f.connection.execute('UPDATE has_products SET prod_id=? WHERE id=?', [
      '9007199254740994',
      lineId,
    ]);
    await expect(payments().get(actor, '1', orderId, randomUUID())).rejects.toMatchObject({
      code: 'ORDER_IMPORT_RECEIPT_INVALID',
    });
  });
  it.each(['paid', 'pending', 'failed', 'cancelled', 'uncertain'] as const)(
    'retains an actual %s provider response when a hold is found after dispatch',
    async (status) => {
      await f.held();
      const attempt = await f.payment(),
        before = await f.effects(),
        decision: ProviderDecision = {
          status,
          reference: 'PRIVATE-PROVIDER-REFERENCE',
          code: 'ACTUAL_PROVIDER_OUTCOME',
        },
        repository = payments();
      const result = await repository.decision(
        actor,
        '1',
        orderId,
        attempt.id,
        decision,
        null,
        attempt.busyOperationId,
      );
      expect(result).toMatchObject({
        status: 'uncertain',
        busyOperationId: null,
        errorCode: 'ORDER_IMPORT_HELD_AFTER_DISPATCH',
        heldProviderDecision: decision,
      });
      expect(publicPayment(result)).not.toHaveProperty('heldProviderDecision');
      expect(await f.effects()).toEqual(before);
      await expect(repository.context(actor, '1', orderId, attempt.id)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_ORDER_HELD',
      });
      await expect(
        repository.decision(
          actor,
          '1',
          orderId,
          attempt.id,
          { status: 'uncertain', reference: null, code: 'A_LATER_GENERIC_ERROR' },
          null,
          attempt.busyOperationId,
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_OPERATION_CHANGED' });
      const [row] = await f.db
        .get('writer')
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, attempt.id));
      expect(row?.state.heldProviderDecision).toEqual(decision);
    },
  );
  it('a missing control table fails closed before payment dispatch rather than meaning no hold', async () => {
    const held = await f.held();
    await held.release();
    await f.connection.query(
      'RENAME TABLE pos_rewrite_import_financial_order_bindings TO isolated_hidden_import_bindings',
    );
    try {
      await expect(payments().begin(actor, '1', orderId, paymentInput())).rejects.toBeDefined();
    } finally {
      await f.connection.query(
        'RENAME TABLE isolated_hidden_import_bindings TO pos_rewrite_import_financial_order_bindings',
      );
    }
    expect((await f.effects()).counts.pos_transaction_logs).toBe('0');
  });
  it('records a real dispatched terminal response under a newly observed hold without a second charge or financial completion', async () => {
    const held = await f.held();
    await held.release();
    const [source] = await f.db
      .get('writer')
      .select()
      .from(financialImportSourceReceipts)
      .where(eq(financialImportSourceReceipts.id, held.input.operationId + ':order'));
    await f.confirm(sourceOrderReceiptSchema.parse(source!.proof));
    await f.fixture.insert('pos_terminal_payment_modes', {
      id: 1,
      mode_id: 1,
      name: 'Fixture card',
      platform: 'PINELAB',
      is_active: 1,
    });
    await f.fixture.insert('pos_machines', { id: 1, store_id: 1, counter_id: 2, is_active: 1 });
    const before = await f.effects(),
      decision: ProviderDecision = { status: 'paid', reference: 'ISOLATED-ACK', code: 'APPROVED' },
      gateway: PaymentGateway = {
        configured: vi.fn(),
        start: vi.fn(async () => {
          await held.restore();
          return decision;
        }),
        status: vi.fn(),
        cancel: vi.fn(),
      },
      repository = payments(),
      service = paymentService(repository, gateway),
      input = {
        ...paymentInput(),
        channel: 'pine-card' as const,
        machineId: '1',
        onlineAmount: '50.00',
        cashAmount: '0.00',
        cashReceived: '0.00',
      };
    expect(await service.start(actor, '1', orderId, input)).toMatchObject({
      status: 'uncertain',
      errorCode: 'ORDER_IMPORT_HELD_AFTER_DISPATCH',
    });
    expect(gateway.start).toHaveBeenCalledTimes(1);
    await expect(service.start(actor, '1', orderId, input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_ORDER_HELD',
    });
    await expect(service.reconcile(actor, '1', orderId, input.operationId)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_ORDER_HELD',
    });
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(gateway.status).not.toHaveBeenCalled();
    const [saved] = await f.db
      .get('writer')
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, input.operationId));
    expect(saved?.state.heldProviderDecision).toEqual(decision);
    expect(await f.effects()).toEqual(before);
  });
  it('blocks return/exchange creation and every inbound/refund/restock checkpoint before effects', async () => {
    const held = await f.held(),
      repository = returns(),
      input = returnInputSchema.parse({
        operationId: held.input.operationId,
        counterId: '2',
        verificationId: randomUUID(),
        reasonId: '1',
        qualityConfirmed: true,
        tagConfirmed: true,
        saleable: false,
        refundMode: 'cash',
      });
    await expect(repository.begin(actor, '1', orderId, lineId, input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_ORDER_HELD',
    });
    await expect(
      repository.begin(actor, '1', orderId, lineId, input, {
        replacementProductId: productId,
        salespersonId: '1',
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_ORDER_HELD' });
    const operation = await f.operation(),
      before = await f.effects();
    for (const run of [
      () => repository.read(actor, '1', operation.id),
      () => repository.inboundData(actor, '1', operation.id),
      () => repository.accepted(actor, '1', operation.id),
      () => repository.claimRefund(actor, '1', operation.id),
      () => repository.complete(actor, '1', operation.id),
      () => repository.restoreExchange(actor, '1', operation.id),
      () => repository.claimReplacement(actor, '1', operation.id),
      () => repository.completeExchange(actor, '1', operation.id),
    ])
      await expect(run()).rejects.toMatchObject({ code: 'ORDER_IMPORT_ORDER_HELD' });
    expect(await f.effects()).toEqual(before);
  });
  it('preserves a definite warehouse rejection and its repair obligation despite a newly observed import hold', async () => {
    await f.held();
    const operation = await f.operation(),
      before = await f.effects();
    const saved = await returns().failure(
      actor,
      '1',
      operation.id,
      'inbound',
      false,
      'RETURN_INBOUND_REJECTED',
    );
    expect(saved).toMatchObject({ phase: 'rejected', errorCode: 'RETURN_INBOUND_REJECTED' });
    const [rows] = await f.connection.query(
      'SELECT return_id,state,error_code FROM pos_rewrite_return_repair_obligations',
    );
    expect(rows).toEqual([
      expect.objectContaining({
        return_id: operation.id,
        state: 'BLOCKED',
        error_code: 'RETURN_REPAIR_DISPATCHER_DISABLED',
      }),
    ]);
    expect(await f.effects()).toEqual(before);
  });
  it('retains confirmed warehouse acceptance as uncertain if the native acceptance is held; it never creates a rejection repair', async () => {
    const held = await f.held();
    await held.release();
    const operation = await f.operation(),
      repository = returns(),
      before = await f.effects();
    const gateway = {
      configured: vi.fn(),
      sendOtp: vi.fn(),
      verifyOtp: vi.fn(),
      eligibility: vi.fn(async () => ({ allowed: true, until: null })),
      inbound: vi.fn(async () => {
        await held.restore();
      }),
      refund: vi.fn(),
    };
    await expect(
      acceptInbound(
        actor,
        operation,
        repository,
        { customer: async () => identity('77') },
        gateway,
        signingEnvironment,
        f.config.BUSINESS_TIMEZONE,
      ),
    ).rejects.toMatchObject({ code: 'RETURN_INBOUND_CONFIRMED_IMPORT_HELD' });
    const [row] = await f.db
      .get('writer')
      .select()
      .from(returnOperations)
      .where(eq(returnOperations.id, operation.id));
    expect(row?.state).toMatchObject({
      phase: 'uncertain',
      uncertainStage: 'inbound',
      errorCode: 'RETURN_INBOUND_CONFIRMED_IMPORT_HELD',
    });
    expect(gateway.inbound).toHaveBeenCalledTimes(1);
    expect(await f.effects()).toEqual(before);
    const [repairs] = await f.connection.query(
      'SELECT COUNT(*) n FROM pos_rewrite_return_repair_obligations',
    );
    expect(repairs).toEqual([{ n: '0' }]);
  });
  it('retains an already confirmed refund amount while prohibiting subsequent stock/native completion', async () => {
    await f.held();
    const operation = await f.operation('return', 'refund-dispatching'),
      before = await f.effects(),
      repository = returns();
    expect(await repository.refundConfirmed(actor, '1', operation.id, '50.00')).toMatchObject({
      phase: 'refund-confirmed',
      returnAmount: '50.00',
    });
    await expect(repository.complete(actor, '1', operation.id)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_ORDER_HELD',
    });
    await repository.failure(actor, '1', operation.id, 'refund', true, 'ORDER_IMPORT_ORDER_HELD');
    const [row] = await f.db
      .get('writer')
      .select()
      .from(returnOperations)
      .where(eq(returnOperations.id, operation.id));
    expect(row?.state).toMatchObject({ phase: 'refund-confirmed', returnAmount: '50.00' });
    expect(await f.effects()).toEqual(before);
  });
  it('retains confirmed inbound evidence even when the hold control table disappears after dispatch', async () => {
    const held = await f.held();
    await held.release();
    const operation = await f.operation(),
      before = await f.effects(),
      gateway = {
        configured: vi.fn(),
        sendOtp: vi.fn(),
        verifyOtp: vi.fn(),
        eligibility: vi.fn(async () => ({ allowed: true, until: null })),
        inbound: vi.fn(async () => {
          await f.connection.query(
            'RENAME TABLE pos_rewrite_import_financial_order_bindings TO isolated_hidden_import_bindings',
          );
        }),
        refund: vi.fn(),
      };
    try {
      await expect(
        acceptInbound(
          actor,
          operation,
          returns(),
          { customer: async () => identity('77') },
          gateway,
          signingEnvironment,
          f.config.BUSINESS_TIMEZONE,
        ),
      ).rejects.toMatchObject({ code: 'RETURN_INBOUND_CONFIRMED_NATIVE_UNCOMMITTED' });
    } finally {
      await f.connection.query(
        'RENAME TABLE isolated_hidden_import_bindings TO pos_rewrite_import_financial_order_bindings',
      );
    }
    const [row] = await f.db
      .get('writer')
      .select()
      .from(returnOperations)
      .where(eq(returnOperations.id, operation.id));
    expect(row?.state).toMatchObject({
      phase: 'uncertain',
      uncertainStage: 'inbound',
      errorCode: 'RETURN_INBOUND_CONFIRMED_NATIVE_UNCOMMITTED',
    });
    expect(gateway.inbound).toHaveBeenCalledTimes(1);
    expect(await f.effects()).toEqual(before);
  });
  it('retains the original replacement acknowledgment but forbids parent-held finalization', async () => {
    await f.held();
    const operation = await f.operation('exchange', 'replacement-dispatching'),
      before = await f.effects(),
      repository = returns();
    expect(
      await repository.replacementConfirmed(actor, '1', operation.id, '9007199254741001'),
    ).toMatchObject({
      phase: 'replacement-confirmed',
      exchange: { childOrderId: '9007199254741001' },
    });
    await expect(
      repository.assertExchangeFinalizationAvailable(actor, '1', operation.id),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_ORDER_HELD' });
    expect(await f.effects()).toEqual(before);
  });
  it('guards both parent and replacement under finalizer locks before invoice/salesperson/voucher/outbox writes', async () => {
    const held = await f.held(),
      childId = '9007199254741001';
    await f.fixture.insert('orders', {
      id: childId,
      user_id: '77',
      parent_order_id: orderId,
      payment_status: 1,
      order_status: 1,
      created_at: '2026-06-15 12:00:00',
      updated_at: '2026-06-15 12:00:00',
    });
    await f.fixture.insert('order_stores', {
      id: 2,
      order_id: childId,
      store_id: 1,
      counter_id: 2,
      order_invoice: '',
    });
    const before = await f.effects();
    await expect(
      orderFinalizer(f.db, f.config, 'exchange')(state(), childId),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_ORDER_HELD' });
    expect(await f.effects()).toEqual(before);
    await held.release();
    await f.db
      .get('writer')
      .insert(financialImportOrderBindings)
      .values({ ...held.binding, orderId: childId });
    await expect(
      orderFinalizer(f.db, f.config, 'exchange')(state(), childId),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_ORDER_HELD' });
    const [invoices] = await f.connection.query(
      'SELECT order_invoice FROM order_stores ORDER BY id',
    );
    expect(invoices).toEqual([{ order_invoice: null }, { order_invoice: '' }]);
  });
  it('blocks exchange read/finalization/completion when only the known child is held', async () => {
    const held = await f.held(),
      childId = '9007199254741001';
    await held.release();
    await f.fixture.insert('orders', { id: childId, user_id: '77', parent_order_id: orderId });
    await f.db
      .get('writer')
      .insert(financialImportOrderBindings)
      .values({ ...held.binding, orderId: childId });
    const operation = await f.operation('exchange', 'replacement-confirmed', childId),
      repository = returns(),
      before = await f.effects();
    for (const read of [
      () => repository.read(actor, '1', operation.id),
      () => repository.assertExchangeFinalizationAvailable(actor, '1', operation.id),
      () => repository.completeExchange(actor, '1', operation.id),
    ])
      await expect(read()).rejects.toMatchObject({ code: 'ORDER_IMPORT_ORDER_HELD' });
    expect(await f.effects()).toEqual(before);
  });
  it('prepaid settlement reads cannot bypass a live hold', async () => {
    await f.held();
    const checkout = checkoutStateSchema.parse({
      id: randomUUID(),
      operatorId: '1',
      storeId: '1',
      counterId: '2',
      operatorCustomerId: '77',
      customerId: '77',
      phase: 'submitted',
      orderId,
      orderSubmissionOperationId: randomUUID(),
      version: 1,
      tabId: 1,
      verifiedCustomerUntil: null,
      cart: null,
      quote: null,
      paymentConfirmation: null,
      salespersonId: null,
      lineSalespersons: {},
      giftCards: {},
      busyOperationId: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await expect(prepaidSettlementReader(f.db)(checkout)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_ORDER_HELD',
    });
  });
  it('unbound normal orders still finalize and take one cash payment with existing native projection policy', async () => {
    const held = await f.held();
    await held.release();
    const [row] = await f.db
      .get('writer')
      .select()
      .from(financialImportSourceReceipts)
      .where(eq(financialImportSourceReceipts.id, held.input.operationId + ':order'));
    await f.confirm(sourceOrderReceiptSchema.parse(row!.proof));
    const result = await orderFinalizer(f.db, f.config)(state(), orderId);
    expect(result.invoice).toContain('INV');
    const gateway: PaymentGateway = {
        configured: vi.fn(),
        start: vi.fn(),
        status: vi.fn(),
        cancel: vi.fn(),
      },
      service = paymentService(payments(), gateway),
      input = paymentInput();
    expect(await service.start(actor, '1', orderId, input)).toMatchObject({ status: 'paid' });
    expect(await service.start(actor, '1', orderId, input)).toMatchObject({ status: 'paid' });
    expect(gateway.start).not.toHaveBeenCalled();
    expect((await f.effects()).counts.pos_transaction_logs).toBe('1');
  });
  it('locks parent then child consistently while another store finalizes the replacement', async () => {
    const held = await f.held();
    await held.release();
    const childId = '9007199254741001';
    await f.fixture.insert('stores', {
      id: 2,
      type: 'STORE',
      is_active: 1,
      location_code: 'OTHER',
    });
    await f.fixture.insert('store_counters', { id: 3, store_id: 2, is_active: 1 });
    await f.fixture.insert('orders', {
      id: childId,
      user_id: '77',
      parent_order_id: orderId,
      payment_status: 1,
      order_status: 1,
      created_at: '2026-06-15 12:00:00',
      updated_at: '2026-06-15 12:00:00',
    });
    await f.fixture.insert('order_stores', {
      id: 2,
      order_id: childId,
      store_id: 2,
      counter_id: 3,
      order_invoice: '',
    });
    let ready: () => void = () => {},
      start: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
        ready = resolve;
      }),
      begin = new Promise<void>((resolve) => {
        start = resolve;
      });
    const parentWriter = f.db.get('writer').transaction(async (tx) => {
      await tx.select({ id: Store.id }).from(Store).where(eq(Store.id, 1n)).for('update');
      await tx
        .select({ id: Order.id })
        .from(Order)
        .where(eq(Order.id, BigInt(orderId)))
        .for('update');
      ready();
      await begin;
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [rows] = await f.connection.query<RowDataPacket[]>(
          "SELECT COUNT(*) n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID AND l.ENGINE=w.ENGINE WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME='orders'",
        );
        if (Number(rows[0]!.n) > 0) {
          waiting = true;
          break;
        }
        await pause(10);
      }
      expect(waiting).toBe(true);
      await tx
        .select({ id: Order.id })
        .from(Order)
        .where(eq(Order.id, BigInt(childId)))
        .for('update');
    });
    await locked;
    const childWriter = orderFinalizer(
      f.db,
      f.config,
      'exchange',
    )({ ...state(), storeId: '2', counterId: '3' }, childId);
    start();
    await expect(Promise.all([parentWriter, childWriter])).resolves.toEqual([
      undefined,
      expect.objectContaining({ invoice: expect.stringContaining('OTHER') }),
    ]);
  });
});
