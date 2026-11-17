import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { importFinancialFixture, financialPlan, financialClock, sourceKey } from './fixture.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import { financialSourceHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import { financialImportSourceReceipts } from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import { readSourceOrderReceipt } from '../../src/modules/legacy-order-imports/financial-adapter-proof.js';
import { assertNativeImportOrder } from '../../src/modules/legacy-order-imports/financial-adapter-writer.js';
import type { FinancialSourceCommand } from '../../src/modules/legacy-order-imports/financial-adapter-transport.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { settleNativeImport } from '../../src/modules/legacy-order-imports/financial-adapter-writer.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
function sourcePlan(kind: 'offline' | 'shopify') {
  const plan = financialPlan(kind);
  if (plan.kind === 'shopify')
    plan.address = {
      shipping_name: 'Fixture',
      shipping_street: 'Road',
      shipping_address1: 'Building',
      shipping_address2: '',
      shipping_phone: '9000000000',
      shipping_country: 'India',
      shipping_province: 'Fixture state',
      shipping_zip: '400001',
      shipping_city: 'Fixture city',
    };
  return plan;
}
const template = process.env.CHECKOUT_MYSQL_TEST_URL,
  authKey = 'fixture-private-source-authority-key-'.repeat(3);
describe.skipIf(!template)('literal API-v2 source order inside private native receiver', () => {
  let f: Awaited<ReturnType<typeof importFinancialFixture>>;
  let sourceFixture: ReturnType<typeof verifiedMysqlFixture>;
  beforeAll(async () => {
    f = await importFinancialFixture(template!);
    sourceFixture = verifiedMysqlFixture(f.connection, [
      'evidence/mysql-order-import-address-schema.json',
    ]);
    await sourceFixture.create([
      'cities',
      'zones',
      'pricelist',
      'pricelist_meta',
      'has_categories',
      'has_addresses',
      'order_address_mapping',
      'flag_history',
      'order_cancel_message_mapping',
    ]);
  }, 30000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.reset();
    await f.connection.query('ALTER TABLE orders AUTO_INCREMENT=5001');
    for (const name of [
      'cities',
      'zones',
      'pricelist',
      'pricelist_meta',
      'has_categories',
      'has_addresses',
      'order_address_mapping',
      'flag_history',
      'order_cancel_message_mapping',
    ])
      await f.connection.query('DELETE FROM `' + name + '`');
    await f.fixture.insert('cities', { id: 10, city_name: 'Fixture city', state_id: 20 });
    await f.fixture.insert('zones', { id: 20, name: 'Fixture state' });
    await f.connection.query(
      "UPDATE stores SET city_id=10,store_name='Fixture store',address='Fixture address',alt_address='',phone='9000000000',pincode='400001' WHERE id=1",
    );
    await f.connection.query(
      "UPDATE users SET firstname='Fixture',lastname='Import',cashback=0,tss_money=0,tss_points=0 WHERE id=77",
    );
    await f.connection.query(
      'UPDATE products SET price=25,spl_price=0,cog=0,parent_prod_id=0 WHERE id=9007199254740993',
    );
    await f.fixture.insert('pricelist_meta', { id: 1, is_active: 1 });
    await sourceFixture.insert('has_addresses', { id: 88, user_id: 77 });
  });
  function driverInput(
    input: FinancialSourceCommand,
    mode?: string,
    phase: 'order' | 'publication' = 'order',
  ) {
    const cap = {
      contract: 'pos-legacy-order-import-source-v1',
      phase,
      operationId: input.state.scope.operationId,
      requestHash: input.state.requestHash,
      planHash: input.state.planHash,
      namespace: input.state.namespace,
      planDigest: financialSourceHash(authKey, 'plan', input.plan),
      scope: input.state.scope,
      authority: input.state.authority,
      orderId: phase === 'order' ? null : input.state.orderId,
      nonce: input.nonce,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    };
    return JSON.stringify({
      url: f.config.MYSQL_WRITER_URL,
      sourceRoot: resolve('../../backend-tss-api_v2'),
      authKey,
      proofKey: sourceKey,
      now: financialClock,
      operationId: input.state.scope.operationId,
      mode,
      phase,
      body: {
        capability: { ...cap, signature: financialSourceHash(authKey, 'capability', cap) },
        ...(phase === 'order' ? { plan: input.plan } : { orderId: input.state.orderId }),
      },
    });
  }
  function run(
    input: FinancialSourceCommand,
    mode?: string,
    phase: 'order' | 'publication' = 'order',
  ) {
    const result: unknown = JSON.parse(
      execFileSync(
        resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
        ['-B', resolve('compatibility/upstream/legacy-order-imports/native_source_driver.py')],
        {
          input: driverInput(input, mode, phase),
          encoding: 'utf8',
          timeout: 20000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
          maxBuffer: 16000,
        },
      ),
    );
    return result;
  }
  it('never exposes an unbound source order when literal inner commits flush before the outer receipt transaction', async () => {
    const input = f.input(),
      journal = legacyImportFinancialJournal(f.config, f.db, f.options);
    await journal.reserve(input);
    const command = await journal.dispatch(input, 'order');
    const child = spawn(
      resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
      ['-B', resolve('compatibility/upstream/legacy-order-imports/native_source_driver.py')],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let output = '';
    const flushed = new Promise<void>((fulfill, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.includes('SOURCE_FLUSHED\n')) fulfill();
      });
      child.once('error', reject);
      child.once('exit', () => {
        if (!output.includes('SOURCE_FLUSHED\n'))
          reject(new Error('Source fixture did not reach its flush barrier.'));
      });
    });
    const finished = new Promise<void>((fulfill, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? fulfill() : reject(new Error('Source fixture did not complete.')),
      );
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdin.end(driverInput(command, 'visibility-barrier'));
    try {
      await flushed;
      const [before] = await f.connection.query(
        'SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM pos_rewrite_import_financial_order_bindings) AS bindings_count',
      );
      expect(before).toEqual([{ orders_count: '0', bindings_count: '0' }]);
      await finished;
      expect(JSON.parse(output.split('\n').at(-2)!)).toEqual({
        recorded: true,
        fixtureFailures: [],
      });
      const [after] = await f.connection.query(
        "SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM pos_rewrite_import_financial_order_bindings WHERE status='held') AS bindings_count",
      );
      expect(after).toEqual([{ orders_count: '1', bindings_count: '1' }]);
    } finally {
      clearTimeout(timeout);
      child.kill();
    }
  }, 30000);
  it.each(['offline', 'shopify'] as const)(
    'commits the literal %s source body and native signed order/HP/refund receipt together',
    async (kind) => {
      const plan = financialPlan(kind);
      if (plan.kind === 'shopify') {
        plan.address = {
          shipping_name: 'Fixture',
          shipping_street: 'Road',
          shipping_address1: 'Building',
          shipping_address2: '',
          shipping_phone: '9000000000',
          shipping_country: 'India',
          shipping_province: 'Fixture state',
          shipping_zip: '400001',
          shipping_city: 'Fixture city',
        };
        plan.currency = 'USD';
        plan.shippingCharges = '7.50';
        plan.discountAmount = '2.00';
      }
      const input = f.input(plan),
        journal = legacyImportFinancialJournal(f.config, f.db, f.options);
      await journal.reserve(input);
      const command = await journal.dispatch(input, 'order');
      const result = run(command);
      expect(result).toEqual({ recorded: true, fixtureFailures: [] });
      const receipt = await f.db
        .get('writer')
        .transaction((tx) => readSourceOrderReceipt(tx, input.operationId, sourceKey));
      expect(receipt).not.toBeNull();
      await f.db
        .get('writer')
        .transaction((tx) => assertNativeImportOrder(tx, command.state, plan, receipt!));
      expect(receipt!.method).toBe(kind === 'offline' ? 14 : 15);
      if (kind === 'shopify') {
        const [headers] = await f.connection.query(
          'SELECT currency,currency_conv_rate,shipping_amt,coupon_amt_used FROM orders',
        );
        expect(headers).toEqual([
          { currency: 'USD', currency_conv_rate: '0', shipping_amt: 0, coupon_amt_used: 0 },
        ]);
      }
      // Duplicate private request reads its original native receipt, without another source order.
      expect(run(command)).toEqual({ recorded: true, fixtureFailures: [] });
      const [rows] = await f.connection.query('SELECT COUNT(*) AS n FROM orders');
      expect(rows).toEqual([{ n: '1' }]);
    },
    30000,
  );
  it.each(['offline', 'shopify'] as const)(
    'records the unmodified %s source model failure without claiming a successful legacy import',
    async (kind) => {
      const input = f.input(sourcePlan(kind)),
        journal = legacyImportFinancialJournal(f.config, f.db, f.options);
      await journal.reserve(input);
      const command = await journal.dispatch(input, 'order');
      const result = run(command, 'original-model');
      expect(result).toMatchObject({
        recorded: true,
        fixtureFailures: [
          kind === 'offline'
            ? { type: 'DataError', nativeCode: 1265, column: 'reward_points_cron' }
            : { type: 'TypeError', column: 'currency' },
        ],
      });
      const [rows] = await f.connection.query('SELECT COUNT(*) AS n FROM orders');
      expect(rows).toEqual([{ n: '0' }]);
      const [record] = await f.db
        .get('writer')
        .select()
        .from(financialImportSourceReceipts)
        .where(eq(financialImportSourceReceipts.operationId, input.operationId));
      expect(record?.status).toBe('rejected');
    },
    30000,
  );
  async function pendingPublication() {
    const plan = sourcePlan('shopify'),
      input = f.input(plan),
      journal = legacyImportFinancialJournal(f.config, f.db, f.options);
    await journal.reserve(input);
    const orderCommand = await journal.dispatch(input, 'order');
    expect(run(orderCommand)).toEqual({ recorded: true, fixtureFailures: [] });
    const order = await f.db
      .get('writer')
      .transaction((tx) => readSourceOrderReceipt(tx, input.operationId, sourceKey));
    if (!order) throw new Error('Native source receipt missing.');
    await journal.transaction(async (tx) => {
      await journal.confirm(tx, orderCommand.state, 'order', order);
      await journal.save(tx, { ...orderCommand.state, orderId: order.orderId });
    });
    const settlementCommand = await journal.dispatch(input, 'settlement');
    await journal.transaction(async (tx) => {
      const settlement = await settleNativeImport(
        tx,
        settlementCommand.state,
        plan,
        order,
        f.options,
      );
      await journal.confirm(tx, settlementCommand.state, 'settlement', settlement);
    });
    return { input, command: await journal.dispatch(input, 'publication') };
  }
  it('completes only after literal source producer jobs receive durable queue acceptance and native seals', async () => {
    const { input, command } = await pendingPublication();
    expect(run(command, undefined, 'publication')).toMatchObject({
      recorded: true,
      fixtureFailures: [],
      queueCalls: expect.any(Number),
    });
    const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, f.transport());
    expect(await adapter.read(input)).toMatchObject({
      status: 'completed',
      businessDate: '2026-06-15',
    });
    // The public completion seal advances the operation/stage. A stale private
    // capability is then refused; only its original GET receipt is needed.
    expect(run(command, undefined, 'publication')).toMatchObject({
      code: 'ORDER_IMPORT_NATIVE_SCOPE_INVALID',
      queueCalls: 0,
    });
    const [orders] = await f.connection.query('SELECT payment_status,order_status FROM orders');
    expect(orders).toEqual([{ payment_status: 1, order_status: 1 }]);
  }, 30000);
  it('freezes a partly accepted producer batch and never republishes after lost queue acknowledgment', async () => {
    const { input, command } = await pendingPublication();
    expect(run(command, 'lost-queue-ack', 'publication')).toMatchObject({
      code: 'ORDER_IMPORT_PUBLICATION_UNCONFIRMED',
      queueCalls: 3,
    });
    expect(run(command, undefined, 'publication')).toMatchObject({
      code: 'ORDER_IMPORT_ORIGINAL_STAGE_UNCERTAIN',
      queueCalls: 0,
    });
    const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, f.transport());
    expect(await adapter.read(input)).toMatchObject({ status: 'unknown', stage: 'publication' });
    const [rows] = await f.connection.query(
      'SELECT status,JSON_LENGTH(deliveries) AS accepted FROM pos_rewrite_import_financial_source_effects',
    );
    expect(rows).toEqual([{ status: 'uncertain', accepted: '2' }]);
  }, 30000);
  it('rolls back literal partial commits on a late source failure and seals one permanent no-effects rejection', async () => {
    const input = f.input(),
      journal = legacyImportFinancialJournal(f.config, f.db, f.options);
    await journal.reserve(input);
    const command = await journal.dispatch(input, 'order');
    run(command, 'late-failure');
    const [orders] = await f.connection.query('SELECT COUNT(*) AS n FROM orders');
    expect(orders).toEqual([{ n: '0' }]);
    const [source] = await f.db
      .get('writer')
      .select()
      .from(financialImportSourceReceipts)
      .where(eq(financialImportSourceReceipts.operationId, input.operationId));
    expect(source?.status).toBe('rejected');
    expect(source?.proof).toMatchObject({
      code: 'ORDER_IMPORT_FIXTURE_LATE_FAILURE',
      noFinancialEffects: true,
    });
    expect(run(command)).toEqual({ recorded: true, fixtureFailures: [] });
    const [lines] = await f.connection.query('SELECT COUNT(*) AS n FROM has_products');
    expect(lines).toEqual([{ n: '0' }]);
  }, 30000);
});
