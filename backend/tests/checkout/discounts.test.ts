import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig, type Config } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import {
  discountApprovals,
  discountKeys,
} from '../../src/modules/checkout/discounts/repository.js';
import type { DiscountMail } from '../../src/modules/checkout/discounts/delivery.js';
import { checkoutSessionStore } from '../../src/modules/checkout/session-store.js';
import { memoryStateStore } from '../../src/modules/checkout/state-store.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  approverSelection,
  assertDiscountApplyPermission,
  discountMetadataSchema,
  discountPolicy,
  discountTerms,
} from '../../src/modules/checkout/discounts/policy.js';
import {
  approvalCode,
  codeDigest,
  matchesCode,
} from '../../src/modules/checkout/discounts/crypto.js';
import { assertDiscountDeliveryReady } from '../../src/modules/checkout/discounts/delivery.js';
import { checkoutStateSchema } from '../../src/modules/checkout/contracts.js';
import { goldenStdout } from '../golden/load.js';

const secret = 'isolated-discount-approval-secret-'.repeat(3);
const state = () =>
  checkoutStateSchema.parse({
    id: crypto.randomUUID(),
    operatorId: '44',
    operatorCustomerId: '777',
    storeId: '1',
    counterId: '3',
    tabId: 1,
    customerId: null,
    verifiedCustomerUntil: null,
    version: 1,
    phase: 'quoted',
    cart: null,
    quote: {
      products: { items: [{ prod_id: 10, quantity: 1, amount: 80 }] },
      meta: {
        items: [
          {
            name: 'calculations',
            products_total: 80,
            total: 80,
            used_pg_discount: 0,
            used_store_discount_pg: 20,
          },
        ],
      },
    },
    orderId: null,
    paymentConfirmation: null,
    salespersonId: null,
    lineSalespersons: {},
    giftCards: {},
    discountMetadata: {
      pg: null,
      store: { remark: 'Price issue', reason: 'Price mismatch (Online v/s POS)' },
    },
    busyOperationId: null,
    createdAt: 0,
    updatedAt: 0,
  });
