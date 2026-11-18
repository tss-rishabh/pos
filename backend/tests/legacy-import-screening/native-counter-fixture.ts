import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { paymentOutbox } from '../../src/modules/checkout/payments/schema.js';
import {
  physicalStockLog,
  storeStockLog,
  aggregateStockLog,
} from '../../src/db/stock-projection/schema.js';
import {
  checkoutProjections,
  checkoutProjectionLines,
} from '../../src/modules/checkout/projection.js';
import { checkoutCustomerConsents } from '../../src/modules/checkout/customer-consent-proof.js';
import {
  PosUser,
  Store,
  StoreCounter,
  Order,
  OrderStore,
  HasProduct,
  OrderStatus,
  Comments,
  PosTransactionLog,
  ProductStore,
  Product,
  ProductInventoryLog,
  GiftVoucher,
  StoreDayClose,
  ExclusiveUser,
  GiftCardCollection,
} from '../../src/db/legacy-schema.js';
import {
  installNativeHeadFixture,
  nativeHeadReviewStatements,
} from '../native-head-metadata/fixture.js';
import {
  screeningCounterSourceCapture,
  initializeScreeningCounter,
} from '../../src/modules/legacy-order-imports/screening-counter/publisher.js';
import { sealCounterPublication } from '../../src/modules/legacy-order-imports/screening-counter/contracts.js';
import { counterTriggers } from '../../src/modules/legacy-order-imports/screening-counter/writers.js';

export const fixtureCounterSourceKey = 'isolated-import-counter-source-key-'.repeat(2);
export const fixtureCounterPublicationKey = 'isolated-import-counter-publication-key-'.repeat(2);
const nativeDml = new Set<string>(
  [
    PosUser,
    Store,
    StoreCounter,
    Order,
    OrderStore,
    HasProduct,
    OrderStatus,
    Comments,
    PosTransactionLog,
    ProductStore,
    Product,
    ProductInventoryLog,
    GiftVoucher,
    StoreDayClose,
    ExclusiveUser,
    GiftCardCollection,
    checkoutProjections,
    checkoutProjectionLines,
    checkoutCustomerConsents,
    physicalStockLog,
    storeStockLog,
    aggregateStockLog,
    paymentOutbox,
  ].map(getTableName),
);
const heads = new Set([
  'pos_rewrite_screening_origin_history_heads',
  'pos_rewrite_screening_origin_history_changes',
  'pos_rewrite_membership_history_heads',
  'pos_rewrite_coupon_history_heads',
  'pos_rewrite_screening_counter_heads',
  'pos_rewrite_screening_counters',
  'pos_rewrite_screening_contributions',
]);

/** Real reviewed ledger DDL, installed only in the existing guarded disposable
 * schema. Empty origin cohorts still require their actual operational tables. */
export async function installOriginCreditFixture(admin: mysql.Connection) {
  for (const file of [
    'compatibility/upstream/screening-origins/migration.sql',
    'compatibility/upstream/other-writer-origins/go/migration.review.sql',
  ])
    for (const statement of nativeHeadReviewStatements(readFileSync(file, 'utf8'))) {
      const table = /^CREATE TABLE\s+(\w+)/i.exec(statement)?.[1];
      if (!table) throw new Error('Unexpected origin fixture migration statement');
      const [rows] = await admin.query<mysql.RowDataPacket[]>(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
        [table],
      );
      if (!rows.length) await admin.query(statement);
    }
}

/** Distinct application/sourceRO/projection-publisher accounts. The baseline
 * rows below are an independently owned synthetic warehouse publication, never
 * a production interactive historical fallback or a hand-written authority bit. */
