import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/domain/errors.js';
import { MUser } from '../../src/db/legacy-schema.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { bumpCurrentContactRevision } from '../../src/modules/customer-contacts/revisions.js';
import { readCustomerContactBinding } from '../../src/modules/checkout/customer-contact-authority.js';
import { checkoutRepository } from '../../src/modules/checkout/repository.js';
import { checkoutService } from '../../src/modules/checkout/service.js';
import { checkoutSessions } from '../../src/modules/checkout/schema.js';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import { orderCopyRepository } from '../../src/modules/checkout/order-copy/repository.js';
import { orderCopyService } from '../../src/modules/checkout/order-copy/service.js';
import { registerOrderCopy } from '../../src/modules/checkout/order-copy/routes.js';
import {
  orderCopyCommands,
  orderCopyReviews,
} from '../../src/modules/checkout/order-copy/schema.js';
import type {
  CopyCartPort,
  CopyFactsPort,
} from '../../src/modules/checkout/order-copy/contracts.js';
import {
  customerOtpService,
  customerOtpOutbox,
  readCustomerOtpOptions,
  type CustomerOtpDelivery,
  type CustomerOtpPayload,
} from '../../src/modules/customer-otp/index.js';
import { orderCopyFixture } from './mysql-fixture.js';
import { FixtureGateway, operator, signingEnvironment } from '../checkout/fixtures.js';