describe('manager discount approval source contract and security bindings', () => {
  it('matches original Python threshold selection including fallback, exemption and exact boundaries', () => {
    const thresholds = {
      '1': {
        '0': ['base@example.test'],
        '10': ['ten@example.test'],
        '20': ['twenty@example.test'],
        '50': [],
      },
    };
    const cases = [
      ...['0', '1', '9.99', '10', '19.99', '20', '49.99', '50', '80', '100'].flatMap((value) =>
        [true, false].map((sendAll) => ({
          storeId: '1',
          amount: value,
          productsTotal: String(100 - Number(value)),
          thresholds,
          sendAll,
        })),
      ),
      { storeId: '2', amount: '10', productsTotal: '90', thresholds, sendAll: true },
      { storeId: '2', amount: '10', productsTotal: '90', thresholds, sendAll: false },
    ];
    const expected: unknown = JSON.parse(
      goldenStdout(
        'checkout',
        'discounts',
        JSON.stringify({ operation: 'discount_policy', cases }),
      ),
    );
    expect(
      cases.map((item) =>
        approverSelection(
          {
            ...discountPolicy({}),
            storeThresholds: item.thresholds,
            sendToAllManagers: item.sendAll,
          },
          item.storeId,
          item,
        ),
      ),
    ).toEqual(expected);
    expect(discountPolicy({})).toMatchObject({
      permittedRoles: [1, 2, 3, 4],
      exemptRoles: [1, 2, 3],
      expirySeconds: 600,
    });
  });
  it('binds the exact server financial terms, customer, quantities, metadata and checkout identity', () => {
    const original = state(),
      terms = discountTerms(original, secret);
    expect(terms).toMatchObject({
      amount: '20.00',
      pgAmount: '0.00',
      storeAmount: '20.00',
      productsTotal: '80.00',
      comment: '|Price issue',
    });
    for (const change of [
      { customerId: '1001' },
      { id: crypto.randomUUID() },
      { counterId: '4' },
      {
        discountMetadata: {
          pg: null,
          store: { remark: 'Different issue', reason: 'Price mismatch (Online v/s POS)' as const },
        },
      },
      {
        quote: {
          ...original.quote,
          products: { items: [{ prod_id: 10, quantity: 2, amount: 80 }] },
        },
      },
      {
        quote: {
          ...original.quote,
          meta: {
            items: [
              { name: 'calculations', products_total: 80, total: 79, used_store_discount_pg: 20 },
            ],
          },
        },
      },
    ])
      expect(discountTerms({ ...original, ...change }, secret).binding).not.toBe(terms.binding);
    expect(() =>
      discountTerms({ ...original, discountMetadata: { pg: null, store: null } }, secret),
    ).toThrow('Save a remark');
    expect(() =>
      discountTerms(
        {
          ...original,
          quote: {
            products: { items: [] },
            meta: { items: [{ name: 'calculations', used_store_discount_pg: 20 }] },
          },
        },
        secret,
      ),
    ).toThrow('missing its products total');
    expect(discountMetadataSchema.safeParse({ pg: { remark: '...' }, store: null }).success).toBe(
      false,
    );
  });
  it('stores manager codes only as hashes bound to the challenge and manager', () => {
    const id = crypto.randomUUID(),
      manager = '45',
      code = approvalCode(),
      digest = codeDigest(secret, id, manager, code);
    expect(code).toMatch(/^[1-9]{6}$/);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(code);
    expect(matchesCode(secret, id, manager, code, digest)).toBe(true);
    expect(matchesCode(secret, crypto.randomUUID(), manager, code, digest)).toBe(false);
    expect(matchesCode(secret, id, '46', code, digest)).toBe(false);
    expect(() => codeDigest('short', id, manager, code)).toThrow('not configured');
  });
  it('gates only old-PG apply by PG_DISC_ROLE_PERM, as the legacy markup does', () => {
    const policy = discountPolicy({}),
      user = (role: 1 | 2 | 3 | 4 | 5) => ({
        id: '9',
        name: 'Operator',
        email: 'operator@example.test',
        role,
        userType: 1 as const,
        storeIds: ['1'],
      });
    expect(() => assertDiscountApplyPermission(policy, user(5), 'pg', true)).toThrow(
      'You do not have permission.',
    );
    expect(() => assertDiscountApplyPermission(policy, user(4), 'pg', true)).not.toThrow();
    // AjaxStoreDiscountPGView (order/views.py:2237) and every removal have no role gate.
    expect(() => assertDiscountApplyPermission(policy, user(5), 'store', true)).not.toThrow();
    expect(() => assertDiscountApplyPermission(policy, user(5), 'pg', false)).not.toThrow();
    expect(() => assertDiscountApplyPermission(policy, user(5), 'store', false)).not.toThrow();
  });
  it('fails closed for missing or insecure approval delivery configuration', () => {
    for (const environment of [
      {},
      { url: 'http://mail.example.test', apiKey: 'fixture', approvalSecret: secret },
      { url: 'https://user:pass@mail.example.test', apiKey: 'fixture', approvalSecret: secret },
      {
        url: 'https://mail.example.test/?api_key=secret',
        apiKey: 'fixture',
        approvalSecret: secret,
      },
    ])
      expect(() => assertDiscountDeliveryReady(environment)).toThrow();
    expect(() =>
      assertDiscountDeliveryReady({
        url: 'https://mail.example.test/send',
        apiKey: 'fixture',
        approvalSecret: secret,
      }),
    ).not.toThrow();
  });
});

