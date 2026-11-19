import mysql, { type Connection } from 'mysql2/promise';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  ExclusiveUser,
  MUser,
  Product,
  ProductBarcode,
  StoreCounter,
} from '../../src/db/legacy-schema.js';
import { checkoutRepository } from '../../src/modules/checkout/repository.js';
import { checkoutService } from '../../src/modules/checkout/service.js';
import { CheckoutGatewayError } from '../../src/modules/checkout/gateway.js';
import {
  customerRegistrationService,
  registrationKeys,
  type RegistrationOtpSender,
} from '../../src/modules/checkout/customers/service.js';
import { registrationCodeDigest } from '../../src/modules/checkout/customers/crypto.js';
import {
  checkoutSessionStore,
  type CheckoutSessionStore,
} from '../../src/modules/checkout/session-store.js';
import { memoryStateStore, type PosStateStore } from '../../src/modules/checkout/state-store.js';
import { createProductionTables } from '../helpers/production-schema.js';
import { FixtureGateway, operator, signingEnvironment } from './fixtures.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('customer registration in an isolated writer schema', () => {
  let connection: Connection,
    db: Databases,
    schemaName = '',
    clock = Date.now(),
    nextCustomer = 88000,
    gateway: FixtureGateway,
    service: ReturnType<typeof checkoutService>,
    store: PosStateStore,
    sessions: CheckoutSessionStore;
  const environment = {
      secret: 'fixture-registration-encryption-key-'.repeat(3),
      ttlSeconds: 600,
      fallbackSeconds: 20,
    },
    messages: { phone: string; code: string; channel: 'sms' | 'whatsapp' }[] = [],
    fallbacks: { delayMs: number; run: () => Promise<void> }[] = [];
  let smsUncertain = false;
  const sender: RegistrationOtpSender = {
    assertReady: () => {},
    send: async (phone, code, channel) => {
      messages.push({ phone, code, channel });
      if (channel === 'sms' && smsUncertain) throw new Error('Fixture unknown delivery');
    },
  };
  const mutation = (expectedVersion: number) => ({
    operationId: crypto.randomUUID(),
    expectedVersion,
  });
  async function seed(table: MySqlTable, values: Record<string, string | number | boolean | null>) {
    const metadata = getTableConfig(table),
      record: Record<string, string | number | boolean | null> = {};
    for (const column of metadata.columns) {
      if ('autoIncrement' in column && column.autoIncrement) continue;
      const type = column.getSQLType();
      record[column.name] = !column.notNull
        ? null
        : /^(date|datetime|timestamp)/.test(type)
          ? type === 'date'
            ? '2026-11-16'
            : '2026-11-16 00:00:00'
          : type.startsWith('time')
            ? '00:00:00'
            : column.dataType === 'boolean'
              ? false
              : ['number', 'bigint'].includes(column.dataType) || type.startsWith('decimal')
                ? 0
                : '';
    }
    Object.assign(record, values);
    const names = Object.keys(record);
    await connection.execute(
      `INSERT INTO ${mysql.escapeId(metadata.name)} (${names.map(mysql.escapeId).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      names.map((name) => record[name]),
    );
  }
  async function rows(query: string, values: (string | number)[] = []) {
    const [result] = await connection.execute<mysql.RowDataPacket[]>(query, values);
    return result;
  }
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_checkout_test'
    )
      throw new Error('Customer tests refuse every non-isolated database template.');
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    schemaName = `pos_rewrite_checkout_test_customer_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schemaName)}`);
    await connection.changeUser({ database: schemaName });
    await createProductionTables(connection, [
      MUser,
      ExclusiveUser,
      StoreCounter,
      Product,
      ProductBarcode,
    ]);
    // Checkout sessions and registrations live in Redis (memory store here); their former
    // rewrite-table migrations are deleted.
    url.pathname = '/' + schemaName;
    db = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'customer-fixture-session-secret-'.repeat(3),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_WRITER_URL: url.href,
      }),
    );
    await seed(MUser, {
      id: 777,
      email: 'operator@example.com',
      firstname: 'Fixture Operator',
      telephone: '9000000000',
      pos_admin_id: 44,
      user_type: '8',
      status: 1,
    });
    await seed(StoreCounter, { id: 3, store_id: 1, is_active: true });
    await seed(Product, { id: 10, prod_type: 1 });
    await seed(ProductBarcode, { product_id: 10, gtin: '8900000000010' });
  });
  beforeEach(() => {
    // Send budgets are counted per clock hour (`consumeSendBudget`). Start every test at the
    // beginning of a fresh hour, at least an hour later, so a test's sends never straddle an hour
    // boundary; the offset used to follow the wall clock at file load, so runs started in the
    // last minutes of an hour saw the per-phone budget reset mid-test.
    clock = (Math.floor(clock / 3600_000) + 2) * 3600_000;
    messages.length = 0;
    fallbacks.length = 0;
    smsUncertain = false;
    gateway = new FixtureGateway();
    store = memoryStateStore(() => clock);
    sessions = checkoutSessionStore(store, () => clock);
    const registration = customerRegistrationService(
      db,
      gateway,
      environment,
      sender,
      'Asia/Kolkata',
      {
        stateStore: store,
        sessions,
        now: () => clock,
        schedule: (delayMs, run) => fallbacks.push({ delayMs, run }),
      },
    );
    service = checkoutService(checkoutRepository(db, sessions), gateway, signingEnvironment, {
      migrationV2: true,
      now: () => clock,
      registrations: registration,
      assertCheckIn: async () => {},
    });
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      if (schemaName) await connection.query(`DROP DATABASE ${mysql.escapeId(schemaName)}`);
      await connection.end();
    }
  });
  function details() {
    nextCustomer++;
    return {
      name: 'New Fixture Customer',
      telephone: String(9000000000 + nextCustomer),
      email: `customer${nextCustomer}@example.com`,
      birthdate: '1990-01-02',
      customerType: 'B2B' as const,
      gstin: '29ABCDE1234F1Z5',
    };
  }
  async function requested() {
    const state = await service.create(operator, '1', '3'),
      value = details(),
      input = mutation(0);
    await service.requestRegistration(operator, '1', state.id, input, value);
    return { id: state.id, value, requestId: input.operationId };
  }
  async function runFallbacks() {
    for (const task of fallbacks.splice(0)) await task.run();
  }
  async function record(id: string) {
    return JSON.parse((await store.get(registrationKeys.record(id))) ?? 'null') as Record<
      string,
      unknown
    > | null;
  }
  async function createAccount(value: ReturnType<typeof details>, id: string) {
    await seed(MUser, {
      id,
      firstname: value.name,
      email: value.email,
      telephone: value.telephone,
      status: 1,
      is_two_fa: 1,
    });
  }
  it('sends the legacy SMS synchronously once, keeps PII sealed, registers and connects the original cart', async () => {
    const state = await service.create(operator, '1', '3'),
      value = details();
    await service.setLine(operator, '1', state.id, mutation(0), '10', 2);
    const input = mutation(1);
    await service.requestRegistration(operator, '1', state.id, input, value);
    await service.requestRegistration(operator, '1', state.id, input, value);
    expect(messages).toEqual([{ phone: value.telephone, code: messages[0]!.code, channel: 'sms' }]);
    expect(messages[0]!.code).toMatch(/^[1-9]{6}$/);
    const stored = await store.get(registrationKeys.record(input.operationId));
    expect(stored).not.toContain(value.telephone);
    expect(stored).not.toContain(value.email);
    expect(stored).not.toContain(messages[0]!.code);
    expect((await sessions.read(state.id))?.registrationId).toBe(input.operationId);
    const code = messages[0]!.code;
    await service.verifyRegistration(operator, '1', state.id, mutation(2), code);
    const customerId = '9007199254740993';
    gateway.intercept = async (path) => {
      if (path !== 'store-register') return undefined;
      await createAccount(value, customerId);
      return { status: 1, user_id: customerId, access_token: 'private-upstream-token' };
    };
    const registration = await service.registerCustomer(operator, '1', state.id, mutation(3));
    expect(registration.status).toBe('succeeded');
    expect(JSON.stringify(registration)).not.toContain('private-upstream-token');
    expect(gateway.calls.find((call) => call.path === 'store-register')?.payload).toEqual({
      first_name: value.name,
      telephone: Number(value.telephone),
      email: value.email,
      customer_type: 'B2B',
      gstin: value.gstin,
      birthdate: value.birthdate,
      localcart: {},
      store_id: 1,
      pos_localcart: {},
    });
    const attached = await service.attachCustomer(operator, '1', state.id, mutation(4), customerId);
    expect(attached.state.customerId).toBe(customerId);
    expect(attached.state.verifiedCustomerUntil).toBe(clock + 15 * 60000);
    expect(attached.state.cart?.products.items[0]?.quantity).toBe(2);
    // Legacy POS never writes users: API-v2 store-register owns the row.
    const [customer] = await rows('SELECT customer_type,gstin FROM users WHERE id=?', [customerId]);
    expect(customer).toMatchObject({ customer_type: null, gstin: null });
    expect(await record(input.operationId)).toMatchObject({ codeHash: '', status: 'registered' });
    // The WhatsApp fallback fires after 20 s only while the same code is still pending.
    expect(fallbacks.map((task) => task.delayMs)).toEqual([20_000]);
    await runFallbacks();
    expect(messages).toHaveLength(1);
    expect(gateway.calls.filter((call) => call.path === 'store-register')).toHaveLength(1);
  });
  it('refuses an already registered mobile or email with the legacy messages', async () => {
    const state = await service.create(operator, '1', '3');
    await expect(
      service.requestRegistration(operator, '1', state.id, mutation(0), {
        ...details(),
        telephone: '9000000000',
      }),
    ).rejects.toMatchObject({
      code: 'CUSTOMER_PHONE_REGISTERED',
      message: 'Mobile No is already registered with us',
    });
    await expect(
      service.requestRegistration(operator, '1', state.id, mutation(0), {
        ...details(),
        email: 'operator@example.com',
      }),
    ).rejects.toMatchObject({
      code: 'CUSTOMER_EMAIL_REGISTERED',
      message: 'Email is already registered with us',
    });
    expect(messages).toHaveLength(0);
  });
  it('freezes unknown registration and reconciles the proved writer identity without another creation', async () => {
    const request = await requested();
    await service.verifyRegistration(operator, '1', request.id, mutation(1), messages[0]!.code);
    const customerId = String(nextCustomer);
    gateway.intercept = async (path) => {
      if (path !== 'store-register') return undefined;
      await createAccount(request.value, customerId);
      throw new CheckoutGatewayError(
        'FIXTURE_REGISTRATION_UNKNOWN',
        'Fixture lost creation response',
        true,
      );
    };
    const input = mutation(2);
    await expect(service.registerCustomer(operator, '1', request.id, input)).rejects.toMatchObject({
      code: 'CUSTOMER_REGISTRATION_OUTCOME_UNCERTAIN',
    });
    expect((await service.read(operator, '1', request.id)).registration?.status).toBe('uncertain');
    expect((await service.registerCustomer(operator, '1', request.id, input)).status).toBe(
      'rejected',
    );
    await expect(
      service.registerCustomer(operator, '1', request.id, mutation(2)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_REVIEW_REQUIRED' });
    const reconciled = await service.reconcileRegistration(operator, '1', request.id, mutation(2));
    if (reconciled.status !== 'succeeded') throw new Error('Expected proved registration');
    expect(reconciled.result).toMatchObject({ registration: { status: 'registered', customerId } });
    expect(gateway.calls.filter((call) => call.path === 'store-register')).toHaveLength(1);
    expect(
      (await service.attachCustomer(operator, '1', request.id, mutation(3), customerId)).state
        .customerId,
    ).toBe(customerId);
  });
  it('returns a definitive API-v2 refusal to the cashier and keeps the verified registration', async () => {
    const request = await requested();
    await service.verifyRegistration(operator, '1', request.id, mutation(1), messages[0]!.code);
    gateway.intercept = async (path) => {
      if (path !== 'store-register') return undefined;
      throw new CheckoutGatewayError('CHECKOUT_REJECTED', 'Telephone already exists', false, 422);
    };
    await expect(
      service.registerCustomer(operator, '1', request.id, mutation(2)),
    ).rejects.toMatchObject({
      code: 'CUSTOMER_REGISTRATION_REJECTED',
      status: 400,
      message: 'Telephone already exists',
    });
    expect((await service.read(operator, '1', request.id)).registration?.status).toBe('verified');
  });
  it('locks a registration after five wrong codes and rate-limits resends per phone', async () => {
    const request = await requested(),
      next = async () => mutation((await service.read(operator, '1', request.id)).version);
    for (let index = 0; index < 5; index++)
      await expect(
        service.verifyRegistration(operator, '1', request.id, await next(), '000000'),
      ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_CODE_INVALID', status: 400 });
    expect((await service.read(operator, '1', request.id)).registration).toMatchObject({
      status: 'locked',
      attemptsRemaining: 0,
    });
    await expect(
      service.verifyRegistration(operator, '1', request.id, await next(), messages[0]!.code),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_ATTEMPT_LIMIT', status: 429 });
    await expect(
      service.resendRegistration(operator, '1', request.id, await next()),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_RATE_LIMITED', status: 429 });
    for (let index = 0; index < 4; index++) {
      clock += 61_000;
      await service.resendRegistration(operator, '1', request.id, await next());
    }
    clock += 61_000;
    await expect(
      service.resendRegistration(operator, '1', request.id, await next()),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_RATE_LIMITED' });
    expect(messages).toHaveLength(5);
    expect(gateway.calls.some((call) => call.path === 'store-register')).toBe(false);
  });
  it('sends the delayed WhatsApp fallback with the same code when the SMS failed', async () => {
    smsUncertain = true;
    const request = await requested();
    expect((await service.read(operator, '1', request.id)).registration?.deliveries).toEqual([
      { channel: 'sms', status: 'failed' },
      { channel: 'whatsapp', status: 'scheduled' },
    ]);
    await runFallbacks();
    expect(messages.map((message) => message.channel)).toEqual(['sms', 'whatsapp']);
    expect(messages[1]?.code).toBe(messages[0]?.code);
    expect((await service.read(operator, '1', request.id)).registration?.deliveries).toContainEqual(
      { channel: 'whatsapp', status: 'sent' },
    );
    await service.verifyRegistration(operator, '1', request.id, mutation(1), messages[1]!.code);
    expect((await service.read(operator, '1', request.id)).registration?.status).toBe('verified');
  });
  it('invalidates a replaced code, skips its stale fallback and stops sends after cancellation', async () => {
    const request = await requested();
    const oldCode = messages[0]!.code;
    clock += 61_000;
    await service.resendRegistration(operator, '1', request.id, mutation(1));
    const currentCode = messages[1]!.code;
    if (currentCode !== oldCode)
      await expect(
        service.verifyRegistration(operator, '1', request.id, mutation(2), oldCode),
      ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_CODE_INVALID' });
    expect((await record(request.requestId))?.codeHash).toBe(
      registrationCodeDigest(environment.secret, request.requestId, request.id, currentCode),
    );
    const saved = await record(request.requestId),
      claims = ['phone', 'email'].map((kind) =>
        registrationKeys.claim(`${kind}:${String(saved?.[`${kind}Hash`])}`),
      );
    for (const claim of claims) expect(await store.get(claim)).toBe(request.requestId);
    await service.cancelRegistration(operator, '1', request.id, mutation(2));
    await runFallbacks();
    expect(messages).toHaveLength(2);
    expect((await service.read(operator, '1', request.id)).registration).toBe(null);
    for (const claim of claims) expect(await store.get(claim)).toBeNull();
  });
  it('recovers an interrupted request checkpoint from the saved registration without sending again', async () => {
    const request = await requested(),
      receipt = await sessions.receipt(request.id, request.requestId),
      current = await sessions.read(request.id);
    await sessions.saveReceipt({ ...receipt!, status: 'inflight', result: null });
    await sessions.write({
      ...current!,
      version: 0,
      busyOperationId: request.requestId,
      updatedAt: clock,
    });
    expect((await service.read(operator, '1', request.id)).registrationRequestRecovery).toBe(true);
    clock += 61_000;
    const input = mutation(0);
    expect(
      (await service.recoverRegistrationRequest(operator, '1', request.id, input)).status,
    ).toBe('succeeded');
    expect((await service.read(operator, '1', request.id)).registrationRequestRecovery).toBe(false);
    expect(messages).toHaveLength(1);
    expect(gateway.calls.some((call) => call.path === 'store-register')).toBe(false);
  });
  it('holds the contact claim for an unresolved registration in another sale', async () => {
    const request = await requested();
    await service.verifyRegistration(operator, '1', request.id, mutation(1), messages[0]!.code);
    gateway.intercept = async (path) =>
      path === 'store-register' ? { status: 1, user_id: 777 } : undefined;
    await expect(
      service.registerCustomer(operator, '1', request.id, mutation(2)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_UNCONFIRMED' });
    await expect(
      service.reconcileRegistration(operator, '1', request.id, mutation(2)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_UNCONFIRMED' });
    await expect(
      service.cancelRegistration(operator, '1', request.id, mutation(2)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_REVIEW_REQUIRED' });
    const other = await service.create(operator, '1', '3');
    clock += 61_000;
    await expect(
      service.requestRegistration(operator, '1', other.id, mutation(0), request.value),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_BUSY' });
    expect(gateway.calls.filter((call) => call.path === 'store-register')).toHaveLength(1);
  });
  it('binds confirmed detach proof to the original manifest and closes the session with its leases atomically', async () => {
    const draftId = crypto.randomUUID(),
      state = await service.create(operator, '1', '3', draftId, {
        version: clock,
        lineItems: [{ productId: '10', quantity: 1 }],
      });
    await service.initializeDraft(operator, '1', state.id, mutation(0));
    await service.attachCustomer(operator, '1', state.id, mutation(1), '777');
    await checkoutRepository(db, sessions).acquireGiftCard(state.id, 'fixture-clear-card');
    const input = mutation(2),
      result = await service.detachCustomer(operator, '1', state.id, input);
    expect(result.state).toMatchObject({
      phase: 'cleared',
      customerId: null,
      lastClear: {
        status: 'cleared',
        operatorId: '44',
        checkoutId: state.id,
        operationId: input.operationId,
        draftId,
        draftVersion: clock,
        storeId: '1',
        counterId: '3',
        reason: 'customer-detach',
      },
    });
    expect(await sessions.leaseHolder('customer', '777')).toBeNull();
    expect(await sessions.leaseHolder('gift-card', 'fixture-clear-card')).toBeNull();
    const calls = gateway.calls.length;
    expect((await service.read(operator, '1', state.id)).phase).toBe('cleared');
    expect((await service.detachCustomer(operator, '1', state.id, input)).status).toBe('succeeded');
    expect(gateway.calls).toHaveLength(calls);
    await expect(
      service.setLine(operator, '1', state.id, mutation(3), '10', 1),
    ).rejects.toMatchObject({ code: 'CHECKOUT_CLEARED' });
    expect(
      (
        await service.create(operator, '1', '3', draftId, {
          version: clock,
          lineItems: [{ productId: '10', quantity: 1 }],
        })
      ).phase,
    ).toBe('cleared');
  });
  it('retains terminal clear evidence and released leases if the final receipt write is interrupted', async () => {
    const repository = checkoutRepository(db, sessions),
      finish = repository.finish;
    let interruptedId = '';
    repository.finish = async (state, id, result) => {
      if (id === interruptedId) throw new Error('Fixture interrupted receipt write');
      return finish(state, id, result);
    };
    const local = checkoutService(repository, gateway, signingEnvironment, {
        migrationV2: true,
        now: () => clock,
        assertCheckIn: async () => {},
      }),
      state = await local.create(operator, '1', '3', crypto.randomUUID(), {
        version: clock,
        lineItems: [{ productId: '10', quantity: 1 }],
      });
    await local.initializeDraft(operator, '1', state.id, mutation(0));
    await local.attachCustomer(operator, '1', state.id, mutation(1), '777');
    const input = mutation(2);
    interruptedId = input.operationId;
    await expect(local.detachCustomer(operator, '1', state.id, input)).rejects.toMatchObject({
      code: 'CHECKOUT_OUTCOME_UNCERTAIN',
    });
    expect(await local.read(operator, '1', state.id)).toMatchObject({
      phase: 'cleared',
      lastClear: { status: 'cleared', operationId: input.operationId },
      customerId: null,
    });
    expect(await sessions.leaseHolder('customer', '777')).toBeNull();
    const calls = gateway.calls.length;
    const replay = await local.detachCustomer(operator, '1', state.id, input);
    expect(replay).toMatchObject({
      status: 'uncertain',
      state: { phase: 'cleared', lastClear: { status: 'cleared' } },
    });
    expect(gateway.calls).toHaveLength(calls);
  });
});
