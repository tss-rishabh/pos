import { createHash, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig, type Config } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { walletAdjustmentRepository } from '../../src/modules/checkout/benefit-adjustments/repository.js';
import {
  walletAdjustmentSchema,
  type WalletAdjustmentInput,
} from '../../src/modules/checkout/benefit-adjustments/contracts.js';
import { memoryStateStore, type PosStateStore } from '../../src/modules/checkout/state-store.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

const integration = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!integration)('approved atomic global wallet writer in isolated MySQL', () => {
  let connection: mysql.Connection,
    db: Databases,
    schema = '',
    config: Config,
    store: PosStateStore,
    repository: ReturnType<typeof walletAdjustmentRepository>;
  const customerId = '9007199254740993',
    operator: Principal = {
      id: '44',
      name: 'Fixture administrator',
      email: 'operator@example.test',
      role: 2,
      userType: 1,
      storeIds: [],
    },
    clock = () => Date.parse('2026-11-16T04:30:00Z'),
    tables = [
      'users',
      'pos_user',
      'pos_special_permission_activity_log',
      'tss_money_history',
      'tss_point_history',
      'orders',
      'products',
    ];
  const input = (
    overrides: Partial<WalletAdjustmentInput['adjustment']> = {},
  ): WalletAdjustmentInput =>
    walletAdjustmentSchema.parse({
      operationId: randomUUID(),
      customerId,
      adjustment: {
        asset: 'money',
        direction: 'add',
        amount: '10.00',
        platform: 'ORDER_REFUND',
        reason: 'Other',
        orderId: '0',
        productId: '0',
        expiry: '2026-12-31',
        ...overrides,
      },
    });
  async function rows(query: string, values: (string | number)[] = []) {
    const result = (await connection.execute<mysql.RowDataPacket[]>(query, values))[0];
    for (const row of result) if (typeof row.count === 'string') row.count = Number(row.count);
    return result;
  }
  const balances = async () =>
    (
      await rows(
        'SELECT CAST(tss_money AS CHAR) money,CAST(tss_points AS CHAR) points,CAST(cashback AS CHAR) cashback FROM users WHERE id=?',
        [customerId],
      )
    )[0]!;
  async function seedEarning(
    asset: 'money' | 'points',
    amount = 100,
    id = '9007199254740996',
    used = 0,
  ) {
    await connection.execute(
      `INSERT INTO ${asset === 'money' ? 'tss_money_history' : 'tss_point_history'}(id,user_id,added_amt,used_amt,is_expired,created_at) VALUES(?,?,?,?,0,'2026-01-01 00:00:00')`,
      [id, customerId, amount, used],
    );
  }
  beforeAll(async () => {
    const url = new URL(integration!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_checkout_test' ||
      url.search ||
      url.hash
    )
      throw new Error('Wallet checks refuse nonisolated database URLs.');
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    schema = `pos_rewrite_checkout_test_wallet_${process.pid}_${randomUUID().slice(0, 8)}`;
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    await verifiedMysqlFixture(connection).create(tables);
    url.pathname = '/' + schema;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'wallet-fixture-secret-'.repeat(3),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
    });
    db = createDatabases(config);
  });
  beforeEach(async () => {
    store = memoryStateStore();
    repository = walletAdjustmentRepository(db, config, { stateStore: store, clock });
    for (const table of tables) await connection.query(`TRUNCATE TABLE ${mysql.escapeId(table)}`);
    const fixture = verifiedMysqlFixture(connection);
    await fixture.insert('pos_user', { id: 44, role: 2, user_type: 1, is_active: 1 });
    await fixture.insert('users', {
      id: customerId,
      firstname: 'Fixture',
      lastname: 'Customer',
      email: 'fixture@example.test',
      status: 1,
      tss_money: 100,
      tss_points: 100,
      cashback: 7,
      is_block: 0,
    });
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      if (/^pos_rewrite_checkout_test_wallet_\d+_[a-f0-9-]{8}$/.test(schema))
        await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });

  it('commits20 identical credits once with one ledger/audit and no cashback mutation', async () => {
    const request = input(),
      settled = await Promise.allSettled(
        Array.from({ length: 20 }, () => repository.adjust(operator, request)),
      ),
      results = settled.flatMap((value) => (value.status === 'fulfilled' ? [value.value] : []));
    // The Redis claim admits one writer; concurrent duplicates see the in-flight claim.
    for (const value of settled)
      if (value.status === 'rejected')
        expect(value.reason).toMatchObject({ code: 'WALLET_ADJUSTMENT_UNCONFIRMED' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(new Set(results.map((value) => JSON.stringify(value))).size).toBe(1);
    expect(results[0]).toMatchObject({
      amount: '10.00',
      balanceBefore: '100.00',
      balanceAfter: '110.00',
      customerId,
      operatorId: '44',
      consumedHistories: 0,
    });
    expect(await balances()).toMatchObject({ money: '110', points: '100', cashback: '7' });
    for (const table of ['tss_money_history', 'pos_special_permission_activity_log'])
      expect((await rows(`SELECT COUNT(*) count FROM ${table}`))[0]?.count).toBe(1);
    expect(await repository.adjust(operator, request)).toEqual(results[0]);
    const audit = (
      await rows('SELECT recipient,comment FROM pos_special_permission_activity_log')
    )[0]!;
    expect(audit.recipient).toBe(customerId);
    expect(String(audit.comment)).not.toMatch(/fixture|@|customer/i);
    expect(await repository.get(operator, request.operationId)).toEqual(results[0]);
  });
  it('serializes different concurrent credits without lost balance updates', async () => {
    await Promise.all([
      repository.adjust(operator, input({ amount: '10.00' })),
      repository.adjust(operator, input({ amount: '20.00' })),
    ]);
    expect((await balances()).money).toBe('130');
    expect((await rows('SELECT COUNT(*) count FROM tss_money_history'))[0]?.count).toBe(2);
  });
  it('preserves exact native Points bindings and consumes source FIFO once across20 requests', async () => {
    await seedEarning('points', 40.1, '9007199254740996');
    await seedEarning('points', 69.9, '9007199254740997', 10);
    const request = input({
      asset: 'points',
      direction: 'subtract',
      amount: '50.25',
      expiry: null,
    });
    await Promise.allSettled(
      Array.from({ length: 20 }, () => repository.adjust(operator, request)),
    );
    const results = [await repository.get(operator, request.operationId)];
    expect(results[0]).toMatchObject({
      asset: 'points',
      balanceAfter: '49.75',
      consumedHistories: 2,
    });
    const history = await rows(
      'SELECT CAST(id AS CHAR) id,used_amt FROM tss_point_history WHERE added_amt>0 ORDER BY id',
    );
    expect(history).toMatchObject([
      { id: '9007199254740996', used_amt: 40.1 },
      { id: '9007199254740997', used_amt: 20.15 },
    ]);
    expect(
      (
        await rows(
          'SELECT prod_id,platform,comment,added_user,CAST(expiry AS CHAR) expiry FROM tss_point_history WHERE added_amt<0',
        )
      )[0],
    ).toMatchObject({
      prod_id: '0',
      platform: 'ORDER_REFUND',
      comment: 'Other',
      // Legacy added_user 0 and '' expiry (stored as the zero date), core/views.py:1316-1333.
      added_user: '0',
      expiry: '0000-00-00 00:00:00',
    });
    expect(await balances()).toMatchObject({ money: '100', points: '49.75', cashback: '7' });
  });
  it('rejects the second competing debit instead of overdrawing or consuming histories twice', async () => {
    await seedEarning('money');
    const results = await Promise.allSettled([
      repository.adjust(operator, input({ direction: 'subtract', amount: '60.00', expiry: null })),
      repository.adjust(operator, input({ direction: 'subtract', amount: '60.00', expiry: null })),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'INSUFFICIENT_WALLET_BALANCE' });
    expect((await balances()).money).toBe('40');
    expect(
      (await rows('SELECT COUNT(*) count FROM tss_money_history WHERE added_amt<0'))[0]?.count,
    ).toBe(1);
  });
  it('rolls every balance/history/command mutation back after a late audit failure and permits the same exact retry', async () => {
    const request = input();
    await connection.query(
      "CREATE TRIGGER fail_wallet_audit BEFORE INSERT ON pos_special_permission_activity_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated audit failure'",
    );
    try {
      await expect(repository.adjust(operator, request)).rejects.toThrow();
    } finally {
      await connection.query('DROP TRIGGER fail_wallet_audit');
    }
    expect((await balances()).money).toBe('100');
    expect((await rows('SELECT COUNT(*) count FROM tss_money_history'))[0]?.count).toBe(0);
    expect((await repository.adjust(operator, request)).balanceAfter).toBe('110.00');
  });
  it('checks fresh role, user type and activity rather than trusting a stale administrator principal', async () => {
    for (const [role, userType, active] of [
      [5, 1, 1],
      [1, 2, 1],
      [2, 1, 0],
    ]) {
      await connection.execute('UPDATE pos_user SET role=?,user_type=?,is_active=? WHERE id=44', [
        role!,
        userType!,
        active!,
      ]);
      await expect(repository.adjust(operator, input())).rejects.toThrow();
    }
    expect((await balances()).money).toBe('100');
    expect((await rows('SELECT COUNT(*) count FROM tss_money_history'))[0]?.count).toBe(0);
  });
  it('rejects ambiguous lookup and writer-blocked identities after a previously valid lookup', async () => {
    const lookup = await repository.lookup(operator, { email: 'fixture@example.test' });
    expect(lookup.id).toBe(customerId);
    await connection.execute('UPDATE users SET is_block=1 WHERE id=?', [customerId]);
    await expect(repository.adjust(operator, input())).rejects.toMatchObject({
      code: 'CUSTOMER_UNAVAILABLE',
    });
    await connection.execute('UPDATE users SET is_block=0 WHERE id=?', [customerId]);
    await verifiedMysqlFixture(connection).insert('users', {
      id: '9007199254740994',
      email: 'FIXTURE@example.test',
      status: 1,
      tss_money: 0,
      tss_points: 0,
      cashback: 0,
    });
    await expect(
      repository.lookup(operator, { email: 'fixture@example.test' }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_IDENTITY_UNCONFIRMED' });
  });
  it('binds UUID to the original actor/customer/body and retains historical receipts after later balance changes', async () => {
    const request = input(),
      result = await repository.adjust(operator, request);
    await expect(
      repository.adjust(operator, {
        ...request,
        adjustment: { ...request.adjustment, amount: '20' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await repository.adjust(operator, input({ amount: '20.00' }));
    expect(await repository.get(operator, request.operationId)).toEqual(result);
    expect((await balances()).money).toBe('130');
    await verifiedMysqlFixture(connection).insert('pos_user', {
      id: 45,
      role: 2,
      user_type: 1,
      is_active: 1,
    });
    await expect(
      repository.get({ ...operator, id: '45' }, request.operationId),
    ).rejects.toMatchObject({ code: 'WALLET_ADJUSTMENT_NOT_FOUND' });
    await expect(repository.adjust({ ...operator, id: '45' }, request)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
  it('replays the stored Redis receipt without another credit after later ledger changes', async () => {
    const request = input(),
      result = await repository.adjust(operator, request);
    await connection.execute('DELETE FROM tss_money_history WHERE id=?', [result.historyId]);
    expect(await repository.get(operator, request.operationId)).toEqual(result);
    expect(await repository.adjust(operator, request)).toEqual(result);
    expect((await balances()).money).toBe('110');
    expect((await rows('SELECT COUNT(*) count FROM tss_money_history'))[0]?.count).toBe(0);
  });
  it('does not overwrite a preexisting unconfirmed command or guess an unsupported platform', async () => {
    const request = input();
    await store.set(
      `pos:wallet_adjustment:${request.operationId}`,
      JSON.stringify({
        operatorId: operator.id,
        customerId,
        requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
        executionId: randomUUID(),
        status: 'inflight',
        result: null,
      }),
      86400,
    );
    await expect(repository.adjust(operator, request)).rejects.toMatchObject({
      code: 'WALLET_ADJUSTMENT_UNCONFIRMED',
    });
    expect((await balances()).money).toBe('100');
    expect(
      walletAdjustmentSchema.safeParse({
        ...input({ asset: 'points' }),
        adjustment: { ...input({ asset: 'points' }).adjustment, platform: 'DONATION_POINTS' },
      }).success,
    ).toBe(false);
  });
  it('is available like the legacy views and fails before mutations without complete earning history', async () => {
    expect((await repository.capabilities(operator)).enabled).toBe(true);
    await expect(
      repository.adjust(operator, input({ direction: 'subtract', expiry: null })),
    ).rejects.toMatchObject({ code: 'WALLET_HISTORY_REPAIR_REQUIRED' });
    expect((await balances()).money).toBe('100');
    expect((await rows('SELECT COUNT(*) count FROM tss_money_history'))[0]?.count).toBe(0);
  });
  it('preserves original Python text-read FLOAT semantics for a noninteger starting balance', async () => {
    await connection.execute('UPDATE users SET tss_money=100.11 WHERE id=?', [customerId]);
    const request = input({ amount: '0.10' }),
      result = await repository.adjust(operator, request);
    expect(result).toMatchObject({ balanceBefore: '100.11', balanceAfter: '100.21' });
    expect(
      (await rows('SELECT amt_before_update,amt_after_update FROM tss_money_history'))[0],
    ).toMatchObject({ amt_before_update: 100.11, amt_after_update: 100.21 });
  });
  it('applies and verifies250 earning allocations across bounded SQL batches', async () => {
    const values = Array.from({ length: 250 }, (_, index) => [
      String(9007199254742000n + BigInt(index)),
      customerId,
    ]);
    await connection.query(
      `INSERT INTO tss_money_history(id,user_id,added_amt,used_amt,is_expired,created_at) VALUES ${values.map(() => "(?,?,0.01,0,0,'2026-01-01 00:00:00')").join(',')}`,
      values.flat(),
    );
    const request = input({ direction: 'subtract', amount: '2.50', expiry: null }),
      result = await repository.adjust(operator, request);
    expect(result).toMatchObject({ consumedHistories: 250, balanceAfter: '97.50' });
    expect(
      (
        await rows(
          'SELECT COUNT(*) count FROM tss_money_history WHERE added_amt>0 AND used_amt=added_amt',
        )
      )[0]?.count,
    ).toBe(250);
    expect(await repository.adjust(operator, request)).toEqual(result);
    expect((await balances()).cashback).toBe('7');
  });
  it('binds optional exact BIGINT order/product references to the selected customer', async () => {
    const fixture = verifiedMysqlFixture(connection),
      orderId = '9007199254742001',
      productId = '9007199254742002';
    await fixture.insert('orders', { id: orderId, user_id: '9007199254742003' });
    const request = input({ orderId, productId });
    await expect(repository.adjust(operator, request)).rejects.toMatchObject({
      code: 'WALLET_ORDER_REFERENCE_INVALID',
    });
    await connection.execute('UPDATE orders SET user_id=? WHERE id=?', [customerId, orderId]);
    await expect(repository.adjust(operator, request)).rejects.toMatchObject({
      code: 'WALLET_PRODUCT_REFERENCE_INVALID',
    });
    expect((await rows('SELECT COUNT(*) count FROM tss_money_history'))[0]?.count).toBe(0);
    await fixture.insert('products', { id: productId });
    const receipt = await repository.adjust(operator, request);
    expect(
      (
        await rows('SELECT order_id,product_id FROM tss_money_history WHERE id=?', [
          receipt.historyId,
        ])
      )[0],
    ).toMatchObject({ order_id: orderId, product_id: productId });
  });
});
