import { execFileSync, spawn } from 'node:child_process';
import { createConnection } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, getTableName, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Order, ProductBarcode } from '../../src/db/legacy-schema.js';
import {
  screeningImportProfile,
  screeningMaximum,
  screeningProfileContract,
  screeningSchemaContract,
  screeningWriterContract,
  screeningReservationDdl,
  screeningReservations,
  readScreeningTicketCount,
  screeningCountStatement,
} from '../../src/modules/legacy-order-imports/screening-profile.js';
import {
  importFinancialFixture,
  financialPlan,
  financialClock,
  sourceKey,
} from '../legacy-import-financial/fixture.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import { financialAdapterProfiles } from '../../src/modules/legacy-order-imports/financial-adapter-profiles.js';
import {
  lockScreeningCustomer,
  financialTransaction,
} from '../../src/modules/legacy-order-imports/screening-transactions.js';
import {
  FinancialImportAdmissionDenied,
  nativeAdmissionRejectionSchema,
} from '../../src/modules/legacy-order-imports/financial-adapter-admission.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import { shopifyOrderColumns } from '../../src/modules/legacy-order-imports/csv.js';
import {
  financialSourceHash,
  financialImportHash,
} from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import {
  financialImportSourceReceipts,
  financialImportStages,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import { readSourceOrderReceipt } from '../../src/modules/legacy-order-imports/financial-adapter-proof.js';
import type { FinancialSourceCommand } from '../../src/modules/legacy-order-imports/financial-adapter-transport.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { runtimeImportSecret } from '../legacy-order-imports/runtime-fixture.js';
import { python, sourceRoot, oracle, sourceOracleSchema } from './source.js';

import {
  installOriginCreditFixture,
  installImportCounterFixture,
  type ImportCounterFixture,
} from './native-counter-fixture.js';
import {
  screeningCounterMutation,
  withScreeningCounterWriter,
} from '../../src/modules/legacy-order-imports/screening-counter/entry.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL,
  authKey = 'isolated-screening-source-authority-'.repeat(3);
const extras = [
  'cities',
  'zones',
  'pricelist',
  'pricelist_meta',
  'has_categories',
  'has_addresses',
  'order_address_mapping',
  'flag_history',
  'order_cancel_message_mapping',
];
function ticketPlan(kind: 'offline' | 'shopify' = 'offline', quantity = 2) {
  const plan = financialPlan(kind);
  plan.lines = [{ productId: '390238', quantity, unitPrice: '25.00', sourceRows: [2] }];
  plan.originalTenderAmount = (quantity * 25).toFixed(2);
  if (plan.kind === 'shopify') {
    plan.declaredSubtotal = plan.originalTenderAmount;
    plan.declaredTotal = plan.originalTenderAmount;
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
  }
  return plan;
}
describe.skipIf(!template)('qualified screening candidate on isolated native writer', () => {
  let f: Awaited<ReturnType<typeof importFinancialFixture>>,
    sourceFixture: ReturnType<typeof verifiedMysqlFixture>,
    quota: ImportCounterFixture | undefined,
    rootDb: typeof f.db;
  beforeAll(async () => {
    f = await importFinancialFixture(template!);
    rootDb = f.db;
    await installOriginCreditFixture(f.connection);
    sourceFixture = verifiedMysqlFixture(f.connection, [
      'evidence/mysql-order-import-address-schema.json',
      'evidence/mysql-screening-schema.json',
    ]);
    await sourceFixture.create([...extras, 'spiderman_screening_orders']);
    await f.connection.query(
      'ALTER TABLE spiderman_screening_orders MODIFY updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
    );
    await f.fixture.create([getTableName(ProductBarcode)]);
    // The generic fixture deliberately omits secondary indexes. These exact
    // verified keys are part of the source's bounded customer/store lookups.
    const physical = z
      .object({
        indexes: z.record(
          z.string(),
          z.array(
            z.object({
              name: z.string(),
              column: z.string(),
              position: z.number(),
              unique: z.boolean(),
            }),
          ),
        ),
      })
      .parse(JSON.parse(readFileSync('evidence/mysql-extra-schema.json', 'utf8')) as unknown);
    expect(physical.indexes.users?.filter((index) => index.name === 'email')).toEqual([
      { name: 'email', column: 'email', position: 1, unique: false },
    ]);
    expect(
      physical.indexes.product_store?.filter((index) => index.name === 'uq_product_store'),
    ).toEqual([
      { name: 'uq_product_store', column: 'product_id', position: 1, unique: true },
      { name: 'uq_product_store', column: 'store_id', position: 2, unique: true },
    ]);
    await f.connection.query('CREATE INDEX email ON users(email)');
    await f.connection.query(
      'CREATE UNIQUE INDEX uq_product_store ON product_store(product_id,store_id)',
    );
    expect(physical.indexes.has_products?.filter((index) => index.name === 'order_id')).toEqual([
      { name: 'order_id', column: 'order_id', position: 1, unique: false },
    ]);
    expect(physical.indexes.order_stores?.filter((index) => index.name === 'order')).toEqual([
      { name: 'order', column: 'order_id', position: 1, unique: false },
    ]);
    await f.connection.query('CREATE INDEX order_id ON has_products(order_id)');
    await f.connection.query('CREATE INDEX `order` ON order_stores(order_id)');
    for (const [name, column] of [
      ['idx_user_id', 'user_id'],
      ['idx_order_id', 'order_id'],
      ['idx_has_product_id', 'has_product_id'],
    ] as const)
      await f.connection.query(
        'CREATE INDEX `' + name + '` ON spiderman_screening_orders(`' + column + '`)',
      );
    await f.connection.query(screeningReservationDdl);
  }, 30000);
  afterAll(async () => {
    await quota?.close();
    await f?.close();
  });
  beforeEach(async () => {
    await quota?.close();
    quota = undefined;
    f.db = rootDb;
    for (const name of [
      'spiderman_screening_orders',
      'pos_rewrite_import_screening_reservations',
      getTableName(ProductBarcode),
      ...extras,
    ])
      await f.connection.query('DELETE FROM `' + name + '`');
    await f.reset();
    await f.connection.query('ALTER TABLE orders AUTO_INCREMENT=5001');
    await f.fixture.insert('products', {
      id: '390238',
      price: 25,
      spl_price: 0,
      cog: 0,
      parent_prod_id: 0,
      prod_type: 1,
    });
    await f.fixture.insert('product_stocks', {
      prod_id: '390238',
      parent_prod_id: 0,
      stock: 100,
      stocked: 0,
    });
    await f.fixture.insert('product_store', {
      id: '2',
      product_id: '390238',
      store_id: '1',
      stock: 100,
      is_avail: 1,
      is_del: 0,
    });
    await f.fixture.insert('products_gs1', {
      id: '1',
      product_id: '390238',
      gtin: '8900000000001',
    });
    await f.fixture.insert('cities', { id: 10, city_name: 'Fixture city', state_id: 20 });
    await f.fixture.insert('zones', { id: 20, name: 'Fixture state' });
    await f.connection.query(
      "UPDATE stores SET city_id=10,store_name='Fixture store',address='Fixture address',alt_address='',phone='9000000000',pincode='400001' WHERE id=1",
    );
    await f.connection.query(
      "UPDATE users SET firstname='Fixture',lastname='Import',cashback=0,tss_money=0,tss_points=0 WHERE id=77",
    );
    await f.fixture.insert('pricelist_meta', { id: 1, is_active: 1 });
    await sourceFixture.insert('has_addresses', { id: 88, user_id: 77 });
    quota = await installImportCounterFixture(f.connection, template!);
    await quota.initialize('77');
    f.db = quota.appDb;
  });
  function profile(qualified = true) {
    return screeningImportProfile(f.config, f.db, {
      financialSecret: runtimeImportSecret,
      proofKey: sourceKey,
      clock: () => financialClock,
      counter: quota!.options,
      ...(qualified
        ? {
            contract: screeningProfileContract,
            schemaContract: screeningSchemaContract,
            writerContract: screeningWriterContract,
          }
        : {}),
    });
  }
  function profiles(lineItemsEnabled = false) {
    return financialAdapterProfiles({ screening: { profile: profile(), lineItemsEnabled } });
  }
  async function countTickets(tx: Parameters<typeof readScreeningTicketCount>[0], customer = '77') {
    await lockScreeningCustomer(tx, customer);
    return readScreeningTicketCount(tx, customer, quota!.options);
  }
  async function marker(order: string | number, line: string | number, customer = '77') {
    return screeningCounterMutation(
      f.db,
      { customerIds: [customer], orderIds: [String(order)], lineIds: [String(line)] },
      (tx) =>
        tx.execute(
          sql`INSERT INTO spiderman_screening_orders(order_id,has_product_id,user_id) VALUES(${BigInt(order)},${BigInt(line)},${BigInt(customer)})`,
        ),
    );
  }
  function journal(lineItemsEnabled = false) {
    return legacyImportFinancialJournal(f.config, f.db, f.options, profiles(lineItemsEnabled));
  }
  async function prepare(quantity = 2, mode = false, kind: 'offline' | 'shopify' = 'offline') {
    const input = f.input(ticketPlan(kind, quantity)),
      j = journal(mode);
    await j.reserve(input);
    const reservation = await j.transaction((tx) => profile().reserve(tx, input, mode));
    return { input, reservation, j };
  }
  function driverInput(command: FinancialSourceCommand, unitMode: boolean, mode?: string) {
    const cap = {
      contract: 'pos-legacy-order-import-source-v1',
      phase: 'order',
      operationId: command.state.scope.operationId,
      requestHash: command.state.requestHash,
      planHash: command.state.planHash,
      namespace: command.state.namespace,
      planDigest: financialSourceHash(authKey, 'plan', command.plan),
      scope: command.state.scope,
      authority: command.state.authority,
      orderId: null,
      nonce: command.nonce,
      issuedAt: command.issuedAt,
      expiresAt: command.expiresAt,
    };
    return JSON.stringify({
      url: quota!.appUrl,
      sourceRoot,
      authKey,
      proofKey: sourceKey,
      now: financialClock,
      operationId: cap.operationId,
      unitMode,
      mode,
      body: {
        capability: { ...cap, signature: financialSourceHash(authKey, 'capability', cap) },
        plan: command.plan,
      },
    });
  }
  function run(command: FinancialSourceCommand, unitMode: boolean, mode?: string) {
    const output = execFileSync(
      python,
      ['-B', resolve('tests/legacy-import-screening/native_source_driver.py')],
      {
        input: driverInput(command, unitMode, mode),
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 2000,
        env: { ...process.env, ...quota!.environment, PYTHONDONTWRITEBYTECODE: '1' },
      },
    );
    return z
      .object({ recorded: z.boolean().optional(), code: z.string().optional() })
      .strict()
      .parse(JSON.parse(output) as unknown);
  }
  function runAsync(
    command: FinancialSourceCommand,
    unitMode: boolean,
    mode?: string,
  ): Promise<{ recorded?: boolean; code?: string }> {
    const child = spawn(
      python,
      ['-B', resolve('tests/legacy-import-screening/native_source_driver.py')],
      {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, ...quota!.environment, PYTHONDONTWRITEBYTECODE: '1' },
      },
    );
    return new Promise((fulfill, reject) => {
      let output = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Screening fixture exceeded its deadline.'));
      }, 20000);
      child.stdout.on('data', (value: Buffer) => {
        output += value.toString('utf8');
        if (output.length > 2000) {
          child.kill('SIGKILL');
        }
      });
      child.once('error', () => {
        clearTimeout(timeout);
        reject(new Error('Screening fixture could not start.'));
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error('Screening source fixture failed.'));
          return;
        }
        try {
          fulfill(
            z
              .object({ recorded: z.boolean().optional(), code: z.string().optional() })
              .strict()
              .parse(JSON.parse(output) as unknown),
          );
        } catch {
          reject(new Error('Screening fixture response is invalid.'));
        }
      });
      child.stdin.end(driverInput(command, unitMode, mode));
    });
  }
  function sourceTransport(unitMode = false, mode?: string) {
    const transport = f.transport();
    transport.order = vi.fn(async (command) => {
      expect(await runAsync(command, unitMode, mode)).toEqual({ recorded: true });
    });
    transport.confirm = vi.fn(async () => {
      throw new Error('Fixture must not execute an offline confirmation.');
    });
    return transport;
  }
  function shopifyInput() {
    const cells: Record<string, string> = {
      Name: randomUUID(),
      Email: 'private-import@example.test',
      'Financial Status': 'paid',
      Currency: 'INR',
      Subtotal: '50.00',
      Shipping: '0.00',
      Taxes: '0.00',
      Total: '50.00',
      'Discount Amount': '0.00',
      'Created at': '2026-06-15 06:30:00 +0000',
      'Lineitem quantity': '2',
      'Lineitem price': '25.00',
      'Lineitem sku': '390238',
      'Shipping Name': 'Fixture',
      'Shipping Street': 'Road',
      'Shipping Address1': 'Building',
      'Shipping City': 'Fixture city',
      'Shipping Zip': '400001',
      'Shipping Province': 'Fixture state',
      'Shipping Country': 'India',
      'Shipping Phone': '9000000000',
      'Tax 1 Name': 'GST 0%',
      'Tax 1 Value': '0.00',
    };
    return {
      id: randomUUID(),
      kind: 'shopify' as const,
      storeId: '1',
      counters: [{ storeId: '1', counterId: '2' }],
      csv:
        shopifyOrderColumns.join(',') +
        '\n' +
        shopifyOrderColumns.map((key) => cells[key] ?? '').join(','),
    };
  }
  it('keeps unselected readiness query-free and never fabricates an empty source counter', async () => {
    const input = f.input(ticketPlan());
    expect(profile(false).qualified).toBe(false);
    await expect(
      journal().transaction((tx) => profile(false).reserve(tx, input, false)),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_SCREENING_UNQUALIFIED' });
    await f.connection.query(
      'RENAME TABLE spiderman_screening_orders TO screening_temporarily_unavailable',
    );
    try {
      await expect(journal().transaction((tx) => countTickets(tx))).rejects.toMatchObject({
        cause: { code: 'ER_NO_SUCH_TABLE' },
      });
    } finally {
      await f.connection.query(
        'RENAME TABLE screening_temporarily_unavailable TO spiderman_screening_orders',
      );
    }
    const [rows] = await f.connection.query(
      'SELECT COUNT(*) AS n FROM pos_rewrite_import_screening_reservations',
    );
    expect(rows).toEqual([{ n: '0' }]);
  });
  it('matches original COUNT(*) across cancelled/returned/status/SKU/orphan/duplicate and malformed historical joins', async () => {
    await quota!.close();
    quota = undefined;
    f.db = rootDb;
    const statusValues = [0, 17, 1, 3, 4, 6, 22];
    for (let index = 0; index < statusValues.length; index++) {
      const id = 100 + index;
      await f.fixture.insert('orders', { id, user_id: 77, order_status: statusValues[index]! });
      await f.fixture.insert('has_products', { id, order_id: id, prod_id: 390238, qty: 2 });
      await f.connection.query(
        'INSERT INTO spiderman_screening_orders(order_id,has_product_id,user_id) VALUES(?,?,77)',
        [id, id],
      );
    }
    await f.connection.query(
      'INSERT INTO spiderman_screening_orders(order_id,has_product_id,user_id) VALUES(102,102,77),(999,102,77),(102,999,77),(102,102,88)',
    );
    await f.fixture.insert('has_products', { id: 200, order_id: 999, prod_id: 390238, qty: 1 });
    await f.fixture.insert('has_products', { id: 201, order_id: 102, prod_id: 123, qty: 1 });
    await f.connection.query(
      'INSERT INTO spiderman_screening_orders(order_id,has_product_id,user_id) VALUES(102,200,77),(102,201,77)',
    );
    const originalSql = sourceOracleSchema
        .parse(oracle())
        .counter.sql.replace(':user_id', '?')
        .replace(':sku', '?'),
      [original] = await f.connection.query(originalSql, [77, 390238]);
    expect(original).toEqual([{ cnt: '7' }]);
    quota = await installImportCounterFixture(f.connection, template!);
    await quota.initialize('77');
    f.db = quota.appDb;
    expect(await journal().transaction((tx) => countTickets(tx))).toBe(7n);
  });
  it('serializes twenty same-command reservations without consuming a second ticket allocation', async () => {
    const { input } = await prepare();
    const values = await Promise.all(
      Array.from({ length: 20 }, () =>
        journal().transaction((tx) => profile().reserve(tx, input, false)),
      ),
    );
    expect(
      values.every(
        (value) => value?.scope.operationId === input.operationId && value.version === 1,
      ),
    ).toBe(true);
    expect(await f.db.get('writer').select().from(screeningReservations)).toHaveLength(1);
  }, 15000);
  it('uses one global customer lock across two stores and twenty competing commands', async () => {
    await f.fixture.insert('stores', { id: 2, type: 'STORE', is_active: 1 });
    await f.fixture.insert('store_counters', { id: 3, store_id: 2, is_active: 1 });
    await f.fixture.insert('product_store', {
      id: 3,
      product_id: 390238,
      store_id: 2,
      stock: 100,
      is_avail: 1,
      is_del: 0,
    });
    const inputs = Array.from({ length: 20 }, (_, index) => {
      const value = f.input(ticketPlan('offline', 1));
      if (index % 2) {
        value.storeId = '2';
        value.counterId = '3';
        value.plan.storeId = '2';
      }
      return value;
    });
    // Recompute only private fixture hashes after choosing each original scope.
    const { expectedFinancialPlanHash } =
      await import('../../src/modules/legacy-order-imports/financial-adapter-crypto.js');
    for (const input of inputs) {
      input.planHash = expectedFinancialPlanHash(runtimeImportSecret, input, input.plan);
    }
    const results = await Promise.all(inputs.map((input) => journal(true).reserve(input)));
    expect(results.filter((value) => value.admission === null)).toHaveLength(screeningMaximum);
    expect(results.filter((value) => value.admission !== null)).toHaveLength(18);
    expect(
      results
        .filter((value) => value.admission !== null)
        .every(
          (value) =>
            value.state.status === 'rejected' &&
            value.admission?.code === 'ORDER_IMPORT_SCREENING_LIMIT',
        ),
    ).toBe(true);
    expect(await f.db.get('writer').select().from(screeningReservations)).toHaveLength(2);
  }, 20000);
  it.each([false, true])(
    'retains source row-count quota for unit mode=%s before source confirmation',
    async (unitMode) => {
      await prepare(2, unitMode);
      const next = f.input(ticketPlan('offline', 1));
      const work = journal().reserve(next);
      if (unitMode)
        await expect(work).resolves.toMatchObject({
          state: { status: 'rejected', errorCode: 'ORDER_IMPORT_SCREENING_LIMIT' },
          admission: { code: 'ORDER_IMPORT_SCREENING_LIMIT' },
        });
      else {
        await work;
        expect(await journal().transaction((tx) => profile().read(tx, next))).toMatchObject({
          quantity: 1,
          pendingBefore: 1,
        });
      }
    },
  );
  it('rejects current catalog ambiguity, stale authority and tampered retained proof before source dispatch', async () => {
    const deniedInput = f.input(ticketPlan());
    await f.fixture.insert('products_gs1', { id: 2, product_id: 390238, gtin: '8900000000002' });
    await expect(journal().reserve(deniedInput)).resolves.toMatchObject({
      admission: { code: 'ORDER_IMPORT_SCREENING_CATALOG_REVIEW' },
    });
    await f.connection.query('DELETE FROM products_gs1 WHERE id=2');
    await expect(journal().reserve(deniedInput)).resolves.toMatchObject({
      created: false,
      admission: { code: 'ORDER_IMPORT_SCREENING_CATALOG_REVIEW' },
    });
    const input = f.input(ticketPlan());
    await journal().reserve(input);
    await f.connection.query(
      "UPDATE pos_rewrite_import_screening_reservations SET proof_hash=REPEAT('0',64)",
    );
    await expect(journal().transaction((tx) => profile().read(tx, input))).rejects.toMatchObject({
      code: 'ORDER_IMPORT_SCREENING_PROOF_INVALID',
    });
    await f.connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
    await expect(
      journal().transaction((tx) => profile().reserve(tx, input, false)),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_ADMINISTRATION_DENIED' });
  });
  it.each([
    ['offline', false],
    ['offline', true],
    ['shopify', false],
    ['shopify', true],
  ] as const)(
    'executes literal %s PosOrder, screening helper and markers atomically (unit=%s)',
    async (kind, unitMode) => {
      const { input, j } = await prepare(2, unitMode, kind),
        command = await j.dispatch(input, 'order');
      expect(run(command, unitMode)).toEqual({ recorded: true });
      const receipt = await j.transaction((tx) =>
        readSourceOrderReceipt(tx, input.operationId, sourceKey),
      );
      expect(receipt).not.toBeNull();
      const value = await j.transaction((tx) => profile().attachSourceReceipt(tx, input));
      expect(value).toMatchObject({
        phase: 'BOUND',
        orderId: receipt!.orderId,
        quantity: 2,
        markerRows: unitMode ? 2 : 1,
      });
      expect(value.lines).toHaveLength(unitMode ? 2 : 1);
      expect(value.lines.reduce((sum, row) => sum + row.quantity, 0)).toBe(2);
      expect(await j.transaction((tx) => countTickets(tx))).toBe(
        kind === 'offline' ? 0n : BigInt(unitMode ? 2 : 1),
      );
      expect(run(command, unitMode)).toEqual({ recorded: true });
      const [rows] = await f.connection.query(
        'SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM spiderman_screening_orders) AS marker_count,(SELECT COUNT(*) FROM pos_rewrite_import_financial_order_bindings) AS bindings_count',
      );
      expect(rows).toEqual([
        { orders_count: '1', marker_count: String(unitMode ? 2 : 1), bindings_count: '1' },
      ]);
      await expect(
        j.transaction((tx) => profile().releaseRejected(tx, input)),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_SCREENING_NO_EFFECTS_REQUIRED' });
      await expect(j.transaction((tx) => profile().complete(tx, input))).rejects.toMatchObject({
        code: 'ORDER_IMPORT_SCREENING_COMPLETION_UNCONFIRMED',
      });
    },
    25000,
  );
  it.each(['wrong-value', 'old-order', 'old-lines', 'wide-predicate'] as const)(
    'refuses CSV date %s outside the authenticated current creation graph',
    async (probe) => {
      await f.fixture.insert('orders', {
        id: 100,
        user_id: 77,
        order_status: 1,
        created_at: '2025-01-01 00:00:00',
      });
      await f.fixture.insert('has_products', {
        id: 100,
        order_id: 100,
        prod_id: 123,
        qty: 1,
        created_at: '2025-01-01 00:00:00',
      });
      const { input, j } = await prepare(),
        command = await j.dispatch(input, 'order');
      expect(run(command, false, 'screening-date-' + probe)).toEqual({ recorded: true });
      const [receipts] = await f.connection.query(
        "SELECT status,JSON_UNQUOTE(JSON_EXTRACT(proof,'$.code')) code,JSON_EXTRACT(proof,'$.noFinancialEffects') no_effects FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=? AND kind='order'",
        [input.operationId],
      );
      expect(receipts).toEqual([
        { status: 'rejected', code: 'ORDER_IMPORT_SCREENING_COUNTER_INVALID', no_effects: true },
      ]);
      const [orders] = await f.connection.query('SELECT id,created_at FROM orders');
      const [lines] = await f.connection.query('SELECT id,created_at FROM has_products');
      expect(orders).toEqual([{ id: '100', created_at: '2025-01-01 00:00:00' }]);
      expect(lines).toEqual([{ id: '100', created_at: '2025-01-01 00:00:00' }]);
      expect(await j.transaction((tx) => profile().releaseRejected(tx, input))).toMatchObject({
        phase: 'REJECTED',
      });
    },
    25000,
  );
  it('rolls back literal order, HP, screening markers and BOUND transition before signed rejection releases quota', async () => {
    const { input, j } = await prepare(),
      command = await j.dispatch(input, 'order');
    expect(run(command, false, 'late-failure')).toEqual({ recorded: true });
    const [rows] = await f.connection.query(
      'SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM has_products) AS line_count,(SELECT COUNT(*) FROM spiderman_screening_orders) AS marker_count,(SELECT COUNT(*) FROM pos_rewrite_import_financial_order_bindings) AS bindings_count',
    );
    expect(rows).toEqual([
      { orders_count: '0', line_count: '0', marker_count: '0', bindings_count: '0' },
    ]);
    expect(await j.transaction((tx) => profile().read(tx, input))).toMatchObject({
      phase: 'RESERVED',
      orderId: null,
    });
    const released = await j.transaction((tx) => profile().releaseRejected(tx, input));
    expect(released).toMatchObject({ phase: 'REJECTED', orderId: null, version: 2 });
    expect(await j.transaction((tx) => profile().releaseRejected(tx, input))).toEqual(released);
    expect(await j.transaction((tx) => profile().reserve(tx, input, false))).toEqual(released);
    const next = await prepare();
    expect(next.reservation?.phase).toBe('RESERVED');
  }, 25000);
  it('never expires an unknown reservation or accepts a forged negative proof as a quota release', async () => {
    const { input, j } = await prepare();
    await expect(j.transaction((tx) => profile().releaseRejected(tx, input))).rejects.toMatchObject(
      { code: 'ORDER_IMPORT_SCREENING_NO_EFFECTS_REQUIRED' },
    );
    const loaded = await j.transaction((tx) => j.load(tx, input));
    const proof = {
      contract: 'pos-legacy-order-import-source-v1',
      operationId: input.operationId,
      requestHash: loaded!.state.requestHash,
      namespace: loaded!.state.namespace,
      status: 'rejected',
      code: 'ORDER_IMPORT_SOURCE_REVIEW',
      noFinancialEffects: true,
    };
    await f.db
      .get('writer')
      .insert(financialImportSourceReceipts)
      .values({
        id: input.operationId + ':order',
        operationId: input.operationId,
        kind: 'order',
        requestHash: loaded!.state.requestHash,
        status: 'rejected',
        proof,
        proofHash: '0'.repeat(64),
        createdAt: financialClock,
      });
    await expect(j.transaction((tx) => profile().releaseRejected(tx, input))).rejects.toMatchObject(
      { code: 'ORDER_IMPORT_SCREENING_NO_EFFECTS_REQUIRED' },
    );
    const next = f.input(ticketPlan());
    await expect(j.reserve(next)).resolves.toMatchObject({
      admission: { code: 'ORDER_IMPORT_SCREENING_LIMIT' },
    });
    await f.db
      .get('writer')
      .update(financialImportSourceReceipts)
      .set({ proofHash: financialSourceHash(sourceKey, 'rejection', proof) })
      .where(eq(financialImportSourceReceipts.operationId, input.operationId));
    expect(await j.transaction((tx) => profile().releaseRejected(tx, input))).toMatchObject({
      phase: 'REJECTED',
    });
  });
  it('rejects a primed RR transaction; a cooperative writer waits for the customer and the next RC transaction sees its committed count', async () => {
    await f.fixture.insert('orders', { id: 100, user_id: 77, order_status: 4 });
    await f.fixture.insert('has_products', { id: 100, order_id: 100, prod_id: 390238, qty: 1 });
    await f.db.get('writer').transaction(async (tx) => {
      await tx.select({ id: Order.id }).from(Order).limit(1);
      await marker(100, 100);
      await expect(lockScreeningCustomer(tx, '77')).rejects.toMatchObject({
        code: 'ORDER_IMPORT_SCREENING_TRANSACTION_REQUIRED',
      });
      await expect(readScreeningTicketCount(tx, '77', quota!.options)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_SCREENING_TRANSACTION_REQUIRED',
      });
    });
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>((yes) => {
        entered = yes;
      }),
      gate = new Promise<void>((yes) => {
        release = yes;
      });
    const reader = journal().transaction(async (tx) => {
      await lockScreeningCustomer(tx, '77');
      expect(await readScreeningTicketCount(tx, '77', quota!.options)).toBe(1n);
      entered();
      await gate;
      expect(await readScreeningTicketCount(tx, '77', quota!.options)).toBe(1n);
    });
    await held;
    let finished = false;
    const writer = marker(100, 100).then(() => {
      finished = true;
    });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [rows] = await f.connection.query(
          "SELECT COUNT(*) n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME='users'",
        );
        if (
          z
            .array(z.object({ n: z.union([z.string(), z.number()]) }))
            .parse(rows)
            .some((row) => Number(row.n) > 0)
        ) {
          waiting = true;
          break;
        }
        await new Promise((yes) => setTimeout(yes, 10));
      }
      expect(waiting).toBe(true);
      expect(finished).toBe(false);
    } finally {
      release();
      await reader;
      await writer;
    }
    expect(await journal().transaction((tx) => countTickets(tx))).toBe(2n);
  });
  it.each([false, true])(
    'retains an exact financial completion seal and replays it without effects (unit=%s)',
    async (unitMode) => {
      const input = f.input(ticketPlan('shopify', 2)),
        j = journal(unitMode),
        transport = f.transport();
      let orderCalls = 0;
      let transportCode = 'NONE';
      transport.order = async (command) => {
        orderCalls++;
        try {
          expect(await j.transaction((tx) => profile().read(tx, input))).toMatchObject({
            phase: 'RESERVED',
            lineItemsEnabled: unitMode,
          });
          expect(run(command, unitMode)).toEqual({ recorded: true });
        } catch (error: unknown) {
          const parsed = z
            .object({ code: z.string().regex(/^ORDER_IMPORT_[A-Z_]+$/) })
            .safeParse(error);
          transportCode = parsed.success ? parsed.data.code : 'FIXTURE_TRANSPORT_FAILURE';
          throw error;
        }
      };
      transport.confirm = async () => {
        throw new Error('Shopify must not execute cash confirmation.');
      };
      const adapter = legacyOrderImportFinancialAdapter(
        f.config,
        f.db,
        f.options,
        transport,
        profiles(unitMode),
      );
      const result = await adapter.start(input);
      if (result.status !== 'completed') {
        throw new Error(
          'Screening completion fixture stopped at ' +
            (result.status === 'unknown' ? result.stage : 'rejected') +
            ':' +
            transportCode,
        );
      }
      const value = await j.transaction((tx) => profile().complete(tx, input));
      expect(value.phase).toBe('COUNTED');
      expect(value.completionHash).toMatch(/^[a-f0-9]{64}$/);
      expect(await j.transaction((tx) => profile().complete(tx, input))).toEqual(value);
      await screeningCounterMutation(
        f.db,
        {
          customerIds: ['77'],
          orderIds: [value.orderId!],
          lineIds: value.lines.map((row) => row.id),
        },
        async (tx) => {
          await tx.execute(
            sql`UPDATE orders SET order_status=4 WHERE id=${BigInt(value.orderId!)}`,
          );
          await tx.execute(
            sql`UPDATE has_products SET price=1 WHERE order_id=${BigInt(value.orderId!)}`,
          );
        },
      );
      expect(await j.transaction((tx) => profile().complete(tx, input))).toEqual(value);
      expect((await adapter.start(input)).status).toBe('completed');
      expect(orderCalls).toBe(1);
      expect(await j.transaction((tx) => countTickets(tx))).toBe(BigInt(unitMode ? 2 : 1));
    },
    25000,
  );
  it('does not expose flushed ticket markers before the source order, held binding and BOUND state commit together', async () => {
    const { input, j } = await prepare(2, true),
      command = await j.dispatch(input, 'order');
    const child = spawn(
      python,
      ['-B', resolve('tests/legacy-import-screening/native_source_driver.py')],
      {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, ...quota!.environment, PYTHONDONTWRITEBYTECODE: '1' },
      },
    );
    let output = '';
    const flushed = new Promise<void>((fulfill, reject) => {
      child.stdout.on('data', (value: Buffer) => {
        output += value.toString('utf8');
        if (output.includes('SOURCE_FLUSHED\n')) fulfill();
      });
      child.once('error', reject);
      child.once('exit', () => {
        if (!output.includes('SOURCE_FLUSHED\n'))
          reject(new Error('Screening flush barrier was not reached.'));
      });
    });
    const finished = new Promise<void>((fulfill, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? fulfill() : reject(new Error('Screening source fixture failed.')),
      );
    });
    void finished.catch(() => undefined);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdin.end(driverInput(command, true, 'visibility-barrier'));
    try {
      await flushed;
      const [before] = await f.connection.query(
        "SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM spiderman_screening_orders) AS marker_count,(SELECT COUNT(*) FROM pos_rewrite_import_financial_order_bindings) AS bindings_count,(SELECT JSON_UNQUOTE(JSON_EXTRACT(data,'$.phase')) FROM pos_rewrite_import_screening_reservations) AS phase",
      );
      expect(before).toEqual([
        { orders_count: '0', marker_count: '0', bindings_count: '0', phase: 'RESERVED' },
      ]);
      await finished;
      expect(JSON.parse(output.trim().split('\n').at(-1)!) as unknown).toEqual({ recorded: true });
      const [after] = await f.connection.query(
        "SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM spiderman_screening_orders) AS marker_count,(SELECT COUNT(*) FROM pos_rewrite_import_financial_order_bindings) AS bindings_count,(SELECT JSON_UNQUOTE(JSON_EXTRACT(data,'$.phase')) FROM pos_rewrite_import_screening_reservations) AS phase",
      );
      expect(after).toEqual([
        { orders_count: '1', marker_count: '2', bindings_count: '1', phase: 'BOUND' },
      ]);
    } finally {
      clearTimeout(timeout);
      child.kill();
    }
  }, 25000);
  it('keeps full-width order/HP identities exact and refuses mismatched or duplicate bound markers', async () => {
    await f.connection.query('ALTER TABLE orders AUTO_INCREMENT=9007199254740995');
    await f.connection.query('ALTER TABLE has_products AUTO_INCREMENT=9007199254740997');
    const { input, j } = await prepare(2, false, 'shopify'),
      command = await j.dispatch(input, 'order');
    expect(run(command, false)).toEqual({ recorded: true });
    const value = await j.transaction((tx) => profile().attachSourceReceipt(tx, input));
    expect(value.orderId).toBe('9007199254740995');
    expect(value.lines).toEqual([{ id: '9007199254740997', quantity: 2 }]);
    expect(await j.transaction((tx) => profile().bind(tx, input, value.orderId!))).toEqual(value);
    await expect(
      j.transaction((tx) => profile().bind(tx, input, '9007199254740996')),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_SCREENING_REPLAY_REQUIRED' });
    await marker(value.orderId!, value.lines[0]!.id);
    await expect(
      j.transaction((tx) => profile().bind(tx, input, value.orderId!)),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_SCREENING_STRUCTURE_CHANGED' });
  }, 25000);
  it('starts an ordinary import once without screening configuration or optional screening tables', async () => {
    await quota!.removeCounterWriters();
    await f.connection.query(
      'RENAME TABLE spiderman_screening_orders TO screening_source_off,pos_rewrite_import_screening_reservations TO screening_reservations_off',
    );
    try {
      const transport = f.transport(),
        order = vi.spyOn(transport, 'order'),
        adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport),
        input = f.input();
      const result = await adapter.start(input);
      expect(result.status).toBe('completed');
      expect(await adapter.start(input)).toEqual(result);
      expect(await adapter.read(input)).toEqual(result);
      expect(order).toHaveBeenCalledTimes(1);
    } finally {
      await f.connection.query(
        'RENAME TABLE screening_source_off TO spiderman_screening_orders,screening_reservations_off TO pos_rewrite_import_screening_reservations',
      );
    }
  });
  it('refuses unqualified screening before creating an operation or calling a source transport', async () => {
    const transport = sourceTransport(),
      adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport),
      input = f.input(ticketPlan('shopify'));
    await expect(adapter.start(input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_SCREENING_UNQUALIFIED',
    });
    await expect(
      journal().transaction((tx) => adapter.authorizeStart!(tx, input)),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_SCREENING_UNQUALIFIED' });
    expect(transport.order).not.toHaveBeenCalled();
    const [rows] = await f.connection.query(
      'SELECT (SELECT COUNT(*) FROM pos_rewrite_import_financial_operations) AS operations,(SELECT COUNT(*) FROM pos_rewrite_import_screening_reservations) AS reservations',
    );
    expect(rows).toEqual([{ operations: '0', reservations: '0' }]);
  });
  it('rolls back both the first operation and screening reservation when another qualified profile refuses admission', async () => {
    const transport = sourceTransport(),
      lifecycle = financialAdapterProfiles({
        screening: { profile: profile(), lineItemsEnabled: false },
        extensions: [
          {
            reserved: async () => {
              throw new Error('Isolated admission refusal.');
            },
          },
        ],
      }),
      adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport, lifecycle);
    await expect(adapter.start(f.input(ticketPlan('shopify')))).rejects.toThrow(
      'Isolated admission refusal.',
    );
    expect(transport.order).not.toHaveBeenCalled();
    const [rows] = await f.connection.query(
      'SELECT (SELECT COUNT(*) FROM pos_rewrite_import_financial_operations) AS operations,(SELECT COUNT(*) FROM pos_rewrite_import_financial_references) AS source_references,(SELECT COUNT(*) FROM pos_rewrite_import_screening_reservations) AS reservations',
    );
    expect(rows).toEqual([{ operations: '0', source_references: '0', reservations: '0' }]);
  });
  it('twenty simultaneous adapter starts dispatch one real source order and retain one screening completion', async () => {
    const transport = sourceTransport(),
      publish = vi.spyOn(transport, 'publication'),
      adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport, profiles()),
      input = f.input(ticketPlan('shopify'));
    const values = await Promise.all(Array.from({ length: 20 }, () => adapter.start(input)));
    expect(
      values.every((value) => value.status === 'unknown' || value.status === 'completed'),
    ).toBe(true);
    expect((await adapter.read(input))?.status).toBe('completed');
    expect(transport.order).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(transport.confirm).not.toHaveBeenCalled();
    expect(await journal().transaction((tx) => profile().read(tx, input))).toMatchObject({
      phase: 'COUNTED',
    });
    const [rows] = await f.connection.query(
      'SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM pos_rewrite_import_financial_operations) AS operations,(SELECT COUNT(*) FROM pos_rewrite_import_screening_reservations) AS reservations',
    );
    expect(rows).toEqual([{ orders_count: '1', operations: '1', reservations: '1' }]);
  }, 30000);
  it('lost source reply retains BOUND quota and exact GET recovery never resends the original order', async () => {
    const transport = sourceTransport(),
      original = transport.order,
      publish = vi.spyOn(transport, 'publication');
    transport.order = vi.fn(async (command) => {
      await original(command);
      throw new Error('Lost synthetic source response.');
    });
    const adapter = legacyOrderImportFinancialAdapter(
        f.config,
        f.db,
        f.options,
        transport,
        profiles(),
      ),
      input = f.input(ticketPlan('shopify'));
    const result = await adapter.start(input);
    expect(result).toMatchObject({ status: 'unknown', stage: 'order' });
    for (let count = 0; count < 3; count++) {
      expect(await adapter.read(input)).toEqual(result);
      expect(await adapter.start(input)).toEqual(result);
    }
    expect(transport.order).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(transport.confirm).not.toHaveBeenCalled();
    expect(await journal().transaction((tx) => profile().read(tx, input))).toMatchObject({
      phase: 'BOUND',
      sourceReceiptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  }, 25000);
  it('lost publication reply seals screening completion from the original durable proofs without republishing', async () => {
    const transport = sourceTransport(),
      original = transport.publication;
    transport.publication = vi.fn(async (...args: Parameters<typeof original>) => {
      await original(...args);
      throw new Error('Lost synthetic publication reply.');
    });
    const adapter = legacyOrderImportFinancialAdapter(
        f.config,
        f.db,
        f.options,
        transport,
        profiles(),
      ),
      input = f.input(ticketPlan('shopify'));
    expect((await adapter.start(input)).status).toBe('completed');
    expect((await adapter.read(input))?.status).toBe('completed');
    expect(transport.publication).toHaveBeenCalledTimes(1);
    expect(await journal().transaction((tx) => profile().read(tx, input))).toMatchObject({
      phase: 'COUNTED',
    });
  }, 25000);
  it('the actual queue and adapter retain a signed source rejection and release only that original reservation', async () => {
    const repository = legacyOrderImportRepository(f.db, {
        secret: runtimeImportSecret,
        now: () => financialClock,
      }),
      transport = sourceTransport(false, 'late-failure'),
      adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport, profiles()),
      input = shopifyInput();
    await repository.stage('1', 'screening-queue-fixture', input);
    const result = await repository.runOne(adapter);
    expect(result).toMatchObject({ state: 'FAILED' });
    const rows = await repository.results('1', input.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ state: 'FAILED', errorCode: 'ORDER_IMPORT_FIXTURE_LATE_FAILURE' });
    expect(await repository.runOne(adapter)).toBeNull();
    expect(transport.order).toHaveBeenCalledTimes(1);
    expect(transport.confirm).not.toHaveBeenCalled();
    expect(
      await journal().transaction((tx) =>
        profile().read(tx, {
          actorId: '1',
          storeId: '1',
          counterId: '2',
          operationId: row.operationId,
        }),
      ),
    ).toMatchObject({ phase: 'REJECTED' });
    const [native] = await f.connection.query(
      'SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM spiderman_screening_orders) AS markers',
    );
    expect(native).toEqual([{ orders_count: '0', markers: '0' }]);
  }, 25000);
  it('the actual queue completes screening and reconciles a lost original start response through GET only', async () => {
    let clock = financialClock;
    const repository = legacyOrderImportRepository(f.db, {
        secret: runtimeImportSecret,
        now: () => clock,
      }),
      transport = sourceTransport(),
      core = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport, profiles()),
      start = vi.fn(async (input: Parameters<typeof core.start>[0]) => {
        await core.start(input);
        throw new Error('Lost synthetic worker response.');
      }),
      read = vi.fn(core.read),
      adapter = { ...core, start, read },
      input = shopifyInput();
    await repository.stage('1', 'screening-queue-lost-reply', input);
    expect(await repository.runOne(adapter)).toMatchObject({ state: 'RECONCILING' });
    clock += 31000;
    expect(await repository.runOne(adapter)).toMatchObject({ state: 'IMPORTED' });
    expect(await repository.detail('1', input.id)).toMatchObject({
      state: 'COMPLETED',
      importedOrders: 1,
      failedOrders: 0,
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(transport.order).toHaveBeenCalledTimes(1);
    const rows = await repository.results('1', input.id),
      row = rows[0]!;
    expect(
      await journal().transaction((tx) =>
        profile().read(tx, {
          actorId: '1',
          storeId: '1',
          counterId: '2',
          operationId: row.operationId,
        }),
      ),
    ).toMatchObject({ phase: 'COUNTED', orderId: row.orderId });
  }, 25000);
  it('rolls back profile savepoint writes but retains one signed local denial and never renews its command', async () => {
    const transport = sourceTransport(),
      lifecycle = financialAdapterProfiles({
        screening: { profile: profile(), lineItemsEnabled: false },
        extensions: [
          {
            reserved: async () => {
              throw new FinancialImportAdmissionDenied('ORDER_IMPORT_SCREENING_CATALOG_REVIEW');
            },
          },
        ],
      }),
      adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport, lifecycle),
      input = f.input(ticketPlan('shopify'));
    const result = await adapter.start(input);
    expect(result).toEqual({
      status: 'rejected',
      operationId: input.operationId,
      code: 'ORDER_IMPORT_SCREENING_CATALOG_REVIEW',
    });
    const [stage] = await f.db
      .get('writer')
      .select()
      .from(financialImportStages)
      .where(eq(financialImportStages.operationId, input.operationId));
    const proof = nativeAdmissionRejectionSchema.parse(stage!.proof);
    expect(proof).toMatchObject({
      scope: { operationId: input.operationId },
      code: 'ORDER_IMPORT_SCREENING_CATALOG_REVIEW',
      noFinancialEffects: true,
    });
    expect(stage!.proofHash).toBe(
      financialImportHash(runtimeImportSecret, 'native-admission-rejection', proof),
    );
    expect(await f.db.get('writer').select().from(screeningReservations)).toHaveLength(0);
    expect(await adapter.start(input)).toEqual(result);
    expect(await adapter.read(input)).toEqual(result);
    const defaultAdapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport);
    expect(await defaultAdapter.start(input)).toEqual(result);
    expect(await defaultAdapter.read(input)).toEqual(result);
    const [current] = await f.db
      .get('writer')
      .select()
      .from(financialImportStages)
      .where(eq(financialImportStages.operationId, input.operationId));
    expect(current!.nonce).toBe(stage!.nonce);
    expect(transport.order).not.toHaveBeenCalled();
    const [native] = await f.connection.query(
      'SELECT (SELECT COUNT(*) FROM pos_rewrite_import_financial_operations) AS operations,(SELECT COUNT(*) FROM pos_rewrite_import_financial_source_receipts) AS source_receipts,(SELECT COUNT(*) FROM orders) AS orders_count',
    );
    expect(native).toEqual([{ operations: '1', source_receipts: '0', orders_count: '0' }]);
  });
  it('does not recast a driver failure carrying a denial-like message as a business rejection', async () => {
    await f.connection.query(
      "ALTER TABLE pos_rewrite_import_screening_reservations ADD CONSTRAINT ORDER_IMPORT_SCREENING_LIMIT CHECK (operation_id='fixture-native-driver-failure')",
    );
    try {
      const transport = sourceTransport(),
        adapter = legacyOrderImportFinancialAdapter(
          f.config,
          f.db,
          f.options,
          transport,
          profiles(),
        );
      await expect(adapter.start(f.input(ticketPlan('shopify')))).rejects.toThrow();
      expect(transport.order).not.toHaveBeenCalled();
      const [rows] = await f.connection.query(
        'SELECT (SELECT COUNT(*) FROM pos_rewrite_import_financial_operations) AS operations,(SELECT COUNT(*) FROM pos_rewrite_import_financial_stages) AS stages,(SELECT COUNT(*) FROM pos_rewrite_import_screening_reservations) AS reservations',
      );
      expect(rows).toEqual([{ operations: '0', stages: '0', reservations: '0' }]);
    } finally {
      await f.connection.query(
        'ALTER TABLE pos_rewrite_import_screening_reservations DROP CHECK ORDER_IMPORT_SCREENING_LIMIT',
      );
    }
  });
  it('rolls back the operation if its native denial proof cannot commit', async () => {
    await f.connection.query(
      "ALTER TABLE pos_rewrite_import_financial_stages ADD CONSTRAINT screening_denial_failure CHECK (operation_id='fixture-native-proof-failure')",
    );
    try {
      await f.fixture.insert('products_gs1', { id: 2, product_id: 390238, gtin: '8900000000002' });
      const transport = sourceTransport(),
        adapter = legacyOrderImportFinancialAdapter(
          f.config,
          f.db,
          f.options,
          transport,
          profiles(),
        );
      await expect(adapter.start(f.input(ticketPlan('shopify')))).rejects.toThrow();
      expect(transport.order).not.toHaveBeenCalled();
      const [rows] = await f.connection.query(
        'SELECT (SELECT COUNT(*) FROM pos_rewrite_import_financial_operations) AS operations,(SELECT COUNT(*) FROM pos_rewrite_import_financial_references) AS source_references,(SELECT COUNT(*) FROM pos_rewrite_import_financial_stages) AS stages',
      );
      expect(rows).toEqual([{ operations: '0', source_references: '0', stages: '0' }]);
    } finally {
      await f.connection.query(
        'ALTER TABLE pos_rewrite_import_financial_stages DROP CHECK screening_denial_failure',
      );
    }
  });
  it('rejects altered local denial seals/nonces and any contradictory later checkpoint before returning a no-effects result', async () => {
    await f.fixture.insert('products_gs1', { id: 2, product_id: 390238, gtin: '8900000000002' });
    const transport = sourceTransport(),
      adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport, profiles()),
      input = f.input(ticketPlan('shopify'));
    expect((await adapter.start(input)).status).toBe('rejected');
    const [stage] = await f.db
      .get('writer')
      .select()
      .from(financialImportStages)
      .where(eq(financialImportStages.operationId, input.operationId));
    await f.db
      .get('writer')
      .update(financialImportStages)
      .set({ proofHash: '0'.repeat(64) })
      .where(eq(financialImportStages.id, stage!.id));
    await expect(adapter.read(input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_ADMISSION_PROOF_INVALID',
    });
    await f.db
      .get('writer')
      .update(financialImportStages)
      .set({ proofHash: stage!.proofHash, nonce: randomUUID() })
      .where(eq(financialImportStages.id, stage!.id));
    await expect(adapter.start(input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_ADMISSION_PROOF_INVALID',
    });
    await f.db
      .get('writer')
      .update(financialImportStages)
      .set({ nonce: stage!.nonce })
      .where(eq(financialImportStages.id, stage!.id));
    await f.db
      .get('writer')
      .insert(financialImportStages)
      .values({
        id: input.operationId + ':order',
        operationId: input.operationId,
        kind: 'order',
        nonce: randomUUID(),
        status: 'dispatched',
        requestHash: 'a'.repeat(64),
        proofHash: null,
        proof: null,
        createdAt: financialClock,
        updatedAt: financialClock,
      });
    await expect(adapter.read(input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_ADMISSION_PROOF_INVALID',
    });
    expect(transport.order).not.toHaveBeenCalled();
  });
  it('queue recovery of a lost native-denial reply returns FAILED through GET without source calls or a new proof nonce', async () => {
    await f.fixture.insert('products_gs1', { id: 2, product_id: 390238, gtin: '8900000000002' });
    let clock = financialClock;
    const events: Array<{ stage: string; eventId: string; requestId: string; userId: string }> = [];
    const repository = legacyOrderImportRepository(f.db, {
        secret: runtimeImportSecret,
        now: () => clock,
      }),
      transport = sourceTransport(),
      core = legacyOrderImportFinancialAdapter(
        f.config,
        f.db,
        { ...f.options, observe: (event) => events.push(event) },
        transport,
        profiles(),
      ),
      start = vi.fn(async (value: Parameters<typeof core.start>[0]) => {
        await core.start(value);
        throw new Error('Lost synthetic denial reply.');
      }),
      read = vi.fn(core.read),
      adapter = { ...core, start, read },
      input = shopifyInput();
    await repository.stage('1', 'native-denial-lost-reply', input);
    expect(await repository.runOne(adapter)).toMatchObject({ state: 'RECONCILING' });
    const [before] = await f.db.get('writer').select().from(financialImportStages);
    clock += 31000;
    expect(await repository.runOne(adapter)).toMatchObject({ state: 'FAILED' });
    expect(await repository.detail('1', input.id)).toMatchObject({
      state: 'FAILED',
      importedOrders: 0,
      failedOrders: 1,
    });
    const [after] = await f.db.get('writer').select().from(financialImportStages);
    expect(after!.nonce).toBe(before!.nonce);
    expect(start).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(transport.order).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        eventId: 'legacy-order-imports.financial-imports.rejected',
        stage: 'preparation',
        requestId: 'native-denial-lost-reply',
        userId: '1',
      }),
    ]);
  });
  it('canonicalizes flat start inputs before sealing a dispatch scope', async () => {
    const { input, j } = await prepare(),
      command = await j.dispatch(input, 'order');
    const [stage] = await f.db
      .get('writer')
      .select()
      .from(financialImportStages)
      .where(eq(financialImportStages.operationId, input.operationId));
    expect(stage!.requestHash).toBe(
      financialImportHash(runtimeImportSecret, 'stage', {
        scope: command.state.scope,
        kind: 'order',
        requestHash: command.state.requestHash,
        nonce: command.nonce,
      }),
    );
    expect(Object.keys(command.state.scope).sort()).toEqual([
      'actorId',
      'counterId',
      'operationId',
      'storeId',
    ]);
  });
  it('waits for Store before taking the operation lock during a retained current read', async () => {
    const { input, j } = await prepare();
    await f.connection.beginTransaction();
    await f.connection.query('SELECT id FROM stores WHERE id=1 FOR UPDATE');
    const loading = j.transaction((tx) => j.load(tx, input));
    void loading.catch(() => undefined);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const [rows] = await f.connection.query(
          "SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='stores'",
          [new URL(f.config.MYSQL_WRITER_URL!).pathname.slice(1)],
        );
        waiting =
          BigInt(z.array(z.object({ n: z.union([z.string(), z.number()]) })).parse(rows)[0]!.n) >
          0n;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      // If load took operation first this NOWAIT probe would fail while it
      // waited for our Store. The probe itself changes no financial state.
      const [rows] = await f.connection.query(
        'SELECT id FROM pos_rewrite_import_financial_operations WHERE id=? FOR UPDATE NOWAIT',
        [input.operationId],
      );
      expect(z.array(z.object({ id: z.string() })).parse(rows)).toEqual([
        { id: input.operationId },
      ]);
    } finally {
      await f.connection.rollback();
      await loading;
    }
  }, 15000);
  it('does not lock a non-ticket Order while its wallet cancellation waits for this customer', async () => {
    await f.fixture.insert('orders', { id: 100, user_id: 77, order_status: 1 });
    await f.fixture.insert('has_products', { id: 100, order_id: 100, prod_id: 123, qty: 1 });
    let ready!: () => void, release!: () => void;
    const customerReady = new Promise<void>((resolve) => {
        ready = resolve;
      }),
      countGate = new Promise<void>((resolve) => {
        release = resolve;
      });
    await f.connection.beginTransaction();
    await f.connection.query('SELECT id FROM orders WHERE id=100 FOR UPDATE');
    const counter = financialTransaction(f.db, true, async (tx) => {
      await lockScreeningCustomer(tx, '77');
      ready();
      await countGate;
      return readScreeningTicketCount(tx, '77');
    });
    let wallet: Promise<unknown> | undefined;
    const observer = await createConnection(f.config.MYSQL_WRITER_URL!);
    try {
      await customerReady;
      wallet = f.connection.query('SELECT id FROM users WHERE id=77 FOR UPDATE');
      void wallet.catch(() => undefined);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const [rows] = await observer.query(
          "SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='users'",
          [new URL(f.config.MYSQL_WRITER_URL!).pathname.slice(1)],
        );
        waiting =
          BigInt(z.array(z.object({ n: z.union([z.string(), z.number()]) })).parse(rows)[0]!.n) >
          0n;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      release();
      expect(await counter).toBe(0n);
      await wallet;
    } finally {
      release();
      await Promise.allSettled([counter, wallet ?? Promise.resolve()]);
      await f.connection.rollback();
      await observer.end();
    }
  }, 15000);
  it('two empty marker ranges for different customers can count then insert without gap locks or retries', async () => {
    await f.fixture.insert('users', { id: 78, status: 1, is_block: 0, is_disabled: 0 });
    await quota!.initialize('78');
    for (const [id, customer] of [
      [100, 77],
      [101, 78],
    ] as const) {
      await f.fixture.insert('orders', { id, user_id: customer, order_status: 1 });
      await f.fixture.insert('has_products', { id, order_id: id, prod_id: 390238, qty: 1 });
    }
    let ready = 0,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const values = await Promise.all(
      (
        [
          [100, '77'],
          [101, '78'],
        ] as const
      ).map(([order, customer]) =>
        financialTransaction(f.db, true, async (tx) => {
          const id = String(customer);
          await lockScreeningCustomer(tx, id);
          expect(await readScreeningTicketCount(tx, id)).toBe(0n);
          if (++ready === 2) release();
          await gate;
          await withScreeningCounterWriter(
            tx,
            { customerId: id, orderIds: [String(order)], lineIds: [String(order)] },
            () =>
              tx.execute(
                sql`INSERT INTO spiderman_screening_orders(order_id,has_product_id,user_id) VALUES(${order},${order},${customer})`,
              ),
          );
          return readScreeningTicketCount(tx, id);
        }),
      ),
    );
    expect(values).toEqual([1n, 1n]);
  }, 15000);
  it('selected screening transactions do not hide a deadlock-shaped failure behind retries', async () => {
    let attempts = 0;
    const lifecycle = financialAdapterProfiles({
      screening: { profile: profile(), lineItemsEnabled: false },
      extensions: [
        {
          reserved: async () => {
            attempts++;
            throw new Error('Isolated lock failure', { cause: { code: 'ER_LOCK_DEADLOCK' } });
          },
        },
      ],
    });
    const adapter = legacyOrderImportFinancialAdapter(
      f.config,
      f.db,
      f.options,
      sourceTransport(),
      lifecycle,
    );
    await expect(adapter.start(f.input(ticketPlan('shopify')))).rejects.toThrow(
      'Isolated lock failure',
    );
    expect(attempts).toBe(1);
    const [rows] = await f.connection.query(
      'SELECT (SELECT COUNT(*) FROM pos_rewrite_import_financial_operations) AS operations,(SELECT COUNT(*) FROM pos_rewrite_import_screening_reservations) AS reservations',
    );
    expect(rows).toEqual([{ operations: '0', reservations: '0' }]);
  });
  it('two customers at different stores reach both literal source bodies before either receipt commits', async () => {
    await f.fixture.insert('users', {
      id: 78,
      email: 'other-import@example.test',
      firstname: 'Other',
      lastname: 'Fixture',
      status: 1,
      is_block: 0,
      is_disabled: 0,
    });
    await f.fixture.insert('stores', {
      id: 2,
      type: 'STORE',
      is_active: 1,
      city_id: 10,
      store_name: 'Other fixture',
      location_code: 'FIXTURE2',
      address: 'Fixture address',
      phone: '9000000000',
      pincode: '400001',
    });
    await f.fixture.insert('store_counters', { id: 3, store_id: 2, is_active: 1 });
    await f.fixture.insert('product_store', {
      id: 3,
      product_id: 390238,
      store_id: 2,
      stock: 100,
      is_avail: 1,
      is_del: 0,
    });
    await sourceFixture.insert('has_addresses', { id: 89, user_id: 78 });
    await quota!.initialize('78');
    const first = f.input(ticketPlan('shopify', 1)),
      second = f.input(ticketPlan('shopify', 1));
    second.storeId = '2';
    second.counterId = '3';
    second.plan.storeId = '2';
    second.plan.email = 'other-import@example.test';
    const { expectedFinancialPlanHash } =
      await import('../../src/modules/legacy-order-imports/financial-adapter-crypto.js');
    second.planHash = expectedFinancialPlanHash(runtimeImportSecret, second, second.plan);
    const j = journal();
    await j.reserve(first);
    await j.reserve(second);
    const commands = [await j.dispatch(first, 'order'), await j.dispatch(second, 'order')],
      directory = mkdtempSync(join(tmpdir(), 'pos-screening-source-race-')),
      gate = join(directory, 'release');
    function launch(command: FinancialSourceCommand) {
      const child = spawn(
        python,
        ['-B', resolve('tests/legacy-import-screening/native_source_driver.py')],
        {
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { ...process.env, ...quota!.environment, PYTHONDONTWRITEBYTECODE: '1' },
        },
      );
      let output = '';
      function failureCode() {
        try {
          const result: unknown = JSON.parse(output.trim().split('\n').at(-1)!);
          const parsed = z
            .object({
              code: z.string().regex(/^(?:ORDER_IMPORT_[A-Z_]+|SCREENING_NATIVE_FIXTURE_FAILED)$/),
            })
            .safeParse(result);
          return parsed.success ? parsed.data.code : 'SCREENING_NATIVE_FIXTURE_FAILED';
        } catch {
          return 'SCREENING_NATIVE_FIXTURE_FAILED';
        }
      }
      const ready = new Promise<void>((fulfill, reject) => {
        child.stdout.on('data', (value: Buffer) => {
          output += value.toString('utf8');
          if (output.includes('SCREENING_BODY_READY\n')) fulfill();
          if (output.length > 4000) child.kill('SIGKILL');
        });
        child.once('error', () => reject(new Error('Source race could not start.')));
        child.once('exit', () => {
          if (!output.includes('SCREENING_BODY_READY\n'))
            reject(new Error('Source did not reach its body barrier: ' + failureCode()));
        });
      });
      const finished = new Promise<void>((fulfill, reject) => {
        child.once('error', () => reject(new Error('Source race could not start.')));
        child.once('exit', (code) =>
          code === 0 ? fulfill() : reject(new Error('Source race did not finish.')),
        );
      });
      void finished.catch(() => undefined);
      const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
      const payload = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(driverInput(command, false, 'screening-race')) as unknown);
      child.stdin.end(JSON.stringify({ ...payload, gate }));
      return {
        child,
        ready,
        finished,
        result: () => JSON.parse(output.trim().split('\n').at(-1)!) as unknown,
        close: () => clearTimeout(timeout),
      };
    }
    const children = commands.map(launch);
    try {
      try {
        await Promise.all(children.map((child) => child.ready));
      } catch {
        const [rows] = await f.connection.query(
          "SELECT JSON_UNQUOTE(JSON_EXTRACT(proof,'$.code')) AS code FROM pos_rewrite_import_financial_source_receipts WHERE kind='order' ORDER BY operation_id",
        );
        const failures = z
          .array(
            z.object({
              code: z
                .string()
                .regex(/^ORDER_IMPORT_[A-Z0-9_]+$/)
                .nullable(),
            }),
          )
          .parse(rows);
        throw new Error('Source barrier failed: ' + failures.map((row) => row.code).join(','));
      }
      const [before] = await f.connection.query(
        'SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM spiderman_screening_orders) AS markers,(SELECT COUNT(*) FROM pos_rewrite_import_financial_source_receipts) AS receipts',
      );
      expect(before).toEqual([{ orders_count: '0', markers: '0', receipts: '0' }]);
      writeFileSync(gate, 'release');
      await Promise.all(children.map((child) => child.finished));
      for (const child of children) expect(child.result()).toEqual({ recorded: true });
      const [receipts] = await f.connection.query(
        "SELECT status,JSON_UNQUOTE(JSON_EXTRACT(proof,'$.code')) AS code FROM pos_rewrite_import_financial_source_receipts WHERE kind='order' ORDER BY operation_id",
      );
      expect(receipts).toEqual([
        { status: 'completed', code: null },
        { status: 'completed', code: null },
      ]);
      for (const input of [first, second])
        expect(await j.transaction((tx) => profile().attachSourceReceipt(tx, input))).toMatchObject(
          { phase: 'BOUND', markerRows: 1 },
        );
      const [after] = await f.connection.query(
        'SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM spiderman_screening_orders) AS markers,(SELECT COUNT(*) FROM pos_rewrite_import_financial_source_receipts) AS receipts',
      );
      expect(after).toEqual([{ orders_count: '2', markers: '2', receipts: '2' }]);
    } finally {
      writeFileSync(gate, 'release');
      for (const child of children) {
        child.close();
        child.child.kill();
      }
      await Promise.allSettled(children.map((child) => child.finished));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
  it('uses the verified customer index first and preserves SQL NULL exclusion without joined locks', async () => {
    // Historical anomalous rows predate maintainer installation.
    await quota!.close();
    quota = undefined;
    f.db = rootDb;
    await f.fixture.insert('orders', { id: 100, user_id: 77, order_status: 1 });
    await f.fixture.insert('has_products', { id: 100, order_id: 100, prod_id: 390238, qty: 2 });
    await f.connection.query(
      'INSERT INTO spiderman_screening_orders(order_id,has_product_id,user_id) VALUES(100,100,77),(100,100,78)',
    );
    quota = await installImportCounterFixture(f.connection, template!);
    await quota.initialize('77');
    f.db = quota.appDb;
    const [rows] = await f.db
      .get('writer')
      .execute(sql`EXPLAIN FORMAT=JSON ${screeningCountStatement('77')}`);
    const values = z.array(z.record(z.string(), z.unknown())).parse(rows),
      raw = values[0]?.EXPLAIN;
    const plan: unknown = JSON.parse(z.string().parse(raw));
    const tables: Array<{ name: string; key: string }> = [];
    function visit(value: unknown) {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      const record = value as Record<string, unknown>;
      if (typeof record.table_name === 'string' && typeof record.key === 'string')
        tables.push({ name: record.table_name, key: record.key });
      for (const item of Object.values(record)) visit(item);
    }
    visit(plan);
    expect(tables).toEqual([
      { name: 's', key: 'idx_user_id' },
      { name: 'o', key: 'PRIMARY' },
      { name: 'hp', key: 'PRIMARY' },
    ]);
    expect(await journal().transaction((tx) => countTickets(tx))).toBe(1n);
    const [nulls] = await f.connection.query(
      'SELECT COUNT(*) AS n FROM (SELECT NULL AS status UNION ALL SELECT 0 UNION ALL SELECT 17 UNION ALL SELECT 4) statuses WHERE status NOT IN (0,17)',
    );
    expect(nulls).toEqual([{ n: '1' }]);
  });
  it.each(['operator', 'epoch', 'customer'] as const)(
    'rechecks %s authority after dispatch and preserves only a source no-effects rejection',
    async (changed) => {
      const { input, j } = await prepare(1, false, 'shopify'),
        command = await j.dispatch(input, 'order');
      if (changed === 'operator')
        await f.connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
      else if (changed === 'epoch')
        await f.connection.query(
          'INSERT INTO pos_rewrite_operator_auth_epochs(operator_id,epoch) VALUES(1,1)',
        );
      else await f.connection.query('UPDATE users SET is_block=1 WHERE id=77');
      expect(run(command, false)).toEqual({ recorded: true });
      const [receipts] = await f.connection.query(
        "SELECT status,JSON_UNQUOTE(JSON_EXTRACT(proof,'$.code')) AS code,JSON_EXTRACT(proof,'$.noFinancialEffects') AS no_effects FROM pos_rewrite_import_financial_source_receipts WHERE operation_id=? AND kind='order'",
        [input.operationId],
      );
      expect(receipts).toEqual([
        { status: 'rejected', code: 'ORDER_IMPORT_AUTHORITY_CHANGED', no_effects: true },
      ]);
      const [counts] = await f.connection.query(
        'SELECT (SELECT COUNT(*) FROM orders) AS orders_count,(SELECT COUNT(*) FROM has_products) AS line_count,(SELECT COUNT(*) FROM spiderman_screening_orders) AS markers,(SELECT COUNT(*) FROM pos_rewrite_import_financial_order_bindings) AS bindings',
      );
      expect(counts).toEqual([{ orders_count: '0', line_count: '0', markers: '0', bindings: '0' }]);
      // Archived/revoked authority cannot create work, but the original sealed
      // negative receipt still permits immutable reconciliation/quota release.
      expect(await j.transaction((tx) => profile().releaseRejected(tx, input))).toMatchObject({
        phase: 'REJECTED',
        orderId: null,
      });
    },
    25000,
  );
});
