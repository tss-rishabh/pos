import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { splitMigration } from '../../src/db/migrations.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { checkoutRepository } from '../../src/modules/checkout/repository.js';
import { registerReturns } from '../../src/modules/checkout/return-workflow/routes.js';
import { returnRepository } from '../../src/modules/checkout/return-workflow/repository.js';
import { returnWindowExtensions } from '../../src/modules/checkout/return-workflow/extensions.js';
import {
  returnWindowInputSchema,
  returnInputSchema,
  type ReturnGateway,
} from '../../src/modules/checkout/return-workflow/contracts.js';
import { memoryStateStore } from '../../src/modules/checkout/state-store.js';
import { returnState } from '../../src/modules/checkout/return-workflow/state.js';
import { readCustomerContactBinding } from '../../src/modules/checkout/customer-contact-authority.js';
import { requestEvent } from '../../src/observability/events.js';
import { returnWindowNativeFixture } from './native-fixture.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
const secret = 'return-window-native-customer-and-revision-proof-'.repeat(2);
const actor: Principal = {
  id: '1',
  role: 3,
  userType: 1,
  name: 'Synthetic manager',
  email: 'manager@example.test',
  storeIds: ['1'],
};
const productId = '9007199254740993';
const day = (days: number) =>
  Temporal.Now.zonedDateTimeISO('Asia/Kolkata').toPlainDate().add({ days }).toString();
const windowView = z
  .object({
    orderId: z.string(),
    lineId: z.string(),
    productId: z.string(),
    date: z.string().nullable(),
    active: z.boolean(),
    revision: z.string(),
    today: z.string(),
    windowClosed: z.boolean(),
  })
  .strict();
