import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { eq } from 'drizzle-orm';
import {
  orderCopyCommands,
  orderCopyCancellations,
} from '../../src/modules/checkout/order-copy/schema.js';
import { copyCommandSchema } from '../../src/modules/checkout/order-copy/contracts.js';
import { copyCancellationClearVerifier } from '../../src/modules/checkout/order-copy/cancellation-evidence.js';
import { AppError } from '../../src/domain/errors.js';
import { checkoutStateSchema, type CheckoutState } from '../../src/modules/checkout/contracts.js';
import { checkoutRepository } from '../../src/modules/checkout/repository.js';
import { checkoutService } from '../../src/modules/checkout/service.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { orderCopyRepository } from '../../src/modules/checkout/order-copy/repository.js';
import { orderCopyService } from '../../src/modules/checkout/order-copy/service.js';
import { orderCopyFacts, copyCutoff } from '../../src/modules/checkout/order-copy/reader.js';
import { registerOrderCopy } from '../../src/modules/checkout/order-copy/routes.js';
import type {
  CopyFactsPort,
  CopyCartPort,
  CopySource,
} from '../../src/modules/checkout/order-copy/contracts.js';
import { FixtureGateway, operator, signingEnvironment } from '../checkout/fixtures.js';
import { orderCopyFixture } from './mysql-fixture.js';

