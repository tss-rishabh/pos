import { randomUUID } from 'node:crypto';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig, type Config } from '../../../src/config.js';
import { createDatabases, type Databases } from '../../../src/db/pools.js';
import type { Principal } from '../../../src/domain/access.js';
import type { JobArgs, JobName, JobProducer } from '../../../src/jobs/contract.js';
import type { CheckoutGateway } from '../../../src/modules/checkout/gateway.js';
import type { CustomerIdentity } from '../../../src/modules/checkout/contracts.js';
import { memoryStateStore } from '../../../src/modules/checkout/state-store.js';
import {
  exchangeInputSchema,
  returnInputSchema,
  type LineEligibility,
  type ReturnGateway,
} from '../../../src/modules/checkout/return-workflow/contracts.js';
import { financialYear } from '../../../src/modules/checkout/finalizer.js';
import { refundAmount } from '../../../src/modules/checkout/return-workflow/gateway.js';
import { returnRepository } from '../../../src/modules/checkout/return-workflow/repository.js';
import { returnService } from '../../../src/modules/checkout/return-workflow/service.js';
import { exchangeService } from '../../../src/modules/checkout/return-workflow/exchanges.js';
import { returnState } from '../../../src/modules/checkout/return-workflow/state.js';
import { verifiedMysqlFixture } from '../../../tools/operational-reports/verified-mysql-fixture.js';

/**
 * Legacy-table return/exchange workflow (order/views.py:885-1313) on an isolated loopback MySQL.
 * Run with CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1:<port>/pos_rewrite_checkout_test.
 */
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
const signing = {
  hs256: 'returns-fixture-signing-key-'.repeat(3),
  hs512: 'returns-fixture-hs512-key-'.repeat(3),
};
const operator: Principal = {
  id: '44',
  name: 'fixture-operator',
  email: 'operator@example.test',
  role: 4,
  userType: 1,
  storeIds: ['1'],
};
const tables = [
  'stores',
  'users',
  'orders',
  'order_stores',
  'has_products',
  'products',
  'product_store',
  'has_options',
  'attributes',
  'amount_to_be_refunded_log',
  'comments',
  'return_orders',
  'reverse_pickup_reason',
  'hold_stock_store',
  'pos_hold_stock_logs',
  'pos_transaction_logs',
  'pos_exchange_log',
  'order_addons',
  'order_status',
  'store_day_close',
  'extend_applicability_for_return_exchange',
  'store_salesperson',
  'salespersons',
];

