import { splitMigration } from '../../src/db/migrations.js';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import mysql from 'mysql2/promise';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { availableStockProjection } from '../../src/db/stock-projection/service.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { cashDigest, offlineCashSigner } from '../../src/modules/checkout/offline-cash/crypto.js';
import {
  cashPriceSnapshotSchema,
  devicePublicKeySchema,
  signedCashAuthorizationSchema,
  signedCashReceiptSchema,
} from '../../src/modules/checkout/offline-cash/contracts.js';
import { cashSourceTemplateSchema } from '../../src/modules/checkout/offline-cash/template.js';
import {
  cashOrderSchemaContract,
  type CashImportWriterOptions,
} from '../../src/modules/checkout/offline-cash/writer.js';
import { offlineCashRepository } from '../../src/modules/checkout/offline-cash/repository.js';
import {
  offlineCashAuthorizations,
  offlineCashDevices,
  offlineCashReceipts,
  offlineCashReceiptLines,
  offlineCashSigningKeys,
} from '../../src/modules/checkout/offline-cash/schema.js';
import { administrationOutbox } from '../../src/modules/administration/schema.js';
import { paymentOutbox, paymentAttempts } from '../../src/modules/checkout/payments/schema.js';
import { paymentRepository } from '../../src/modules/checkout/payments/repository.js';
import { paymentService } from '../../src/modules/checkout/payments/service.js';
import { signingEnvironment } from './fixtures.js';
import type { Principal } from '../../src/domain/access.js';

const fixtureSchema = z
  .object({
    template: cashSourceTemplateSchema,
    envelope: signedCashReceiptSchema,
    authorization: signedCashAuthorizationSchema,
    snapshot: cashPriceSnapshotSchema,
    serverKey: devicePublicKeySchema,
    deviceKey: devicePublicKeySchema,
  })
  .strict();
