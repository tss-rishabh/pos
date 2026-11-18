import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Principal } from '../../src/domain/access.js';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { orderMutationGuards } from '../../src/modules/checkout/order-mutation-guards.js';
import { paymentReversalRepository } from '../../src/modules/checkout/payment-reversals/repository.js';
import { cashReturnIntents } from '../../src/modules/checkout/payment-reversals/intent-schema.js';
import { cashReturnClaims } from '../../src/modules/checkout/payment-reversals/intent-claim-schema.js';
import { cashReturnClaimBody } from '../../src/modules/checkout/payment-reversals/intent-claim-contracts.js';
import { claimHash } from '../../src/modules/checkout/payment-reversals/intent-claim-evidence.js';
import { buildPrivateWholeOrderStatusRuntime } from '../../src/modules/legacy-order-status/runtime.js';
import { wholeOrderStatusRepository } from '../../src/modules/legacy-order-status/repository.js';
import {
  sourceStatusBody,
  receiptSchema,
  receiptSignature,
} from '../../src/modules/legacy-order-status/domain.js';
import { wholeOrderStatusCommands } from '../../src/modules/legacy-order-status/schema.js';
import {
  statusAttempts,
  statusReceivers,
  statusVendorCalls,
} from '../../src/modules/legacy-order-status/receiver-schema.js';
import { options, snapshot } from './fixtures.js';
import { wholeStatusFixture } from './mysql-fixture.js';
import { privateRuntimeEnv, privateReceiverHeaders } from './private-runtime-fixtures.js';

const template = process.env.WHOLE_ORDER_STATUS_MYSQL_TEST_URL,
  actor: Principal = {
    id: '1',
    role: 2,
    userType: 1,
    storeIds: ['1'],
    name: 'Synthetic',
    email: '',
  },
  keys = {
    cashReturnProofKey: privateRuntimeEnv().POS_PAYMENT_CORRECTION_PROOF_KEY_V1!,
  };

