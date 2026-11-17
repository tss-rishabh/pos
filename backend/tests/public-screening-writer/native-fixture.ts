import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitMigration } from '../../src/db/migrations.js';
import { checkoutStateSchema } from '../../src/modules/checkout/contracts.js';
import { readCustomerContactBinding } from '../../src/modules/checkout/customer-contact-authority.js';
import { contactActorVersion } from '../../src/modules/customer-contacts/authority.js';
import { screeningReservationDdl } from '../../src/modules/legacy-order-imports/screening-profile.js';
import {
  signNodeScreeningWriter,
  nodeScreeningWriterContract,
} from '../../src/modules/checkout/screening-writer/capability.js';
import { publicScreeningHash } from '../../src/modules/checkout/screening-writer/proof.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  importFinancialFixture,
  sourceKey,
  financialClock,
} from '../legacy-import-financial/fixture.js';

export const python = resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
  driver = resolve('tests/public-screening-writer/native_source_driver.py'),
  sourceRoot =
    process.env.POS_LEGACY_IMPORT_SOURCE_ROOT ??
    process.env.SCREENING_SOURCE_ROOT ??
    resolve('../../backend-tss-api_v2'),
  environment = {
    screeningWriterContract: nodeScreeningWriterContract,
    customerContextContract: 'pos-customer-context-v1',
    customerContextKey: 'isolated-public-node-screening-purpose-'.repeat(3),
  };