const refuse = async (): Promise<never> => {
  throw new Error('No external dispatch belongs to date extension');
};
const sink: ReturnGateway = {
  configured() {
    throw new Error('No return dispatch belongs to date extension');
  },
  sendOtp: refuse,
  verifyOtp: refuse,
  orderEligibility: refuse,
  eligibility: refuse,
  inbound: refuse,
  refund: refuse,
  returnMail: refuse,
  exchangeMail: refuse,
  slack: refuse,
};
describe.skipIf(!template)('manager return date on verified native source tables', () => {
  let f: Awaited<ReturnType<typeof returnWindowNativeFixture>>;
  let proofId: string,
    currentActor: Principal = actor;
  let api: FastifyInstance;
  let store = memoryStateStore();
  let extension: ReturnType<typeof returnWindowExtensions>,
    repository: ReturnType<typeof returnRepository>;
  const events: unknown[] = [];
  beforeAll(async () => {
    f = await returnWindowNativeFixture(template!);
    await f.fixture.create(['extend_applicability_for_return_exchange', 'reverse_pickup_reason']);
    for (const file of ['src/modules/administration/migration.sql'])
      for (const statement of splitMigration(readFileSync(file, 'utf8')))
        await f.connection.query(statement);
  });
  afterAll(async () => {
    await api?.close();
    await f?.close();
  });
  async function setup(role: Principal['role'] = 3) {
    await api?.close();
    const [tables] = await f.connection.query<RowDataPacket[]>('SHOW TABLES');
    for (const row of tables) {
      const name = String(Object.values(row)[0]);
      if (
        name === 'pos_rewrite_operator_checkins' ||
        name === 'extend_applicability_for_return_exchange' ||
        name === 'reverse_pickup_reason'
      )
        await f.connection.query('DELETE FROM `' + name + '`');
    }
    await f.reset();
    currentActor = { ...actor, role };
    events.length = 0;
    await f.connection.query('UPDATE pos_user SET role=? WHERE id=1', [role]);
    await f.fixture.insert('user_stores', { django_user_id: '1', store_id: '1' });
    await f.fixture.insert('users', {
      id: '88',
      pos_admin_id: '1',
      status: 1,
      is_block: 0,
      is_disabled: 0,
      email: 'native-manager@example.test',
    });
    await f.connection.query("UPDATE users SET user_type='2',telephone='9876543210' WHERE id=77");
    await f.fixture.insert('orders', {
      id: '100',
      user_id: '77',
      order_status: 3,
      payment_status: 4,
    });
    for (const id of ['1000', '1001'])
      await f.fixture.insert('has_products', {
        id,
        order_id: '100',
        prod_id: productId,
        qty: 1,
        status: 'DELIVERED',
        return_status: 0,
      });
    await f.fixture.insert('orders', {
      id: '101',
      user_id: '77',
      order_status: 3,
      payment_status: 4,
    });
    await f.fixture.insert('has_products', {
      id: '1002',
      order_id: '101',
      prod_id: productId,
      qty: 1,
      status: 'DELIVERED',
      return_status: 0,
    });
    await f.fixture.insert('comments', {
      order_id: '100',
      status_id: 3,
      created_at: '2026-01-01 12:00:00',
    });
    await checkInService(f.db, f.config).set(currentActor, '1', '2');
    // The customer verification proof is Redis state (pos:return_verification:{id}); the OTP
    // exchange itself belongs to the customer-otp module and is outside this native test.
    store = memoryStateStore();
    const state = returnState(store),
      customers = checkoutRepository(f.db);
    proofId = randomUUID();
    const contact = await f.db
      .get('writer')
      .transaction((tx) => readCustomerContactBinding(tx, '77'));
    await state.saveVerification({
      id: proofId,
      operatorId: currentActor.id,
      storeId: '1',
      counterId: '2',
      orderId: '100',
      customerId: '77',
      requestHash: 'a'.repeat(64),
      sent: false,
      expiresAt: Date.now() + 300000,
      verifiedUntil: Date.now() + 900000,
      busyOperationId: null,
      contact,
      otpChallengeId: null,
      deliveryStatus: 'sent',
      requestOperationId: null,
      verifyOperationId: null,
      verificationError: null,
    });
    repository = returnRepository(f.db, f.config, { returnPeriodDays: 30, state });
    extension = returnWindowExtensions(f.db, f.config, { repository });
    api = Fastify();
    api.addHook('preHandler', async (request) => {
      request.principal = currentActor;
    });
    api.addHook('onResponse', async (request, reply) => {
      events.push(requestEvent(request, reply));
    });
    api.setErrorHandler((error, _request, reply) => {
      const status =
        error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500;
      void reply.code(status).send({
        error: {
          code:
            error instanceof AppError
              ? error.code
              : error instanceof z.ZodError
                ? 'VALIDATION_ERROR'
                : 'INTERNAL_ERROR',
          message: 'The return date could not be confirmed.',
        },
      });
    });
    registerReturns(api, f.config, f.db, {
      signing: { hs256: secret },
      customers,
      gateway: sink,
      environment: { returnPeriodDays: 30 },
      stateStore: store,
    });
    await api.ready();
  }
  beforeEach(() => setup());
  function scope() {
    return { counterId: '2', verificationId: proofId, productId };
  }
  const path = '/api/v1/stores/1/orders/100/line-items/1000/return-window';
  async function get() {
    return extension.read(currentActor, '1', '100', '1000', scope());
  }
  async function put(date: string, revision: string) {
    return extension.set(currentActor, '1', '100', '1000', {
      ...scope(),
      date,
      expectedRevision: revision,
    });
  }
  async function rows() {
    const [result] = await f.connection.query<RowDataPacket[]>(
      'SELECT * FROM extend_applicability_for_return_exchange ORDER BY id',
    );
    return result;
  }
  it.each([1, 2, 3] as const)(
    'registered resources admit current source role %s and emit only private resource events',
    async (role) => {
      await setup(role);
      const before = await api.inject({
        method: 'GET',
        url: path + '?' + new URLSearchParams(scope()),
      });
      expect(before.statusCode).toBe(200);
      const state = windowView.parse(before.json());
      expect(state.windowClosed).toBe(true);
      const result = await api.inject({
        method: 'PUT',
        url: path,
        payload: { ...scope(), date: day(3), expectedRevision: state.revision },
      });
      expect(result.statusCode).toBe(200);
      expect(windowView.parse(result.json())).toMatchObject({ date: day(3), active: true });
      expect(
        (await rows()).map((r) => ({
          order: r.order_id,
          line: r.has_product_id,
          product: r.prod_id,
          date: r.extended_date,
          created: r.created_by,
          updated: r.updated_by,
        })),
      ).toEqual([
        {
          order: '100',
          line: '1000',
          product: productId,
          date: day(3) + ' 23:59:59',
          created: '88',
          updated: '88',
        },
      ]);
      const log = JSON.stringify(events);
      expect(log).toContain('checkout.return-window-extension.update.completed');
      for (const privateValue of [
        '9876543210',
        'native-manager@example.test',
        'Synthetic manager',
        proofId,
        state.revision,
        day(3),
      ])
        expect(log).not.toContain(privateValue);
    },
  );
  it('20 exact retries store one native tuple and a lost response is recovered by a read', async () => {
    const before = await get(),
      date = day(4);
    const result = await Promise.all(Array.from({ length: 20 }, () => put(date, before.revision)));
    expect(new Set(result.map((r) => r.revision)).size).toBe(1);
    expect(await rows()).toHaveLength(1);
    expect(await get()).toEqual(result[0]);
  }, 15000);
  it('a stale competing date is refused and an explicit fresh update can shorten without deleting history', async () => {
    const start = await get(),
      first = await put(day(10), start.revision),
      old = (await rows())[0]!;
    await expect(put(day(12), start.revision)).rejects.toMatchObject({
      code: 'RETURN_EXTENSION_CHANGED',
    });
    const next = await put(day(0), first.revision),
      latest = (await rows())[0]!;
    expect(next.date).toBe(day(0));
    expect(latest.extended_date).toBe(day(0) + ' 23:59:59');
    expect(latest.id).toBe(old.id);
    expect(latest.created_by).toBe(old.created_by);
    expect(latest.created_at).toBe(old.created_at);
  });
  it.each([4, 5] as const)(
    'refuses disallowed source role %s even with a verified customer',
    async (role) => {
      const start = await get();
      currentActor = { ...actor, role };
      await f.connection.query('UPDATE pos_user SET role=? WHERE id=1', [role]);
      await expect(put(day(1), start.revision)).rejects.toMatchObject({
        code: 'ROLE_ACCESS_DENIED',
      });
      expect(await rows()).toHaveLength(0);
    },
  );
  it('cached manager authority cannot survive native role revocation or expired check-in', async () => {
    const start = await get();
    await f.connection.query('UPDATE pos_user SET role=5 WHERE id=1');
    await expect(put(day(1), start.revision)).rejects.toMatchObject({ code: 'ROLE_ACCESS_DENIED' });
    await f.connection.query('UPDATE pos_user SET role=3 WHERE id=1');
    await f.connection.query(
      "UPDATE pos_rewrite_operator_checkins SET expires_at='2020-01-01 00:00:00'",
    );
    await expect(put(day(1), start.revision)).rejects.toMatchObject({ code: 'CHECK_IN_REQUIRED' });
    expect(await rows()).toHaveLength(0);
  });
  it('current assignment, counter and account revocations are enforced despite cached scope', async () => {
    const start = await get();
    await f.connection.query('DELETE FROM user_stores');
    await expect(put(day(1), start.revision)).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await f.fixture.insert('user_stores', { django_user_id: '1', store_id: '1' });
    await f.connection.query('UPDATE store_counters SET is_active=0 WHERE id=2');
    await expect(put(day(1), start.revision)).rejects.toMatchObject({
      code: 'COUNTER_UNAVAILABLE',
    });
    await f.connection.query('UPDATE store_counters SET is_active=1 WHERE id=2');
    await f.connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
    await expect(put(day(1), start.revision)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await rows()).toHaveLength(0);
  });
  it('rejects another product/HP/order or expired/customer-contact-changed proof before any write', async () => {
    const start = await get();
    await expect(
      extension.set(actor, '1', '100', '1000', {
        ...scope(),
        productId: '123',
        date: day(1),
        expectedRevision: start.revision,
      }),
    ).rejects.toMatchObject({ code: 'RETURN_EXTENSION_LINE_INELIGIBLE' });
    await expect(
      extension.set(actor, '1', '100', '1002', {
        ...scope(),
        date: day(1),
        expectedRevision: start.revision,
      }),
    ).rejects.toMatchObject({ code: 'RETURN_LINE_NOT_FOUND' });
    await f.connection.query("UPDATE users SET telephone='9876543211' WHERE id=77");
    await expect(put(day(1), start.revision)).rejects.toMatchObject({
      code: 'RETURN_CUSTOMER_VERIFICATION_REQUIRED',
    });
    await f.connection.query("UPDATE users SET user_type='2',telephone='9876543210' WHERE id=77");
    const proof = (await returnState(store).readVerification(proofId))!;
    await returnState(store).saveVerification({ ...proof, verifiedUntil: 0 });
    await expect(put(day(1), start.revision)).rejects.toMatchObject({
      code: 'RETURN_CUSTOMER_VERIFICATION_REQUIRED',
    });
    expect(await rows()).toHaveLength(0);
  });
  it('refuses ambiguous existing extensions and missing native manager identity', async () => {
    for (let i = 0; i < 2; i++)
      await f.fixture.insert('extend_applicability_for_return_exchange', {
        order_id: 100,
        prod_id: productId,
        has_product_id: 1000,
        extended_date: day(2) + ' 23:59:59',
        created_by: 88,
        updated_by: 88,
        is_active: 1,
      });
    await expect(get()).rejects.toMatchObject({ code: 'RETURN_EXTENSION_AMBIGUOUS' });
    await f.connection.query('DELETE FROM extend_applicability_for_return_exchange');
    await f.connection.query('DELETE FROM users WHERE id=88');
    await expect(get()).rejects.toMatchObject({ code: 'RETURN_EXTENSION_ACTOR_UNAVAILABLE' });
  });
  it('strict dates and resource bodies cannot carry money, guessed authority or clear native state', async () => {
    const start = await get();
    await expect(put(day(-1), start.revision)).rejects.toMatchObject({
      code: 'RETURN_EXTENSION_DATE_INVALID',
    });
    for (const date of ['', '2026-02-30', '2026-13-01'])
      expect(
        returnWindowInputSchema.safeParse({ ...scope(), date, expectedRevision: start.revision })
          .success,
      ).toBe(false);
    await expect(put('0001-01-01', start.revision)).rejects.toMatchObject({
      code: 'RETURN_EXTENSION_DATE_INVALID',
    });
    const result = await api.inject({
      method: 'PUT',
      url: path,
      payload: {
        ...scope(),
        date: day(1),
        expectedRevision: start.revision,
        amount: '100',
        email: 'return-extension-private-canary@example.test',
        role: 1,
      },
    });
    expect(result.statusCode).toBe(400);
    expect(JSON.stringify(events)).not.toContain('return-extension-private-canary');
    expect(await rows()).toHaveLength(0);
  });
  it('the real return admission consumes the new exact-HP date while the duplicate-SKU sibling stays closed', async () => {
    const input = returnInputSchema.parse({
      operationId: randomUUID(),
      counterId: '2',
      verificationId: proofId,
      reasonId: '1',
      qualityConfirmed: true,
      tagConfirmed: true,
      saleable: false,
    });
    await expect(repository.begin(actor, '1', '100', '1000', input)).rejects.toMatchObject({
      code: 'RETURN_WINDOW_CLOSED',
    });
    const start = await get();
    await put(day(1), start.revision);
    await f.fixture.insert('reverse_pickup_reason', { id: 1, reason: 'Fixture size' });
    await f.fixture.insert('amount_to_be_refunded_log', {
      order_id: 100,
      prod_id: productId,
      has_product_id: 1000,
      is_refunded: 0,
    });
    await expect(
      repository.begin(actor, '1', '100', '1001', { ...input, operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'RETURN_WINDOW_CLOSED' });
    const accepted = await repository.begin(actor, '1', '100', '1000', input);
    expect(accepted.operation).toMatchObject({ lineId: '1000', phase: 'inbound-dispatching' });
  });
  it('does not alter money, stock, line status or start a return/refund operation', async () => {
    const query =
      'SELECT o.pay_amt,o.order_status,o.payment_status,u.tss_money,u.tss_points,u.cashback,h.status,h.return_status,p.stock FROM orders o JOIN users u ON u.id=o.user_id JOIN has_products h ON h.order_id=o.id JOIN product_store p ON p.product_id=h.prod_id WHERE o.id=100 ORDER BY h.id';
    const [before] = await f.connection.query(query);
    const start = await get();
    await put(day(1), start.revision);
    const [after] = await f.connection.query(query);
    expect(after).toEqual(before);
    expect([...store.entries().keys()].filter((key) => key.startsWith('pos:return_op'))).toEqual(
      [],
    );
  });
});
