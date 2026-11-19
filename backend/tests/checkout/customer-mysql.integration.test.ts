import { readFileSync } from 'node:fs';
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
  type RegistrationOtpSender,
} from '../../src/modules/checkout/customers/service.js';
import { customerRegistrationOutboxDispatcher } from '../../src/modules/checkout/customers/outbox.js';
import { registrationCodeDigest } from '../../src/modules/checkout/customers/crypto.js';
import type { DeliveryResult } from '../../src/modules/checkout/delivery.js';
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
    dispatch: ReturnType<typeof customerRegistrationOutboxDispatcher>;
  const environment = {
      secret: 'fixture-registration-encryption-key-'.repeat(3),
      ttlSeconds: 600,
      fallbackSeconds: 20,
    },
    messages: { phone: string; code: string; channel: 'sms' | 'whatsapp' }[] = [],
    observed: DeliveryResult[] = [];
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
    for (const table of [MUser, ExclusiveUser, StoreCounter, Product, ProductBarcode]) {
      const metadata = getTableConfig(table),
        definitions = metadata.columns.map(
          (column) =>
            `${mysql.escapeId(column.name)} ${column.getSQLType()}${column.notNull ? ' NOT NULL' : ''}${'autoIncrement' in column && column.autoIncrement ? ' AUTO_INCREMENT' : ''}`,
        ),
        primary = metadata.columns
          .filter((column) => column.primary)
          .map((column) => mysql.escapeId(column.name));
      if (primary.length) definitions.push(`PRIMARY KEY (${primary.join(',')})`);
      await connection.query(
        `CREATE TABLE ${mysql.escapeId(metadata.name)} (${definitions.join(',')}) ENGINE=InnoDB`,
      );
    }
    for (const name of [
      '0002_checkout.sql',
      '0008_checkout_draft_binding.sql',
      '0010_customer_registration.sql',
    ])
      for (const statement of readFileSync('src/modules/checkout/migrations/' + name, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((item) => item.trim()))
        await connection.query(statement);
    for (const statement of readFileSync('src/modules/customer-contacts/migration.sql', 'utf8')
      .replace(/^--.*$/gm, '')
      .split(';')
      .filter((item) => item.trim()))
      await connection.query(statement);
    for (const statement of readFileSync('src/modules/customer-contacts/contact-revisions-migration.sql','utf8')
      .replace(/^--.*$/gm,'').split(';').filter((value)=>value.trim())) await connection.query(statement);
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
      status: 1,
    });
    await seed(StoreCounter, { id: 3, store_id: 1, is_active: true });
    await seed(Product, { id: 10, prod_type: 1 });
    await seed(ProductBarcode, { product_id: 10, gtin: '8900000000010' });
  });
  beforeEach(() => {
    clock += 3600_001;
    messages.length = 0;
    observed.length = 0;
    smsUncertain = false;
    gateway = new FixtureGateway();
    const registration = customerRegistrationService(
      db,
      gateway,
      environment,
      sender,
      'Asia/Kolkata',
      () => clock,
    );
    service = checkoutService(checkoutRepository(db), gateway, signingEnvironment, {
      migrationV2: true,
      now: () => clock,
      registrations: registration,
      assertCheckIn: async () => {},
    });
    dispatch = customerRegistrationOutboxDispatcher(
      db,
      environment,
      sender,
      (event) => observed.push(event),
      () => clock,
    );
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
  it('queues encrypted registration once, consumes proof, preserves exact customer IDs and connects the original cart', async () => {
    const state = await service.create(operator, '1', '3'),
      value = details();
    await service.setLine(operator, '1', state.id, mutation(0), '10', 2);
    const input = mutation(1);
    await service.requestRegistration(operator, '1', state.id, input, value);
    await service.requestRegistration(operator, '1', state.id, input, value);
    const [stored] = await rows('SELECT * FROM pos_rewrite_customer_registrations WHERE id=?', [
      input.operationId,
    ]);
    expect(stored?.encrypted_input).not.toContain(value.telephone);
    expect(stored?.encrypted_input).not.toContain(value.email);
    expect(String(stored?.code_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await rows(
        'SELECT id FROM pos_rewrite_customer_registration_deliveries WHERE registration_id=?',
        [input.operationId],
      ),
    ).toHaveLength(2);
    await Promise.all(Array.from({ length: 20 }, () => dispatch()));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.channel).toBe('sms');
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
    const attached = await service.attachCustomer(operator, '1', state.id, mutation(4), customerId);
    expect(attached.state.customerId).toBe(customerId);
    expect(attached.state.verifiedCustomerUntil).toBe(clock + 15 * 60000);
    expect(attached.state.cart?.products.items[0]?.quantity).toBe(2);
    const [customer] = await rows('SELECT customer_type,gstin FROM users WHERE id=?', [customerId]);
    expect(customer).toMatchObject({ customer_type: 'B2B', gstin: value.gstin });
    const [consumed] = await rows(
      'SELECT code_hash,status FROM pos_rewrite_customer_registrations WHERE id=?',
      [input.operationId],
    );
    expect(consumed).toMatchObject({ code_hash: '', status: 'registered' });
    clock += 30_000;
    await dispatch();
    expect(messages).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      resource: 'customer-registration-sms',
      outcome: 'delivered',
      operatorId: '44',
    });
    expect(JSON.stringify(observed)).not.toContain(value.telephone);
    expect(gateway.calls.filter((call) => call.path === 'store-register')).toHaveLength(1);
  });
  it('freezes unknown registration and reconciles the proved writer identity without another creation', async () => {
    const request = await requested();
    await dispatch();
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
  it('retains wrong-code attempts across operation IDs and blocks resetting the shared budget in a new checkout', async () => {
    const request = await requested();
    await dispatch();
    for (let index = 0; index < 5; index++)
      await expect(
        service.verifyRegistration(operator, '1', request.id, mutation(1), '000000'),
      ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_CODE_INVALID' });
    expect((await service.read(operator, '1', request.id)).registration).toMatchObject({
      status: 'locked',
      attemptsRemaining: 0,
    });
    clock += 61_000;
    await expect(
      service.resendRegistration(operator, '1', request.id, mutation(1)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_RATE_LIMITED' });
    const other = await service.create(operator, '1', '3');
    await expect(
      service.requestRegistration(operator, '1', other.id, mutation(0), details()),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_RATE_LIMITED' });
    expect(gateway.calls.some((call) => call.path === 'store-register')).toBe(false);
  });
  it('freezes an uncertain SMS, delivers only the delayed WhatsApp fallback and never retries that SMS job', async () => {
    smsUncertain = true;
    const request = await requested();
    await dispatch();
    await dispatch();
    expect(messages).toHaveLength(1);
    expect((await service.read(operator, '1', request.id)).registration?.deliveries).toContainEqual(
      { channel: 'sms', status: 'uncertain' },
    );
    clock += 20_001;
    await dispatch();
    await dispatch();
    expect(messages.map((message) => message.channel)).toEqual(['sms', 'whatsapp']);
    expect(messages[1]?.code).toBe(messages[0]?.code);
    await service.verifyRegistration(operator, '1', request.id, mutation(1), messages[1]!.code);
    expect((await service.read(operator, '1', request.id)).registration?.status).toBe('verified');
  });
  it('invalidates a replaced registration code, cancels pending fallback and stops sends after cancellation', async () => {
    const request = await requested();
    await dispatch();
    const oldCode = messages[0]!.code;
    clock += 61_000;
    await service.resendRegistration(operator, '1', request.id, mutation(1));
    await dispatch();
    const currentCode = messages[1]!.code;
    if (currentCode !== oldCode)
      await expect(
        service.verifyRegistration(operator, '1', request.id, mutation(2), oldCode),
      ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_CODE_INVALID' });
    const [record] = await rows(
      'SELECT code_hash FROM pos_rewrite_customer_registrations WHERE id=?',
      [request.requestId],
    );
    expect(record?.code_hash).toBe(
      registrationCodeDigest(environment.secret, request.requestId, request.id, currentCode),
    );
    await service.cancelRegistration(operator, '1', request.id, mutation(2));
    clock += 30_000;
    await dispatch();
    expect(messages).toHaveLength(2);
    expect((await service.read(operator, '1', request.id)).registration).toBe(null);
    expect(
      await rows(
        'SELECT claim_key FROM pos_rewrite_customer_registration_claims WHERE registration_id=?',
        [request.requestId],
      ),
    ).toHaveLength(0);
  });
  it('recovers a queued request checkpoint after a process interruption without sending or enqueueing again', async () => {
    const request = await requested();
    await connection.execute(
      "UPDATE pos_rewrite_checkout_operations SET status='inflight',result=NULL WHERE checkout_id=? AND id=?",
      [request.id, request.requestId],
    );
    await connection.execute(
      "UPDATE pos_rewrite_checkout_sessions SET version=0,state=JSON_SET(state,'$.version',0,'$.busyOperationId',?,'$.updatedAt',?) WHERE id=?",
      [request.requestId, clock, request.id],
    );
    expect((await service.read(operator, '1', request.id)).registrationRequestRecovery).toBe(true);
    await expect(
      service.recoverRegistrationRequest(operator, '1', request.id, mutation(0)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_REQUEST_IN_PROGRESS' });
    clock += 61_000;
    const input = mutation(0),
      replies = await Promise.all(
        Array.from({ length: 20 }, () =>
          service.recoverRegistrationRequest(operator, '1', request.id, input),
        ),
      );
    expect(replies.every((reply) => ['inflight', 'succeeded'].includes(reply.status))).toBe(true);
    expect(
      (await service.recoverRegistrationRequest(operator, '1', request.id, input)).status,
    ).toBe('succeeded');
    expect((await service.operation(operator, '1', request.id, request.requestId)).status).toBe(
      'succeeded',
    );
    expect((await service.read(operator, '1', request.id)).registrationRequestRecovery).toBe(false);
    expect(
      await rows(
        'SELECT id FROM pos_rewrite_customer_registration_deliveries WHERE registration_id=?',
        [request.requestId],
      ),
    ).toHaveLength(2);
    expect(messages).toHaveLength(0);
    expect(gateway.calls.some((call) => call.path === 'store-register')).toBe(false);
    await dispatch();
    expect(messages.filter((message) => message.channel === 'sms')).toHaveLength(1);
    expect(messages.filter((message) => message.channel === 'whatsapp')).toHaveLength(1);
  });
  it('requires renewed phone proof before reconciling an old uncertain registration and still never redispatches it', async () => {
    const request = await requested();
    await dispatch();
    await service.verifyRegistration(operator, '1', request.id, mutation(1), messages[0]!.code);
    gateway.intercept = async (path) => {
      if (path !== 'store-register') return undefined;
      await createAccount(request.value, String(nextCustomer));
      throw new Error('Fixture unknown registration');
    };
    await expect(
      service.registerCustomer(operator, '1', request.id, mutation(2)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_OUTCOME_UNCERTAIN' });
    clock += 16 * 60_000;
    await expect(
      service.reconcileRegistration(operator, '1', request.id, mutation(2)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_REVERIFICATION_REQUIRED' });
    await service.resendRegistration(operator, '1', request.id, mutation(2));
    await dispatch();
    await service.verifyRegistration(operator, '1', request.id, mutation(3), messages.at(-1)!.code);
    const reply = await service.reconcileRegistration(operator, '1', request.id, mutation(4));
    if (reply.status !== 'succeeded') throw new Error('Expected proved customer');
    expect(reply.result).toMatchObject({ registration: { status: 'registered' } });
    expect(gateway.calls.filter((call) => call.path === 'store-register')).toHaveLength(1);
  });
  it('rejects an unbound customer response and holds unresolved contact claims instead of creating another account', async () => {
    const request = await requested();
    await dispatch();
    await service.verifyRegistration(operator, '1', request.id, mutation(1), messages[0]!.code);
    gateway.intercept = async (path) =>
      path === 'store-register' ? { status: 1, user_id: 777 } : undefined;
    await expect(
      service.registerCustomer(operator, '1', request.id, mutation(2)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_OUTCOME_UNCERTAIN' });
    await expect(
      service.reconcileRegistration(operator, '1', request.id, mutation(2)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_UNCONFIRMED' });
    await expect(
      service.cancelRegistration(operator, '1', request.id, mutation(2)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_REGISTRATION_REVIEW_REQUIRED' });
    const [owner] = await rows('SELECT customer_type,gstin FROM users WHERE id=777');
    // Nullable in production; the fixture-created account leaves both unset.
    expect(owner).toMatchObject({ customer_type: null, gstin: null });
    const other = await service.create(operator, '1', '3');
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
    await checkoutRepository(db).acquireGiftCard(state.id, 'fixture-clear-card');
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
    expect(
      await rows('SELECT customer_id FROM pos_rewrite_customer_cart_leases WHERE checkout_id=?', [
        state.id,
      ]),
    ).toHaveLength(0);
    expect(
      await rows('SELECT serial FROM pos_rewrite_gift_card_leases WHERE checkout_id=?', [state.id]),
    ).toHaveLength(0);
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
    const repository = checkoutRepository(db),
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
    expect(
      await rows('SELECT customer_id FROM pos_rewrite_customer_cart_leases WHERE checkout_id=?', [
        state.id,
      ]),
    ).toHaveLength(0);
    const calls = gateway.calls.length;
    const replay = await local.detachCustomer(operator, '1', state.id, input);
    expect(replay).toMatchObject({
      status: 'uncertain',
      state: { phase: 'cleared', lastClear: { status: 'cleared' } },
    });
    expect(gateway.calls).toHaveLength(calls);
  });
});