const legacyTables = [
  'users',
  'gift_vouchers',
  'orders',
  'has_products',
  'order_stores',
  'order_status',
  'stores',
  'product_store',
  'products',
  'product_stocks',
  'product_inventory_logs',
  'pos_inventory_sync_log',
  'pos_product_inventory_logs',
  'products_inventory_logs',
  'comments',
  'pos_transaction_logs',
  'flag_history',
  'amount_to_be_refunded_log',
  'order_cancel_message_mapping',
  'pos_user',
  'user_stores',
] as const;
const integration = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!integration)(
  'atomic source-authorized offline cash import in strict MySQL',
  () => {
    let connection: mysql.Connection,
      db: Databases,
      schemaName = '',
      config: ReturnType<typeof readConfig>,
      source: z.infer<typeof fixtureSchema>,
      repository: ReturnType<typeof offlineCashRepository>,
      writer: CashImportWriterOptions;
    const manager: Principal = {
      id: '8',
      role: 4,
      userType: 1,
      name: 'Fixture manager',
      email: 'fixture@example.test',
      storeIds: ['1'],
    };
    async function rows(query: string, values: (string | number)[] = []) {
      const result = (await connection.execute<mysql.RowDataPacket[]>(query, values))[0];
      for (const row of result) if (typeof row.count === 'string') row.count = Number(row.count);
      return result;
    }
    async function create(table: MySqlTable) {
      const metadata = getTableConfig(table);
      const definitions = metadata.columns.map(
        (column) =>
          `${mysql.escapeId(column.name)} ${column.getSQLType()}${column.notNull ? ' NOT NULL' : ''}${'autoIncrement' in column && column.autoIncrement ? ' AUTO_INCREMENT' : ''}`,
      );
      const keys = metadata.columns
        .filter((column) => column.primary)
        .map((column) => mysql.escapeId(column.name));
      if (keys.length) definitions.push(`PRIMARY KEY(${keys.join(',')})`);
      await connection.query(
        `CREATE TABLE ${mysql.escapeId(metadata.name)} (${definitions.join(',')}) ENGINE=InnoDB`,
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
        throw new Error('Cash import checks refuse nonisolated database URLs.');
      connection = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
      schemaName = `pos_rewrite_checkout_test_import_${process.pid}_${randomUUID().slice(0, 8)}`;
      await connection.query(`CREATE DATABASE ${mysql.escapeId(schemaName)}`);
      await connection.changeUser({ database: schemaName });
      await verifiedMysqlFixture(connection, ['evidence/mysql-global-benefits-schema.json']).create(
        legacyTables,
      );
      // Generic financial writers require the imported-order hold control tables.
      for (const statement of splitMigration(
        readFileSync('src/modules/legacy-order-imports/financial-proof-migration.sql', 'utf8'),
      ))
        await connection.query(statement);
      for (const name of [
        '0009_checkout_projection_proof.sql',
        '0011_offline_cash.sql',
        '0012_offline_cash_receipt_identity.sql',
        '0013_offline_cash_import_proof.sql',
        '0015_gift_card_issuance.sql',
        '0017_customer_consent_proof.sql',
      ])
        for (const statement of readFileSync('src/modules/checkout/migrations/' + name, 'utf8')
          .split(';')
          .filter((statement) => statement.trim()))
          await connection.query(statement);
      await create(administrationOutbox);
      await create(paymentOutbox);
      await create(paymentAttempts);
      for (const statement of readFileSync(
        'src/modules/checkout/cancellations/migration.sql',
        'utf8',
      )
        .split(';')
        .filter((value) => value.trim()))
        await connection.query(statement);
      url.pathname = '/' + schemaName;
      config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'offline-import-fixture-'.repeat(4),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
      });
      db = createDatabases(config);
    });
    beforeEach(async (context) => {
      const [tables] = await connection.query<mysql.RowDataPacket[]>('SHOW TABLES');
      for (const row of tables)
        await connection.query(`DELETE FROM ${mysql.escapeId(String(Object.values(row)[0]))}`);
      await connection.query('ALTER TABLE orders AUTO_INCREMENT=9007199254740993');
      for (const statement of readFileSync(
        'compatibility/upstream/offline-cash-import/001_unset_event_dates.sql',
        'utf8',
      )
        .split(';')
        .filter((statement) => statement.trim()))
        await connection.query(statement);
      source = fixtureSchema.parse(
        JSON.parse(
          execFileSync(
            'uv',
            [
              'run',
              '--project',
              'compatibility/upstream/offline-cash-pricing',
              '--frozen',
              'python',
              'tools/checkout/offline_import_fixture.py',
              ...(context.task.name.includes('duplicate-SKU remainder')
                ? ['--remainder-basket']
                : []),
            ],
            {
              encoding: 'utf8',
              timeout: 30000,
              env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                UV_PROJECT_ENVIRONMENT: join(tmpdir(), 'pos-offline-pricing-runtime'),
                PYTHONDONTWRITEBYTECODE: '1',
              },
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          ),
        ) as unknown,
      );
      const fixture = verifiedMysqlFixture(connection);
      await fixture.insert('pos_user', {
        id: manager.id,
        role: manager.role,
        user_type: manager.userType,
        is_active: 1,
      });
      await fixture.insert('user_stores', { id: 1, django_user_id: manager.id, store_id: 1 });
      await fixture.insert('stores', {
        id: 1,
        location_code: 'FIXTURE',
        store_name: 'Fixture store',
        ecom_delivery: 1,
        ecom_threshold: 0,
      });
      await fixture.insert('order_status', { id: 3, order_status: 'DELIVERED' });
      for (const line of source.envelope.receipt.lines) {
        await fixture.insert('products', { id: line.productId, parent_prod_id: 0, prod_type: 1 });
        await fixture.insert('product_store', {
          product_id: line.productId,
          store_id: 1,
          stock: 10,
          is_avail: 1,
          is_del: 0,
        });
        await fixture.insert('product_stocks', {
          prod_id: line.productId,
          parent_prod_id: 0,
          stock: 10,
          stocked: 0,
        });
      }
      const tx = db.get('writer'),
        grant = source.authorization.authorization,
        receipt = source.envelope.receipt;
      await fixture.insert('users', { id: grant.operatorCustomerId, status: 1, is_block: null });
      await tx.insert(offlineCashSigningKeys).values({
        keyId: source.authorization.keyId,
        publicKey: JSON.stringify(source.serverKey),
        createdAt: grant.issuedAt,
      });
      await tx.insert(offlineCashDevices).values({
        id: grant.deviceId,
        operatorId: grant.operatorId,
        storeId: '1',
        counterId: '2',
        publicKey: JSON.stringify(source.deviceKey),
        keyHash: grant.deviceKeyHash,
        createdAt: grant.issuedAt,
      });
      await tx.insert(offlineCashAuthorizations).values({
        id: grant.id,
        deviceId: grant.deviceId,
        operatorId: grant.operatorId,
        storeId: '1',
        counterId: '2',
        businessDate: grant.businessDate,
        envelope: JSON.stringify(source.authorization),
        snapshot: JSON.stringify(source.snapshot),
        snapshotHash: grant.snapshotHash,
        acceptedReceipts: 1,
        acceptedCents: receipt.payableCents,
        createdAt: grant.issuedAt,
      });
      await tx.insert(offlineCashReceipts).values({
        id: receipt.id,
        authorizationId: grant.id,
        deviceId: grant.deviceId,
        sequence: receipt.sequence,
        operatorId: grant.operatorId,
        storeId: '1',
        counterId: '2',
        draftId: receipt.draftId,
        businessDate: receipt.businessDate,
        completedAt: receipt.completedAt,
        acceptedAt: receipt.completedAt + 1000,
        receiptNumber: receipt.receiptNumber,
        requestHash: cashDigest(source.envelope),
        envelope: JSON.stringify(source.envelope),
        payableCents: receipt.payableCents,
        cashReceivedCents: receipt.cashReceivedCents,
        changeCents: receipt.changeCents,
        status: 'accepted',
        conflicts: '[]',
        version: 1,
      });
      await tx.insert(offlineCashReceiptLines).values(
        receipt.lines.map((line) => ({
          receiptId: receipt.id,
          storeId: '1',
          productId: line.productId,
          quantity: line.quantity,
        })),
      );
      repository = offlineCashRepository(db, config, {
        verifyAuthorization: () => false,
        assertCheckIn: async () => {},
        currentRole: async (_tx, user) => user.role,
        assertStoreAccess: async () => {},
        authenticationVersion: async () => grant.operatorAuthVersion,
        operatorCustomer: async () => grant.operatorCustomerId,
        clock: () => receipt.completedAt + 10000,
        sourceImportReady: true,
      });
      writer = {
        stockProcedure: availableStockProjection(config.BUSINESS_TIMEZONE),
        stockContract: 'pos-stock-projection-70b801-v1',
        orderSchemaContract: cashOrderSchemaContract,
        signer: offlineCashSigner(
          generateKeyPairSync('ed25519')
            .privateKey.export({ format: 'pem', type: 'pkcs8' })
            .toString(),
        ),
        finalizedAt: receipt.completedAt + 10000,
        requestId: 'fixture-import-request',
        actorId: manager.id,
      };
    });
    afterAll(async () => {
      await db?.close();
      if (connection) {
        if (/^pos_rewrite_checkout_test_import_\d+_[a-f0-9]{8}$/.test(schemaName))
          await connection.query(`DROP DATABASE ${mysql.escapeId(schemaName)}`);
        await connection.end();
      }
    });
    async function approved() {
      const receiptId = source.envelope.receipt.id;
      const first = await repository.importOrder(
        manager,
        '1',
        receiptId,
        { operationId: randomUUID(), expectedVersion: 1 },
        source.template,
        writer,
      );
      expect(first).toMatchObject({
        status: 'conflicted',
        version: 2,
        conflicts: ['price-changed'],
        orderId: null,
      });
      const approvalId = randomUUID();
      const approval = await repository.approveImport(manager, '1', receiptId, {
        operationId: approvalId,
        expectedVersion: 2,
        reason: 'Honor the immutable source price after receiving cash; stock physically checked.',
      });
      return {
        receiptId,
        input: { operationId: randomUUID(), expectedVersion: approval.version, approvalId },
      };
    }
    it('imports20 concurrent lost-response retries once with exact source rows, cash, stock, ledger, invoice and sealed proof', async () => {
      const { receiptId, input } = await approved();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          repository.importOrder(manager, '1', receiptId, input, source.template, writer),
        ),
      );
      expect(new Set(results.map((result) => result.orderId)).size).toBe(1);
      expect(results[0]).toMatchObject({
        status: 'imported',
        orderId: '9007199254740993',
        importedAt: writer.finalizedAt,
        payableCents: source.envelope.receipt.payableCents,
        cashReceivedCents: 100000,
        changeCents: source.envelope.receipt.changeCents,
      });
      for (const table of [
        'orders',
        'order_stores',
        'pos_rewrite_offline_cash_order_links',
        'pos_rewrite_offline_cash_import_proofs',
        'pos_transaction_logs',
        'comments',
        'order_cancel_message_mapping',
        'flag_history',
        'pos_rewrite_administration_outbox',
      ])
        expect(
          (await rows(`SELECT COUNT(*) AS count FROM ${mysql.escapeId(table)}`))[0]!.count,
        ).toBe(1);
      expect((await rows('SELECT COUNT(*) AS count FROM has_products'))[0]!.count).toBe(
        source.template.lines.length,
      );
      expect(
        (await rows('SELECT COUNT(*) AS count FROM amount_to_be_refunded_log'))[0]!.count,
      ).toBe(source.template.lines.length);
      expect(
        (await rows('SELECT product_id,stock FROM product_store ORDER BY product_id')).map(
          (row) => ({ ...row, product_id: String(row.product_id) }),
        ),
      ).toEqual(
        source.envelope.receipt.lines.map((line) => ({
          product_id: line.productId,
          stock: 10 - line.quantity,
        })),
      );
      expect(
        (
          await rows('SELECT ship_date,ret_ex_request_date,courier,pg_disc_platform FROM orders')
        )[0],
      ).toMatchObject({
        ship_date: null,
        ret_ex_request_date: null,
        courier: 0,
        pg_disc_platform: null,
      });
      expect((await rows('SELECT CAST(id AS CHAR) AS id FROM orders'))[0]!.id).toBe(
        '9007199254740993',
      );
      expect(await repository.importOrder(manager, '1', receiptId, input, null, null)).toEqual(
        results[0],
      );
      expect((await repository.get(manager, '1', receiptId)).activeApproval).toBeNull();
    }, 30000);
    it('rolls back every order, stock, ledger, proof and outbox mutation when a later stock projection fails', async () => {
      const { receiptId, input } = await approved();
      let calls = 0;
      await expect(
        repository.importOrder(manager, '1', receiptId, input, source.template, {
          ...writer,
          stockProcedure: async (tx, value) => {
            await writer.stockProcedure(tx, value);
            if (++calls === 1) throw new Error('Fixture projection failure');
          },
        }),
      ).rejects.toThrow('Fixture projection failure');
      for (const table of [
        'orders',
        'has_products',
        'order_stores',
        'amount_to_be_refunded_log',
        'pos_transaction_logs',
        'comments',
        'pos_rewrite_checkout_projections',
        'pos_rewrite_offline_cash_import_proofs',
        'pos_rewrite_offline_cash_order_links',
        'pos_rewrite_administration_outbox',
      ])
        expect(
          (await rows(`SELECT COUNT(*) AS count FROM ${mysql.escapeId(table)}`))[0]!.count,
        ).toBe(0);
      expect((await rows('SELECT SUM(stock) AS stock FROM product_store'))[0]!.stock).toBe('20');
      expect((await repository.get(manager, '1', receiptId)).status).toBe('conflicted');
      expect(
        (await repository.importOrder(manager, '1', receiptId, input, source.template, writer))
          .status,
      ).toBe('imported');
    });
    it('imports the approved duplicate-SKU remainder without overwriting individual source allocations', async () => {
      expect(source.template.lines).toHaveLength(5);
      const { receiptId, input } = await approved(),
        imported = await repository.importOrder(
          manager,
          '1',
          receiptId,
          input,
          source.template,
          writer,
        );
      expect(imported.status).toBe('imported');
      const differences = await rows(
        'SELECT COUNT(*) AS count FROM has_products hp JOIN amount_to_be_refunded_log r ON r.has_product_id=hp.id AND r.order_id=hp.order_id AND r.prod_id=hp.prod_id WHERE hp.order_id=? AND NOT(hp.amount_to_be_refunded <=> r.amount_to_be_refunded)',
        [imported.orderId!],
      );
      expect(differences[0]!.count).toBe(0);
      const remainder = await rows(
        'SELECT prod_id,COUNT(DISTINCT amount_to_be_refunded) AS variants FROM has_products WHERE order_id=? GROUP BY prod_id HAVING variants>1',
        [imported.orderId!],
      );
      expect(remainder).toHaveLength(1);
      expect(
        Number(
          (
            await rows(
              'SELECT CAST(ROUND(SUM(amount_to_be_refunded),2) AS CHAR) AS total FROM has_products WHERE order_id=?',
              [imported.orderId!],
            )
          )[0]!.total,
        ) * 100,
      ).toBe(source.envelope.receipt.payableCents);
    });
    it('fails closed on missing proof during paid read/replay and preserves immutable original cash through later return/status changes', async () => {
      const { receiptId, input } = await approved(),
        paid = await repository.importOrder(
          manager,
          '1',
          receiptId,
          input,
          source.template,
          writer,
        );
      await connection.query(
        'UPDATE orders SET order_status=13,payment_status=1,pay_amt=1 WHERE id=?',
        [paid.orderId],
      );
      await connection.query(
        "UPDATE has_products SET status='RETURN_DELIVERED',price=1 WHERE order_id=?",
        [paid.orderId],
      );
      const payments = paymentService(
        paymentRepository(db, config, {
          hashSecret: 'cash-duplicate-charge-fixture-secret',
          projection: signingEnvironment,
          assertCheckIn: async () => {},
        }),
        {
          configured() {},
          start: async () => {
            throw new Error('Unexpected duplicate charge');
          },
          status: async () => {
            throw new Error('Unexpected provider enquiry');
          },
          cancel: async () => {
            throw new Error('Unexpected cancellation');
          },
        },
      );
      await expect(
        payments.start(manager, '1', paid.orderId!, {
          operationId: randomUUID(),
          channel: 'cash',
          onlineAmount: '0.00',
          cashAmount: '1.00',
          cashReceived: '1.00',
        }),
      ).rejects.toMatchObject({ code: 'ORDER_ALREADY_SETTLED_OFFLINE' });
      expect((await repository.get(manager, '1', receiptId)).payableCents).toBe(
        source.envelope.receipt.payableCents,
      );
      await connection.query(
        'DELETE FROM pos_rewrite_offline_cash_import_proofs WHERE receipt_id=?',
        [receiptId],
      );
      await expect(repository.get(manager, '1', receiptId)).rejects.toMatchObject({
        code: 'OFFLINE_CASH_IMPORT_PROOF_REQUIRED',
      });
      await expect(
        repository.importOrder(manager, '1', receiptId, input, null, null),
      ).rejects.toMatchObject({ code: 'OFFLINE_CASH_IMPORT_PROOF_REQUIRED' });
      expect((await rows('SELECT COUNT(*) AS count FROM orders'))[0]!.count).toBe(1);
    });
    it('retains received cash and refuses a newly blocked customer before allocating order or stock', async () => {
      const { receiptId, input } = await approved();
      await connection.query('UPDATE users SET is_block=1 WHERE id=777');
      await expect(
        repository.importOrder(manager, '1', receiptId, input, source.template, writer),
      ).rejects.toMatchObject({ code: 'CHECKOUT_CUSTOMER_UNAVAILABLE' });
      expect((await rows('SELECT COUNT(*) AS count FROM orders'))[0]!.count).toBe(0);
      expect(
        (await rows('SELECT COUNT(*) AS count FROM product_store WHERE stock<>10'))[0]!.count,
      ).toBe(0);
      const [receipt] = await rows(
        'SELECT payable_cents,cash_received_cents,change_cents,status FROM pos_rewrite_offline_cash_receipts WHERE id=?',
        [receiptId],
      );
      expect(receipt).toMatchObject({
        payable_cents: String(source.envelope.receipt.payableCents),
        cash_received_cents: String(source.envelope.receipt.cashReceivedCents),
        change_cents: String(source.envelope.receipt.changeCents),
        status: 'conflicted',
      });
    });
    it('rejects unapplied schema compatibility, forged template amounts and physical stock shortages without manufacturing an order', async () => {
      const { receiptId, input } = await approved();
      await connection.query(
        'ALTER TABLE orders MODIFY ship_date DATETIME NOT NULL, MODIFY ret_ex_request_date DATETIME NOT NULL',
      );
      await expect(
        repository.importOrder(manager, '1', receiptId, input, source.template, writer),
      ).rejects.toMatchObject({ code: 'OFFLINE_CASH_ORDER_SCHEMA_UNVERIFIED' });
      for (const statement of readFileSync(
        'compatibility/upstream/offline-cash-import/001_unset_event_dates.sql',
        'utf8',
      )
        .split(';')
        .filter((statement) => statement.trim()))
        await connection.query(statement);
      await expect(
        repository.importOrder(
          manager,
          '1',
          receiptId,
          input,
          { ...source.template, header: { ...source.template.header, pay_amt: '1' } },
          writer,
        ),
      ).rejects.toMatchObject({ code: 'OFFLINE_CASH_TEMPLATE_INVALID' });
      await connection.query('UPDATE product_store SET stock=0');
      const conflict = await repository.importOrder(
        manager,
        '1',
        receiptId,
        input,
        source.template,
        writer,
      );
      expect(conflict.status).toBe('conflicted');
      expect(conflict.conflicts).toContain('stock-shortage');
      expect((await rows('SELECT COUNT(*) AS count FROM orders'))[0]!.count).toBe(0);
      expect(conflict.payableCents).toBe(source.envelope.receipt.payableCents);
    });
  },
);