describe.skipIf(!process.env.CHECKOUT_MYSQL_TEST_URL)(
  'customer-copy authority with actual native OTP proof',
  { timeout: 15000 },
  () => {
    let native: Awaited<ReturnType<typeof orderCopyFixture>>,
      checkout: ReturnType<typeof checkoutService>,
      copy: ReturnType<typeof orderCopyService>,
      otp: ReturnType<typeof customerOtpService>,
      worker: ReturnType<typeof customerOtpOutbox>,
      gateway: FixtureGateway,
      time: number,
      checkoutId: string,
      factCalls: number,
      nativeAssertions: number;
    const sent: CustomerOtpPayload[] = [],
      delivery: CustomerOtpDelivery = {
        assertReady() {},
        async send(_id, payload) {
          sent.push(payload);
          return 'accepted';
        },
      },
      otpOptions = readCustomerOtpOptions({
        CUSTOMER_OTP_ENABLED: 'true',
        CUSTOMER_OTP_CONTRACT: 'pos-customer-otp-v1',
        CUSTOMER_OTP_SECRET: 'native-customer-copy-purpose-otp-key-'.repeat(2),
        CUSTOMER_OTP_WORKER_ENABLED: 'true',
      });
    const scope = () => ({ storeId: '1', checkoutId });
    const source = { kind: 'customer' as const, orderId: '9007199254740993' };
    const facts: CopyFactsPort = {
      async read(input) {
        expect(Object.keys(input).sort()).toEqual(['cutoff', 'source', 'targetCustomerId']);
        factCalls++;
        return {
          orderId: input.source.orderId,
          sourceCustomerId: input.targetCustomerId,
          sourceStoreId: null,
          createdAt: '2026-01-01 10:00:00',
          reader: 'bigquery',
          fetchedAt: new Date(time).toISOString(),
          generationId: 'qualified-native-fixture-only',
          complete: true,
          lines: [{ lineId: '9007199254740994', productId: '10' }],
        };
      },
    };
    const state = async () => {
      const value = await checkoutRepository(native.db).get(operator.id, '1', checkoutId);
      if (!value) throw new Error('Fixture state missing');
      return value;
    };
    function service(
      cart: CopyCartPort = checkout.orderCopyCart,
      port = facts,
      withVerifier = true,
    ) {
      const customerOtp = withVerifier
        ? {
            ...otp,
            async assertVerified(...args: Parameters<typeof otp.assertVerified>) {
              nativeAssertions++;
              return otp.assertVerified(...args);
            },
          }
        : undefined;
      return orderCopyService(
        native.config,
        orderCopyRepository(native.config, native.db, () => time, { customerOtp }),
        port,
        cart,
        () => time,
      );
    }
    async function verifyCustomer() {
      let current = await state();
      await checkout.sendVerification(operator, '1', checkoutId, {
        operationId: crypto.randomUUID(),
        expectedVersion: current.version,
      });
      await worker.drain(new AbortController().signal, 10);
      expect(sent.at(-1)?.code).toMatch(/^\d{6}$/);
      current = await state();
      await checkout.verify(
        operator,
        '1',
        checkoutId,
        { operationId: crypto.randomUUID(), expectedVersion: current.version },
        sent.at(-1)!.code,
      );
      current = await state();
      expect(current.verifiedCustomerUntil).toBe(time + 900000);
      return current;
    }
    async function prepare(port = copy) {
      const current = await state();
      return port.prepare(operator, scope(), {
        reviewId: crypto.randomUUID(),
        expectedVersion: current.version,
        source,
      });
    }
    async function start(review: Awaited<ReturnType<typeof prepare>>, port = copy) {
      return port.start(operator, scope(), {
        operationId: crypto.randomUUID(),
        reviewId: review.id,
        manifestHash: review.hash,
        expectedVersion: review.checkoutVersion,
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
        user_type: '2',
        status: 1,
        is_block: 0,
        is_disabled: 0,
      });
      await native.fixture.insert('products', { id: 10, prod_type: 1 });
      await native.fixture.insert('products_gs1', { product_id: 10, gtin: '8900000000010' });
      await native.fixture.insert('product_store', {
        id: 10,
        product_id: 10,
        store_id: 1,
        stock: 50,
        is_avail: 1,
        is_del: 0,
      });
      await checkInService(native.db, native.config).set(operator, '1', '3');
    }, 30000);
    afterAll(async () => native?.close());
    beforeEach(async () => {
      for (const table of [
        'pos_rewrite_order_copy_commands',
        'pos_rewrite_order_copy_reviews',
        'pos_rewrite_checkout_operations',
        'pos_rewrite_customer_cart_leases',
        'pos_rewrite_checkout_sessions',
        'pos_rewrite_customer_otp_operations',
        'pos_rewrite_customer_otp_deliveries',
        'pos_rewrite_customer_otp_challenges',
        'pos_rewrite_customer_otp_budgets',
        'pos_rewrite_customer_contact_revisions',
        'pos_rewrite_operator_auth_epochs',
      ])
        await native.connection.query(`DELETE FROM ${table}`);
      await native.connection.query(
        'UPDATE pos_user SET role=4,user_type=1,is_active=1 WHERE id=44',
      );
      await native.connection.query(
        "UPDATE users SET telephone='',status=1,is_block=0,is_disabled=0 WHERE id=1001",
      );
      await native.connection.query(
        'INSERT INTO pos_rewrite_operator_auth_epochs (operator_id,epoch) VALUES(44,0)',
      );
      time = Date.now();
      factCalls = 0;
      nativeAssertions = 0;
      sent.length = 0;
      otp = customerOtpService(native.config, native.db, otpOptions, delivery, () => time);
      worker = customerOtpOutbox(native.config, native.db, otpOptions, delivery, () => time);
      gateway = new FixtureGateway();
      checkout = checkoutService(checkoutRepository(native.db), gateway, signingEnvironment, {
        migrationV2: true,
        orderCopyHashSecret: native.config.SESSION_SECRET,
        now: () => time,
        customerOtp: otp,
        assertCheckIn: (...args) => checkInService(native.db, native.config).assertCheckIn(...args),
      });
      const created = await checkout.create(operator, '1', '3', crypto.randomUUID(), {
        version: 5,
        lineItems: [{ productId: '10', quantity: 2 }],
      });
      checkoutId = created.id;
      const current = (
        await checkout.initializeDraft(operator, '1', created.id, {
          operationId: crypto.randomUUID(),
          expectedVersion: created.version,
        })
      ).state;
      await checkout.attachCustomer(
        operator,
        '1',
        current.id,
        { operationId: crypto.randomUUID(), expectedVersion: current.version },
        '1001',
      );
      copy = service();
    });
    it('attaching an unverified customer cannot read any public historical purchase facts', async () => {
      await expect(prepare()).rejects.toMatchObject({ code: 'CUSTOMER_VERIFICATION_REQUIRED' });
      expect(factCalls).toBe(0);
      expect(await native.db.get('writer').select().from(orderCopyReviews)).toHaveLength(0);
    });
    it('native verify authorizes the exact customer review/start and private proof never enters a DTO', async () => {
      await verifyCustomer();
      const review = await prepare();
      expect(nativeAssertions).toBe(2);
      expect(factCalls).toBe(1);
      const [saved] = await native.db.get('writer').select().from(orderCopyReviews);
      expect(saved?.data.customerAuthority?.challengeId).toBe(
        (await state()).verificationChallenge?.id,
      );
      expect(review).not.toHaveProperty('customerAuthority');
      expect(JSON.stringify(review)).not.toContain(saved!.data.customerAuthority!.contact.digest);
      const result = await start(review);
      expect(nativeAssertions).toBe(3);
      expect(result.status).toBe('review-required');
      expect(result.steps[0]?.targetQuantity).toBe(3);
      expect(await copy.review(operator, scope(), review.id)).not.toHaveProperty(
        'customerAuthority',
      );
    });
    it('forged verified flags and a missing native verifier do not authorize source reads', async () => {
      const current = await state(),
        contact = await native.db
          .get('writer')
          .transaction((tx) => readCustomerContactBinding(tx, '1001'));
      await native.db
        .get('writer')
        .update(checkoutSessions)
        .set({
          state: {
            ...current,
            verifiedCustomerUntil: time + 900000,
            verifiedCustomerContact: contact,
            verificationChallenge: {
              id: crypto.randomUUID(),
              contact,
              expiresAt: time + 300000,
              lastSentAt: time,
              attempts: 0,
              sent: true,
            },
          },
        })
        .where(eq(checkoutSessions.id, checkoutId));
      await expect(prepare()).rejects.toThrow();
      expect(nativeAssertions).toBe(1);
      expect(factCalls).toBe(0);
      await expect(prepare(service(checkout.orderCopyCart, facts, false))).rejects.toMatchObject({
        code: 'CUSTOMER_VERIFICATION_REQUIRED',
      });
      expect(factCalls).toBe(0);
    });
    it('an expired proof cannot start a new command even while its reviewed manifest is unexpired', async () => {
      await verifyCustomer();
      time += 13 * 60000;
      const review = await prepare();
      time += 3 * 60000;
      expect(review.expiresAt).toBeGreaterThan(time);
      await expect(start(review)).rejects.toMatchObject({ code: 'CUSTOMER_VERIFICATION_REQUIRED' });
      expect(await native.db.get('writer').select().from(orderCopyCommands)).toHaveLength(0);
    });
    it('a previously authorized command can recover, continue and acknowledge after fixed OTP expiry without renewing it', async () => {
      await verifyCustomer();
      const review = await prepare();
      let release = () => undefined as void,
        entered = () => undefined as void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        reached = new Promise<void>((resolve) => {
          entered = resolve;
        });
      let pause = true;
      let setCalls = 0;
      const port: CopyCartPort = {
        ...checkout.orderCopyCart,
        async read(current) {
          if (pause) {
            pause = false;
            entered();
            await gate;
          }
          return checkout.orderCopyCart.read(current);
        },
        async setLine(...args) {
          setCalls++;
          return checkout.orderCopyCart.setLine(...args);
        },
      };
      const runner = service(port),
        operationId = crypto.randomUUID(),
        initial = runner.start(operator, scope(), {
          operationId,
          reviewId: review.id,
          manifestHash: review.hash,
          expectedVersion: review.checkoutVersion,
        });
      await reached;
      time += 16 * 60000;
      try {
        const pending = await copy.read(operator, scope(), operationId);
        expect(pending.canContinue).toBe(true);
        expect((await copy.review(operator, scope(), review.id)).hash).toBe(review.hash);
        const completed = await runner.continue(operator, scope(), operationId, {
          operationId: crypto.randomUUID(),
          expectedVersion: pending.checkoutVersion,
        });
        expect(completed.status).toBe('review-required');
        expect(nativeAssertions).toBe(3);
        const acknowledged = await copy.acknowledge(operator, scope(), operationId, {
          operationId: crypto.randomUUID(),
          expectedVersion: completed.checkoutVersion,
          resultHash: completed.resultHash!,
        });
        expect(acknowledged.status).toBe('acknowledged');
        expect((await state()).verifiedCustomerUntil).toBeLessThan(time);
        expect((await copy.read(operator, scope(), operationId)).status).toBe('acknowledged');
      } finally {
        release();
        await initial;
      }
      expect(setCalls).toBe(1);
    });
    it('changed contact during history fetch refuses persistence rather than returning the fetched contents', async () => {
      await verifyCustomer();
      const changedFacts: CopyFactsPort = {
        async read(input) {
          const result = await facts.read(input);
          await native.db.get('writer').transaction(async (tx) => {
            await tx.update(MUser).set({ telephone: '9876543210' }).where(eq(MUser.id, 1001n));
            await bumpCurrentContactRevision(tx, '1001');
          });
          return result;
        },
      };
      await expect(prepare(service(checkout.orderCopyCart, changedFacts))).rejects.toMatchObject({
        code: 'ORDER_COPY_CUSTOMER_AUTHORITY_CHANGED',
      });
      expect(await native.db.get('writer').select().from(orderCopyReviews)).toHaveLength(0);
    });
    it('changed actor/contact cannot read or acknowledge an already-authorized result and its outcome stays durable', async () => {
      await verifyCustomer();
      const review = await prepare(),
        completed = await start(review);
      await native.connection.query(
        'UPDATE pos_rewrite_operator_auth_epochs SET epoch=epoch+1 WHERE operator_id=44',
      );
      await expect(copy.read(operator, scope(), completed.id)).rejects.toMatchObject({
        code: 'ORDER_COPY_CUSTOMER_AUTHORITY_CHANGED',
      });
      const [saved] = await native.db.get('writer').select().from(orderCopyCommands);
      expect(saved?.data.status).toBe('review-required');
      // Restore only this disposable fixture epoch to isolate the contact fence; no production restoration is performed.
      await native.connection.query(
        'UPDATE pos_rewrite_operator_auth_epochs SET epoch=epoch-1 WHERE operator_id=44',
      );
      await native.db.get('writer').transaction((tx) => bumpCurrentContactRevision(tx, '1001'));
      await expect(
        copy.acknowledge(operator, scope(), completed.id, {
          operationId: crypto.randomUUID(),
          expectedVersion: completed.checkoutVersion,
          resultHash: completed.resultHash!,
        }),
      ).rejects.toMatchObject({ code: 'ORDER_COPY_CUSTOMER_AUTHORITY_CHANGED' });
      expect((await native.db.get('writer').select().from(orderCopyCommands))[0]?.data.status).toBe(
        'review-required',
      );
    });
    it('correctly signed pre-fix customer rows remain unproved instead of receiving a fabricated authorization', async () => {
      await verifyCustomer();
      const fresh = await prepare(),
        [saved] = await native.db.get('writer').select().from(orderCopyReviews);
      const { hash: _hash, ...body } = fresh,
        legacy = {
          ...body,
          hash: operationHash('order-copy.review.v1', body, native.config.SESSION_SECRET),
        };
      await native.db
        .get('writer')
        .update(orderCopyReviews)
        .set({ data: legacy })
        .where(eq(orderCopyReviews.id, fresh.id));
      await expect(copy.review(operator, scope(), fresh.id)).rejects.toMatchObject({
        code: 'ORDER_COPY_CUSTOMER_AUTHORIZATION_UNPROVED',
      });
      await expect(start(legacy)).rejects.toMatchObject({
        code: 'ORDER_COPY_CUSTOMER_AUTHORIZATION_UNPROVED',
      });
      expect(await native.db.get('writer').select().from(orderCopyCommands)).toHaveLength(0);
      await native.db
        .get('writer')
        .update(orderCopyReviews)
        .set({ data: saved!.data })
        .where(eq(orderCopyReviews.id, fresh.id));
      const completed = await start(fresh),
        [command] = await native.db.get('writer').select().from(orderCopyCommands);
      await native.db
        .get('writer')
        .update(orderCopyCommands)
        .set({ data: { ...command!.data, review: legacy } })
        .where(eq(orderCopyCommands.id, completed.id));
      await expect(copy.read(operator, scope(), completed.id)).rejects.toMatchObject({
        code: 'ORDER_COPY_CUSTOMER_AUTHORIZATION_UNPROVED',
      });
      expect(
        (await native.db.get('writer').select().from(orderCopyCommands))[0]?.data.steps[0]?.status,
      ).toBe('confirmed');
    });
    it('a real proof cannot authorize facts returned for a different customer', async () => {
      await verifyCustomer();
      const mismatched: CopyFactsPort = {
        async read(input) {
          return { ...(await facts.read(input)), sourceCustomerId: '999' };
        },
      };
      await expect(prepare(service(checkout.orderCopyCart, mismatched))).rejects.toMatchObject({
        code: 'ORDER_COPY_CONTEXT_CHANGED',
      });
      expect(await native.db.get('writer').select().from(orderCopyReviews)).toHaveLength(0);
    });
    async function app(
      validator?: () => Promise<boolean>,
      cart: CopyCartPort = checkout.orderCopyCart,
      port = facts,
    ) {
      const instance = Fastify();
      instance.addHook('preHandler', async (request) => {
        request.principal = operator;
        if (validator) request.authSessionValid = validator;
      });
      instance.setErrorHandler((error, _request, reply) =>
        reply
          .code(error instanceof AppError ? error.status : 500)
          .send({ error: { code: error instanceof AppError ? error.code : 'FIXTURE_REJECTED' } }),
      );
      registerOrderCopy(instance, native.config, native.db, cart, {
        customerOtp: otp,
        facts: port,
        clock: () => time,
      });
      return instance;
    }
    it('missing and revoked after-await session validators withhold source/review data', async () => {
      await verifyCustomer();
      const base = `/api/v1/stores/1/checkout-sessions/${checkoutId}`;
      const absent = await app();
      try {
        expect(
          (await absent.inject({ method: 'GET', url: base + '/order-copies/current' })).statusCode,
        ).toBe(401);
      } finally {
        await absent.close();
      }
      let valid = true;
      const delayed: CopyFactsPort = {
        async read(input) {
          const result = await facts.read(input);
          valid = false;
          return result;
        },
      };
      const guarded = await app(async () => valid, checkout.orderCopyCart, delayed);
      try {
        const response = await guarded.inject({
          method: 'POST',
          url: base + '/order-copy-reviews',
          payload: {
            reviewId: crypto.randomUUID(),
            expectedVersion: (await state()).version,
            source,
          },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: { code: 'SESSION_EXPIRED' } });
        const [saved] = await native.db.get('writer').select().from(orderCopyReviews);
        expect(saved?.data.customerAuthority).toBeDefined();
        let checks = 0;
        const readGuard = await app(async () => ++checks === 1);
        try {
          const denied = await readGuard.inject({
            method: 'GET',
            url: base + '/order-copy-reviews/' + saved!.id,
          });
          expect(denied.statusCode).toBe(401);
          expect(denied.json()).toEqual({ error: { code: 'SESSION_EXPIRED' } });
        } finally {
          await readGuard.close();
        }
      } finally {
        await guarded.close();
      }
    });
    it('session loss after a dispatched cart change withholds the response but never erases or retries its saved outcome', async () => {
      await verifyCustomer();
      const review = await prepare();
      let valid = true,
        calls = 0;
      const port: CopyCartPort = {
        ...checkout.orderCopyCart,
        async setLine(...args) {
          calls++;
          const result = await checkout.orderCopyCart.setLine(...args);
          valid = false;
          return result;
        },
      };
      const guarded = await app(async () => valid, port),
        operationId = crypto.randomUUID(),
        base = `/api/v1/stores/1/checkout-sessions/${checkoutId}`;
      try {
        const response = await guarded.inject({
          method: 'POST',
          url: base + '/order-copies',
          payload: {
            operationId,
            reviewId: review.id,
            manifestHash: review.hash,
            expectedVersion: review.checkoutVersion,
          },
        });
        expect(response.statusCode).toBe(401);
        expect(calls).toBe(1);
        const [saved] = await native.db.get('writer').select().from(orderCopyCommands);
        expect(saved?.data.status).toBe('review-required');
        valid = true;
        const recovered = await guarded.inject({
          method: 'GET',
          url: base + '/order-copies/' + operationId,
        });
        expect(recovered.statusCode).toBe(200);
        expect(calls).toBe(1);
      } finally {
        await guarded.close();
      }
    });
  },
);
