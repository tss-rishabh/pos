import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Temporal } from '@js-temporal/polyfill';
import { eq, sql } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { HasProduct, Order, OrderStore, StoreDayClose } from '../../src/db/legacy-schema.js';
import type { Principal } from '../../src/domain/access.js';
import {
  offlineCashReceipts,
  offlineCashCloseImpacts,
  offlineCashImportProofs,
  offlineCashOrderLinks,
  offlineCashSigningKeys,
} from '../../src/modules/checkout/offline-cash/schema.js';
import { cashDigest, offlineCashSigner } from '../../src/modules/checkout/offline-cash/crypto.js';
import { canonicalCashJson } from '../../src/modules/checkout/offline-cash/canonical.js';
import { assertOfflineCashImportProofs } from '../../src/modules/checkout/offline-cash/import-proof.js';
import type { CashImportProofData } from '../../src/modules/checkout/offline-cash/import-proof-contracts.js';
import type { SignedCashReceipt } from '../../src/modules/checkout/offline-cash/contracts.js';
import {
  checkoutHeaderHashSql,
  checkoutLineHashSql,
} from '../../src/modules/checkout/projection.js';
import { aggregateOfflineCash } from '../../src/modules/finance/offline-cash.js';
import { collectionSnapshot, financeService } from '../../src/modules/finance/service.js';
import { cashLedgerService, ledgerOptions } from '../../src/modules/finance/ledger.js';
import { closeEntriesSchema } from '../../src/modules/finance/domain.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { bindReportSql, reportService, rollupSchema } from '../../src/modules/reports.js';
import { legacyReportSql } from '../../src/modules/legacy-report-sql.js';
import { offlineDailyStoreTemplate } from '../../src/modules/daily-report-offline.js';
import { matchedImportedOfflineOrder } from '../../src/modules/finance/offline-cash.js';
import {
  refundAllocationContract,
  refundSourcePatchHash,
} from '../../src/modules/checkout/refund-allocation.js';
const integration = process.env.MYSQL_INTEGRATION_URL;
const user: Principal = {
  id: '1',
  name: 'Fixture',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: ['1'],
};
describe.skipIf(!integration)('offline cash finance projections on isolated verified MySQL', () => {
  const schema =
      'pos_rewrite_offline_finance_test_' + randomUUID().replaceAll('-', '').slice(0, 12),
    clock = () => Temporal.Instant.from('2026-11-16T17:30:00Z');
  let connection: mysql.Connection | undefined,
    databases: Databases | undefined,
    created = false;
  const native = () => {
      if (!connection) throw new Error('Offline finance fixture unavailable.');
      return connection;
    },
    db = () => {
      if (!databases) throw new Error('Offline finance fixture unavailable.');
      return databases;
    };
  const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'offline-finance-fixture-'.repeat(3),
  });
  beforeAll(async () => {
    const url = new URL(integration!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Offline finance fixtures require localhost.');
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    created = true;
    await connection.changeUser({ database: schema });
    await verifiedMysqlFixture(connection).create([
      'stores',
      'orders',
      'order_stores',
      'has_products',
      'amount_to_be_refunded_log',
      'return_orders',
      'store_day_close',
      'store_day_banking',
      'store_cash_opening_balance',
      'pos_user',
      'products',
      'users',
      'payment_status',
      'order_attributes',
      'exchange_order_log',
      'has_categories',
      'categories',
      'pos_online_orders',
    ]);
    for (const path of [
      'src/modules/finance/migration.sql',
      'src/modules/checkout/migrations/0003_payments.sql',
      'src/modules/checkout/payment-reversals/migration.sql',
      'src/modules/checkout/migrations/0011_offline_cash.sql',
      'src/modules/checkout/migrations/0012_offline_cash_receipt_identity.sql',
      'src/modules/checkout/migrations/0013_offline_cash_import_proof.sql',
    ])
      for (const statement of readFileSync(path, 'utf8')
        .split(';')
        .map((value) => value.trim())
        .filter(Boolean))
        await connection.query(statement);
    await connection.query(
      'ALTER TABLE store_day_close ADD UNIQUE KEY uq_offline_fixture_close(store_id,close_date,version)',
    );
    await connection.query(
      'ALTER TABLE store_day_banking ADD UNIQUE KEY uq_offline_fixture_banking(store_id,banking_date)',
    );
    url.pathname = '/' + schema;
    config.MYSQL_WRITER_URL = url.toString();
    config.MYSQL_PRIMARY_READER_URL = url.toString();
    config.MYSQL_DATA_READER_URL = url.toString();
    config.MYSQL_ALLOW_LOCAL_PLAINTEXT = true;
    databases = createDatabases(config);
  });
  beforeEach(async () => {
    for (const table of [
      'pos_rewrite_finance_commands',
      'pos_rewrite_offline_cash_import_proofs',
      'pos_rewrite_offline_cash_signing_keys',
      'pos_rewrite_offline_cash_receipt_lines',
      'pos_rewrite_offline_cash_close_impacts',
      'pos_rewrite_offline_cash_receipts',
      'pos_rewrite_offline_cash_order_links',
      'store_day_close',
      'store_day_banking',
      'store_cash_opening_balance',
      'order_stores',
      'has_products',
      'orders',
      'return_orders',
      'amount_to_be_refunded_log',
      'stores',
      'pos_user',
      'products',
      'users',
      'payment_status',
      'order_attributes',
      'exchange_order_log',
      'has_categories',
      'categories',
      'pos_online_orders',
    ])
      await native().query(`DELETE FROM ${mysql.escapeId(table)}`);
    const fixture = verifiedMysqlFixture(native());
    await fixture.insert('stores', {
      id: 1,
      store_name: 'Fixture',
      location_code: 'FIX1',
      is_active: 1,
      type: 'STORE',
      category: 'IN_HOUSE',
    });
    await fixture.insert('pos_user', { id: 1, role: 1, user_type: 1, is_active: 1 });
    await fixture.insert('orders', { id: 1, created_at: '2026-11-16 10:00:00' });
    await fixture.insert('order_stores', {
      id: 1,
      order_id: 1,
      store_id: 1,
      counter_id: 7,
      offline_payment: '100.00',
      online_payment: '0.00',
      online_other_payment: '0.00',
    });
    await fixture.insert('store_cash_opening_balance', {
      store_id: 1,
      balance_date: '2026-11-16',
      amount: '50.00',
    });
  });
  afterAll(async () => {
    await databases?.close();
    if (connection && created) {
      await connection.changeUser({ database: 'mysql' });
      await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
    }
    await connection?.end();
  });
  async function receipt(
    amount: number,
    status = 'accepted',
    businessDate = '2026-11-16',
    storeId = '1',
  ) {
    const id = randomUUID();
    await db()
      .get('writer')
      .insert(offlineCashReceipts)
      .values({
        id,
        authorizationId: randomUUID(),
        deviceId: randomUUID(),
        sequence: 1,
        operatorId: '1',
        storeId,
        counterId: '7',
        draftId: randomUUID(),
        businessDate,
        completedAt: Temporal.Instant.from('2026-11-01T01:00:00Z').epochMilliseconds,
        acceptedAt: clock().epochMilliseconds,
        receiptNumber: randomUUID().slice(0, 24),
        requestHash: 'a'.repeat(64),
        envelope: '{}',
        payableCents: amount,
        cashReceivedCents: amount + 100,
        changeCents: 100,
        status,
        conflicts: status === 'conflicted' ? '["ACCESS_REVOKED","STOCK_CHANGED"]' : '[]',
        version: 1,
        orderId: null,
        requestId: 'fixture-offline-cash',
      });
    return id;
  }
  async function imported(
    index = 0,
    quantity = 1,
    lineItemsEnabled = false,
    signer = offlineCashSigner(
      generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    ),
  ) {
    const amount = 1001 * quantity,
      id = await receipt(amount),
      orderId = String(9007199254740993n + BigInt(index) * 100n),
      productId = String(9007199254740994n + BigInt(index) * 100n),
      hpBase = 9007199254740995n + BigInt(index) * 100n;
    const [saved] = await db()
      .get('writer')
      .select()
      .from(offlineCashReceipts)
      .where(eq(offlineCashReceipts.id, id));
    if (!saved) throw new Error('Offline receipt fixture unavailable.');
    const receiptNumber = 'OC-' + saved.authorizationId.replaceAll('-', '').toUpperCase() + '-0001',
      deviceKey = generateKeyPairSync('ed25519').privateKey;
    const receiptData: SignedCashReceipt['receipt'] = {
      version: 1,
      id,
      authorizationId: saved.authorizationId,
      deviceId: saved.deviceId,
      operatorId: '1',
      storeId: '1',
      counterId: '7',
      businessDate: '2026-11-16',
      draftId: saved.draftId,
      draftVersion: clock().epochMilliseconds,
      sequence: 1,
      receiptNumber,
      completedAt: saved.completedAt,
      currency: 'INR',
      snapshotId: randomUUID(),
      snapshotHash: 'a'.repeat(64),
      stockPolicy: 'cached-stock-manager',
      lines: [
        {
          productId,
          name: 'Fixture SKU',
          barcode: '12345',
          hsn: '6109',
          quantity,
          unitPrice: '10.01',
          mainSubtotalCents: amount,
          taxableCents: amount,
          taxCents: 0,
          invoiceGst: '0',
        },
      ],
      taxableCents: amount,
      taxCents: 0,
      roundingCents: 0,
      payableCents: amount,
      cashReceivedCents: amount + 100,
      changeCents: 100,
    };
    const envelope: SignedCashReceipt = {
        receipt: receiptData,
        signature: sign(null, Buffer.from(canonicalCashJson(receiptData)), deviceKey).toString(
          'base64url',
        ),
      },
      requestHash = cashDigest(envelope),
      fixture = verifiedMysqlFixture(native());
    await fixture.insert('orders', {
      id: orderId,
      user_id: '77',
      payment_method: 14,
      payment_status: 4,
      order_status: 3,
      pay_amt: amount / 100,
      created_at: '2026-11-16 10:00:00',
    });
    await fixture.insert('order_stores', {
      id: orderId,
      order_id: orderId,
      store_id: 1,
      counter_id: 7,
      offline_payment: (amount / 100).toFixed(2),
      offline_payment_recieved: ((amount + 100) / 100).toFixed(2),
      online_payment: '0.00',
      online_other_payment: '0.00',
      is_offline_order: 1,
      is_manually_paid: 1,
      transaction_id: receiptNumber,
    });
    for (let i = 0; i < (lineItemsEnabled ? quantity : 1); i++)
      await fixture.insert('has_products', {
        id: String(hpBase + BigInt(i)),
        order_id: orderId,
        prod_id: productId,
        sub_prod_id: 0,
        qty: lineItemsEnabled ? 1 : quantity,
        price: 10.01,
        disc: 0,
        store_disc_pg: 0,
        hp_tss_points_used: 0,
        pre_gst_amt: 0,
      });
    const [header] = await db()
        .get('writer')
        .select({ hash: sql<string>`${sql.raw(checkoutHeaderHashSql)}` })
        .from(Order)
        .where(eq(Order.id, BigInt(orderId))),
      lines = await db()
        .get('writer')
        .select({
          id: HasProduct.id,
          quantity: HasProduct.qty,
          hash: sql<string>`${sql.raw(checkoutLineHashSql)}`,
        })
        .from(HasProduct)
        .where(eq(HasProduct.order, BigInt(orderId)));
    if (!header) throw new Error('Native financial proof fixture unavailable.');
    const finalizedAt = clock().add({ seconds: 1 }).epochMilliseconds,
      proofData: CashImportProofData = {
        version: 1,
        kind: 'pos-offline-cash-import-v1',
        receiptId: id,
        authorizationId: saved.authorizationId,
        receiptHash: requestHash,
        orderId,
        operatorId: '1',
        customerId: '77',
        storeId: '1',
        counterId: '7',
        businessDate: '2026-11-16',
        receiptNumber,
        payableCents: amount,
        cashReceivedCents: amount + 100,
        changeCents: 100,
        finalizedAt,
        orderCreatedAt: '2026-11-16 10:00:00',
        headerHash: header.hash,
        lineItemsEnabled,
        lines: lines.map((line) => ({
          hasProductId: String(line.id),
          productId,
          quantity: Number(line.quantity),
          priceHash: line.hash,
        })),
        stock: [{ productId, quantity, beforeAvailable: 100, afterAvailable: 100 - quantity }],
        stockContract: 'pos-stock-projection-70b801-v1',
        sourceApiCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
        sourcePaymentsCommit: '434f3e438d1cb48c64e5723222c6efda506db571',
        refundAllocationContract,
        refundSourcePatchHash,
      },
      sealed = signer.sealImport(proofData);
    await db()
      .get('writer')
      .update(offlineCashReceipts)
      .set({
        status: 'imported',
        orderId,
        receiptNumber,
        requestHash,
        envelope: JSON.stringify(envelope),
      })
      .where(eq(offlineCashReceipts.id, id));
    await db()
      .get('writer')
      .insert(offlineCashSigningKeys)
      .values({
        keyId: signer.keyId,
        publicKey: JSON.stringify(signer.publicKey),
        createdAt: clock().epochMilliseconds,
      })
      .onDuplicateKeyUpdate({ set: { keyId: signer.keyId } });
    await db()
      .get('writer')
      .insert(offlineCashImportProofs)
      .values({
        receiptId: id,
        orderId,
        keyId: sealed.keyId,
        proof: JSON.stringify(sealed.proof),
        signature: sealed.signature,
        createdAt: finalizedAt,
      });
    await db().get('writer').insert(offlineCashOrderLinks).values({
      receiptId: id,
      orderId,
      payableCents: amount,
      businessDate: '2026-11-16',
      projectionHash: header.hash,
      finalizedAt,
    });
    return { id, orderId, productId, hpId: String(hpBase), sealed, signer };
  }
  it('retains accepted, conflicted and importing cash exactly once, without requiring a live grant or current operator access', async () => {
    await receipt(101);
    await receipt(202, 'conflicted');
    await receipt(303, 'importing');
    await receipt(999, 'accepted', '2026-11-16', '2');
    await native().query('UPDATE pos_user SET is_active=0');
    expect(
      await aggregateOfflineCash(db().get('writer'), ['1'], '2026-11-16', '2026-11-16'),
    ).toEqual([
      { storeId: '1', date: '2026-11-16', cash: '6.06', orderCount: 3, pendingOrderCount: 3 },
    ]);
    expect(await collectionSnapshot(db().get('writer'), '1', '2026-11-16')).toMatchObject({
      order_count: 4,
      cash: '106.06',
      cash_refund: '0.00',
    });
  });
  it('uses the signed business date rather than device completion or server acceptance time', async () => {
    await receipt(505, 'conflicted', '2026-11-15');
    expect(
      await aggregateOfflineCash(db().get('writer'), ['1'], '2026-11-16', '2026-11-16'),
    ).toEqual([]);
    expect(await collectionSnapshot(db().get('writer'), '1', '2026-11-15')).toMatchObject({
      order_count: 1,
      cash: '5.05',
    });
  });
  it('includes receipt cash in a current data-reader open ledger and in the writer close snapshot', async () => {
    await receipt(506, 'conflicted');
    const ledger = await cashLedgerService(config, db(), ledgerOptions({}), undefined, clock).read(
      user,
      ['1'],
      '2026-11-16',
      '2026-11-16',
    );
    expect(ledger.reader).toBe('data');
    expect(ledger.data[0]).toMatchObject({
      opening_cash: '50.00',
      sales_cash: '105.06',
      running_total: '155.06',
    });
    const finance = financeService(config, db(), clock, { assertCheckIn: async () => {} }),
      entries = closeEntriesSchema.parse({
        cash_actual: '105.06',
        cash_manual_punched: '0',
        cash_manual_created: '0',
        card_actual: '0',
        card_manual_punched: '0',
        card_manual_created: '0',
        banking_amount: '0',
      });
    expect(await finance.close(user, '1', '2026-11-16', randomUUID(), 0, entries)).toMatchObject({
      cash: { system: '105.06' },
    });
    const [closed] = await db().get('writer').select().from(StoreDayClose);
    expect(closed?.snap_order_count).toBe(2);
  });
  it('preserves frozen prior close figures while a late receipt increases the authoritative current snapshot', async () => {
    const finance = financeService(config, db(), clock, { assertCheckIn: async () => {} }),
      entries = closeEntriesSchema.parse({
        cash_actual: '100',
        cash_manual_punched: '0',
        cash_manual_created: '0',
        card_actual: '0',
        card_manual_punched: '0',
        card_manual_created: '0',
        banking_amount: '0',
      });
    await finance.close(user, '1', '2026-11-16', randomUUID(), 0, entries);
    const id = await receipt(707, 'conflicted');
    const [priorClose] = await db().get('writer').select().from(StoreDayClose);
    if (!priorClose) throw new Error('Offline finance close unavailable.');
    await db().get('writer').insert(offlineCashCloseImpacts).values({
      receiptId: id,
      closeId: priorClose.id,
      priorStatus: 'CLOSED',
      priorReason: null,
      createdAt: clock().epochMilliseconds,
    });
    await db()
      .get('writer')
      .update(StoreDayClose)
      .set({ status: 'STALE', stale_reason: 'OFFLINE_CASH', stale_trigger_ref: id })
      .where(eq(StoreDayClose.version, 1));
    const state = await finance.state(user, '1', '2026-11-16');
    expect(state.system.cash).toBe('107.07');
    expect(state.close).toMatchObject({
      status: 'STALE',
      stale_reason: 'OFFLINE_CASH',
      cash: { system: '100.00' },
    });
    const ledger = () =>
      cashLedgerService(config, db(), ledgerOptions({}), undefined, clock).read(
        user,
        ['1'],
        '2026-11-16',
        '2026-11-16',
      );
    expect((await ledger()).data[0]).toMatchObject({
      sales_cash: '100.00',
      note: expect.stringContaining('7.07'),
    });
    await finance.close(user, '1', '2026-11-16', randomUUID(), 1, {
      ...entries,
      cash_actual: '107.07',
    });
    expect((await ledger()).data[0]).toMatchObject({ sales_cash: '107.07', note: '' });
    const [frozen] = await db()
      .get('writer')
      .select()
      .from(StoreDayClose)
      .where(eq(StoreDayClose.version, 1));
    expect(frozen?.cash_system).toBe('100.00');
  });
  it('keeps receipt and ordinary order reads in one repeatable snapshot during a concurrent source payment update', async () => {
    await receipt(505);
    await db()
      .get('data')
      .transaction(
        async (transaction) => {
          await aggregateOfflineCash(transaction, ['1'], '2026-11-16', '2026-11-16');
          await native().query('UPDATE order_stores SET offline_payment=200 WHERE id=1');
          expect((await collectionSnapshot(transaction, '1', '2026-11-16')).cash).toBe('105.05');
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    expect((await collectionSnapshot(db().get('writer'), '1', '2026-11-16')).cash).toBe('205.05');
  });
  it('fails closed on an unknown receipt lifecycle state instead of silently dropping recognized cash', async () => {
    await receipt(101, 'invalid');
    await expect(collectionSnapshot(db().get('writer'), '1', '2026-11-16')).rejects.toMatchObject({
      code: 'OFFLINE_CASH_RECONCILIATION_REQUIRED',
    });
  });
  it('requires immutable import proof before accepting an imported-status claim', async () => {
    await receipt(101, 'imported');
    await expect(collectionSnapshot(db().get('writer'), '1', '2026-11-16')).rejects.toMatchObject({
      code: 'OFFLINE_CASH_IMPORT_PROOF_REQUIRED',
    });
  });
  it('verifies native sealed headers/lines above safe integer range in unit and quantity modes and counts imported cash once', async () => {
    await imported(0, 2, false);
    await imported(1, 3, true);
    const verified = await assertOfflineCashImportProofs(db().get('writer'), {
      storeIds: ['1'],
      from: '2026-11-16',
      to: '2026-11-16',
    });
    expect(verified).toHaveLength(2);
    expect(verified.map((row) => row.orderId).sort()).toEqual([
      '9007199254740993',
      '9007199254741093',
    ]);
    expect(await collectionSnapshot(db().get('writer'), '1', '2026-11-16')).toMatchObject({
      cash: '150.05',
      order_count: 3,
    });
  });
  it('keeps received cash after later status/price changes and still recognizes separate refunds and non-cash inflows', async () => {
    const row = await imported();
    await db()
      .get('writer')
      .update(Order)
      .set({ order_statuses: 10n, payment_statuses: 6n, pay_amt: 999 })
      .where(eq(Order.id, BigInt(row.orderId)));
    await db()
      .get('writer')
      .update(HasProduct)
      .set({ status: 'RETURN_RECEIVED', return_qty: '1', price: 999 })
      .where(eq(HasProduct.id, BigInt(row.hpId)));
    await db()
      .get('writer')
      .update(OrderStore)
      .set({ online_payment: '5.00' })
      .where(eq(OrderStore.order, BigInt(row.orderId)));
    const fixture = verifiedMysqlFixture(native());
    await fixture.insert('amount_to_be_refunded_log', {
      id: 1,
      order_id: row.orderId,
      has_product_id: row.hpId,
      refund_mode: 'cash',
      is_refunded: 1,
      refunded_amt: 5,
    });
    for (const id of [1, 2])
      await fixture.insert('return_orders', {
        id,
        order_id: row.orderId,
        has_product_id: row.hpId,
        store_id: 1,
        created_at: '2026-11-16 12:00:00',
      });
    expect(await collectionSnapshot(db().get('writer'), '1', '2026-11-16')).toMatchObject({
      cash: '110.01',
      order_count: 2,
      card_upi: '5.00',
      cash_refund: '5.00',
    });
  });
  it('uses historical trusted signing keys across rotation and rejects missing keys or tampered sealed proof', async () => {
    const old = await imported(0),
      newer = await imported(1);
    expect(old.signer.keyId).not.toBe(newer.signer.keyId);
    expect(
      await assertOfflineCashImportProofs(db().get('writer'), {
        storeIds: ['1'],
        from: '2026-11-16',
        to: '2026-11-16',
      }),
    ).toHaveLength(2);
    await db()
      .get('writer')
      .delete(offlineCashSigningKeys)
      .where(eq(offlineCashSigningKeys.keyId, old.signer.keyId));
    await expect(collectionSnapshot(db().get('writer'), '1', '2026-11-16')).rejects.toMatchObject({
      code: 'OFFLINE_CASH_IMPORT_PROOF_REQUIRED',
    });
    await db()
      .get('writer')
      .insert(offlineCashSigningKeys)
      .values({
        keyId: old.signer.keyId,
        publicKey: JSON.stringify(old.signer.publicKey),
        createdAt: clock().epochMilliseconds,
      });
    await db()
      .get('writer')
      .update(offlineCashImportProofs)
      .set({ proof: JSON.stringify({ ...old.sealed.proof, customerId: '88' }) })
      .where(eq(offlineCashImportProofs.receiptId, old.id));
    await expect(collectionSnapshot(db().get('writer'), '1', '2026-11-16')).rejects.toMatchObject({
      code: 'OFFLINE_CASH_IMPORT_PROOF_INVALID',
    });
  });
  it('requires the approved per-HP allocation descriptor even on an otherwise genuinely signed import proof', async () => {
    const keys = generateKeyPairSync('ed25519'),
      signer = offlineCashSigner(
        keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      ),
      row = await imported(0, 1, false, signer);
    const variants: Record<string, unknown>[] = [
      { ...row.sealed.proof, refundAllocationContract: 'pos-refund-per-product-v0' },
      { ...row.sealed.proof, refundSourcePatchHash: 'f'.repeat(64) },
      { ...row.sealed.proof },
      { ...row.sealed.proof },
    ];
    delete variants[2]!.refundAllocationContract;
    delete variants[3]!.refundSourcePatchHash;
    for (const proof of variants) {
      await db()
        .get('writer')
        .update(offlineCashImportProofs)
        .set({
          proof: JSON.stringify(proof),
          signature: sign(null, Buffer.from(canonicalCashJson(proof)), keys.privateKey).toString(
            'base64url',
          ),
        })
        .where(eq(offlineCashImportProofs.receiptId, row.id));
      await expect(collectionSnapshot(db().get('writer'), '1', '2026-11-16')).rejects.toMatchObject(
        { code: 'OFFLINE_CASH_IMPORT_PROOF_INVALID' },
      );
    }
    await db()
      .get('writer')
      .update(offlineCashImportProofs)
      .set({ proof: JSON.stringify(row.sealed.proof), signature: row.sealed.signature })
      .where(eq(offlineCashImportProofs.receiptId, row.id));
    expect(await collectionSnapshot(db().get('writer'), '1', '2026-11-16')).toMatchObject({
      cash: '110.01',
      order_count: 2,
    });
  });
  it('fails on structural ownership, stable quantity or cross-date link mismatches before excluding an ordinary payment', async () => {
    const row = await imported();
    await db()
      .get('writer')
      .update(OrderStore)
      .set({ counter: 8n })
      .where(eq(OrderStore.order, BigInt(row.orderId)));
    await expect(collectionSnapshot(db().get('writer'), '1', '2026-11-16')).rejects.toMatchObject({
      code: 'OFFLINE_CASH_IMPORT_PROOF_INVALID',
    });
    await db()
      .get('writer')
      .update(OrderStore)
      .set({ counter: 7n })
      .where(eq(OrderStore.order, BigInt(row.orderId)));
    await db()
      .get('writer')
      .update(HasProduct)
      .set({ qty: 2n })
      .where(eq(HasProduct.id, BigInt(row.hpId)));
    await expect(collectionSnapshot(db().get('writer'), '1', '2026-11-16')).rejects.toMatchObject({
      code: 'OFFLINE_CASH_IMPORT_PROOF_INVALID',
    });
    await db()
      .get('writer')
      .update(HasProduct)
      .set({ qty: 1n })
      .where(eq(HasProduct.id, BigInt(row.hpId)));
    await db()
      .get('writer')
      .update(offlineCashReceipts)
      .set({ businessDate: '2026-11-15' })
      .where(eq(offlineCashReceipts.id, row.id));
    await expect(collectionSnapshot(db().get('writer'), '1', '2026-11-16')).rejects.toMatchObject({
      code: 'OFFLINE_CASH_IMPORT_PROOF_INVALID',
    });
  });
  it('batches seal, key and structural reads instead of issuing one query per imported receipt', async () => {
    const signer = offlineCashSigner(
      generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    );
    for (let index = 0; index < 257; index++) await imported(index, 1, false, signer);
    const writer = db().get('writer'),
      selects = vi.spyOn(writer, 'select');
    try {
      expect(
        await assertOfflineCashImportProofs(writer, {
          storeIds: ['1'],
          from: '2026-11-16',
          to: '2026-11-16',
        }),
      ).toHaveLength(257);
      expect(selects.mock.calls.length).toBeGreaterThan(0);
      expect(selects.mock.calls.length).toBeLessThan(257);
    } finally {
      selects.mockRestore();
    }
    expect(await collectionSnapshot(db().get('writer'), '1', '2026-11-16')).toMatchObject({
      cash: '2672.57',
      order_count: 258,
    });
  }, 20000);
  async function dailySource() {
    const fixture = verifiedMysqlFixture(native());
    await fixture.insert('users', { id: 77, email: 'fixture-customer@example.test' });
    await fixture.insert('payment_status', { id: 4, payment_status: 'Paid' });
    await fixture.insert('products', {
      id: 10,
      product: 'Fixture SKU',
      prod_type: 1,
      parent_prod_id: 0,
    });
    await db()
      .get('writer')
      .update(Order)
      .set({
        user: 77n,
        order_statuses: 3n,
        payment_statuses: 4n,
        country_id: 'India',
        pay_amt: 100,
      })
      .where(eq(Order.id, 1n));
    await fixture.insert('has_products', {
      id: 1,
      order_id: 1,
      prod_id: 10,
      sub_prod_id: 0,
      qty: 2,
      price: 100,
      disc: 0,
      store_disc_pg: 0,
      hp_tss_points_used: 0,
      pre_gst_amt: 0,
      gst: 0,
      status: 'DELIVERED',
    });
    await fixture.insert('store_day_banking', {
      store_id: 1,
      banking_date: '2026-11-16',
      amount: '25.00',
      updated_by_id: 1,
    });
  }
  it('verifies a targeted receipt without scanning unrelated corrupt imports and retains scoped immutable finalization time', async () => {
    const good = await imported(0),
      bad = await imported(1);
    await db()
      .get('writer')
      .update(offlineCashImportProofs)
      .set({ signature: 'A'.repeat(86) })
      .where(eq(offlineCashImportProofs.receiptId, bad.id));
    const scope = { storeIds: ['1'], from: '2026-11-16', to: '2026-11-16', receiptIds: [good.id] },
      verified = await assertOfflineCashImportProofs(db().get('writer'), scope);
    expect(verified).toMatchObject([
      {
        receiptId: good.id,
        orderId: good.orderId,
        finalizedAt: clock().add({ seconds: 1 }).epochMilliseconds,
      },
    ]);
    expect(
      await assertOfflineCashImportProofs(db().get('writer'), { ...scope, storeIds: ['2'] }),
    ).toEqual([]);
    await expect(
      assertOfflineCashImportProofs(db().get('writer'), {
        ...scope,
        receiptIds: [good.id, good.id],
      }),
    ).rejects.toBeDefined();
    await expect(collectionSnapshot(db().get('writer'), '1', '2026-11-16')).rejects.toMatchObject({
      code: 'OFFLINE_CASH_IMPORT_PROOF_INVALID',
    });
  });
  it('preserves the pinned native daily store SQL with no offline imports and runs current sources/banking on one read-only data transaction', async () => {
    await dailySource();
    const database = db().get('data'),
      legacy = bindReportSql(
        legacyReportSql.storeOrders,
        ['1'],
        [],
        '2026-11-16 00:00:00',
        '2026-11-16 23:59:59',
      ),
      rewritten = bindReportSql(
        offlineDailyStoreTemplate(legacyReportSql.storeOrders),
        ['1'],
        [],
        '2026-11-16 00:00:00',
        '2026-11-16 23:59:59',
        matchedImportedOfflineOrder(database, {
          orderId: sql.raw('o.id'),
          storeId: sql.raw('oss.store_id'),
          counterId: sql.raw('oss.counter_id'),
        }),
      );
    const [before] = await database.execute(legacy),
      [after] = await database.execute(rewritten);
    expect(rollupSchema.array().parse(after)).toEqual(rollupSchema.array().parse(before));
    const readers: string[] = [],
      selected: Databases = {
        get: (reader) => {
          readers.push(reader);
          return reader === 'data' ? database : db().get(reader);
        },
        close: async () => {},
      };
    const transaction = vi.spyOn(database, 'transaction');
    try {
      const result = await reportService(config, selected, { clock }).daily(user, {
        storeIds: ['1'],
        from: '2026-11-16',
        to: '2026-11-16',
      });
      expect(result.data[0]).toMatchObject({
        store_revenue: 100,
        store_qty: 2,
        store_orders: 1,
        cash: 100,
        total_online: 0,
        banking: 25,
        pending_offline_orders: 0,
      });
      expect(readers).toEqual(['data']);
      expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
    } finally {
      transaction.mockRestore();
    }
  });
  it('counts signed-date offline cash/orders once while retaining imported HP revenue/quantity and exposes pending receipt counts', async () => {
    await dailySource();
    const row = await imported();
    await verifiedMysqlFixture(native()).insert('products', {
      id: row.productId,
      product: 'Fixture imported SKU',
      prod_type: 1,
      parent_prod_id: 0,
    });
    await db()
      .get('writer')
      .update(Order)
      .set({ country_id: 'India' })
      .where(eq(Order.id, BigInt(row.orderId)));
    await db()
      .get('writer')
      .update(HasProduct)
      .set({ status: 'DELIVERED', gst: 0 })
      .where(eq(HasProduct.id, BigInt(row.hpId)));
    await receipt(202, 'conflicted');
    const service = reportService(config, db(), { clock }),
      input = { storeIds: ['1'], from: '2026-11-16', to: '2026-11-16' };
    const first = await service.daily(user, input);
    expect(first.data[0]).toMatchObject({
      store_orders: 3,
      store_qty: 3,
      store_revenue: 110.01,
      cash: 112.03,
      total_online: 0,
      pending_offline_orders: 1,
    });
    expect(first.pendingOrderCount).toBe(1);
    await db()
      .get('writer')
      .update(HasProduct)
      .set({ status: 'RETURN_RECEIVED' })
      .where(eq(HasProduct.id, BigInt(row.hpId)));
    const returned = await service.daily(user, input);
    expect(returned.data[0]).toMatchObject({
      store_orders: 3,
      store_qty: 2,
      store_revenue: 100,
      cash: 112.03,
      pending_offline_orders: 1,
    });
  });
});