export async function installImportCounterFixture(admin: mysql.Connection, template: string) {
  const native = await installNativeHeadFixture(admin, template, { families: ['counter'] });
  const [tables] = await admin.query<mysql.RowDataPacket[]>(
    "SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'",
  );
  for (const row of tables) {
    const table = String(row.name);
    if (
      !heads.has(table) &&
      (nativeDml.has(table) ||
        table.startsWith('pos_rewrite_import_') ||
        table.startsWith('pos_rewrite_legacy_order_import') ||
        [
          'pos_rewrite_operator_auth_epochs',
          'pos_rewrite_administration_outbox',
          'pos_rewrite_aggregate_stock',
          'product_stocks',
          'has_addresses',
          'order_address_mapping',
          'flag_history',
          'amount_to_be_refunded_log',
          'pos_rewrite_gift_card_issuances',
          'order_cancel_message_mapping',
        ].includes(table))
    )
      await admin.query(
        'GRANT INSERT,UPDATE,DELETE ON ' +
          mysql.escapeId(native.schema) +
          '.' +
          mysql.escapeId(table) +
          ' TO ' +
          mysql.escape(native.names.app) +
          "@'%'",
      );
  }
  const environment = {
    ...native.environment,
    POS_SCREENING_COUNTER_CONTRACT: 'pos-screening-current-counter-v1',
    POS_SCREENING_COUNTER_PUBLICATION_KEY: fixtureCounterPublicationKey,
  };
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  async function initialize(customer: string) {
    const snapshot = await screeningCounterSourceCapture(
      native.sourceDb,
      fixtureCounterSourceKey,
      Date.now,
      native.headMetadata,
    ).snapshot(customer);
    const [rows] = await admin.query<mysql.RowDataPacket[]>(
      `SELECT CAST(s.id AS CHAR) markerId,CAST(s.order_id AS CHAR) orderId,CAST(s.has_product_id AS CHAR) lineId,CAST(IF(hp.prod_id=390238 AND o.order_status NOT IN(0,17),1,0) AS CHAR) included FROM spiderman_screening_orders s LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN has_products hp ON hp.id=s.has_product_id WHERE s.user_id=? ORDER BY s.id`,
      [customer],
    );
    const baseline = sealCounterPublication(
      snapshot.capture,
      fixtureCounterSourceKey,
      fixtureCounterPublicationKey,
      {
        generationId: 'a'.repeat(64),
        snapshotId: snapshot.capture.snapshotId,
        sourceCaptureHash: snapshot.capture.signature,
        sourceCdcThrough: Date.now(),
        complete: true,
        rows: rows.map((row) => ({
          markerId: String(row.markerId),
          orderId: String(row.orderId),
          lineId: String(row.lineId),
          included: row.included === '1',
        })),
      },
    );
    await initializeScreeningCounter(
      native.publisherDb!,
      baseline,
      fixtureCounterPublicationKey,
      null,
      Date.now(),
      {
        headMetadata: native.headMetadata,
        configuration: snapshot.configuration,
        purpose: 'counter-publication',
      },
    );
  }
  const applicationWriter = native.appDb.get('writer');
  const appDb = {
    ...native.appDb,
    get: (name: Parameters<typeof native.appDb.get>[0]) =>
      name === 'writer' ? applicationWriter : native.appDb.get(name),
  };
  return {
    ...native,
    appDb,
    environment,
    options: {
      contract: 'pos-screening-current-counter-v1' as const,
      publicationKey: fixtureCounterPublicationKey,
      headMetadata: native.headMetadata,
    },
    initialize,
    async removeCounterWriters() {
      for (const trigger of counterTriggers)
        await admin.query('DROP TRIGGER IF EXISTS ' + mysql.escapeId(trigger.name));
    },
    async close() {
      await native.close();
      for (const table of [
        'pos_rewrite_screening_contributions',
        'pos_rewrite_screening_counters',
        'pos_rewrite_screening_counter_heads',
        'pos_rewrite_screening_origin_history_changes',
        'pos_rewrite_screening_origin_history_heads',
      ])
        await admin.query('DROP TABLE IF EXISTS ' + mysql.escapeId(table));
      vi.unstubAllEnvs();
    },
  };
}
export type ImportCounterFixture = Awaited<ReturnType<typeof installImportCounterFixture>>;