describe.skipIf(!template)('standalone private runtime with real shared financial barriers', () => {
  let native: Awaited<ReturnType<typeof wholeStatusFixture>>,
    runtime: Extract<
      Awaited<ReturnType<typeof buildPrivateWholeOrderStatusRuntime>>,
      { enabled: true }
    >,
    now: number,
    fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeAll(async () => {
    native = await wholeStatusFixture(template!);
    // All DDL is confined to the random localhost fixture schema. These are the
    // exact deployed migrations, not simplified stand-ins for the guard tables.
    for (const path of [
      'migrations/0002_auth_sessions.sql',
      'src/modules/checkout/migrations/0003_payments.sql',
      'src/modules/checkout/payment-reversals/migration.sql',
      'src/modules/checkout/payment-reversals/intent-migration.sql',
    ])
      for (const statement of readFileSync(path, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((value) => value.trim()))
        await native.connection.query(statement);
  });
  afterAll(async () => native?.close());
  afterEach(async () => runtime?.stop());
  beforeEach(async () => {
    await native.reset();
    now = Date.parse('2026-11-17T06:00:00Z');
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
      payment_method: 14,
      payment_status: '4',
      order_status: '3',
      location_id: null,
      is_split_order: 0,
      created_at: '2026-11-17 11:30:00',
    });
    await native.fixture.insert('order_stores', {
      id: '11',
      order_id: snapshot.orderId,
      store_id: '1',
      counter_id: '1',
      offline_payment: 50,
      offline_payment_recieved: 50,
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
    for (const [id, parent] of [
      ['501', '500'],
      ['500', '0'],
    ] as const)
      await native.fixture.insert('products', {
        id,
        parent_prod_id: parent,
        url_key: 'synthetic-' + id,
      });
    fetcher = vi.fn(async () => {
      throw new Error('No live fulfillment request is permitted.');
    });
    const built = await buildPrivateWholeOrderStatusRuntime(
      privateRuntimeEnv({
        MYSQL_WRITER_URL: native.url,
        MYSQL_PRIMARY_READER_URL: native.url,
        MYSQL_DATA_READER_URL: native.url,
      }),
      { logger: false, clock: () => now, fetcher },
    );
    if (!built.enabled) throw new Error('Expected the isolated selected runtime.');
    runtime = built;
  });
  async function createCommand() {
    const repository = wholeOrderStatusRepository(
        native.config,
        native.db,
        () => now,
        orderMutationGuards(keys).assertHandoverAvailable,
      ),
      current = await repository.status(actor, '1', snapshot.orderId),
      result = await repository.submit(
        actor,
        '1',
        snapshot.orderId,
        { operationId: randomUUID(), platform: 'PACK', scopeHash: current.scopeHash },
        'synthetic-private-runtime-request',
      );
    await repository.claim();
    const [row] = await native.db
      .get('writer')
      .select()
      .from(wholeOrderStatusCommands)
      .where(eq(wholeOrderStatusCommands.id, result.operationId));
    if (!row || row.state !== 'SENDING') throw new Error('Expected the real authorized command.');
    return row;
  }
  async function held(_kind: 'cash') {
    // A retained already-returned claim is intentionally accepted independently
    // of new handover eligibility. Seal a valid fixture claim; do not forge a paid
    // flag or pretend this test certifies its separate original-funding producer.
    const id = randomUUID(),
      body = cashReturnClaimBody.parse({
        id,
        contract: 'pos-retained-cash-return-v1',
        orderId: snapshot.orderId,
        storeId: '1',
        counterId: '1',
        registeredBy: '1',
        registeredAt: '2026-11-17T06:00:00.000Z',
        sessionHash: 'a'.repeat(64),
        input: {
          original: {
            operationId: id,
            originalPaymentId: randomUUID(),
            counterId: '1',
            snapshotHash: 'b'.repeat(64),
            cashReturnReceiptId: randomUUID(),
            returnedCash: '50.00',
            confirmCashReturned: true,
            confirmNoHandover: true,
            reason: 'customer-payment-correction',
          },
          returnedBy: '1',
          returnedAt: '2026-11-17T05:59:00.000Z',
          confirmAlreadyReturned: true,
          evidenceId: randomUUID(),
        },
        originalPaymentHash: 'c'.repeat(64),
        originalFundingAt: '2026-11-17 11:00:00',
        orderDate: '2026-11-17',
        businessTimezone: 'Asia/Kolkata',
        returnedAt: '2026-11-17 11:29:00',
        businessDate: '2026-11-17',
      });
    await native.db
      .get('writer')
      .insert(cashReturnClaims)
      .values({
        id,
        orderId: body.orderId,
        storeId: body.storeId,
        counterId: body.counterId,
        originalPaymentId: body.input.original.originalPaymentId,
        cashReturnReceiptId: body.input.original.cashReturnReceiptId,
        body,
        bodyHash: claimHash(body, keys.cashReturnProofKey),
        impactFrom: '2026-11-17',
        createdAt: '2026-11-17 06:00:00.000',
        requestId: 'synthetic-retained-claim',
      });
  }
  async function accept(row: Awaited<ReturnType<typeof createCommand>>) {
    return runtime.app.inject({
      method: 'POST',
      url: '/api/store-order/status',
      headers: privateReceiverHeaders(row),
      payload: sourceStatusBody(row.snapshot, row.platform),
    });
  }
  it('accepts the exact original signed command and recovers/replays the same receipt with no provider sends', async () => {
    const row = await createCommand(),
      accepted = await accept(row),
      receipt = receiptSchema.parse(accepted.json<unknown>());
    expect(accepted.statusCode).toBe(202);
    expect(receipt).toMatchObject({
      operationId: row.id,
      state: 'queued',
      scopeHash: row.scopeHash,
      requestHash: row.requestHash,
    });
    expect(accepted.headers['x-pos-status-receipt']).toBe(
      receiptSignature(options.WHOLE_ORDER_STATUS_RECEIPT_KEY!, receipt),
    );
    const recovered = await runtime.app.inject({
        method: 'GET',
        url: '/api/store-order/status/commands/' + row.id,
        headers: privateReceiverHeaders(row),
      }),
      replay = await accept(row);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json<unknown>()).toEqual(receipt);
    expect(replay.statusCode).toBe(202);
    expect(replay.json<unknown>()).toEqual(receipt);
    expect(await native.db.get('writer').select().from(statusReceivers)).toHaveLength(1);
    expect(await native.db.get('writer').select().from(statusAttempts)).toHaveLength(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['cash'] as const)(
    'refuses a %s hold at private HTTP acceptance under the shared current locks',
    async (kind) => {
      const row = await createCommand();
      await held(kind);
      const result = await accept(row);
      expect(result.statusCode).toBe(409);
      expect(result.json<unknown>()).toMatchObject({
        code: 'CASH_RETURN_RECONCILIATION_REQUIRED',
      });
      expect(await native.db.get('writer').select().from(statusReceivers)).toHaveLength(0);
      expect(await native.db.get('writer').select().from(statusAttempts)).toHaveLength(0);
      expect(await native.db.get('writer').select().from(statusVendorCalls)).toHaveLength(0);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(['cash'] as const)(
    'rechecks a later %s hold at private worker dispatch and freezes the original attempt',
    async (kind) => {
      const row = await createCommand();
      expect((await accept(row)).statusCode).toBe(202);
      await held(kind);
      now += 300001;
      await runtime.receiver.runOnce();
      const attempts = await native.db.get('writer').select().from(statusAttempts),
        calls = await native.db.get('writer').select().from(statusVendorCalls);
      expect(attempts).toMatchObject([{ state: 'UNKNOWN', attempts: 1 }]);
      expect(calls).toMatchObject([{ state: 'UNKNOWN', attempt: 1 }]);
      expect(await runtime.receiver.runOnce()).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
      const recovered = await runtime.app.inject({
        method: 'GET',
        url: '/api/store-order/status/commands/' + row.id,
        headers: privateReceiverHeaders(row),
      });
      expect(receiptSchema.parse(recovered.json<unknown>())).toMatchObject({
        operationId: row.id,
        state: 'unknown',
        stages: [{ platform: 'PACK', status: 'UNKNOWN' }],
      });
    },
  );
  it('the inverse guard refuses real cash-return preparation while a whole-order handover is active', async () => {
    await createCommand();
    const session = await mysqlSessions(native.db).create('1', Date.parse('2099-01-01T00:00:00Z')),
      reversals = paymentReversalRepository(native.db, native.config, {
        hashSecret: keys.cashReturnProofKey,
        intentContract: 'pos-cash-return-intent-v1',
        projection: {},
        clock: () => Temporal.Instant.fromEpochMilliseconds(now),
        assertHandoverReady: orderMutationGuards(keys).assertCashReturnHandoverReady,
      });
    await expect(
      reversals.intents.prepare(
        actor,
        '1',
        snapshot.orderId,
        {
          operationId: randomUUID(),
          correctionId: randomUUID(),
          cashReturnReceiptId: randomUUID(),
          originalPaymentId: randomUUID(),
          counterId: '1',
          snapshotHash: 'a'.repeat(64),
          returnedCash: '50.00',
          reason: 'customer-payment-correction',
          confirmNoHandover: true,
        },
        session.sessionId,
      ),
    ).rejects.toMatchObject({ code: 'WHOLE_ORDER_HANDOVER_ACTIVE' });
    expect(await native.db.get('writer').select().from(cashReturnIntents)).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