describe.skipIf(!process.env.CHECKOUT_MYSQL_TEST_URL)(
  'durable order copying on isolated real MySQL',
  () => {
    let native: Awaited<ReturnType<typeof orderCopyFixture>>,
      state: CheckoutState,
      gateway: FixtureGateway,
      checkout: ReturnType<typeof checkoutService>,
      service: ReturnType<typeof orderCopyService>,
      time: number;
    const scope = () => ({ storeId: '1', checkoutId: state.id });
    const source: CopySource = { kind: 'store', storeId: '1', orderId: '9007199254740993' };
    const facts: CopyFactsPort = {
      async read(input) {
        return {
          orderId: input.source.orderId,
          sourceStoreId: input.source.kind === 'store' ? input.source.storeId : null,
          sourceCustomerId: input.source.kind === 'customer' ? input.targetCustomerId : '55',
          createdAt: '2026-01-01 10:00:00',
          reader: 'bigquery',
          fetchedAt: new Date(time).toISOString(),
          generationId: 'qualified-fixture-generation',
          complete: true,
          lines: [
            { lineId: '9007199254740994', productId: '10' },
            { lineId: '9007199254740995', productId: '10' },
            { lineId: '9007199254740996', productId: '11' },
          ],
        };
      },
    };
    const cartCalls = () =>
      gateway.calls.filter(
        (call) =>
          call.path === 'pos/product' ||
          (typeof call.payload.payload === 'object' &&
            call.payload.payload !== null &&
            'operation' in call.payload.payload &&
            call.payload.payload.operation === 'set'),
      );
    async function persisted() {
      const result = await checkoutRepository(native.db).get(operator.id, '1', state.id);
      if (!result) throw new Error('fixture state missing');
      return result;
    }
    async function review() {
      return service.prepare(operator, scope(), {
        reviewId: crypto.randomUUID(),
        expectedVersion: state.version,
        source,
      });
    }
    beforeAll(async () => {
      native = await orderCopyFixture(process.env.CHECKOUT_MYSQL_TEST_URL!);
      await native.fixture.insert('pos_user', { id: 44, role: 4, user_type: 1, is_active: 1 });
      await native.fixture.insert('stores', {
        id: 1,
        is_active: 1,
        type: 'STORE',
        category: 'IN_HOUSE',
      });
      await native.fixture.insert('stores', {
        id: 2,
        is_active: 1,
        type: 'STORE',
        category: 'IN_HOUSE',
      });
      await native.fixture.insert('store_counters', { id: 3, store_id: 1, is_active: 1 });
      await native.fixture.insert('user_stores', { django_user_id: 44, store_id: 1 });
      await native.fixture.insert('users', {
        id: 777,
        pos_admin_id: 44,
        email: 'operator.fixture@example.test',
        status: 1,
        is_block: 0,
        is_disabled: 0,
      });
      await native.fixture.insert('users', {
        id: 1001,
        email: 'customer.fixture@example.test',
        status: 1,
        is_block: 0,
        is_disabled: 0,
      });
      for (const id of [10, 11, 80]) {
        await native.fixture.insert('products', { id, prod_type: id === 80 ? 8 : 1 });
        await native.fixture.insert('products_gs1', { product_id: id, gtin: `89000000000${id}` });
        await native.fixture.insert('product_store', {
          id,
          product_id: id,
          store_id: 1,
          stock: 50,
          is_avail: 1,
          is_del: 0,
        });
      }
      await checkInService(native.db, native.config).set(operator, '1', '3');
    }, 30_000);
    afterAll(async () => native?.close());
    beforeEach(async () => {
      await native.connection.query('DELETE FROM pos_rewrite_order_copy_cancellations');
      await native.connection.query('DELETE FROM pos_rewrite_order_copy_commands');
      await native.connection.query('DELETE FROM pos_rewrite_order_copy_reviews');
      await native.connection.query('DELETE FROM pos_rewrite_checkout_operations');
      await native.connection.query('DELETE FROM pos_rewrite_customer_cart_leases');
      await native.connection.query('DELETE FROM pos_rewrite_checkout_sessions');
      await native.connection.query(
        'UPDATE pos_user SET is_active=1,user_type=1,role=4 WHERE id=44',
      );
      await native.connection.query(
        'UPDATE users SET status=1,is_block=0,is_disabled=0 WHERE id=1001',
      );
      await native.connection.query('UPDATE product_store SET stock=50,is_avail=1,is_del=0');
      time = Date.now();
      gateway = new FixtureGateway();
      checkout = checkoutService(checkoutRepository(native.db), gateway, signingEnvironment, {
        orderCopyHashSecret: native.config.SESSION_SECRET,
        verifyCopyCancellationClear: copyCancellationClearVerifier(native.config, native.db),
        migrationV2: true,
        now: () => time,
        assertCheckIn: (...args) => checkInService(native.db, native.config).assertCheckIn(...args),
      });
      const created = await checkout.create(operator, '1', '3', crypto.randomUUID(), {
        version: 42,
        lineItems: [{ productId: '10', quantity: 2 }],
      });
      state = checkoutStateSchema.parse(
        await checkoutRepository(native.db).get(operator.id, '1', created.id),
      );
      state = (
        await checkout.initializeDraft(operator, '1', state.id, {
          operationId: crypto.randomUUID(),
          expectedVersion: state.version,
        })
      ).state;
      state = (
        await checkout.attachCustomer(
          operator,
          '1',
          state.id,
          { operationId: crypto.randomUUID(), expectedVersion: state.version },
          '1001',
        )
      ).state;
      gateway.calls = [];
      service = orderCopyService(
        native.config,
        orderCopyRepository(native.config, native.db, () => time),
        facts,
        checkout.orderCopyCart,
        () => time,
      );
    });
    it('20 exact contenders dispatch each SKU once, retain the original draft and require explicit acknowledgement before quote', async () => {
      const original = structuredClone(state.draftImport),
        r = await review(),
        input = {
          operationId: crypto.randomUUID(),
          reviewId: r.id,
          manifestHash: r.hash,
          expectedVersion: state.version,
        };
      await Promise.all(Array.from({ length: 20 }, () => service.start(operator, scope(), input)));
      const result = await service.read(operator, scope(), input.operationId);
      expect(result.status).toBe('review-required');
      expect(result.steps.map((line) => line.targetQuantity)).toEqual([4, 1]);
      expect(cartCalls()).toHaveLength(2);
      expect((await persisted()).draftImport).toEqual(original);
      expect(result.result?.map((line) => [line.productId, line.quantity])).toEqual([
        ['10', 4],
        ['11', 1],
      ]);
      const before = gateway.calls.length;
      await expect(
        checkout.setLine(
          operator,
          '1',
          state.id,
          { operationId: crypto.randomUUID(), expectedVersion: result.checkoutVersion },
          '10',
          1,
        ),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_REVIEW_REQUIRED' });
      expect(gateway.calls.length).toBe(before);
      const ack = {
        operationId: crypto.randomUUID(),
        expectedVersion: result.checkoutVersion,
        resultHash: result.resultHash!,
      };
      const acknowledged = await service.acknowledge(operator, scope(), result.id, ack);
      expect(acknowledged.status).toBe('acknowledged');
      expect(await service.acknowledge(operator, scope(), result.id, ack)).toEqual(acknowledged);
      const edited = await checkout.setLine(
        operator,
        '1',
        state.id,
        { operationId: crypto.randomUUID(), expectedVersion: acknowledged.checkoutVersion },
        '10',
        3,
      );
      expect(edited.state.orderCopy).toBeNull();
      expect(edited.state.draftImport).toEqual(original);
      expect(
        gateway.calls.some(
          (call) =>
            call.path === 'syncart' ||
            (typeof call.payload.payload === 'object' &&
              call.payload.payload !== null &&
              'operation' in call.payload.payload &&
              call.payload.payload.operation === 'clear'),
        ),
      ).toBe(false);
    });
    it('does not infer causal success when a lost mutator reply left exactly the desired quantities', async () => {
      const r = await review(),
        input = {
          operationId: crypto.randomUUID(),
          reviewId: r.id,
          manifestHash: r.hash,
          expectedVersion: state.version,
        };
      gateway.intercept = async (path, payload) => {
        if (
          path === 'cart' &&
          typeof payload.payload === 'object' &&
          payload.payload !== null &&
          'operation' in payload.payload &&
          payload.payload.operation === 'set'
        ) {
          const target = gateway.carts.get('1001:customer');
          if (target) target.products.items[0]!.quantity = 4;
          throw new Error('private provider/body canary');
        }
        return undefined;
      };
      const result = await service.start(operator, scope(), input);
      expect(result.status).toBe('uncertain');
      await expect(
        service.cancelUnsent(operator, scope(), input.operationId, {
          operationId: crypto.randomUUID(),
          original: input,
        }),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_ALREADY_DISPATCHED' });
      expect(result.result).toBeNull();
      expect(result.errorCode).toBe('ORDER_COPY_OUTCOME_UNCERTAIN');
      const before = gateway.calls.length;
      time += 120_000;
      for (let i = 0; i < 3; i++) {
        expect((await service.read(operator, scope(), result.id)).status).toBe('uncertain');
        await service.start(operator, scope(), input);
      }
      await expect(
        service.continue(operator, scope(), result.id, {
          operationId: crypto.randomUUID(),
          expectedVersion: state.version,
        }),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_CONTEXT_CHANGED' });
      expect(gateway.calls.length).toBe(before);
      expect(JSON.stringify(result)).not.toContain('canary');
    });
    it('exposes a known unavailable prefix as partial and preserves the available cart for review', async () => {
      const r = await review();
      await native.connection.query('UPDATE product_store SET stock=0 WHERE product_id=11');
      const result = await service.start(operator, scope(), {
        operationId: crypto.randomUUID(),
        reviewId: r.id,
        manifestHash: r.hash,
        expectedVersion: state.version,
      });
      expect(result.status).toBe('review-required');
      expect(result.partial).toBe(true);
      expect(result.steps.map((step) => step.status)).toEqual(['confirmed', 'unavailable']);
      expect(result.result?.map((line) => [line.productId, line.quantity])).toEqual([['10', 4]]);
      expect(cartCalls()).toHaveLength(1);
    });
    it('rechecks current franchise/store and customer eligibility after preparing the manifest', async () => {
      const r = await review(),
        input = {
          operationId: crypto.randomUUID(),
          reviewId: r.id,
          manifestHash: r.hash,
          expectedVersion: state.version,
        };
      await native.connection.query('UPDATE pos_user SET user_type=2,role=1 WHERE id=44');
      await expect(service.start(operator, scope(), input)).rejects.toMatchObject({
        code: 'STORE_ACCESS_DENIED',
      });
      expect(cartCalls()).toHaveLength(0);
      await native.connection.query('UPDATE pos_user SET user_type=1,role=4 WHERE id=44');
      await native.connection.query('UPDATE users SET is_disabled=1 WHERE id=1001');
      await expect(service.start(operator, scope(), input)).rejects.toMatchObject({
        code: 'CHECKOUT_CUSTOMER_UNAVAILABLE',
      });
      expect(cartCalls()).toHaveLength(0);
    });
    it('refuses a source store outside current assignment before reading facts or a cart', async () => {
      await expect(
        service.prepare({ ...operator, storeIds: ['1', '2'] }, scope(), {
          reviewId: crypto.randomUUID(),
          expectedVersion: state.version,
          source: { ...source, storeId: '2' },
        }),
      ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
      expect(gateway.calls).toHaveLength(0);
    });
    it('rejects a changed source customer, version or tampered manifest before dispatch', async () => {
      const badFacts: CopyFactsPort = {
        async read(input) {
          return { ...(await facts.read(input)), sourceCustomerId: '999' };
        },
      };
      const bad = orderCopyService(
        native.config,
        orderCopyRepository(native.config, native.db, () => time),
        badFacts,
        checkout.orderCopyCart,
        () => time,
      );
      await expect(
        bad.prepare(operator, scope(), {
          reviewId: crypto.randomUUID(),
          expectedVersion: state.version,
          source: { kind: 'customer', orderId: source.orderId },
        }),
      ).rejects.toMatchObject({ code: 'CUSTOMER_VERIFICATION_REQUIRED' });
      const r = await review();
      await expect(
        service.start(operator, scope(), {
          operationId: crypto.randomUUID(),
          reviewId: r.id,
          manifestHash: '0'.repeat(64),
          expectedVersion: state.version,
        }),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_CONTEXT_CHANGED' });
      await expect(
        service.start(operator, scope(), {
          operationId: crypto.randomUUID(),
          reviewId: r.id,
          manifestHash: r.hash,
          expectedVersion: state.version + 1,
        }),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_CONTEXT_CHANGED' });
      expect(cartCalls()).toHaveLength(0);
    });
    it('holds an interrupted dispatched write after a late SQL checkpoint failure without retrying it', async () => {
      const r = await review();
      await native.connection.query(
        "CREATE TRIGGER fixture_copy_checkpoint BEFORE UPDATE ON pos_rewrite_order_copy_commands FOR EACH ROW BEGIN IF JSON_UNQUOTE(JSON_EXTRACT(NEW.data,'$.steps[0].status'))='confirmed' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='private SQL canary'; END IF; END",
      );
      try {
        const result = await service.start(operator, scope(), {
          operationId: crypto.randomUUID(),
          reviewId: r.id,
          manifestHash: r.hash,
          expectedVersion: state.version,
        });
        expect(result.status).toBe('uncertain');
        expect(cartCalls()).toHaveLength(1);
        expect((await persisted()).draftImport).toEqual(state.draftImport);
      } finally {
        await native.connection.query('DROP TRIGGER fixture_copy_checkpoint');
      }
    });
    it('fences a stale worker while allowing explicit continuation only before any mutator dispatch', async () => {
      let entered: () => void = () => undefined,
        release: () => void = () => undefined;
      const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        hold = new Promise<void>((resolve) => {
          release = resolve;
        });
      let block = false;
      const port: CopyCartPort = {
        ...checkout.orderCopyCart,
        async read(value) {
          if (block) {
            block = false;
            entered();
            await hold;
          }
          return checkout.orderCopyCart.read(value);
        },
      };
      const coordinated = orderCopyService(
        native.config,
        orderCopyRepository(native.config, native.db, () => time),
        facts,
        port,
        () => time,
      );
      const r = await coordinated.prepare(operator, scope(), {
        reviewId: crypto.randomUUID(),
        expectedVersion: state.version,
        source,
      });
      block = true;
      const commandId = crypto.randomUUID(),
        original = coordinated.start(operator, scope(), {
          operationId: commandId,
          reviewId: r.id,
          manifestHash: r.hash,
          expectedVersion: state.version,
        });
      await waiting;
      time += 61_000;
      const continuation = await coordinated.continue(operator, scope(), commandId, {
        operationId: crypto.randomUUID(),
        expectedVersion: state.version,
      });
      release();
      await original;
      expect(continuation.status).toBe('review-required');
      expect(cartCalls()).toHaveLength(2);
    });
    it('routes old product facts solely through the injected warehouse port, never old MySQL line fallback', async () => {
      const id = '7001';
      await native.fixture.insert('orders', {
        id,
        user_id: 1001,
        created_at: '2020-01-01 00:00:00',
      });
      let historyCalls = 0;
      const reader = orderCopyFacts(
        native.db,
        {
          async read(input) {
            historyCalls++;
            return facts.read(input);
          },
        },
        () => time,
      );
      const result = await reader.read({
        source: { ...source, orderId: id },
        targetCustomerId: '1001',
        cutoff: copyCutoff(native.config, time),
      });
      expect(result.reader).toBe('bigquery');
      expect(historyCalls).toBe(1);
      const closed = orderCopyFacts(native.db, {
        async read() {
          throw new AppError(503, 'WAREHOUSE_UNAVAILABLE', 'Fixture warehouse unavailable');
        },
      });
      await expect(
        closed.read({
          source: { ...source, orderId: id },
          targetCustomerId: '1001',
          cutoff: copyCutoff(native.config, time),
        }),
      ).rejects.toMatchObject({ code: 'WAREHOUSE_UNAVAILABLE' });
    });
    it('rejects corrupt copy receipt intent/result without changing the original draft', async () => {
      const r = await review(),
        result = await service.start(operator, scope(), {
          operationId: crypto.randomUUID(),
          reviewId: r.id,
          manifestHash: r.hash,
          expectedVersion: state.version,
        });
      await native.connection.query(
        "UPDATE pos_rewrite_order_copy_commands SET data=JSON_SET(data,'$.result[0].quantity',999) WHERE id=?",
        [result.id],
      );
      await expect(service.read(operator, scope(), result.id)).rejects.toMatchObject({
        code: 'ORDER_COPY_CONTEXT_CHANGED',
      });
      await expect(
        service.acknowledge(operator, scope(), result.id, {
          operationId: crypto.randomUUID(),
          expectedVersion: result.checkoutVersion,
          resultHash: result.resultHash!,
        }),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_CONTEXT_CHANGED' });
      expect((await persisted()).draftImport).toEqual(state.draftImport);
    });
    it('does not accept a historical port that silently returns primary data', async () => {
      const reader = orderCopyFacts(native.db, {
        async read(input) {
          return { ...(await facts.read(input)), reader: 'primary' };
        },
      });
      await expect(
        reader.read({ source, targetCustomerId: '1001', cutoff: copyCutoff(native.config, time) }),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_HISTORY_INVALID' });
    });
    it('exposes strict authenticated resource routes and rejects malformed input before any cart write', async () => {
      const app = Fastify({ logger: false });
      app.decorateRequest('principal', null);
      app.addHook('preHandler', async (request) => {
        request.principal = operator;
        request.authSessionValid = async () => true;
      });
      app.setErrorHandler((error, _request, reply) => {
        const status =
          error instanceof ZodError ? 400 : error instanceof AppError ? error.status : 500;
        return reply.code(status).send({
          error: { code: 'FIXTURE_REQUEST_REJECTED', message: 'Fixture request rejected' },
        });
      });
      registerOrderCopy(app, native.config, native.db, checkout.orderCopyCart, {
        facts,
        clock: () => time,
      });
      try {
        const base = `/api/v1/stores/1/checkout-sessions/${state.id}`;
        expect(
          (await app.inject({ method: 'GET', url: base + '/order-copies/current' })).json(),
        ).toBeNull();
        const invalid = await app.inject({
          method: 'POST',
          url: base + '/order-copy-reviews',
          payload: {
            reviewId: crypto.randomUUID(),
            expectedVersion: state.version,
            source: { ...source, email: 'private-contact-canary' },
          },
        });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.body).not.toContain('canary');
        expect(cartCalls()).toHaveLength(0);
        const response = await app.inject({
          method: 'POST',
          url: base + '/order-copy-reviews',
          payload: { reviewId: crypto.randomUUID(), expectedVersion: state.version, source },
        });
        expect(response.statusCode).toBe(200);
        const r = JSON.parse(response.body) as { id: string; hash: string };
        expect(
          (await app.inject({ method: 'GET', url: base + '/order-copy-reviews/' + r.id }))
            .statusCode,
        ).toBe(200);
      } finally {
        await app.close();
      }
    });
    it('serializes twenty unsent cancellations, claims the original nonce and makes delayed exact start read-only', async () => {
      const r = await review(),
        original = {
          operationId: crypto.randomUUID(),
          reviewId: r.id,
          manifestHash: r.hash,
          expectedVersion: state.version,
        },
        input = { operationId: crypto.randomUUID(), original },
        before = structuredClone(state);
      const receipts = await Promise.all(
        Array.from({ length: 20 }, () =>
          service.cancelUnsent(operator, scope(), original.operationId, input),
        ),
      );
      for (const receipt of receipts) expect(receipt).toEqual(receipts[0]);
      const receipt = receipts[0]!;
      expect(receipt).toMatchObject({
        status: 'cancelled-unsent',
        source: null,
        result: null,
        originHash: null,
        steps: [],
        markerRequired: true,
        requiresOnlineClear: true,
      });
      expect(await service.start(operator, scope(), original)).toEqual(receipt);
      expect(await service.current(operator, scope())).toEqual(receipt);
      expect(await service.read(operator, scope(), original.operationId)).toEqual(receipt);
      expect(
        await service.cancellation(operator, scope(), original.operationId, input.operationId),
      ).toEqual(receipt);
      expect(await native.db.get('writer').select().from(orderCopyCancellations)).toHaveLength(1);
      const commands = await native.db.get('writer').select().from(orderCopyCommands);
      expect(commands).toHaveLength(1);
      expect(copyCommandSchema.safeParse(commands[0]!.data).success).toBe(false);
      expect(cartCalls()).toHaveLength(0);
      const saved = await persisted();
      expect(saved.draftImport).toEqual(before.draftImport);
      expect(saved.cart).toEqual(before.cart);
      expect(saved.customerId).toBe(before.customerId);
      expect(saved.orderCopy).toMatchObject({
        status: 'cancelled-unsent',
        commandId: original.operationId,
        cancellationId: input.operationId,
      });
      await expect(
        service.start(operator, scope(), {
          ...original,
          expectedVersion: original.expectedVersion + 1,
        }),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_CONTEXT_CHANGED' });
      await expect(
        service.start(operator, scope(), { ...original, operationId: crypto.randomUUID() }),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_CONTEXT_CHANGED' });
    });
    it('fences a missing or expired review without inventing its source, products or customer snapshot', async () => {
      const original = {
        operationId: crypto.randomUUID(),
        reviewId: crypto.randomUUID(),
        manifestHash: 'f'.repeat(64),
        expectedVersion: 0,
      };
      // No review has ever been persisted; the slot is a no-dispatch fence only.
      const value = await service.cancelUnsent(operator, scope(), original.operationId, {
        operationId: crypto.randomUUID(),
        original,
      });
      expect(value.status).toBe('cancelled-unsent');
      expect(await service.start(operator, scope(), original)).toEqual(value);
      const [row] = await native.db.get('writer').select().from(orderCopyCancellations);
      expect(row!.originalCommand).toBeNull();
      expect(JSON.stringify(row!.receipt)).not.toContain('customer');
      expect(gateway.calls).toHaveLength(0);
    });
    it('cancels a reserved command before its dispatch checkpoint and fences the paused worker', async () => {
      let entered: () => void = () => undefined,
        release: () => void = () => undefined,
        block = false;
      const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        hold = new Promise<void>((resolve) => {
          release = resolve;
        });
      const port: CopyCartPort = {
        ...checkout.orderCopyCart,
        async read(value) {
          if (block) {
            block = false;
            entered();
            await hold;
          }
          return checkout.orderCopyCart.read(value);
        },
      };
      const coordinated = orderCopyService(
        native.config,
        orderCopyRepository(native.config, native.db, () => time),
        facts,
        port,
        () => time,
      );
      const r = await coordinated.prepare(operator, scope(), {
        reviewId: crypto.randomUUID(),
        expectedVersion: state.version,
        source,
      });
      const original = {
        operationId: crypto.randomUUID(),
        reviewId: r.id,
        manifestHash: r.hash,
        expectedVersion: state.version,
      };
      block = true;
      const started = coordinated.start(operator, scope(), original);
      await waiting;
      try {
        const cancelled = await coordinated.cancelUnsent(operator, scope(), original.operationId, {
          operationId: crypto.randomUUID(),
          original,
        });
        expect(cancelled.status).toBe('cancelled-unsent');
      } finally {
        release();
      }
      expect((await started).status).toBe('cancelled-unsent');
      expect(cartCalls()).toHaveLength(0);
      const [row] = await native.db.get('writer').select().from(orderCopyCancellations);
      expect(row!.originalCommand?.status).toBe('pending');
      expect(row!.originalCommand?.steps.every((step) => step.status === 'not-dispatched')).toBe(
        true,
      );
      expect((await persisted()).draftImport).toEqual(state.draftImport);
    });
    it('cannot cancel a dispatched mutation, its uncertain outcome, or a confirmed result', async () => {
      let entered: () => void = () => undefined,
        release: () => void = () => undefined;
      const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        hold = new Promise<void>((resolve) => {
          release = resolve;
        });
      const port: CopyCartPort = {
        ...checkout.orderCopyCart,
        async setLine(...args) {
          entered();
          await hold;
          return checkout.orderCopyCart.setLine(...args);
        },
      };
      const coordinated = orderCopyService(
        native.config,
        orderCopyRepository(native.config, native.db, () => time),
        facts,
        port,
        () => time,
      );
      const r = await coordinated.prepare(operator, scope(), {
          reviewId: crypto.randomUUID(),
          expectedVersion: state.version,
          source,
        }),
        original = {
          operationId: crypto.randomUUID(),
          reviewId: r.id,
          manifestHash: r.hash,
          expectedVersion: state.version,
        },
        input = { operationId: crypto.randomUUID(), original };
      const started = coordinated.start(operator, scope(), original);
      await waiting;
      try {
        await expect(
          coordinated.cancelUnsent(operator, scope(), original.operationId, input),
        ).rejects.toMatchObject({ code: 'ORDER_COPY_ALREADY_DISPATCHED' });
      } finally {
        release();
      }
      const result = await started;
      expect(result.status).toBe('review-required');
      await expect(
        coordinated.cancelUnsent(operator, scope(), original.operationId, input),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_ALREADY_DISPATCHED' });
      expect(await native.db.get('writer').select().from(orderCopyCancellations)).toHaveLength(0);
      expect(cartCalls()).toHaveLength(2);
    });
    it('fences an otherwise invalid copy without requiring customer or lease renewal', async () => {
      const original = {
        operationId: crypto.randomUUID(),
        reviewId: crypto.randomUUID(),
        manifestHash: 'e'.repeat(64),
        expectedVersion: state.version,
      };
      await native.connection.query('UPDATE users SET is_disabled=1 WHERE id=1001');
      await native.connection.query('DELETE FROM pos_rewrite_customer_cart_leases');
      const receipt = await service.cancelUnsent(operator, scope(), original.operationId, {
        operationId: crypto.randomUUID(),
        original,
      });
      expect(receipt.status).toBe('cancelled-unsent');
      expect(await service.read(operator, scope(), original.operationId)).toEqual(receipt);
      expect(gateway.calls).toHaveLength(0);
      expect((await persisted()).cart).toEqual(state.cart);
    });
    it('fences an expired original review with its original nonce, never a replacement start', async () => {
      const r = await review(),
        original = {
          operationId: crypto.randomUUID(),
          reviewId: r.id,
          manifestHash: r.hash,
          expectedVersion: state.version,
        };
      time += 301000;
      await expect(service.start(operator, scope(), original)).rejects.toMatchObject({
        code: 'ORDER_COPY_CONTEXT_CHANGED',
      });
      const cancelled = await service.cancelUnsent(operator, scope(), original.operationId, {
        operationId: crypto.randomUUID(),
        original,
      });
      expect(cancelled.status).toBe('cancelled-unsent');
      expect(await service.start(operator, scope(), original)).toEqual(cancelled);
      expect(cartCalls()).toHaveLength(0);
    });
    it('never releases an unrelated checkout operation even when the caller reuses its UUID', async () => {
      const busy = crypto.randomUUID(),
        original = {
          operationId: busy,
          reviewId: crypto.randomUUID(),
          manifestHash: 'e'.repeat(64),
          expectedVersion: state.version,
        };
      await native.connection.query(
        "UPDATE pos_rewrite_checkout_sessions SET state=JSON_SET(state,'$.busyOperationId',?,'$.phase','uncertain') WHERE id=?",
        [busy, state.id],
      );
      const before = await persisted();
      await expect(
        service.cancelUnsent(operator, scope(), busy, {
          operationId: crypto.randomUUID(),
          original,
        }),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_CONTEXT_CHANGED' });
      expect(await persisted()).toEqual(before);
      expect(await native.db.get('writer').select().from(orderCopyCancellations)).toHaveLength(0);
      expect(await native.db.get('writer').select().from(orderCopyCommands)).toHaveLength(0);
    });
    it('refuses inconsistent native checkout owner metadata before claiming a nonce', async () => {
      const original = {
        operationId: crypto.randomUUID(),
        reviewId: crypto.randomUUID(),
        manifestHash: 'e'.repeat(64),
        expectedVersion: state.version,
      };
      await native.connection.query(
        "UPDATE pos_rewrite_checkout_sessions SET state=JSON_SET(state,'$.operatorId','99') WHERE id=?",
        [state.id],
      );
      await expect(
        service.cancelUnsent(operator, scope(), original.operationId, {
          operationId: crypto.randomUUID(),
          original,
        }),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_CONTEXT_CHANGED' });
      expect(await native.db.get('writer').select().from(orderCopyCancellations)).toHaveLength(0);
      expect(gateway.calls).toHaveLength(0);
    });
    it('withholds a cancellation response after session revocation without erasing its committed fence', async () => {
      const app = Fastify({ logger: false });
      app.decorateRequest('principal', null);
      app.addHook('preHandler', async (request) => {
        request.principal = operator;
        let checks = 0;
        request.authSessionValid = async () => ++checks === 1;
      });
      app.setErrorHandler((error, _request, reply) =>
        reply
          .code(error instanceof AppError ? error.status : 500)
          .send({
            error: {
              code: error instanceof AppError ? error.code : 'FIXTURE_ERROR',
              message: 'Fixture response withheld',
            },
          }),
      );
      registerOrderCopy(app, native.config, native.db, checkout.orderCopyCart, {
        facts,
        clock: () => time,
      });
      const original = {
        operationId: crypto.randomUUID(),
        reviewId: crypto.randomUUID(),
        manifestHash: 'e'.repeat(64),
        expectedVersion: state.version,
      };
      try {
        const reply = await app.inject({
          method: 'POST',
          url: `/api/v1/stores/1/checkout-sessions/${state.id}/order-copies/${original.operationId}/cancellations`,
          payload: { operationId: crypto.randomUUID(), original },
        });
        expect(reply.statusCode).toBe(401);
        expect(reply.body).not.toContain('originalRequestHash');
        expect(await native.db.get('writer').select().from(orderCopyCancellations)).toHaveLength(1);
        expect((await persisted()).orderCopy?.status).toBe('cancelled-unsent');
        expect(cartCalls()).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
    it('requires current native actor/store authority even for a no-send cancellation', async () => {
      const original = {
          operationId: crypto.randomUUID(),
          reviewId: crypto.randomUUID(),
          manifestHash: 'e'.repeat(64),
          expectedVersion: state.version,
        },
        input = { operationId: crypto.randomUUID(), original };
      await native.connection.query('UPDATE pos_user SET user_type=2,role=1 WHERE id=44');
      await expect(
        service.cancelUnsent(operator, scope(), original.operationId, input),
      ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
      expect(await native.db.get('writer').select().from(orderCopyCancellations)).toHaveLength(0);
      expect(gateway.calls).toHaveLength(0);
    });
    it('rolls back the nonce, cancellation audit and checkout binding together on a late SQL failure', async () => {
      const original = {
          operationId: crypto.randomUUID(),
          reviewId: crypto.randomUUID(),
          manifestHash: 'e'.repeat(64),
          expectedVersion: state.version,
        },
        before = await persisted();
      await native.connection.query(
        "CREATE TRIGGER fixture_cancel_rollback BEFORE UPDATE ON pos_rewrite_checkout_sessions FOR EACH ROW BEGIN IF JSON_UNQUOTE(JSON_EXTRACT(NEW.state,'$.orderCopy.status'))='cancelled-unsent' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='private rollback canary'; END IF; END",
      );
      try {
        await expect(
          service.cancelUnsent(operator, scope(), original.operationId, {
            operationId: crypto.randomUUID(),
            original,
          }),
        ).rejects.toThrow();
      } finally {
        await native.connection.query('DROP TRIGGER fixture_cancel_rollback');
      }
      expect(await native.db.get('writer').select().from(orderCopyCancellations)).toHaveLength(0);
      expect(await native.db.get('writer').select().from(orderCopyCommands)).toHaveLength(0);
      expect(await persisted()).toEqual(before);
      expect(gateway.calls).toHaveLength(0);
    });
    it('permits only an explicit clear with verified immutable cancellation evidence while quote stays fenced', async () => {
      const original = {
          operationId: crypto.randomUUID(),
          reviewId: crypto.randomUUID(),
          manifestHash: 'e'.repeat(64),
          expectedVersion: state.version,
        },
        receipt = await service.cancelUnsent(operator, scope(), original.operationId, {
          operationId: crypto.randomUUID(),
          original,
        });
      await expect(
        checkout.quote(operator, '1', state.id, {
          operationId: crypto.randomUUID(),
          expectedVersion: receipt.checkoutVersion,
        }),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_REVIEW_REQUIRED' });
      const [row] = await native.db.get('writer').select().from(orderCopyCancellations);
      await native.db
        .get('writer')
        .update(orderCopyCancellations)
        .set({ receiptHash: '0'.repeat(64) })
        .where(eq(orderCopyCancellations.copyId, original.operationId));
      await expect(
        checkout.clear(operator, '1', state.id, {
          operationId: crypto.randomUUID(),
          expectedVersion: receipt.checkoutVersion,
        }),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_CANCELLATION_UNCONFIRMED' });
      expect(gateway.calls).toHaveLength(0);
      await native.db
        .get('writer')
        .update(orderCopyCancellations)
        .set({ receiptHash: row!.receiptHash })
        .where(eq(orderCopyCancellations.copyId, original.operationId));
      const cleared = await checkout.clear(operator, '1', state.id, {
        operationId: crypto.randomUUID(),
        expectedVersion: receipt.checkoutVersion,
      });
      expect(cleared.state.phase).toBe('cleared');
      if (cleared.status !== 'succeeded') throw new Error('Fixture clear was not confirmed');
      expect(cleared.result.cleared).toMatchObject({
        draftId: state.draftId,
        reason: 'cart-clear',
      });
      expect(await service.read(operator, scope(), original.operationId)).toEqual(receipt);
      expect(await native.db.get('writer').select().from(orderCopyCancellations)).toHaveLength(1);
    });
    it('copies a gift product as a fresh unassigned cart instance using the existing v2 helper', async () => {
      const giftFacts: CopyFactsPort = {
        async read(input) {
          const original = await facts.read(input);
          return { ...original, lines: [{ lineId: '9007199254740998', productId: '80' }] };
        },
      };
      const gift = orderCopyService(
        native.config,
        orderCopyRepository(native.config, native.db, () => time),
        giftFacts,
        checkout.orderCopyCart,
        () => time,
      );
      const r = await gift.prepare(operator, scope(), {
        reviewId: crypto.randomUUID(),
        expectedVersion: state.version,
        source,
      });
      const result = await gift.start(operator, scope(), {
        operationId: crypto.randomUUID(),
        reviewId: r.id,
        manifestHash: r.hash,
        expectedVersion: state.version,
      });
      expect(result.status).toBe('review-required');
      const card = result.result?.find((line) => line.kind === 'gift-card');
      expect(card?.quantity).toBe(1);
      expect(card?.identity).toMatch(/^[1-9]\d*$/);
      const saved = await persisted();
      expect(saved.giftCards).toEqual({});
      expect(saved.draftImport).toEqual(state.draftImport);
      const call = gateway.calls.find((value) => value.path === 'pos/product');
      expect(call?.payload.custom_data).toHaveProperty('pos_gift_id');
      expect(JSON.stringify(call?.payload)).not.toContain('gift_card_no');
    });
  },
);