const integration = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!integration)('PG discount manager OTP on the legacy Redis key', () => {
  let connection: mysql.Connection,
    config: Config,
    db: Databases,
    schema = '';
  const now = Date.parse('2026-11-16T04:30:00Z'),
    mails: DiscountMail[] = [],
    staff: Principal = {
      id: '44',
      name: 'Fixture staff',
      email: 'staff@example.test',
      role: 5,
      userType: 1,
      storeIds: ['1'],
    };
  beforeAll(async () => {
    const url = new URL(integration!);
    if (
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_checkout_test'
    )
      throw new Error('Discount checks refuse nonisolated database URLs.');
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    schema = `pos_rewrite_checkout_test_discount_${process.pid}_${randomUUID().slice(0, 8)}`;
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(connection);
    await fixture.create(['pos_user', 'stores', 'orders', 'order_stores', 'store_pg_disc_addons']);
    await fixture.insert('pos_user', {
      id: 44,
      role: 5,
      user_type: 1,
      is_active: 1,
      first_name: 'Staff',
      contact_email: 'staff@example.test',
    });
    await fixture.insert('pos_user', {
      id: 45,
      role: 3,
      user_type: 1,
      is_active: 1,
      first_name: 'Manager',
      contact_email: 'manager@example.test',
    });
    await fixture.insert('stores', { id: 1, store_name: 'Fixture <store>' });
    await fixture.insert('orders', { id: 900, user_id: 777 });
    await fixture.insert('order_stores', { id: 1, order_id: 900, store_id: 1, counter_id: 3 });
    await fixture.insert('orders', { id: 901, user_id: 777 });
    await fixture.insert('order_stores', { id: 2, order_id: 901, store_id: 1, counter_id: 3 });
    url.pathname = '/' + schema;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'discount-fixture-secret-'.repeat(3),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
    });
    db = createDatabases(config);
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      if (/^pos_rewrite_checkout_test_discount_\d+_[a-f0-9-]{8}$/.test(schema))
        await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });
  it('sends per-manager codes once, verifies the code and value, records the addon and mails inline', async () => {
    const store = memoryStateStore(() => now),
      sessions = checkoutSessionStore(store, () => now),
      current = state();
    await sessions.write(current);
    const approvals = discountApprovals(db, config, {
      signingSecret: secret,
      approvalSecret: secret,
      policy: discountPolicy({}),
      mailer: { send: async (mail) => (mails.push(mail), true) },
      stateStore: store,
      sessions,
      now: () => now,
    });
    // Store discount (PG) has no role gate (AjaxStoreDiscountPGView); role 5 is not OTP-exempt.
    expect((await approvals.describe(staff, current)).status).toBe('required');
    expect(await approvals.request(staff, current)).toMatchObject({
      status: 'pending',
      delivered: 1,
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'manager@example.test', subject: 'PG Discount OTP Mail' });
    expect(mails[0]!.html).toContain('Store - Fixture &lt;store&gt;');
    expect(mails[0]!.html).toContain(
      'PG Discount Value - 20 <br>Total Bill Amount Without GST - 80',
    );
    const code = /<b>([1-9]{6})<\/b>/.exec(mails[0]!.html)![1]!;
    const otpMap = JSON.parse((await store.get(discountKeys.otp(current)))!) as Record<
      string,
      unknown
    >;
    expect(discountKeys.otp(current)).toBe('44_1_3_1');
    expect(Object.values(otpMap)).toEqual([[45, '20.00']]);
    expect(Object.keys(otpMap)[0]).not.toContain(code);
    // "otp already sent": no second mail while the key exists.
    await approvals.request(staff, current);
    expect(mails).toHaveLength(1);
    await expect(approvals.authorize(staff, current)).rejects.toMatchObject({
      code: 'DISCOUNT_APPROVAL_REQUIRED',
    });
    await expect(
      approvals.confirm(staff, current, code === '111111' ? '222222' : '111111'),
    ).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_CODE_INVALID' });
    expect(await approvals.confirm(staff, current, code)).toMatchObject({ status: 'approved' });
    const evidence = await approvals.authorize(staff, current);
    expect(evidence).toMatchObject({ approvedBy: '45' });
    await approvals.record({ ...current, customerId: '777' }, '900', evidence);
    await approvals.record({ ...current, customerId: '777' }, '900', evidence);
    const [addons] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT order_id,pg_disc_desc,pg_disc_amount_in_rs,pg_disc_otp,otp_provided_by,otp_provided_by_name,otp_applied_by,otp_applied_by_name,store_id,counter_id FROM store_pg_disc_addons',
    );
    expect(addons).toEqual([
      {
        order_id: '900',
        pg_disc_desc: '|Price issue',
        pg_disc_amount_in_rs: 20,
        pg_disc_otp: null,
        otp_provided_by: 45,
        otp_provided_by_name: 'Manager',
        otp_applied_by: 44,
        otp_applied_by_name: 'Staff',
        store_id: 1,
        counter_id: 3,
      },
    ]);
    const [[order]] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT store_disc_pg_comment,store_disc_pg_reason FROM orders WHERE id=900',
    );
    expect(order).toEqual({
      store_disc_pg_comment: 'Price issue',
      store_disc_pg_reason: 'Price mismatch (Online v/s POS)',
    });
    expect(mails[1]).toMatchObject({
      to: 'manager@example.test',
      subject: 'PG Discount Used For Order - 900',
    });
    expect(mails[1]!.html).toContain('Your PG Discount OTP has been applied');
    expect(await store.get(discountKeys.otp(current))).toBeNull();
    // Every order gets the legacy comment/reason update, even without a discount.
    const plain = {
      ...current,
      customerId: '777',
      discountMetadata: { pg: null, store: null },
      quote: {
        ...current.quote!,
        meta: { items: [{ name: 'calculations', products_total: 80, total: 80 }] },
      },
    };
    await approvals.record(plain, '901', await approvals.authorize(staff, plain));
    const [[second]] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT store_disc_pg_comment,store_disc_pg_reason FROM orders WHERE id=901',
    );
    expect(second).toEqual({ store_disc_pg_comment: '', store_disc_pg_reason: '' });
    expect(mails).toHaveLength(2);
  });
});