export async function publicScreeningFixture(template: string) {
  const f = await importFinancialFixture(template),
    extra = [
      'cities',
      'zones',
      'pricelist',
      'pricelist_meta',
      'has_categories',
      'has_addresses',
      'order_address_mapping',
      'flag_history',
      'order_cancel_message_mapping',
      'spiderman_screening_orders',
      'products_gs1',
      'order_tss_money',
      'order_tss_point',
      'gift_voucher_history',
      'referral_log',
      'tss_money_history',
      'tss_point_history',
      'reward_point_history',
    ];
  const fixture = verifiedMysqlFixture(f.connection, [
    'evidence/mysql-order-import-address-schema.json',
    'evidence/mysql-screening-schema.json',
    'evidence/mysql-pending-cancellation-benefits-schema.json',
    'evidence/mysql-global-benefits-schema.json',
    'evidence/mysql-import-referral-schema.json',
  ]);
  await fixture.create(extra);
  await f.connection.query(
    'ALTER TABLE referral_log ADD UNIQUE KEY unique_refer_pair(referred_to,referred_by)',
  );
  for (const path of [
    'src/modules/checkout/migrations/0002_checkout.sql',
    'src/modules/checkout/migrations/0008_checkout_draft_binding.sql',
    'src/modules/checkout/migrations/0011_offline_cash.sql',
    'src/modules/checkout/cancellations/benefit-migration.sql',
    'src/modules/checkout/cancellations/membership-producer-migration.sql',
    'compatibility/upstream/public-screening-writer/migration.review.sql',
    'src/modules/checkout/screening-writer/negative-migration.sql',
    'src/modules/checkout/screening-writer/migration.sql',
  ])
    for (const statement of splitMigration(readFileSync(path, 'utf8')))
      await f.connection.query(statement);
  await f.connection.query(screeningReservationDdl);
  // Exact verified writer index. Without it the index-free generic fixture's
  // locking lookup scans and locks another store's stock rows.
  await f.connection.query(
    'CREATE UNIQUE INDEX uq_product_store ON product_store(product_id,store_id)',
  );
  await f.connection.query(
    'CREATE TABLE pos_rewrite_operator_checkins(operator_id VARCHAR(32) PRIMARY KEY,store_id BIGINT UNSIGNED NOT NULL,counter_id BIGINT UNSIGNED NULL,expires_at DATETIME(3) NOT NULL,checked_in_at DATETIME(3) NOT NULL)',
  );
  for (const [table, index, column] of [
    ['spiderman_screening_orders', 'idx_user_id', 'user_id'],
    ['spiderman_screening_orders', 'idx_order_id', 'order_id'],
    ['spiderman_screening_orders', 'idx_has_product_id', 'has_product_id'],
    ['has_products', 'order_id', 'order_id'],
    ['order_stores', 'order', 'order_id'],
  ] as const)
    await f.connection.query('CREATE INDEX `' + index + '` ON `' + table + '`(`' + column + '`)');
  async function reset() {
    for (const table of [
      'pos_rewrite_public_screening_abandonments',
      'pos_rewrite_public_screening_negatives',
      'pos_rewrite_public_screening_work',
      'pos_rewrite_public_screening_submission_dispatches',
      'pos_rewrite_public_screening_payment_evidence',
      'pos_rewrite_public_screening_publication_dispatches',
      'pos_rewrite_public_screening_publication_replies',
      'pos_rewrite_public_screening_completions',
      'pos_rewrite_public_screening_effects',
      'pos_rewrite_public_screening_orders',
      'pos_rewrite_import_screening_reservations',
      'pos_rewrite_operator_checkins',
      'pos_rewrite_checkout_operations',
      'pos_rewrite_checkout_sessions',
      'pos_rewrite_customer_cart_leases',
      'pos_rewrite_cancellation_membership_provenance',
      'pos_rewrite_membership_versions',
      'pos_rewrite_offline_cash_receipts',
      'pos_rewrite_offline_cash_order_links',
      ...extra,
    ])
      await f.connection.query('DELETE FROM `' + table + '`');
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
    await fixture.insert('cities', { id: 10, city_name: 'Fixture city', state_id: 20 });
    await fixture.insert('zones', { id: 20, name: 'Fixture state' });
    await f.connection.query(
      "UPDATE stores SET city_id=10,store_name='Fixture',address='Road',alt_address='',phone='9000000000',pincode='400001' WHERE id=1",
    );
    await f.connection.query(
      "UPDATE users SET firstname='Fixture',lastname='Customer',cashback=0,tss_money=0,tss_points=0 WHERE id=77",
    );
    await fixture.insert('has_addresses', { id: 88, user_id: 77 });
    await fixture.insert('pricelist_meta', { id: 1, is_active: 1 });
    await f.connection.query(
      "INSERT INTO pos_rewrite_operator_checkins VALUES('1',1,2,'2099-06-15 23:59:59','2026-06-15 00:00:00')",
    );
  }
  async function prepare(
    quantity = 2,
    unitMode = false,
    scope = { actorId: '1', customerId: '77', storeId: '1', counterId: '2' },
    journaled = true,
  ) {
    const lines = [{ productId: '390238', quantity, unitPrice: '25.00' }],
      quote = JSON.parse(
        execFileSync(python, ['-B', driver], {
          input: JSON.stringify({ action: 'quote', lines }),
          encoding: 'utf8',
          timeout: 10000,
        }),
      ) as unknown,
      operationId = randomUUID(),
      state = checkoutStateSchema.parse({
        id: randomUUID(),
        operatorId: scope.actorId,
        operatorCustomerId: '88',
        storeId: scope.storeId,
        counterId: scope.counterId,
        tabId: 1,
        customerId: scope.customerId,
        verifiedCustomerUntil: null,
        version: 2,
        phase: 'quoted',
        cart: quote,
        quote,
        orderId: null,
        paymentConfirmation: null,
        salespersonId: null,
        lineSalespersons: {},
        giftCards: {},
        busyOperationId: operationId,
        screeningAdmission: { operationId, status: 'pending' },
        draftId: randomUUID(),
        draftVersion: 12,
        draftImport: {
          lineItems: [{ productId: '390238', quantity }],
          completedProductIds: ['390238'],
          status: 'complete',
        },
        createdAt: financialClock,
        updatedAt: financialClock,
      }),
      payload = {
        is_pos: true,
        store_id: Number(scope.storeId),
        counter_id: Number(scope.counterId),
        admin_user_id: 88,
        payment_method: 'coc',
        id: 14,
      },
      contact = await f.db
        .get('writer')
        .transaction((tx) => readCustomerContactBinding(tx, scope.customerId)),
      actorVersion = await f.db
        .get('writer')
        .transaction((tx) => contactActorVersion(tx, scope.actorId)),
      signed = signNodeScreeningWriter(environment, {
        state,
        operationId,
        actorVersion,
        actorEpoch: '0',
        contact,
        payload,
        now: financialClock,
      });
    await f.connection.execute(
      'INSERT INTO pos_rewrite_checkout_sessions(id,operator_id,store_id,version,state) VALUES(?,?,?,?,?)',
      [state.id, scope.actorId, scope.storeId, state.version, JSON.stringify(state)],
    );
    await f.connection.execute(
      "INSERT INTO pos_rewrite_checkout_operations(checkout_id,id,status,request_hash) VALUES(?,?,'inflight',?)",
      [state.id, operationId, 'a'.repeat(64)],
    );
    await f.connection.execute(
      'INSERT INTO pos_rewrite_customer_cart_leases VALUES(?,?,?) ON DUPLICATE KEY UPDATE checkout_id=VALUES(checkout_id),expires_at_ms=VALUES(expires_at_ms)',
      [scope.customerId, state.id, financialClock + 300000],
    );
    if (journaled) {
      await f.connection.execute(
        "INSERT INTO pos_rewrite_public_screening_work(operation_id,checkout_id,actor_id,store_id,data,proof_hash,status,next_check_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'awaiting-source',?,?,?)",
        [
          operationId,
          state.id,
          scope.actorId,
          scope.storeId,
          JSON.stringify(signed.value),
          publicScreeningHash(sourceKey, 'intent', signed.value),
          financialClock + 15000,
          financialClock,
          financialClock,
        ],
      );
      const dispatch = {
        contract: 'pos-node-screening-submission-dispatch-v1',
        operationId,
        requestHash: signed.value.requestHash,
        dispatchedAt: financialClock,
      };
      await f.connection.execute(
        'INSERT INTO pos_rewrite_public_screening_submission_dispatches VALUES(?,?,?)',
        [
          operationId,
          JSON.stringify(dispatch),
          publicScreeningHash(sourceKey, 'submission-dispatch', dispatch),
        ],
      );
    }
    return {
      state,
      signed,
      value: {
        url: f.config.MYSQL_WRITER_URL,
        sourceRoot,
        key: environment.customerContextKey,
        proofKey: sourceKey,
        now: financialClock,
        lines,
        unitMode,
        header: signed.header,
        payload,
      },
    };
  }
  return { ...f, sourceFixture: fixture, reset, prepare };
}
export function run(value: unknown): unknown {
  return JSON.parse(
    execFileSync(python, ['-B', driver], {
      input: JSON.stringify(value),
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 64000,
    }),
  ) as unknown;
}
export function runAsync(value: unknown) {
  const child = spawn(python, ['-B', driver], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '',
    readyResolve: () => void,
    readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const completed = new Promise<unknown>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('PUBLIC_BODY_READY\n')) readyResolve();
      if (output.length > 64000) {
        child.kill();
        reject(new Error('Fixture output bound exceeded'));
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = output.trim().split('\n').at(-1);
      if (code !== 0 || !line) {
        const error = new Error('Native source child failed');
        readyReject(error);
        reject(error);
        return;
      }
      try {
        const value = JSON.parse(line) as unknown;
        if (!output.includes('PUBLIC_BODY_READY\n'))
          readyReject(new Error('Source body never reached its barrier'));
        resolve(value);
      } catch {
        reject(new Error('Invalid native fixture result'));
      }
    });
  });
  void ready.catch(() => {});
  void completed.catch(() => {});
  child.stdin.end(JSON.stringify(value));
  return { ready, completed, stop: () => child.kill() };
}
