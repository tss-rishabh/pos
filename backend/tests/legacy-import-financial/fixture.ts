import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { getTableName, eq, sql } from 'drizzle-orm';
import { splitMigration } from '../../src/db/migrations.js';
import {
  MUser,
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
  GiftCardCollection,
  StoreDayClose,
  ExclusiveUser,
} from '../../src/db/legacy-schema.js';
import {
  aggregateStock,
  physicalStockLog,
  storeStockLog,
  aggregateStockLog,
} from '../../src/db/stock-projection/schema.js';
import { availableStockProjection } from '../../src/db/stock-projection/service.js';
import {
  checkoutHeaderHashSql,
  checkoutLineHashSql,
  checkoutProjections,
  checkoutProjectionLines,
} from '../../src/modules/checkout/projection.js';
import {
  checkoutCustomerConsents,
  customerConsentContract,
} from '../../src/modules/checkout/customer-consent-proof.js';
import {
  sourceOrderReceiptSchema,
  financialSourceContract,
  financialImportContract,
  financialPublicationContract,
  type ImportFinancialState,
  type SourceOrderReceipt,
} from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import {
  financialImportSourceReceipts,
  financialImportOrderBindings,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import {
  financialSourceHash,
  expectedFinancialPlanHash,
} from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import { nativeImportOrder } from '../../src/modules/legacy-order-imports/financial-adapter-proof.js';
import {
  orderImportRuntimeFixture,
  runtimeImportSecret,
} from '../legacy-order-imports/runtime-fixture.js';
import type { LegacyOrderImportPlan } from '../../src/modules/legacy-order-imports/plans.js';
import type { LegacyImportFinancialOptions } from '../../src/modules/legacy-order-imports/financial-adapter-options.js';
import type { LegacyImportFinancialTransport } from '../../src/modules/legacy-order-imports/financial-adapter-transport.js';

export const financialClock = Date.parse('2026-06-15T06:30:00.000Z'),
  sourceKey = 'isolated-private-source-receipt-'.repeat(3);
export function financialPlan(kind: 'offline' | 'shopify' = 'offline'): LegacyOrderImportPlan {
  const common = {
    sequence: 1,
    firstRow: 2,
    reference: randomUUID(),
    storeId: '1',
    email: 'private-import@example.test',
    createdAt: '2026-06-15 12:00:00',
    lines: [{ productId: '9007199254740993', quantity: 2, unitPrice: '25.00', sourceRows: [2] }],
    originalTenderAmount: '50.00',
  };
  return kind === 'offline'
    ? { ...common, kind, payment: 'cash', sendOrderPlacedSms: false, message: 'fixture settlement' }
    : {
        ...common,
        kind,
        payment: 'shopify',
        currency: 'INR',
        address: { shipping_name: 'Fixture' },
        legacyTaxDigit: 1,
        shippingCharges: '0.00',
        discountAmount: '0.00',
        financialStatus: 'paid',
        declaredSubtotal: '50.00',
        declaredTaxes: '0.00',
        declaredTotal: '50.00',
      };
}
export async function importFinancialFixture(template: string) {
  const url = new URL(template);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname != '/pos_rewrite_checkout_test'
  )
    throw new Error('Isolated checkout URL required.');
  url.pathname = '/pos_rewrite_legacy_order_imports_test';
  const f = await orderImportRuntimeFixture(url.href);
  const extra = [
    MUser,
    Order,
    OrderStore,
    HasProduct,
    OrderStatus,
    Comments,
    PosTransactionLog,
    ProductStore,
    Product,
    GiftVoucher,
    StoreDayClose,
    ExclusiveUser,
    GiftCardCollection,
    ProductInventoryLog,
    aggregateStock,
    physicalStockLog,
    storeStockLog,
    aggregateStockLog,
  ].map(getTableName);
  await f.fixture.create([...extra, 'amount_to_be_refunded_log']);
  await f.connection.query(
    'ALTER TABLE orders MODIFY ship_date DATETIME NULL DEFAULT NULL,MODIFY ret_ex_request_date DATETIME NULL DEFAULT NULL',
  );
  for (const path of [
    'src/modules/legacy-order-imports/financial-proof-migration.sql',
    'src/modules/checkout/migrations/0009_checkout_projection_proof.sql',
    'src/modules/checkout/migrations/0017_customer_consent_proof.sql',
    'src/modules/checkout/migrations/0015_gift_card_issuance.sql',
    'src/modules/customer-contacts/contact-revisions-migration.sql',
    'src/modules/checkout/migrations/0003_payments.sql',
  ]) {
    for (const statement of splitMigration(readFileSync(path, 'utf8')))
      await f.connection.query(statement);
  }
  await f.connection.query(
    'CREATE TABLE pos_rewrite_operator_auth_epochs(operator_id VARCHAR(32) PRIMARY KEY,epoch BIGINT UNSIGNED NOT NULL DEFAULT 0)',
  );
  await f.connection.query(
    'CREATE TABLE pos_rewrite_administration_outbox(id VARCHAR(36) PRIMARY KEY,kind VARCHAR(64) NOT NULL,payload JSON NOT NULL,attempts INT NOT NULL,created_at DATETIME NOT NULL,delivered_at DATETIME NULL)',
  );
  const baseReset = f.reset;
  async function reset() {
    for (const table of [
      'pos_rewrite_import_financial_source_effects',
      'pos_rewrite_import_financial_order_bindings',
      'pos_rewrite_import_financial_close_impacts',
      'pos_rewrite_import_financial_proofs',
      'pos_rewrite_import_financial_source_receipts',
      'pos_rewrite_import_financial_stages',
      'pos_rewrite_import_financial_references',
      'pos_rewrite_import_financial_approvals',
      'pos_rewrite_import_financial_operations',
      'pos_rewrite_customer_contact_revisions',
      'pos_rewrite_operator_auth_epochs',
      'pos_rewrite_checkout_customer_consents',
      'pos_rewrite_checkout_projection_lines',
      'pos_rewrite_checkout_projections',
      'pos_rewrite_payment_attempts',
      'pos_rewrite_payment_outbox',
      'pos_rewrite_administration_outbox',
      'pos_rewrite_gift_card_issuances',
      'amount_to_be_refunded_log',
      ...extra,
    ])
      await f.connection.query('DELETE FROM `' + table + '`');
    await baseReset();
    await f.connection.query("UPDATE stores SET location_code='FIXTURE' WHERE id=1");
    await f.fixture.insert('users', {
      id: '77',
      email: 'private-import@example.test',
      telephone: '',
      status: 1,
      is_block: 0,
      is_disabled: 0,
    });
    await f.fixture.insert('products', { id: '9007199254740993', prod_type: 1, parent_prod_id: 0 });
    await f.fixture.insert('product_stocks', {
      prod_id: '9007199254740993',
      parent_prod_id: 0,
      stock: 100,
      stocked: 0,
    });
    await f.fixture.insert('product_store', {
      id: '1',
      product_id: '9007199254740993',
      store_id: '1',
      stock: 100,
      is_avail: 1,
      is_del: 0,
    });
    await f.fixture.insert('order_status', { id: '3', order_status: 'DELIVERED' });
  }
  const options: LegacyImportFinancialOptions = {
    secret: runtimeImportSecret,
    contract: financialImportContract,
    sourceContract: financialSourceContract,
    publicationContract: financialPublicationContract,
    sourceProofKey: sourceKey,
    stockContract: 'pos-stock-projection-70b801-v1',
    orderSchemaContract: 'pos-offline-cash-order-schema-v1',
    clock: () => financialClock,
    stockProcedure: availableStockProjection(f.config.BUSINESS_TIMEZONE, () =>
      Temporal.Instant.fromEpochMilliseconds(financialClock),
    ),
  };
  async function createOrder(state: ImportFinancialState, plan: LegacyOrderImportPlan) {
    const orderId = '9007199254740995';
    await f.fixture.insert('orders', {
      id: orderId,
      user_id: '77',
      payment_method: plan.kind === 'offline' ? 14 : 15,
      payment_status: plan.kind === 'offline' ? 0 : 1,
      order_status: plan.kind === 'offline' ? 0 : 1,
      created_at: plan.createdAt,
      updated_at: plan.createdAt,
      pay_amt: 50,
      order_amt: 50,
      cashback_used: 0,
      tss_money_used: 0,
      tss_points_used: 0,
      voucher_used: 0,
      voucher_amt_used: 0,
      coupon_used: 0,
      coupon_amt_used: 0,
      parent_order_id: 0,
      original_order_id: 0,
      hl_parent_order_id: 0,
      location_id: 0,
      order_ref_no: 'FIXTURE-REF',
    });
    await f.fixture.insert('order_stores', {
      id: '1',
      order_id: orderId,
      store_id: '1',
      counter_id: '2',
      offline_payment: 0,
      offline_payment_recieved: 0,
      online_payment: 0,
      online_other_payment: 0,
      is_manually_paid: 0,
    });
    await f.fixture.insert('has_products', {
      id: '9007199254740997',
      order_id: orderId,
      prod_id: '9007199254740993',
      sub_prod_id: 0,
      qty: 2,
      price: 50,
      status: 'INCOMPLETE',
      amount_to_be_refunded: 50,
      created_at: plan.createdAt,
      updated_at: plan.createdAt,
    });
    await f.fixture.insert('amount_to_be_refunded_log', {
      order_id: orderId,
      prod_id: '9007199254740993',
      has_product_id: '9007199254740997',
      amount_to_be_refunded: 50,
    });
    return f.db.get('writer').transaction(async (tx) => {
      const value = await nativeImportOrder(tx, orderId);
      const receipt = sourceOrderReceiptSchema.parse({
        contract: financialSourceContract,
        operationId: state.scope.operationId,
        requestHash: state.requestHash,
        namespace: state.namespace,
        customerId: '77',
        storeId: '1',
        counterId: '2',
        createdAt: plan.createdAt,
        orderId,
        headerHash: value.header.headerHash,
        lineHash: value.lineHash,
        method: plan.kind === 'offline' ? 14 : 15,
        payable: '50.00',
        refundAllocationContract: 'pos-refund-per-hp-v1',
        refundSourcePatchHash: 'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
        sourceCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
        sourceControllerHash: 'd8b922d8ddaa5ed4743b51b113bbae344e3853a4f49054f18bb9b1cd8597da18',
        lineItemsEnabled: false,
        lines: value.lines,
        effectsHash: 'e'.repeat(64),
      });
      await tx.insert(financialImportSourceReceipts).values({
        id: state.scope.operationId + ':order',
        operationId: state.scope.operationId,
        kind: 'order',
        requestHash: state.requestHash,
        status: 'completed',
        proof: receipt,
        proofHash: financialSourceHash(sourceKey, 'order', receipt),
        createdAt: financialClock,
      });
      await tx.insert(financialImportOrderBindings).values({
        orderId,
        operationId: state.scope.operationId,
        requestHash: state.requestHash,
        proofHash: financialSourceHash(sourceKey, 'order', receipt),
        status: 'held',
      });
      return receipt;
    });
  }
  async function confirm(order: SourceOrderReceipt) {
    await f.db.get('writer').transaction(async (tx) => {
      await tx
        .update(Order)
        .set({ payment_statuses: 1n, order_statuses: 1n, is_stock_reduced: 1 })
        .where(eq(Order.id, BigInt(order.orderId)));
      await tx
        .update(HasProduct)
        .set({ status: 'PLACED' })
        .where(eq(HasProduct.order, BigInt(order.orderId)));
      await tx.update(ProductStore).set({ stock: 98 }).where(eq(ProductStore.id, 1n));
      const [header] = await tx
        .select({ hash: sql<string>`${sql.raw(checkoutHeaderHashSql)}` })
        .from(Order)
        .where(eq(Order.id, BigInt(order.orderId)));
      await tx.insert(checkoutProjections).values({
        orderId: BigInt(order.orderId),
        storeId: 1n,
        counterId: 2n,
        userId: 77n,
        inputHash: header!.hash,
        lineCount: 1,
        contractVersion: 'pos-checkout-projection-v1',
        confirmedAt: '2026-06-15 06:30:00',
      });
      const [line] = await tx
        .select({ hash: sql<string>`${sql.raw(checkoutLineHashSql)}` })
        .from(HasProduct)
        .where(eq(HasProduct.order, BigInt(order.orderId)));
      await tx.insert(checkoutProjectionLines).values({
        orderId: BigInt(order.orderId),
        lineId: 9007199254740997n,
        productId: 9007199254740993n,
        quantity: 2n,
        inputHash: line!.hash,
      });
      await tx.insert(checkoutCustomerConsents).values({
        orderId: BigInt(order.orderId),
        customerId: 77n,
        operatorId: 1n,
        storeId: 1n,
        counterId: 2n,
        inputHash: header!.hash,
        required: 0,
        contactRevision: null,
        contactDigest: null,
        verifiedUntilMs: null,
        acceptedAtMs: BigInt(financialClock),
        contractVersion: customerConsentContract,
      });
    });
  }
  function transport(): LegacyImportFinancialTransport {
    return {
      assertReady() {},
      async order(input) {
        await createOrder(input.state, input.plan);
      },
      async confirm(input, order) {
        await confirm(order);
        const proof = {
          contract: 'pos-legacy-order-import-confirmation-v1',
          operationId: input.state.scope.operationId,
          orderId: order.orderId,
          requestHash: input.state.requestHash,
          nonce: input.nonce,
          customerId: '77',
          storeId: '1',
          counterId: '2',
          headerHash: order.headerHash,
          confirmedAt: financialClock,
        };
        await f.db
          .get('writer')
          .insert(financialImportSourceReceipts)
          .values({
            id: input.state.scope.operationId + ':confirmation',
            operationId: input.state.scope.operationId,
            kind: 'confirmation',
            requestHash: input.state.requestHash,
            status: 'completed',
            proof,
            proofHash: financialSourceHash(sourceKey, 'confirmation', proof),
            createdAt: financialClock,
          });
      },
      async publication(input, order) {
        const proof = {
          contract: financialPublicationContract,
          operationId: input.state.scope.operationId,
          orderId: order.orderId,
          requestHash: input.state.requestHash,
          sourceHash: order.effectsHash,
          acceptedAt: financialClock,
          delivery: 'durable-queue-accepted',
          jobs: [
            { id: 'source-job-1', kind: 'kinesis-chain' },
            { id: 'source-job-2', kind: 'engagement' },
          ],
        };
        await f.db
          .get('writer')
          .insert(financialImportSourceReceipts)
          .values({
            id: input.state.scope.operationId + ':publication',
            operationId: input.state.scope.operationId,
            kind: 'publication',
            requestHash: input.state.requestHash,
            status: 'completed',
            proof,
            proofHash: financialSourceHash(sourceKey, 'publication', proof),
            createdAt: financialClock,
          });
      },
    };
  }
  const scope = () => ({ actorId: '1', storeId: '1', counterId: '2', operationId: randomUUID() });
  return {
    ...f,
    reset,
    options,
    createOrder,
    confirm,
    transport,
    input(plan = financialPlan()) {
      const value = scope();
      return {
        ...value,
        plan,
        planHash: expectedFinancialPlanHash(runtimeImportSecret, value, plan),
      };
    },
  };
}