describe.skipIf(!template)('returns and exchanges on legacy tables', () => {
  let connection: Connection, db: Databases, config: Config, schema: string;
  let fixture: ReturnType<typeof verifiedMysqlFixture>;
  const calls = {
    inbound: 0,
    refund: 0,
    returnMail: [] as unknown[],
    exchangeMail: [] as unknown[],
    slack: [] as string[],
    jobs: [] as { name: JobName; args: JobArgs }[],
    exchange: [] as Record<string, unknown>[],
  };
  let eligibility = new Map<string, LineEligibility>();
  let inboundResult: 'ok' | 'reject' = 'ok';
  let refundResult: 'ok' | 'already' | 'float-noise' = 'ok';
  let exchangeResult: 'ok' | 'fail' = 'ok';
  const entry = (status: boolean, reason = '', upto: string | null = '2099-01-01') => ({
    status,
    reason,
    upto: status ? upto : upto,
  });
  const gateway: ReturnGateway = {
    configured() {},
    async orderEligibility() {
      return eligibility;
    },
    async eligibility() {
      return { allowed: true, until: null };
    },
    async inbound() {
      calls.inbound++;
      if (inboundResult === 'reject')
        throw Object.assign(new Error('rejected'), { name: 'CheckoutGatewayError' });
    },
    async refund() {
      calls.refund++;
      if (refundResult === 'already') return { kind: 'already-refunded' };
      if (refundResult === 'float-noise') {
        // API-v2 cash branch on an order part-paid with TSS money: an unrounded float.
        const raw = 0.010000000000005116;
        return { kind: 'refunded', returnAmount: refundAmount(raw)!, returnAmountRaw: raw };
      }
      return { kind: 'refunded', returnAmount: '50.25', returnAmountRaw: 50.25 };
    },
    async returnMail(value) {
      calls.returnMail.push(value);
    },
    async exchangeMail(value) {
      calls.exchangeMail.push(value);
    },
    async slack(value) {
      calls.slack.push(value.message);
    },
  };
  const jobs: JobProducer = {
    async enqueue(name, args, options) {
      calls.jobs.push({ name, args });
      return { jobId: randomUUID(), name, queue: options.queue, dueAt: Date.now() };
    },
  };
  const customer = (id: string): CustomerIdentity => ({
    id,
    email: '',
    firstName: '',
    lastName: '',
    telephone: '',
    twoFactor: false,
    exclusive: false,
    active: true,
  });
  let childOrderId = 7000;
  const orders: CheckoutGateway = {
    async api(segment, payload) {
      expect(segment).toBe('pos/exchange');
      calls.exchange.push(payload as Record<string, unknown>);
      if (exchangeResult === 'fail') return { status: 'FAIL', message: 'Fixture stock lock' };
      const body = payload as Record<string, number>;
      const id = ++childOrderId;
      await connection.query(
        'INSERT INTO orders (id,user_id,parent_order_id,payment_status,order_status,tss_money_used,payment_method,updated_at) VALUES (?,?,?,?,?,?,?,NOW())',
        [id, 1001, body.order_id, 1, 1, 0, 3],
      );
      await connection.query(
        'INSERT INTO order_stores (order_id,store_id,counter_id,order_invoice) VALUES (?,?,?,?)',
        [id, body.store_id, body.counter_id, ''],
      );
      await connection.query(
        'INSERT INTO has_products (id,order_id,prod_id,qty,status,return_status) VALUES (?,?,?,?,?,?)',
        [id + 100000, id, body.exchange_prod_id, 1, 'PLACED', 0],
      );
      return { status: 'SUCCESS', new_order_id: id };
    },
    async confirm() {
      return {};
    },
    async exchangeReasons() {
      return [];
    },
  } as unknown as CheckoutGateway;

  beforeAll(async () => {
    const url = new URL(template!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Isolated loopback MySQL required.');
    schema = 'pos_rewrite_returns_' + randomUUID().replaceAll('-', '').slice(0, 12);
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    await connection.query('CREATE DATABASE ' + mysql.escapeId(schema));
    await connection.changeUser({ database: schema });
    fixture = verifiedMysqlFixture(connection);
    await fixture.create(tables);
    url.pathname = '/' + schema;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'returns-fixture-session-secret-'.repeat(2),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      EXCHANGE_ENABLED_STORE_IDS: '1',
    });
    db = createDatabases(config);
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      await connection.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(schema));
      await connection.end();
    }
  });

  let store = memoryStateStore();
  // The operator's legacy check-in store (`check_in_{uid}`) the S35 exchange flag is read from.
  let checkinStoreId: string | null = '1';
  function services() {
    const state = returnState(store);
    const repository = returnRepository(db, config, {
        returnPeriodDays: 30,
        assertCheckIn: async () => {},
        checkedInStore: async () => checkinStoreId,
        state,
      }),
      context = {
        repository,
        customers: {
          async customer(id: string) {
            return customer(id);
          },
          async operatorIdentity(id: string) {
            return id === operator.id ? customer('88') : null;
          },
        },
        gateway,
        signing,
        config,
        jobs,
      };
    return {
      state,
      repository,
      returns: returnService(context),
      exchanges: exchangeService(context, orders),
    };
  }
  async function seedOrder(
    orderId: number,
    options: { oldDelivery?: boolean; productType?: number; storeOrder?: boolean } = {},
  ) {
    await fixture.insert('orders', {
      id: String(orderId),
      user_id: '1001',
      payment_method: 14,
      payment_status: 4,
      order_status: 3,
      tss_money_used: 0,
      first_name: 'Private fixture customer',
    });
    if (options.storeOrder !== false)
      await fixture.insert('order_stores', {
        order_id: String(orderId),
        store_id: '2',
        counter_id: '9',
      });
    await fixture.insert('has_products', {
      id: String(orderId + 100),
      order_id: String(orderId),
      prod_id: '10',
      qty: 1,
      status: 'DELIVERED',
      return_status: 0,
    });
    await connection.query('UPDATE products SET prod_type=? WHERE id=10', [
      options.productType ?? 1,
    ]);
    await fixture.insert('amount_to_be_refunded_log', {
      order_id: String(orderId),
      prod_id: '10',
      has_product_id: String(orderId + 100),
      is_refunded: 0,
      amount_to_be_refunded: 50.25,
      tss_money_used: 5,
      tss_point_used: 3,
      gift_voucher_amount: 2,
    });
    await fixture.insert('comments', {
      order_id: String(orderId),
      status_id: 3,
      created_at: options.oldDelivery ? '2000-01-01 00:00:00' : '2099-01-01 00:00:00',
    });
    eligibility = new Map([
      [
        String(orderId + 100),
        { return: entry(true, '', '2099-01-01'), exchange: entry(true, '', '2099-01-01') },
      ],
    ]);
    return { orderId: String(orderId), lineId: String(orderId + 100) };
  }
  beforeEach(async () => {
    for (const table of tables) await connection.query('DELETE FROM ' + mysql.escapeId(table));
    store = memoryStateStore();
    checkinStoreId = '1';
    Object.assign(calls, {
      inbound: 0,
      refund: 0,
      returnMail: [],
      exchangeMail: [],
      slack: [],
      jobs: [],
      exchange: [],
    });
    inboundResult = 'ok';
    refundResult = 'ok';
    exchangeResult = 'ok';
    for (const [id, name, code] of [
      ['1', 'Counter store', 'FST1'],
      ['2', 'Origin store', 'FST2'],
    ])
      await fixture.insert('stores', {
        id,
        store_name: name,
        location_code: code,
        type: 'STORE',
        is_active: 1,
      });
    await fixture.insert('users', { id: '1001', status: 1, is_block: 0, is_disabled: 0 });
    await fixture.insert('users', {
      id: '88',
      pos_admin_id: operator.id,
      status: 1,
      is_block: 0,
      is_disabled: 0,
    });
    await fixture.insert('reverse_pickup_reason', { id: '1', reason: 'Size issue', type: 1 });
    await fixture.insert('order_status', { id: '3', order_status: 'DELIVERED' });
    await fixture.insert('attributes', { id: '1', attr: 'Size' });
    for (const [id, parent, size, stock] of [
      ['10', '5', 'M', 0],
      ['11', '5', 'L', 4],
    ] as const) {
      await fixture.insert('products', { id, parent_prod_id: parent, prod_type: 1, is_del: 0 });
      await fixture.insert('product_store', {
        product_id: id,
        store_id: '1',
        stock,
        is_avail: 1,
        is_del: 0,
      });
      await fixture.insert('has_options', { prod_id: id, attr_id: '1', attr_val: size });
    }
    await fixture.insert('salespersons', { id: '7', is_active: 1 });
    await fixture.insert('store_salesperson', { store_id: '1', salesperson_id: '7', is_active: 1 });
  });
  const returnInput = (extra: Record<string, unknown> = {}) =>
    returnInputSchema.parse({
      operationId: randomUUID(),
      counterId: '3',
      reasonId: '1',
      qualityConfirmed: true,
      tagConfirmed: false,
      saleable: false,
      ...extra,
    });
  async function rows(sql: string, values: unknown[] = []) {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  }

  it('executes one cross-store wallet return with a credit note, hold stock, audit and mail', async () => {
    const { returns, state } = services(),
      line = await seedOrder(9001),
      input = returnInput();
    const result = await returns.start(operator, '1', line.orderId, line.lineId, input);
    expect(result).toMatchObject({ phase: 'completed', returnAmount: '50.25' });
    expect(result.creditNote).toMatch(/^FST1\d{4}CN00001$/);
    expect(await rows('SELECT status,return_status,return_mode FROM has_products')).toEqual([
      { status: 'PRODUCT_RETURNED', return_status: 33, return_mode: 3 },
    ]);
    expect(await rows('SELECT order_status,payment_status FROM orders')).toEqual([
      { order_status: 6, payment_status: 5 },
    ]);
    expect(
      await rows('SELECT store_id,stock_before,stock_after,comment FROM pos_hold_stock_logs'),
    ).toEqual([
      {
        store_id: '1',
        stock_before: '0',
        stock_after: '1',
        comment: 'Hold Stock inventory added from admin panel on order return, [Order ID:9001]',
      },
    ]);
    expect(await rows('SELECT pay_dict,comment FROM pos_transaction_logs')).toEqual([
      {
        pay_dict:
          "{'tss point refunded': 3.0, 'tss money refunded': 5.0, 'gift voucher amount refunded': 2.0, 'pay amt refunded into tss money': 50.25, 'total amount refunded': 53.25}",
        comment: 'Product ID : 10, 1 Quantity Return to Counter store',
      },
    ]);
    expect(
      (await rows('SELECT comment,notify FROM comments ORDER BY id')).map((row) => row.comment),
    ).toContain('Store return initiated by POS dashbaord');
    expect(calls.returnMail).toEqual([
      { orderId: '9001', productId: '10', storeId: '1', lineId: '9101' },
    ]);
    // Replay of the same request returns the stored operation without another effect.
    expect(await returns.start(operator, '1', line.orderId, line.lineId, input)).toMatchObject({
      id: input.operationId,
      phase: 'completed',
    });
    expect([calls.inbound, calls.refund, calls.returnMail.length]).toEqual([1, 1, 1]);
    expect(await state.readOperation(input.operationId)).toMatchObject({ phase: 'completed' });
    await expect(
      returns.start(operator, '1', line.orderId, line.lineId, {
        ...input,
        comment: 'changed',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('re-pushes the order to Vinculum after a warehouse rejection and writes nothing native', async () => {
    const { returns } = services(),
      line = await seedOrder(9002);
    inboundResult = 'reject';
    await expect(
      returns.start(operator, '1', line.orderId, line.lineId, returnInput()),
    ).rejects.toMatchObject({
      status: 502,
      message: 'Order is under process, Please try again in 5 minutes.',
    });
    expect(calls.jobs).toEqual([
      { name: 'core.tasks.push_vinc_order_for_all', args: { order_id: 9002 } },
    ]);
    expect(await rows('SELECT id FROM return_orders')).toEqual([]);
    inboundResult = 'ok';
    expect(
      (await returns.start(operator, '1', line.orderId, line.lineId, returnInput())).phase,
    ).toBe('completed');
  });

  it('stops after the native return when the refund service answers Already refunded', async () => {
    const { returns } = services(),
      line = await seedOrder(9003);
    refundResult = 'already';
    await expect(
      returns.start(operator, '1', line.orderId, line.lineId, returnInput()),
    ).rejects.toMatchObject({ status: 409, message: 'Already refunded' });
    expect(await rows('SELECT credit_note_no FROM return_orders')).toHaveLength(1);
    expect(await rows('SELECT id FROM pos_hold_stock_logs')).toEqual([]);
    expect(await rows('SELECT id FROM pos_transaction_logs')).toEqual([]);
    expect(calls.returnMail).toEqual([]);
  });

  it('completes the return when API-v2 refunds an unrounded float amount', async () => {
    const { returns } = services(),
      line = await seedOrder(9004);
    refundResult = 'float-noise';
    const result = await returns.start(operator, '1', line.orderId, line.lineId, returnInput());
    expect(result).toMatchObject({ phase: 'completed', returnAmount: '0.01' });
    expect(await rows('SELECT id FROM pos_hold_stock_logs')).toHaveLength(1);
    const logs = await rows('SELECT pay_dict FROM pos_transaction_logs');
    expect(logs).toHaveLength(1);
    expect(String(logs[0]!.pay_dict)).toContain('0.010000000000005116');
    expect(calls.returnMail).toHaveLength(1);
  });

  it('applies the return window, and accepts force return only where show.html offers it', async () => {
    const { returns } = services(),
      line = await seedOrder(9004, { oldDelivery: true });
    await expect(
      returns.start(operator, '1', line.orderId, line.lineId, returnInput()),
    ).rejects.toMatchObject({ status: 409, message: 'This order is not applicable for return' });
    // The eligibility service gave neither status nor reason: the force-return button.
    eligibility = new Map([
      [line.lineId, { return: entry(false, '', null), exchange: entry(false, '', null) }],
    ]);
    expect(
      (
        await returns.start(
          operator,
          '1',
          line.orderId,
          line.lineId,
          returnInput({ clickType: 'extreme' }),
        )
      ).phase,
    ).toBe('completed');
  });

  it('refuses force return when the service gave a reason', async () => {
    const { returns } = services(),
      line = await seedOrder(9005, { oldDelivery: true });
    eligibility = new Map([
      [line.lineId, { return: entry(false, 'Return window closed', null), exchange: entry(false) }],
    ]);
    await expect(
      returns.start(
        operator,
        '1',
        line.orderId,
        line.lineId,
        returnInput({ clickType: 'extreme' }),
      ),
    ).rejects.toMatchObject({ code: 'RETURN_NOT_ELIGIBLE' });
    expect(calls.inbound).toBe(0);
  });

  it('S35: refuses force return for a current type-8 product, an undelivered line or an online order', async () => {
    const { returns, state } = services();
    const none = (lineId: string) =>
      new Map([[lineId, { return: entry(false, '', null), exchange: entry(false, '', null) }]]);
    const refused = {
      status: 409,
      code: 'RETURN_NOT_APPLICABLE',
      message: 'Not applicable for return',
    };
    const typeEight = await seedOrder(9020, { oldDelivery: true, productType: 8 });
    eligibility = none(typeEight.lineId);
    const input = returnInput({ clickType: 'extreme' });
    await expect(
      returns.start(operator, '1', typeEight.orderId, typeEight.lineId, input),
    ).rejects.toMatchObject(refused);
    expect(await state.readOperation(input.operationId)).toBeNull();
    const placed = await seedOrder(9021, { oldDelivery: true });
    await connection.query("UPDATE has_products SET status='PLACED' WHERE id=?", [placed.lineId]);
    eligibility = none(placed.lineId);
    await expect(
      returns.start(
        operator,
        '1',
        placed.orderId,
        placed.lineId,
        returnInput({ clickType: 'extreme' }),
      ),
    ).rejects.toMatchObject(refused);
    const online = await seedOrder(9022, { oldDelivery: true, storeOrder: false });
    eligibility = none(online.lineId);
    await expect(
      returns.start(
        operator,
        '1',
        online.orderId,
        online.lineId,
        returnInput({ clickType: 'extreme' }),
      ),
    ).rejects.toMatchObject(refused);
    expect([calls.inbound, calls.refund]).toEqual([0, 0]);
    expect(await rows('SELECT id FROM return_orders')).toEqual([]);
  });

  it('S35: refuses a new exchange and a retry when the check-in store has exchanges disabled', async () => {
    const { returns, exchanges } = services(),
      line = await seedOrder(9023);
    checkinStoreId = '2';
    const view = await returns.eligibility(
      operator,
      '1',
      line.orderId,
      line.lineId,
      { counterId: '3' },
      'exchange',
    );
    expect(view).toMatchObject({ exchangeFeatureEnabled: false, cell: { branch: 'merged' } });
    expect(view.facts.checkinStoreId).toBe('2');
    const disabled = {
      status: 403,
      code: 'EXCHANGE_NOT_ENABLED',
      message: 'Not applicable for exchange',
    };
    await expect(
      exchanges.start(operator, '1', line.orderId, line.lineId, exchangeInput()),
    ).rejects.toMatchObject(disabled);
    expect(await rows('SELECT id FROM pos_exchange_log')).toEqual([]);
    expect(calls.inbound).toBe(0);
    // A failed replacement offers its retry button only while exchanges are enabled.
    checkinStoreId = '1';
    exchangeResult = 'fail';
    const input = exchangeInput();
    await expect(
      exchanges.start(operator, '1', line.orderId, line.lineId, input),
    ).rejects.toMatchObject({ code: 'EXCHANGE_REPLACEMENT_FAILED' });
    exchangeResult = 'ok';
    checkinStoreId = null;
    await expect(exchanges.retry(operator, '1', input.operationId, '7')).rejects.toMatchObject(
      disabled,
    );
    expect(await rows('SELECT status,retry_count FROM pos_exchange_log')).toEqual([
      { status: 'FAILED_NEEDS_MANUAL_FIX', retry_count: 0 },
    ]);
    expect(calls.exchange).toHaveLength(1);
  });

  it('S35: refuses a type-8 exchange where the templates show Not Applicable For Exchange', async () => {
    const { exchanges } = services();
    const notApplicable = {
      status: 409,
      code: 'EXCHANGE_NOT_APPLICABLE',
      message: 'Not Applicable For Exchange',
    };
    // show.html: a type-8 line renders no return or exchange button at all.
    const store = await seedOrder(9024, { productType: 8 });
    await expect(
      exchanges.start(operator, '1', store.orderId, store.lineId, exchangeInput()),
    ).rejects.toMatchObject(notApplicable);
    expect(await rows('SELECT id FROM pos_exchange_log')).toEqual([]);
    // Online cells: type 8 wins over an eligible exchange outside the merged cell.
    const online = await seedOrder(9025, { productType: 8, storeOrder: false });
    eligibility = new Map([
      [
        online.lineId,
        { return: entry(true, '', '2099-01-01'), exchange: entry(true, '', '2099-02-01') },
      ],
    ]);
    await expect(
      exchanges.start(operator, '1', online.orderId, online.lineId, exchangeInput()),
    ).rejects.toMatchObject(notApplicable);
    expect(calls.inbound).toBe(0);
    // S35 refusals happen before any write: no PENDING (or failed) exchange-log row, no line change.
    expect(await rows('SELECT id FROM pos_exchange_log')).toEqual([]);
    expect(
      await rows('SELECT status FROM has_products WHERE id = ?', [Number(online.lineId)]),
    ).toEqual([{ status: 'DELIVERED' }]);
    // ...but the merged cell still offers the exchange (legacy online template).
    const merged = await seedOrder(9026, { productType: 8, storeOrder: false });
    expect(
      (await exchanges.start(operator, '1', merged.orderId, merged.lineId, exchangeInput())).phase,
    ).toBe('completed');
  });

  it('reports the cell facts: current product type, check-in exchange flag and failed retry', async () => {
    const { returns } = services(),
      line = await seedOrder(9006, { productType: 8, storeOrder: false });
    const view = await returns.eligibility(
      operator,
      '1',
      line.orderId,
      line.lineId,
      { counterId: '3' },
      'exchange',
    );
    expect(view.exchangeFeatureEnabled).toBe(true);
    expect(view.facts).toMatchObject({ variant: 'online', productType: 8, merged: true });
    // Merged return/exchange stays available for product type 8 in the online template.
    expect(view.cell.branch).toBe('merged');
    eligibility = new Map([
      [
        line.lineId,
        { return: entry(true, '', '2099-01-01'), exchange: entry(true, '', '2099-02-01') },
      ],
    ]);
    const split = await returns.eligibility(
      operator,
      '1',
      line.orderId,
      line.lineId,
      { counterId: '3' },
      'exchange',
    );
    expect(split.cell.parts[1]?.texts).toEqual([
      { text: 'Not Applicable For Exchange', style: 'plain' },
    ]);
  });

  function exchangeInput() {
    return exchangeInputSchema.parse({
      operationId: randomUUID(),
      counterId: '3',
      reasonId: '4',
      qualityConfirmed: true,
      tagConfirmed: true,
      saleable: false,
      replacementProductId: '11',
      salespersonId: '7',
    });
  }

  it('completes one exchange with the delivered child order, invoice, logs and mail', async () => {
    const { exchanges } = services(),
      line = await seedOrder(9010),
      input = exchangeInput();
    const result = await exchanges.start(operator, '1', line.orderId, line.lineId, input);
    expect(result).toMatchObject({ phase: 'completed', newOrderId: String(childOrderId) });
    expect(calls.exchange[0]).toMatchObject({
      order_id: 9010,
      has_prod_id: 9110,
      prod_id: 10,
      exchange_prod_id: 11,
      exchange_parent_prod_id: 5,
      size: 'L',
      store_id: 1,
      counter_id: 3,
      admin_user_id: 88,
      salesperson_id: 7,
    });
    expect(
      await rows(
        'SELECT status,retry_count,new_order_id,old_size,new_size,staff_user_id FROM pos_exchange_log',
      ),
    ).toEqual([
      {
        status: 'SUCCESS',
        retry_count: 0,
        new_order_id: childOrderId,
        old_size: 'M',
        new_size: 'L',
        staff_user_id: 44,
      },
    ]);
    expect(
      await rows('SELECT order_status,payment_status FROM orders WHERE id=?', [childOrderId]),
    ).toEqual([{ order_status: 3, payment_status: 4 }]);
    expect(
      (await rows('SELECT order_invoice FROM order_stores WHERE order_id=?', [childOrderId]))[0]
        ?.order_invoice,
    ).toMatch(/^FST1\d{4}INV00001$/);
    expect(await rows('SELECT status FROM has_products ORDER BY id')).toEqual([
      { status: 'EXCHANGE_COMPLETED' },
      { status: 'DELIVERED' },
    ]);
    expect(
      (await rows('SELECT comment FROM pos_transaction_logs ORDER BY id')).map(
        (row) => row.comment,
      ),
    ).toEqual([
      `Exchanged : TSS Money Used 0.0 (New order ${childOrderId} created)`,
      `Order Delivered : TSS Money Used 0.0 (Exchange from order 9010)`,
    ]);
    expect(await rows('SELECT shipped_location FROM order_addons')).toEqual([
      { shipped_location: 'MW1' },
    ]);
    expect(calls.exchangeMail).toEqual([
      { orderId: String(childOrderId), productId: '11', lineId: String(childOrderId + 100000) },
    ]);
    expect(calls.refund).toBe(0);
  });

  it("matches a store code with '_' or '%' literally in credit note and invoice sequences", async () => {
    // helpers.py:2230-2231, 2284-2285: Django `startswith` escapes `\ % _`.
    const { exchanges } = services(),
      fy = financialYear(new Date().toISOString().slice(0, 10)),
      line = await seedOrder(9013);
    await connection.query("UPDATE stores SET location_code='F_1' WHERE id=1");
    // Unescaped, 'F_1…' would match these other codes and continue their sequences.
    await fixture.insert('return_orders', {
      order_id: '1',
      prod_id: '10',
      has_product_id: '1',
      store_id: 1,
      qty: 1,
      credit_note_no: `FX1${fy}CN00009`,
      created_at: '2026-01-01 10:00:01',
    });
    await connection.query(
      'INSERT INTO order_stores (order_id,store_id,counter_id,order_invoice) VALUES (1,1,3,?),(2,1,3,?)',
      [`FX1${fy}INV00009`, `F%1/${fy}/INV/00004`],
    );
    const result = await exchanges.start(operator, '1', line.orderId, line.lineId, exchangeInput());
    expect(result.phase).toBe('completed');
    expect(
      (await rows('SELECT credit_note_no FROM return_orders WHERE order_id=9013'))[0]
        ?.credit_note_no,
    ).toBe(`F_1${fy}CN00001`);
    expect(
      (await rows('SELECT order_invoice FROM order_stores WHERE order_id=?', [childOrderId]))[0]
        ?.order_invoice,
    ).toBe(`F_1${fy}INV00001`);
  });

  it('marks a failed replacement for manual fix, alerts Slack and retries with stored picks', async () => {
    const { exchanges } = services(),
      line = await seedOrder(9011),
      input = exchangeInput();
    exchangeResult = 'fail';
    await expect(
      exchanges.start(operator, '1', line.orderId, line.lineId, input),
    ).rejects.toMatchObject({
      status: 502,
      message: 'Item returned, but the replacement order could not be created: Fixture stock lock',
    });
    expect(await rows('SELECT status,last_error FROM pos_exchange_log')).toEqual([
      { status: 'FAILED_NEEDS_MANUAL_FIX', last_error: 'Fixture stock lock' },
    ]);
    expect(calls.slack[0]).toContain('POS Exchange FAILED (needs manual fix) | order_id=9011');
    exchangeResult = 'ok';
    const retried = await exchanges.retry(operator, '1', input.operationId, '7');
    expect(retried.phase).toBe('completed');
    expect(await rows('SELECT status,retry_count FROM pos_exchange_log')).toEqual([
      { status: 'SUCCESS', retry_count: 1 },
    ]);
    expect([calls.inbound, calls.exchange.length]).toEqual([1, 2]);
  });

  it('claims a legacy failed exchange once and answers its lost-claim outcome per actor', async () => {
    const { repository, exchanges } = services(),
      line = await seedOrder(9012);
    await connection.query("UPDATE has_products SET status='EXCHANGE_INITIATED',return_status=1");
    await fixture.insert('pos_exchange_log', {
      order_id: 9012,
      has_prod_id: 9112,
      old_prod_id: 10,
      old_size: 'M',
      new_prod_id: 11,
      new_size: 'L',
      exchange_parent_prod_id: 5,
      store_id: 1,
      counter_id: 0,
      staff_user_id: 3,
      reason_id: 4,
      sub_reason_id: 0,
      comment: '',
      saleable: 0,
      new_order_id: 0,
      status: 'FAILED_NEEDS_MANUAL_FIX',
      retry_count: 0,
      created_at: '2026-01-01 10:00:00',
      updated_at: '2026-01-01 10:00:00',
    });
    await fixture.insert('return_orders', {
      order_id: '9012',
      prod_id: '10',
      has_product_id: '9112',
      store_id: 1,
      qty: 1,
      credit_note_no: 'FST12526CN00009',
      created_at: '2026-01-01 10:00:01',
    });
    const scope = { counterId: '3' };
    const read = await repository.exchangeRecovery(operator, '1', line.orderId, line.lineId, scope);
    expect(read).toMatchObject({ state: 'legacy', newSize: 'L' });
    const claim = {
      ...scope,
      operationId: randomUUID(),
      expectedRevision: read.revision,
      salespersonId: '7',
    };
    const claimed = await repository.claimExchangeRecovery(
      operator,
      '1',
      line.orderId,
      line.lineId,
      claim,
    );
    expect(claimed).toMatchObject({ phase: 'replacement-rejected', creditNote: 'FST12526CN00009' });
    expect(
      await repository.claimExchangeRecovery(operator, '1', line.orderId, line.lineId, claim),
    ).toMatchObject({ id: claimed.id });
    await expect(
      repository.claimExchangeRecovery(operator, '1', line.orderId, line.lineId, {
        ...claim,
        salespersonId: '8',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(
      await repository.exchangeRecoveryClaimStatus(
        operator,
        '1',
        line.orderId,
        line.lineId,
        claim.operationId,
        scope,
      ),
    ).toEqual({ status: 'recorded', operationId: claimed.id });
    // The retry keeps the stored financial counter (0) and never repeats the return leg.
    const done = await exchanges.retry(operator, '1', claimed.id, '7');
    expect(done.phase).toBe('completed');
    expect(calls.exchange[0]).toMatchObject({ counter_id: 0, size: 'L' });
    expect(calls.inbound).toBe(0);
    expect(await rows('SELECT status,retry_count,staff_user_id FROM pos_exchange_log')).toEqual([
      { status: 'SUCCESS', retry_count: 1, staff_user_id: 44 },
    ]);
  });
});
