import { splitMigration } from '../../src/db/migrations.js';
import { readFileSync } from 'node:fs';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { Decimal } from 'decimal.js';
import { Temporal } from '@js-temporal/polyfill';
import { sql } from 'drizzle-orm';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  AmountToBeRefundedLog,
  Comments,
  Coupon,
  ExclusiveUser,
  GiftVoucher,
  GiftCardCollection,
  HasProduct,
  MUser,
  Order,
  OrderStatus,
  OrderStore,
  PosMachine,
  PosPaytmMachine,
  PosPaytmTransaction,
  PosTerminalTransaction,
  PosTerminalPaymentModes,
  PosTransactionLog,
  StoreCounter,
  StoreDayClose,
  Store,
  ReturnOrder,
  HoldStockStore,
  PosHoldStockLog,
  ExtendApplicabilityForReturnExchange,
  ReversePickupReason,
  Product,
  ProductBarcode,
  ProductStore,
  HasOptions,
  Attributes,
  HasCategories,
  StoreSalesPerson,
  PosExchangeLog,
  OrderAddon,
  SalesPerson,
  PosUser,
  UserStore,
  ProductInventoryLog,
} from '../../src/db/legacy-schema.js';
import {
  aggregateStock,
  physicalStockLog,
  storeStockLog,
  aggregateStockLog,
} from '../../src/db/stock-projection/schema.js';
import { availableStockProjection } from '../../src/db/stock-projection/service.js';
import { pendingCancellationRepository } from '../../src/modules/checkout/cancellations/repository.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  cancellationBenefitPolicy,
  type CancellationBenefitProfile,
} from '../../src/modules/checkout/cancellations/benefit-contracts.js';
import { legacyPaymentSourceHash } from '../../src/modules/checkout/payments/legacy.js';
import { readOrderPaymentEvidence } from '../../src/modules/checkout/payments/repository.js';
import { pendingCancellationContract } from '../../src/modules/checkout/cancellations/contracts.js';
import { paymentRepository } from '../../src/modules/checkout/payments/repository.js';
import { paymentService } from '../../src/modules/checkout/payments/service.js';
import { returnRepository } from '../../src/modules/checkout/return-workflow/repository.js';
import { returnService } from '../../src/modules/checkout/return-workflow/service.js';
import {
  returnInputSchema,
  type ReturnGateway,
} from '../../src/modules/checkout/return-workflow/contracts.js';
import { returnVerificationService } from '../../src/modules/checkout/return-workflow/verification.js';
import { paymentOutboxDispatcher } from '../../src/modules/checkout/payments/outbox.js';
import { returnOutboxDispatcher } from '../../src/modules/checkout/return-workflow/outbox.js';
import Fastify from 'fastify';
import { registerInvoices } from '../../src/modules/checkout/invoices.js';
import { exchangeService } from '../../src/modules/checkout/return-workflow/exchanges.js';
import { exchangeInputSchema } from '../../src/modules/checkout/return-workflow/contracts.js';
import { orderFinalizer, prepaidSettlementReader } from '../../src/modules/checkout/finalizer.js';
import { registerRequestTrace } from '../../src/observability/context.js';
import { registerPayments } from '../../src/modules/checkout/payments/routes.js';
import type {
  PaymentGateway,
  PaymentInput,
  ProviderDecision,
} from '../../src/modules/checkout/payments/contracts.js';
import { checkoutRepository } from '../../src/modules/checkout/repository.js';
import { checkoutService } from '../../src/modules/checkout/service.js';
import { returnReadService } from '../../src/modules/checkout/returns.js';
import { ordersService } from '../../src/modules/orders.js';
import { CheckoutGatewayError } from '../../src/modules/checkout/gateway.js';
import { AppError } from '../../src/domain/errors.js';
import { createSettlementNote } from '../../src/modules/checkout/settlement-note.js';
import {
  orderMessageContract,
  orderMessageResponseProof,
} from '../../src/modules/checkout/order-message-proof.js';
import {
  feedbackProofContract,
  invoiceSecurityContract,
  invoiceResponseProof,
} from '../../src/modules/checkout/invoice-security.js';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import {
  FixtureGateway,
  operator,
  signingEnvironment,
  orderMessageFixtureEnvironment,
} from './fixtures.js';
import { localOrderMessageDelivery } from '../../src/modules/checkout/order-messages/service.js';
import { orderMessageOptions } from '../../src/modules/checkout/order-messages/options.js';
import { feedbackVerifier } from '../../src/modules/checkout/feedback-proof.js';
import { discountApprovals } from '../../src/modules/checkout/discounts/repository.js';
import { discountPolicy } from '../../src/modules/checkout/discounts/policy.js';
import { discountOutboxDispatcher } from '../../src/modules/checkout/discounts/delivery.js';
import { legacyDiscountAddons } from '../../src/modules/checkout/discounts/schema.js';
import { decryptCode } from '../../src/modules/checkout/discounts/crypto.js';
import { exchangeOrderLog } from '../../src/modules/checkout/return-workflow/exchange-ledger.js';
import {
  exchangeStockConfirmations,
  exchangeStockContract,
} from '../../src/modules/checkout/return-workflow/stock-proof.js';
import {
  checkoutHeaderHashSql,
  checkoutLineHashSql,
  checkoutProjectionContract,
  assertCheckoutProjection,
} from '../../src/modules/checkout/projection.js';
import { assertOrderRefundAllocations } from '../../src/modules/checkout/refund-allocation.js';
import { customerConsentContract } from '../../src/modules/checkout/customer-consent-proof.js';
import type {
  CustomerOtpOperationView,
  CustomerOtpView,
} from '../../src/modules/customer-otp/index.js';
import type { CustomerVerificationClient } from '../../src/modules/checkout/customer-verification.js';
import {
  assertCompletedGiftCardIssuance,
  giftCardIssuanceHashSql,
  recordGiftCardIssuance,
} from '../../src/modules/checkout/gift-card-issuance.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('checkout against isolated real MySQL', () => {
  const tables: MySqlTable[] = [
    MUser,
    Coupon,
    ExclusiveUser,
    StoreCounter,
    Order,
    OrderStore,
    OrderStatus,
    HasProduct,
    AmountToBeRefundedLog,
    Comments,
    GiftVoucher,
    GiftCardCollection,
    PosMachine,
    PosPaytmMachine,
    PosPaytmTransaction,
    PosTerminalTransaction,
    PosTerminalPaymentModes,
    PosTransactionLog,
    StoreDayClose,
    Store,
    ReturnOrder,
    HoldStockStore,
    PosHoldStockLog,
    ExtendApplicabilityForReturnExchange,
    ReversePickupReason,
    Product,
    ProductBarcode,
    ProductStore,
    HasOptions,
    Attributes,
    HasCategories,
    StoreSalesPerson,
    PosExchangeLog,
    OrderAddon,
    SalesPerson,
    PosUser,
    UserStore,
    legacyDiscountAddons,
    exchangeOrderLog,
    ProductInventoryLog,
    aggregateStock,
    physicalStockLog,
    storeStockLog,
    aggregateStockLog,
  ];
  let connection: Connection,
    db: Databases,
    schemaName: string,
    repository: ReturnType<typeof checkoutRepository>;
  async function seed(table: MySqlTable, values: Record<string, string | number | boolean | null>) {
    const config = getTableConfig(table),
      record: Record<string, string | number | boolean | null> = {};
    for (const column of config.columns) {
      if ('autoIncrement' in column && column.autoIncrement) continue;
      const type = column.getSQLType();
      record[column.name] = !column.notNull
        ? null
        : /^(date|datetime|timestamp)/.test(type)
          ? type === 'date'
            ? '2026-11-16'
            : '2026-11-16 00:00:00'
          : type.startsWith('time')
            ? '00:00:00'
            : column.dataType === 'boolean'
              ? false
              : ['number', 'bigint'].includes(column.dataType) || type.startsWith('decimal')
                ? 0
                : '';
    }
    Object.assign(record, values);
    const names = Object.keys(record);
    await connection.execute(
      `INSERT INTO ${mysql.escapeId(config.name)} (${names.map((name) => mysql.escapeId(name)).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      names.map((name) => record[name]!),
    );
  }
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_checkout_test'
    )
      throw new Error('Checkout tests require the explicit isolated localhost schema template.');
    schemaName = `pos_rewrite_checkout_test_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schemaName)}`);
    await connection.changeUser({ database: schemaName });
    for (const statement of readFileSync('migrations/0006_operator_auth_epochs.sql', 'utf8')
      .replace(/^--.*$/gm, '')
      .split(';')
      .filter((value) => value.trim()))
      await connection.query(statement);
    for (const table of tables) {
      const config = getTableConfig(table),
        definitions = config.columns.map(
          (column) =>
            `${mysql.escapeId(column.name)} ${column.getSQLType()}${column.notNull ? ' NOT NULL' : ''}${'autoIncrement' in column && column.autoIncrement ? ' AUTO_INCREMENT' : ''}`,
        ),
        primary = config.columns
          .filter((column) => column.primary)
          .map((column) => mysql.escapeId(column.name));
      if (primary.length) definitions.push(`PRIMARY KEY (${primary.join(',')})`);
      await connection.query(
        `CREATE TABLE ${mysql.escapeId(config.name)} (${definitions.join(',')}) ENGINE=InnoDB`,
      );
    }
    await verifiedMysqlFixture(connection, [
      'evidence/mysql-pending-cancellation-benefits-schema.json',
    ]).create(['order_tss_money', 'order_tss_point', 'tss_money_history', 'tss_point_history']);
    // Generic financial writers require the imported-order hold control tables.
    for (const statement of splitMigration(
      readFileSync('src/modules/legacy-order-imports/financial-proof-migration.sql', 'utf8'),
    ))
      await connection.query(statement);
    for (const migration of [
      '0002_checkout.sql',
      '0003_payments.sql',
      '0004_returns.sql',
      '0005_financial_delivery_context.sql',
      '0006_discount_approvals.sql',
      '0007_exchange_stock_proof.sql',
      '0008_checkout_draft_binding.sql',
      '0009_checkout_projection_proof.sql',
      '0011_offline_cash.sql',
      '0012_offline_cash_receipt_identity.sql',
      '0013_offline_cash_import_proof.sql',
      '0015_gift_card_issuance.sql',
      '0017_customer_consent_proof.sql',
    ])
      for (const statement of readFileSync('src/modules/checkout/migrations/' + migration, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((s) => s.trim()))
        await connection.query(statement);
    for (const migration of [
      'src/modules/legacy-order-status/migration.sql',
      'src/modules/legacy-order-status/repair-migration.sql',
    ])
      for (const statement of readFileSync(migration, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((value) => value.trim()))
        await connection.query(statement);
    await connection.query(`ALTER TABLE gift_vouchers
      ADD from_id BIGINT NOT NULL DEFAULT 777,
      ADD collection_no BIGINT NOT NULL DEFAULT 0,
      ADD gv_type ENUM('GIFT_VOUCHER','GIFT_CARD') NOT NULL DEFAULT 'GIFT_VOUCHER',
      ADD start_date DATETIME NOT NULL DEFAULT '2026-11-16 00:00:00',
      ADD end_date DATETIME NOT NULL DEFAULT '2027-02-14 00:00:00'`);
    for (const statement of readFileSync(
      'src/modules/checkout/payments/legacy-migration.sql',
      'utf8',
    )
      .split(';')
      .filter((value) => value.trim()))
      await connection.query(statement);
    for (const statement of readFileSync(
      'src/modules/checkout/order-messages/migration.sql',
      'utf8',
    )
      .replace(/^--.*$/gm, '')
      .split(';')
      .filter((value) => value.trim()))
      await connection.query(statement);
    await connection.query(`ALTER TABLE order_stores
      MODIFY message VARCHAR(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL`);
    for (const statement of readFileSync('src/modules/checkout/cancellations/migration.sql', 'utf8')
      .split(';')
      .filter((value) => value.trim()))
      await connection.query(statement);
    for (const statement of readFileSync(
      'src/modules/customer-contacts/contact-revisions-migration.sql',
      'utf8',
    )
      .replace(/^--.*$/gm, '')
      .split(';')
      .filter((value) => value.trim()))
      await connection.query(statement);
    for (const statement of readFileSync('src/modules/administration/migration.sql', 'utf8')
      .replace(/^--.*$/gm, '')
      .split(';')
      .filter((value) => value.trim()))
      await connection.query(statement);
    url.pathname = '/' + schemaName;
    db = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'checkout-integration-secret-'.repeat(3),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_WRITER_URL: url.href,
      }),
    );
    repository = checkoutRepository(db);
    await seed(MUser, {
      id: 777,
      email: 'operator@example.test',
      firstname: 'Operator',
      lastname: 'Fixture',
      telephone: '9000000000',
      status: 1,
      pos_admin_id: 44,
    });
    await seed(StoreCounter, { id: 3, store_id: 1, is_active: true });
    await seed(OrderStatus, { id: 3, order_status: 'DELIVERED', display_name: 'Delivered' });
    await seed(OrderStatus, { id: 4, order_status: 'CANCELLED', display_name: 'Cancelled' });
    await seed(Store, {
      id: 1,
      store_name: 'Fixture receiving store',
      type: 'STORE',
      location_code: 'FST1',
      is_active: true,
    });
    await seed(PosUser, {
      id: 44,
      first_name: 'Fixture operator',
      contact_email: 'operator@example.test',
      role: 4,
      user_type: 1,
      is_active: true,
    });
    await seed(PosUser, {
      id: 45,
      first_name: 'Fallback manager',
      contact_email: 'fallback@example.test',
      role: 3,
      user_type: 1,
      is_active: true,
    });
    await seed(PosUser, {
      id: 46,
      first_name: 'Policy approver',
      contact_email: 'approver@example.test',
      role: 4,
      user_type: 1,
      is_active: true,
    });
    await seed(PosUser, {
      id: 47,
      first_name: 'Inactive manager',
      contact_email: 'inactive@example.test',
      role: 3,
      user_type: 1,
      is_active: false,
    });
    await seed(UserStore, { django_user_id: 44, store_id: 1 });
    await connection.execute(
      'INSERT INTO pos_rewrite_operator_checkins (operator_id,store_id,counter_id,expires_at,checked_in_at) VALUES (44,1,3,DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY),UTC_TIMESTAMP())',
    );
    await seed(MUser, {
      id: 1001,
      email: 'return-customer@example.test',
      firstname: 'Fixture',
      lastname: 'Customer',
      telephone: '9000000000',
      status: 1,
    });
    await seed(ReversePickupReason, { id: 1, reason: 'Size issue', type: 1 });
    await seed(GiftCardCollection, {
      id: 1,
      size: 10,
      is_completed: 1,
      is_block: 0,
      is_printed: 1,
    });
    await seed(Product, { id: 80, product: 'Fixture physical gift card', prod_type: 8 });
    await seed(ProductBarcode, { [ProductBarcode.product.name]: 80, gtin: '8900000000080' });
    await seed(Product, { id: 100, product: 'Fixture configurable product', prod_type: 3 });
    for (const [id, size] of [
      [10, 'M'],
      [11, 'L'],
      [12, 'XL'],
    ] as const) {
      await seed(Product, {
        id,
        product: 'Fixture size ' + size,
        parent_prod_id: 100,
        prod_type: 2,
        is_del: 0,
      });
      await seed(ProductStore, {
        product_id: id,
        store_id: 1,
        stock: 20,
        is_avail: true,
        is_del: false,
      });
      await seed(ProductBarcode, {
        [ProductBarcode.product.name]: id,
        gtin: id === 10 ? '8900000000010' : id === 11 ? '8900000000011' : '8900000000012',
      });
    }
    await seed(Attributes, { id: 1, attr: 'Size' });
    for (const [id, size] of [
      [10, 'M'],
      [11, 'L'],
      [12, 'XL'],
    ] as const)
      await seed(HasOptions, { prod_id: id, attr_id: 1, attr_val: size });
    await seed(HasCategories, { prod_id: 100, cat_id: 200 });
    await seed(SalesPerson, {
      id: 5,
      first_name: 'Fixture',
      last_name: 'Salesperson',
      is_active: 1,
    });
    await seed(StoreSalesPerson, { store_id: 1, salesperson_id: 5, is_active: 1 });
    await seed(PosMachine, {
      id: 1,
      store_id: 1,
      counter_id: 3,
      is_active: 1,
      merchant_id: 'fixture',
      security_token: 'private-pine-key',
      client_id: 'fixture',
      merchant_store_pos_code: 'fixture',
      imei_no: 'fixture',
    });
    await seed(PosPaytmMachine, {
      id: 2,
      store_id: 1,
      counter_id: 3,
      is_active: 1,
      merchant_key: 'fixture-key-1234',
      paytm_mid: 'fixture-mid',
      paytm_tid: 'fixture-tid',
      channel_id: 'fixture',
    });
    for (const mode of [1, 10, 1001, 1003, 1004, 1005, 1006])
      await seed(PosTerminalPaymentModes, {
        mode_id: mode,
        name: `Fixture mode ${mode}`,
        platform: mode < 1000 ? 'PINELAB' : [1003, 1004].includes(mode) ? 'PAYTM' : 'OTHERS',
        is_active: 1,
      });
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      if (schemaName) await connection.query(`DROP DATABASE ${mysql.escapeId(schemaName)}`);
      await connection.end();
    }
  });
  const makeService = (gateway: FixtureGateway) =>
    checkoutService(repository, gateway, signingEnvironment, {
      migrationV2: true,
      verifyRefundAllocations: async () => {},
      assertCheckIn: async () => {},
      finalizeOrder: async () => ({ transactionId: 'TXN-5001', invoice: 'FIXTURE-001' }),
    });
  const mutation = (expectedVersion: number) => ({
    expectedVersion,
    operationId: crypto.randomUUID(),
  });
  it('atomically repairs an original OTP receipt across twenty repository restarts without overwriting a later cart', async () => {
    const gateway = new FixtureGateway(),
      service = makeService(gateway),
      created = await service.create(operator, '1', '3'),
      request = mutation(0),
      contact = await repository.customerContact('1001'),
      challengeId = crypto.randomUUID();
    const reserved = await repository.begin(
      operator.id,
      '1',
      created.id,
      request,
      operationHash('customer.otp.send', {}, signingEnvironment.hs256),
    );
    await repository.checkpoint(
      {
        ...reserved.state,
        customerId: '1001',
        verificationChallenge: {
          id: challengeId,
          expiresAt: Date.now() + 300000,
          attempts: 0,
          lastSentAt: Date.now(),
          sent: false,
          contact,
          requestOperationId: request.operationId,
          verifyOperationId: null,
          deliveryStatus: 'pending',
        },
      },
      request.operationId,
    );
    // A committed local OTP queue can outlive its caller's database connection.
    await repository.fail(reserved.state, request.operationId, true, 'CHECKOUT_OUTCOME_UNCERTAIN');
    const evidence: CustomerOtpOperationView = {
      kind: 'request',
      error: null,
      result: {
        id: challengeId,
        status: 'uncertain',
        expiresAt: Date.now() + 300000,
        verifiedUntil: null,
        contact,
      },
    };
    const replies = await Promise.all(
      Array.from({ length: 20 }, () =>
        checkoutRepository(db).reconcileCustomerVerification(
          operator.id,
          '1',
          created.id,
          request,
          evidence,
        ),
      ),
    );
    expect(
      replies.every(
        (value) =>
          value.receipt.status === 'succeeded' &&
          value.state.version === 1 &&
          value.state.busyOperationId === null,
      ),
    ).toBe(true);
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT status FROM pos_rewrite_checkout_operations WHERE checkout_id=? AND id=?',
      [created.id, request.operationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('succeeded');
    await service.setLine(operator, '1', created.id, mutation(1), '10', 3);
    const replay = await checkoutRepository(db).reconcileCustomerVerification(
      operator.id,
      '1',
      created.id,
      request,
      evidence,
    );
    expect(replay.state.version).toBe(2);
    expect(replay.state.cart?.products.items[0]?.quantity).toBe(3);
  });
  it('rejects stale contact, wrong original action and version changes before repairing an OTP checkpoint', async () => {
    const gateway = new FixtureGateway(),
      service = makeService(gateway),
      created = await service.create(operator, '1', '3'),
      request = mutation(0),
      contact = await repository.customerContact('1001'),
      challengeId = crypto.randomUUID();
    const reserved = await repository.begin(
      operator.id,
      '1',
      created.id,
      request,
      operationHash('customer.otp.verify', { otp: '123456' }, signingEnvironment.hs256),
    );
    await repository.checkpoint(
      {
        ...reserved.state,
        customerId: '1001',
        verificationChallenge: {
          id: challengeId,
          expiresAt: Date.now() + 300000,
          attempts: 1,
          lastSentAt: Date.now(),
          sent: false,
          contact,
          requestOperationId: crypto.randomUUID(),
          verifyOperationId: request.operationId,
          deliveryStatus: 'uncertain',
        },
      },
      request.operationId,
    );
    await repository.fail(reserved.state, request.operationId, true, 'CHECKOUT_OUTCOME_UNCERTAIN');
    const evidence: CustomerOtpOperationView = {
      kind: 'verify',
      error: null,
      result: {
        id: challengeId,
        status: 'sent',
        expiresAt: Date.now() + 300000,
        verifiedUntil: Date.now() + 600000,
        contact,
      },
    };
    await expect(
      repository.reconcileCustomerVerification(
        operator.id,
        '1',
        created.id,
        { ...request, expectedVersion: 9 },
        evidence,
      ),
    ).rejects.toMatchObject({ code: 'CHECKOUT_VERSION_CONFLICT' });
    await expect(
      repository.reconcileCustomerVerification(operator.id, '1', created.id, request, {
        ...evidence,
        kind: 'request',
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_VERIFICATION_RECOVERY_CONFLICT' });
    await connection.execute(
      "INSERT INTO pos_rewrite_customer_contact_revisions(customer_id,revision) VALUES('1001',1) ON DUPLICATE KEY UPDATE revision=revision+1",
    );
    await expect(
      repository.reconcileCustomerVerification(operator.id, '1', created.id, request, evidence),
    ).rejects.toMatchObject({ code: 'CUSTOMER_CONTACT_CHANGED' });
    expect((await repository.get(operator.id, '1', created.id))?.verifiedCustomerUntil).toBeNull();
    await connection.execute(
      "DELETE FROM pos_rewrite_customer_contact_revisions WHERE customer_id='1001'",
    );
  });
  it('reserves one physical serial across SQL-backed sessions and preserves its lease through value replacement', async () => {
    const gateway = new FixtureGateway(),
      service = makeService(gateway),
      states = await Promise.all([
        service.create(operator, '1', '3'),
        service.create(operator, '1', '3'),
      ]);
    const cards = await Promise.all(
      states.map((state) => service.addGiftCard(operator, '1', state.id, mutation(0), '80')),
    );
    const ids = cards.map((card) => String(card.state.cart?.giftvouchers?.items[0]?.gv_id));
    const results = await Promise.allSettled(
      states.map((state, index) =>
        service.giftCardMetadata(operator, '1', state.id, mutation(1), ids[index]!, {
          number: '990111',
          startDate: '2026-11-17',
          endDate: '2027-02-15',
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const index = results.findIndex((result) => result.status === 'fulfilled'),
      winner = states[index]!;
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected')
      expect(rejected.reason).toMatchObject({ code: 'GIFT_CARD_RESERVED' });
    repository = checkoutRepository(db);
    const replaced = await makeService(gateway).giftCardValue(
      operator,
      '1',
      winner.id,
      mutation(2),
      ids[index]!,
      1234,
    );
    const rows = replaced.state.cart?.giftvouchers?.items || [];
    expect(rows).toHaveLength(1);
    const newId = String(rows[0]!.gv_id);
    expect(newId).not.toBe(ids[index]);
    expect(replaced.state.giftCards[newId]?.number).toBe('990111');
    const [leases] = await connection.execute<RowDataPacket[]>(
      'SELECT checkout_id FROM pos_rewrite_gift_card_leases WHERE serial=?',
      ['990111'],
    );
    expect(leases[0]?.checkout_id).toBe(winner.id);
    expect((await makeService(gateway).read(operator, '1', winner.id)).giftCardValues).toEqual({
      [newId]: 1234,
    });
  });
  it('persists partial draft import progress across a repository restart and never quotes an omitted line', async () => {
    const gateway = new FixtureGateway(),
      service = makeService(gateway),
      draft = {
        version: Date.now(),
        lineItems: [
          { productId: '10', quantity: 2 },
          { productId: '11', quantity: 1 },
        ],
      },
      created = await service.create(operator, '1', '3', crypto.randomUUID(), draft);
    gateway.intercept = async (path, payload) => {
      if (path === 'pos/product' && payload.barcode === '8900000000011')
        throw new AppError(422, 'FIXTURE_PRODUCT_UNAVAILABLE', 'Fixture unavailable');
      return undefined;
    };
    await expect(
      service.initializeDraft(operator, '1', created.id, mutation(0)),
    ).rejects.toMatchObject({ code: 'FIXTURE_PRODUCT_UNAVAILABLE' });
    repository = checkoutRepository(db);
    const restarted = makeService(gateway);
    expect((await restarted.read(operator, '1', created.id)).draftImport).toMatchObject({
      status: 'pending',
      completedProductIds: ['10'],
    });
    await expect(restarted.quote(operator, '1', created.id, mutation(0))).rejects.toMatchObject({
      code: 'CHECKOUT_DRAFT_NOT_INITIALIZED',
    });
    await expect(restarted.submit(operator, '1', created.id, mutation(0))).rejects.toMatchObject({
      code: 'CHECKOUT_DRAFT_NOT_INITIALIZED',
    });
    gateway.intercept = undefined;
    const completed = await restarted.initializeDraft(operator, '1', created.id, mutation(0));
    expect(completed.state.draftImport).toMatchObject({
      status: 'complete',
      completedProductIds: ['10', '11'],
    });
    expect(
      gateway.calls.filter(
        (call) => call.path === 'pos/product' && call.payload.barcode === '8900000000010',
      ),
    ).toHaveLength(1);
    expect(completed.state.cart?.products.items).toEqual(
      expect.arrayContaining([
        { prod_id: 10, quantity: 2, prod_type: 1 },
        { prod_id: 11, quantity: 1, prod_type: 1 },
      ]),
    );
  });
  it('binds twenty concurrent checkout opens to one operator draft and restores its latest state after restart', async () => {
    const gateway = new FixtureGateway(),
      service = makeService(gateway),
      draftId = crypto.randomUUID();
    const states = await Promise.all(
      Array.from({ length: 20 }, () => service.create(operator, '1', '3', draftId)),
    );
    expect(new Set(states.map((state) => state.id)).size).toBe(1);
    const first = states[0]!;
    await service.coupon(operator, '1', first.id, mutation(0), 'FIXTURE');
    repository = checkoutRepository(db);
    expect(await makeService(gateway).create(operator, '1', '3', draftId)).toMatchObject({
      id: first.id,
      draftId,
      version: 1,
    });
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM pos_rewrite_checkout_sessions WHERE operator_id=? AND client_draft_id=?',
      [operator.id, draftId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
    await seed(StoreCounter, { id: 4, store_id: 1, is_active: true });
    await expect(makeService(gateway).create(operator, '1', '4', draftId)).rejects.toMatchObject({
      code: 'CHECKOUT_DRAFT_SCOPE_CONFLICT',
    });
    expect(gateway.calls.filter((call) => call.path === 'coupon')).toHaveLength(1);
    const saved = await repository.get(operator.id, '1', first.id);
    if (!saved) throw new Error('Missing bound checkout');
    const otherOperator = await repository.create({
      ...saved,
      id: crypto.randomUUID(),
      operatorId: '45',
    });
    expect(otherOperator.id).not.toBe(first.id);
    expect(otherOperator.draftId).toBe(draftId);
  });
  it('reserves one external effect across ten concurrent retries and survives a repository restart', async () => {
    const gateway = new FixtureGateway(),
      service = makeService(gateway),
      state = await service.create(operator, '1', '3'),
      input = mutation(0);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.coupon(operator, '1', state.id, input, 'FIXTURE')),
    );
    expect(results.every((result) => ['succeeded', 'inflight'].includes(result.status))).toBe(true);
    expect(gateway.calls.filter((call) => call.path === 'coupon')).toHaveLength(1);
    repository = checkoutRepository(db);
    expect(
      (await makeService(gateway).coupon(operator, '1', state.id, input, 'FIXTURE')).status,
    ).toBe('succeeded');
    expect(gateway.calls.filter((call) => call.path === 'coupon')).toHaveLength(1);
    await expect(
      makeService(gateway).coupon(operator, '1', state.id, input, 'CHANGED'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('serializes competing operation keys for the same checkout version', async () => {
    const gateway = new FixtureGateway(),
      service = makeService(gateway),
      state = await service.create(operator, '1', '3');
    const results = await Promise.allSettled([
      service.coupon(operator, '1', state.id, mutation(0), 'FIRST'),
      service.coupon(operator, '1', state.id, mutation(0), 'SECOND'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(gateway.calls.filter((call) => call.path === 'coupon')).toHaveLength(1);
  });
  it('retains order checkpoints and uncertain receipts after a process restart', async () => {
    const gateway = new FixtureGateway(),
      service = makeService(gateway),
      state = await service.create(operator, '1', '3');
    await service.quote(operator, '1', state.id, mutation(0));
    gateway.intercept = async (path) => {
      if (path === 'payment-confirm')
        throw new CheckoutGatewayError('PAYMENT_CONFIRMATION_UNCERTAIN', 'Fixture timeout', true);
      return undefined;
    };
    const input = mutation(1);
    await expect(service.submit(operator, '1', state.id, input)).rejects.toMatchObject({
      code: 'PAYMENT_CONFIRMATION_UNCERTAIN',
    });
    repository = checkoutRepository(db);
    const restarted = makeService(gateway),
      saved = await restarted.read(operator, '1', state.id);
    expect(saved.phase).toBe('uncertain');
    expect(saved.orderId).toBe('5001');
    expect((await restarted.submit(operator, '1', state.id, input)).status).toBe('uncertain');
    expect(gateway.calls.filter((call) => call.path === 'pos/order')).toHaveLength(1);
  });
  it('freezes a rejected upstream order response after a partial header commit without recreating the order', async () => {
    const gateway = new FixtureGateway(),
      service = makeService(gateway),
      state = await service.create(operator, '1', '3');
    await service.quote(operator, '1', state.id, mutation(0));
    let dispatches = 0;
    gateway.intercept = async (path) => {
      if (path === 'pos/order') {
        dispatches++;
        await seed(Order, { id: 50019, user_id: 777, order_status: 0, payment_status: 0 });
        throw new CheckoutGatewayError(
          'CHECKOUT_REJECTED',
          'Controlled gift collection rejection after source header commit.',
          false,
          422,
        );
      }
      return undefined;
    };
    const input = mutation(1);
    await expect(service.submit(operator, '1', state.id, input)).rejects.toMatchObject({
      code: 'CHECKOUT_REJECTED',
      uncertain: true,
    });
    expect(await service.read(operator, '1', state.id)).toMatchObject({
      phase: 'uncertain',
      orderId: null,
    });
    expect((await service.submit(operator, '1', state.id, input)).status).toBe('uncertain');
    await expect(service.submit(operator, '1', state.id, mutation(1))).rejects.toMatchObject({
      code: 'CHECKOUT_REVIEW_REQUIRED',
    });
    expect(dispatches).toBe(1);
    const [partial] = await connection.query<RowDataPacket[]>(
      'SELECT id FROM orders WHERE id=50019',
    );
    expect(partial).toHaveLength(1);
  });
  it('allows purpose-bound cross-store and online refund previews while denying generic order detail', async () => {
    for (const [id, store] of [
      [6001, 2],
      [6002, null],
    ] as const) {
      await seed(Order, {
        id,
        payment_method: 3,
        parent_order_id: 0,
        is_parent_express: false,
        order_status: 3,
      });
      await seed(HasProduct, { id: id + 100, order_id: id, prod_id: 10 });
      if (store) await seed(OrderStore, { order_id: id, store_id: store, counter_id: 99 });
    }
    let checked = 0;
    const returns = returnReadService(db, new FixtureGateway(), async (user, store) => {
      expect([user, store]).toEqual(['44', '1']);
      checked++;
    });
    for (const id of [6001, 6002]) {
      expect(await returns.refund(operator, '1', String(id), String(id + 100))).toEqual({
        pay_mode: 'prepaid',
        pay_amt: 0,
        is_exchange_order: false,
      });
      await expect(
        ordersService(db, undefined, undefined, () => Date.parse('2026-11-16T12:00:00Z')).detail(
          operator,
          '1',
          String(id),
          { from: '2026-11-16', to: '2026-11-16' },
        ),
      ).rejects.toMatchObject({
        code: 'ORDER_NOT_FOUND',
      });
    }
    expect(checked).toBe(2);
    const denied = returnReadService(db, new FixtureGateway(), async () => {
      throw new AppError(409, 'CHECK_IN_REQUIRED', 'Check in first.');
    });
    await expect(denied.refund(operator, '1', '6001', '6101')).rejects.toMatchObject({
      code: 'CHECK_IN_REQUIRED',
    });
    await expect(returns.refund(operator, '2', '6001', '6101')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
  });
  function paymentInput(channel: PaymentInput['channel'] = 'cash'): PaymentInput {
    return {
      operationId: crypto.randomUUID(),
      channel,
      onlineAmount: channel === 'cash' ? '0.00' : '59.95',
      cashAmount: channel === 'cash' ? '99.95' : '40.00',
      cashReceived: '100.00',
      ...(channel.startsWith('pine-')
        ? { machineId: '1' }
        : channel.startsWith('paytm-')
          ? { machineId: '2' }
          : {}),
    };
  }
  async function physicalCardFixture(orderId: number, collectionId: number) {
    await seed(GiftCardCollection, {
      id: collectionId,
      size: 10,
      is_completed: 1,
      is_block: 0,
      is_printed: 1,
    });
    await seed(GiftVoucher, {
      id: orderId,
      order_id: orderId,
      gift_card_srno: Number(`990${String(collectionId).length}1${collectionId}`),
      voucher_initial_value: 500,
      voucher_code: `FIXTURE-GC-${orderId}`,
      status: 0,
    });
    await connection.execute(
      "UPDATE gift_vouchers SET collection_no=?,gv_type='GIFT_CARD' WHERE id=?",
      [collectionId, orderId],
    );
  }
  async function paymentFixture(orderId: number) {
    await seed(Order, {
      id: orderId,
      order_ref_no: `FIXTURE-${orderId}`,
      user_id: 777,
      payment_method: 14,
      pay_amt: 99.95,
      payment_status: 1,
      order_status: 1,
    });
    await seed(OrderStore, { order_id: orderId, store_id: 1, counter_id: 3 });
    await seed(HasProduct, { order_id: orderId, prod_id: 10, qty: 1, status: 'PROCESSING' });
    await projectionFixture(orderId);
    return String(orderId);
  }
  // This fixture tests the Node consumer's proof binding. The separate patched
  // Go suite exercises real source wallet, voucher, stock and proof transactions.
  async function projectionFixture(orderId: number) {
    const [lines] = await connection.execute<mysql.RowDataPacket[]>(
      'SELECT CAST(id AS CHAR) AS id,CAST(prod_id AS CHAR) AS product_id,amount_to_be_refunded FROM has_products WHERE order_id=?',
      [orderId],
    );
    for (const line of lines)
      await seed(AmountToBeRefundedLog, {
        order_id: orderId,
        prod_id: String(line.product_id),
        has_product_id: String(line.id),
        amount_to_be_refunded: Number(line.amount_to_be_refunded),
      });
    await connection.execute(
      `INSERT INTO pos_rewrite_checkout_projections (order_id,store_id,counter_id,user_id,input_hash,line_count,contract_version,confirmed_at) SELECT orders.id,order_stores.store_id,order_stores.counter_id,orders.user_id,${checkoutHeaderHashSql},(SELECT COUNT(*) FROM has_products WHERE order_id=orders.id),?,UTC_TIMESTAMP() FROM orders JOIN order_stores ON order_stores.order_id=orders.id WHERE orders.id=?`,
      [checkoutProjectionContract, orderId],
    );
    await connection.execute(
      `INSERT INTO pos_rewrite_checkout_projection_lines (order_id,has_product_id,product_id,quantity,input_hash) SELECT has_products.order_id,has_products.id,has_products.prod_id,has_products.qty,${checkoutLineHashSql} FROM has_products WHERE has_products.order_id=?`,
      [orderId],
    );
    // Consumer fixture only: the separate source Go suite proves the original
    // locked customer guard and atomic attestation. No production backfill exists.
    const needsConsent =
      '(orders.tss_money_used>0 OR orders.tss_points_used>0 OR COALESCE(orders.voucher_amt_used,0)>0)';
    const acceptedAt = Date.now() - 1000;
    await connection.execute(
      'DELETE FROM pos_rewrite_checkout_customer_consents WHERE order_id=?',
      [orderId],
    );
    await connection.execute(
      `INSERT INTO pos_rewrite_checkout_customer_consents (order_id,store_id,counter_id,user_id,operator_id,input_hash,required,contact_revision,contact_digest,verified_until_ms,accepted_at_ms,contract_version) SELECT orders.id,order_stores.store_id,order_stores.counter_id,orders.user_id,7,${checkoutHeaderHashSql},CASE WHEN ${needsConsent} THEN 1 ELSE 0 END,CASE WHEN ${needsConsent} THEN 0 ELSE NULL END,CASE WHEN ${needsConsent} THEN REPEAT('a',64) ELSE NULL END,CASE WHEN ${needsConsent} THEN ? ELSE NULL END,?,? FROM orders JOIN order_stores ON order_stores.order_id=orders.id WHERE orders.id=?`,
      [acceptedAt + 900000, acceptedAt, customerConsentContract, orderId],
    );
  }
  function payments(gateway: PaymentGateway, projection = signingEnvironment) {
    const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'payment-test-secret-'.repeat(3),
    });
    return paymentService(
      paymentRepository(db, config, {
        hashSecret: signingEnvironment.hs256,
        projection,
        assertCheckIn: async () => {},
      }),
      gateway,
    );
  }
  const inactiveGateway: PaymentGateway = {
    configured() {},
    async start() {
      throw new Error('Unexpected provider start');
    },
    async status() {
      throw new Error('Unexpected provider enquiry');
    },
    async cancel() {
      throw new Error('Unexpected cancellation');
    },
  };
  function cancellations(
    stockProcedure = availableStockProjection('Asia/Kolkata'),
    membershipProductIds: string[] = [],
    benefitProfile?: CancellationBenefitProfile,
  ) {
    const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'cancellation-test-secret-'.repeat(3),
    });
    return pendingCancellationRepository(db, config, {
      hashSecret: signingEnvironment.hs256,
      projection: signingEnvironment,
      contract: pendingCancellationContract,
      membershipProductIds,
      benefitProfile,
      stockProcedure,
      assertCheckIn: async () => {},
    });
  }
  async function cancellationFixture(orderNumber: number, quantity = 2) {
    const productId = orderNumber + 10000;
    await seed(Product, {
      id: productId,
      product: 'Synthetic plain cancel SKU',
      prod_type: 4,
      parent_prod_id: 0,
    });
    await seed(ProductStore, {
      store_id: 1,
      product_id: productId,
      stock: 10,
      is_avail: false,
      is_del: true,
    });
    await seed(aggregateStock, { prod_id: productId, parent_prod_id: 0, stock: 10, stocked: 0 });
    const id = await paymentFixture(orderNumber);
    await connection.execute(
      "UPDATE has_products SET prod_id=?,qty=?,status='PLACED' WHERE order_id=?",
      [productId, quantity, id],
    );
    await connection.execute('DELETE FROM pos_rewrite_checkout_projections WHERE order_id=?', [id]);
    await connection.execute('DELETE FROM pos_rewrite_checkout_projection_lines WHERE order_id=?', [
      id,
    ]);
    await connection.execute('DELETE FROM amount_to_be_refunded_log WHERE order_id=?', [id]);
    await projectionFixture(orderNumber);
    const service = cancellations(),
      context = await service.context(operator, '1', id);
    return {
      id,
      productId,
      service,
      input: { operationId: crypto.randomUUID(), snapshotHash: context.snapshotHash! },
    };
  }
  it('rejects screening cancellation before projection, wallet or stock work without an inverse customer lock wait', async () => {
    for (const [orderNumber, money] of [
      [907101, 0],
      [907102, 10],
    ] as const) {
      const { id, service, productId } = await cancellationFixture(orderNumber);
      await connection.execute('UPDATE has_products SET prod_id=390238 WHERE order_id=?', [id]);
      await connection.execute('UPDATE orders SET tss_money_used=? WHERE id=?', [money, id]);
      // Stale projection/audit deliberately proves denial precedes those reads.
      expect(await service.context(operator, '1', id)).toMatchObject({
        eligible: false,
        blocker: 'CANCELLATION_SCREENING_UNSUPPORTED',
        receipt: null,
      });
      await expect(
        service.create(operator, '1', id, {
          operationId: crypto.randomUUID(),
          snapshotHash: 'a'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: 'CANCELLATION_SCREENING_UNSUPPORTED' });
      await expect(service.context({ ...operator, storeIds: [] }, '1', id)).rejects.toMatchObject({
        code: 'STORE_ACCESS_DENIED',
      });
      const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'screening-cancellation-secret-'.repeat(3),
      });
      let userReady: () => void = () => {},
        orderReady: () => void = () => {},
        readReady: () => void = () => {};
      const userHeld = new Promise<void>((resolve) => {
          userReady = resolve;
        }),
        orderHeld = new Promise<void>((resolve) => {
          orderReady = resolve;
        }),
        readStarted = new Promise<void>((resolve) => {
          readReady = resolve;
        });
      let orderLocks = 0;
      const guarded = pendingCancellationRepository(db, config, {
        hashSecret: signingEnvironment.hs256,
        projection: signingEnvironment,
        contract: pendingCancellationContract,
        membershipProductIds: [],
        stockProcedure: availableStockProjection('Asia/Kolkata'),
        assertCheckIn: async (_actor, _store, counter) => {
          if (counter !== undefined) {
            orderLocks++;
            orderReady();
            await readStarted;
          }
        },
      });
      const holder = db.get('writer').transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM users WHERE id=777 FOR UPDATE`);
        userReady();
        await orderHeld;
        const read = tx.execute(sql`SELECT id FROM orders WHERE id=${BigInt(id)} FOR SHARE`);
        readReady();
        await read;
      });
      await userHeld;
      try {
        const [context] = await Promise.all([guarded.context(operator, '1', id), holder]);
        expect(context.blocker).toBe('CANCELLATION_SCREENING_UNSUPPORTED');
        expect(orderLocks).toBe(1); // No DB retry may conceal an inversion.
      } finally {
        orderReady();
        readReady();
        await holder.catch(() => {});
      }
      const [orders] = await connection.query<RowDataPacket[]>(
        'SELECT order_status,payment_status,tss_money_used FROM orders WHERE id=?',
        [id],
      );
      expect(orders[0]).toMatchObject({
        order_status: 1,
        payment_status: 1,
        tss_money_used: money,
      });
      const [stock] = await connection.query<RowDataPacket[]>(
        'SELECT stock FROM product_store WHERE product_id=?',
        [productId],
      );
      expect(stock[0]?.stock).toBe(10);
      const [commands] = await connection.query<RowDataPacket[]>(
        'SELECT id FROM pos_rewrite_pending_order_cancellations WHERE order_id=?',
        [id],
      );
      expect(commands).toHaveLength(0);
    }
  });
  it('keeps an original cancellation receipt readable after screening classification changes without another effect', async () => {
    const { id, service, input } = await cancellationFixture(907103);
    const original = await service.create(operator, '1', id, input);
    await connection.execute('UPDATE has_products SET prod_id=390238 WHERE order_id=?', [id]);
    expect((await service.context(operator, '1', id)).receipt).toEqual(original);
    expect(await service.get(operator, '1', id, input.operationId)).toEqual(original);
    expect(await service.create(operator, '1', id, input)).toEqual(original);
    const [logs] = await connection.query<RowDataPacket[]>(
      'SELECT id FROM pos_transaction_logs WHERE order_id=?',
      [id],
    );
    expect(logs).toHaveLength(1);
  });
  it('cancels one pending zero-benefit order atomically across twenty retries with source stock projection and immutable replay', async () => {
    const { id, productId, service, input } = await cancellationFixture(906001);
    await seed(StoreDayClose, {
      store_id: 1,
      close_date: '2026-11-16',
      version: 20,
      status: 'CLOSED',
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.create(operator, '1', id, input)),
    );
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
      true,
    );
    expect(results[0]).toMatchObject({
      status: 'cancelled',
      cashRefunded: '0.00',
      restoredProducts: [{ productId: String(productId), quantity: 2, before: 10, after: 12 }],
    });
    expect(await service.get(operator, '1', id, input.operationId)).toEqual(results[0]);
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT stock,is_avail,is_del FROM product_store WHERE store_id=1 AND product_id=?',
      [productId],
    );
    expect(rows[0]).toMatchObject({ stock: 12, is_avail: 0, is_del: 1 });
    const [statuses] = await connection.execute<RowDataPacket[]>(
      'SELECT order_status,payment_status FROM orders WHERE id=?',
      [id],
    );
    expect(statuses[0]).toMatchObject({ order_status: 4, payment_status: 2 });
    const [logs] = await connection.execute<RowDataPacket[]>(
      'SELECT pay_dict,comment FROM pos_transaction_logs WHERE order_id=?',
      [id],
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      pay_dict: '{}',
      comment: 'Order Cancelled : No Transaction Made',
    });
    const [outbox] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM pos_rewrite_administration_outbox WHERE id=?',
      [input.operationId],
    );
    expect(outbox).toHaveLength(1);
    const [closed] = await connection.query<RowDataPacket[]>(
      "SELECT status FROM store_day_close WHERE store_id=1 AND close_date='2026-11-16' ORDER BY version DESC LIMIT 1",
    );
    expect(closed[0]?.status).toBe('STALE');
    await connection.execute(
      "DELETE FROM store_day_close WHERE store_id=1 AND close_date='2026-11-16' AND version=20",
    );
    // A source repair cannot erase the durable cancellation or reopen collection.
    await connection.execute('UPDATE orders SET order_status=1,payment_status=1 WHERE id=?', [id]);
    expect(await service.create(operator, '1', id, input)).toEqual(results[0]);
    await expect(
      payments(inactiveGateway).start(operator, '1', id, paymentInput()),
    ).rejects.toMatchObject({ code: 'ORDER_CANCELLATION_RECORDED' });
    await expect(
      service.create(operator, '1', id, { ...input, operationId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'ORDER_ALREADY_CANCELLED' });
  });
  it('rolls cancellation stock, order, audit and command back together on a late SQL failure, then retries the original intent', async () => {
    const { id, productId, service, input } = await cancellationFixture(906002);
    await connection.query(
      `CREATE TRIGGER reject_cancel_log BEFORE INSERT ON pos_transaction_logs FOR EACH ROW BEGIN IF NEW.order_id=906002 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='controlled cancellation rollback'; END IF; END`,
    );
    try {
      await expect(service.create(operator, '1', id, input)).rejects.toThrow();
    } finally {
      await connection.query('DROP TRIGGER reject_cancel_log');
    }
    const [stocks] = await connection.execute<RowDataPacket[]>(
      'SELECT stock FROM product_store WHERE store_id=1 AND product_id=?',
      [productId],
    );
    expect(stocks[0]?.stock).toBe(10);
    expect((await service.context(operator, '1', id)).eligible).toBe(true);
    await expect(service.get(operator, '1', id, input.operationId)).rejects.toMatchObject({
      code: 'CANCELLATION_NOT_FOUND',
    });
    expect((await service.create(operator, '1', id, input)).restoredProducts[0]?.after).toBe(12);
  });
  it('fences pending provider states, collected split cash, spent benefits, membership and changed snapshots', async () => {
    const legacy = await legacyFixture(906003);
    expect(
      (await legacy.service.paymentContext(operator, '1', legacy.id)).legacyPayment,
    ).toBeTruthy();
    expect((await cancellations().context(operator, '1', legacy.id)).blocker).toBe(
      'CANCELLATION_PAYMENT_UNRESOLVED',
    );
    const { id, service, input, productId } = await cancellationFixture(906004);
    expect(
      (await cancellations(undefined, [String(productId)]).context(operator, '1', id)).blocker,
    ).toBe('CANCELLATION_MEMBERSHIP_RESTORATION_UNVERIFIED');
    await expect(
      service.create(operator, '1', id, { ...input, snapshotHash: 'a'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'CANCELLATION_STATE_CHANGED' });
    await connection.execute(
      'UPDATE amount_to_be_refunded_log SET tss_money_used=0.01 WHERE order_id=?',
      [id],
    );
    expect((await service.context(operator, '1', id)).blocker).toBe(
      'CANCELLATION_BENEFIT_RESTORATION_UNVERIFIED',
    );
    await connection.execute(
      'UPDATE amount_to_be_refunded_log SET tss_money_used=0 WHERE order_id=?',
      [id],
    );
    const failed = payments({
      ...inactiveGateway,
      start: async () => ({ status: 'failed', reference: 'not-collected', code: 'FAILED' }),
    });
    await failed.start(operator, '1', id, paymentInput('pine-card'));
    expect((await service.context(operator, '1', id)).blocker).toBe(
      'CANCELLATION_PAYMENT_UNRESOLVED',
    );
    await expect(service.context(operator, '2', id)).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
  });
  it('serializes different payment commands against cancellation without collecting money and restoring the same stock', async () => {
    for (let index = 0; index < 6; index++) {
      const { id, productId, service, input } = await cancellationFixture(906020 + index),
        pay = payments(inactiveGateway),
        payment = paymentInput();
      const outcomes = await Promise.allSettled([
        service.create(operator, '1', id, input),
        pay.start(operator, '1', id, payment),
      ]);
      expect(outcomes.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
      const [orders] = await connection.execute<RowDataPacket[]>(
        'SELECT order_status,payment_status FROM orders WHERE id=?',
        [id],
      );
      const [stocks] = await connection.execute<RowDataPacket[]>(
        'SELECT stock FROM product_store WHERE store_id=1 AND product_id=?',
        [productId],
      );
      const cancelled = outcomes[0]!.status === 'fulfilled';
      expect(orders[0]).toMatchObject(
        cancelled ? { order_status: 4, payment_status: 2 } : { order_status: 3, payment_status: 4 },
      );
      expect(stocks[0]?.stock).toBe(cancelled ? 12 : 10);
    }
    const orderId = await paymentFixture(906029),
      paymentService = payments(inactiveGateway);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        paymentService.start(operator, '1', orderId, paymentInput()),
      ),
    );
    expect(outcomes.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const [attempts] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM pos_rewrite_payment_attempts WHERE order_id=?',
      [orderId],
    );
    expect(attempts).toHaveLength(1);
  });
  it('groups duplicate SKU quantities once and rejects revoked actor scope and changed cancellation receipts', async () => {
    const { id, productId } = await cancellationFixture(906030);
    await seed(HasProduct, { order_id: Number(id), prod_id: productId, qty: 3, status: 'PLACED' });
    await connection.execute('DELETE FROM pos_rewrite_checkout_projections WHERE order_id=?', [id]);
    await connection.execute('DELETE FROM pos_rewrite_checkout_projection_lines WHERE order_id=?', [
      id,
    ]);
    await connection.execute('DELETE FROM amount_to_be_refunded_log WHERE order_id=?', [id]);
    await projectionFixture(Number(id));
    let stockCalls = 0;
    const originalStock = availableStockProjection('Asia/Kolkata'),
      service = cancellations(async (tx, value) => {
        stockCalls++;
        await originalStock(tx, value);
      }),
      context = await service.context(operator, '1', id),
      input = { operationId: crypto.randomUUID(), snapshotHash: context.snapshotHash! };
    await connection.execute(
      `UPDATE ${mysql.escapeId(getTableConfig(PosUser).name)} SET user_type=2 WHERE id=44`,
    );
    try {
      await expect(service.create(operator, '1', id, input)).rejects.toMatchObject({ status: 403 });
    } finally {
      await connection.execute(
        `UPDATE ${mysql.escapeId(getTableConfig(PosUser).name)} SET user_type=1 WHERE id=44`,
      );
    }
    const result = await service.create(operator, '1', id, input);
    expect(result.restoredProducts).toEqual([
      { productId: String(productId), quantity: 5, before: 10, after: 15 },
    ]);
    expect(stockCalls).toBe(1);
    await connection.execute(
      "UPDATE pos_rewrite_pending_order_cancellations SET receipt=JSON_SET(receipt,'$.cashRefunded','9.00') WHERE id=?",
      [input.operationId],
    );
    await expect(service.get(operator, '1', id, input.operationId)).rejects.toThrow();
  });
  const approvedBenefitProfile: CancellationBenefitProfile = {
    policy: cancellationBenefitPolicy,
    walletWriterContract: 'pos-wallet-user-lock-v1',
    voucherWriterContract: 'pos-voucher-user-lock-v1',
  };
  async function cancellationWalletFixture(orderId: number) {
    const original = await cancellationFixture(orderId),
      customerId = orderId + 20000;
    await seed(MUser, {
      id: customerId,
      email: `isolated-${customerId}@example.test`,
      status: 1,
      is_block: 0,
      is_disabled: 0,
      tss_money: 100,
      tss_points: 200,
      cashback: 7,
    });
    await connection.execute(
      'UPDATE orders SET user_id=?,tss_money_used=25,tss_points_used=30 WHERE id=?',
      [customerId, original.id],
    );
    await connection.execute('DELETE FROM pos_rewrite_checkout_projections WHERE order_id=?', [
      original.id,
    ]);
    await connection.execute('DELETE FROM pos_rewrite_checkout_projection_lines WHERE order_id=?', [
      original.id,
    ]);
    await connection.execute('DELETE FROM amount_to_be_refunded_log WHERE order_id=?', [
      original.id,
    ]);
    await projectionFixture(orderId);
    await connection.execute(
      'UPDATE amount_to_be_refunded_log SET tss_money_used=25,tss_point_used=30 WHERE order_id=?',
      [original.id],
    );
    for (const [asset, amount, expiry] of [
      ['money', 10, '2020-01-01 00:00:00'],
      ['money', 15, '2099-01-01 00:00:00'],
      ['point', 30, '2098-01-01 00:00:00'],
    ] as const) {
      const [row] = await connection.execute<mysql.ResultSetHeader>(
        `INSERT INTO tss_${asset}_history(user_id,added_amt,used_amt,platform,expiry,is_expired,is_bulk_upload) VALUES (?,?,?,'MISC_COMPENSATION',?,0,0)`,
        [customerId, amount, amount, expiry],
      );
      await connection.execute(
        `INSERT INTO order_tss_${asset}(order_id,tss_${asset}_id,used_amount,tss_${asset}_return) VALUES (?,?,?,0)`,
        [original.id, row.insertId, amount],
      );
    }
    const service = cancellations(undefined, [], approvedBenefitProfile),
      context = await service.context(operator, '1', original.id);
    expect(context.eligible).toBe(true);
    return {
      ...original,
      customerId,
      service,
      input: { operationId: crypto.randomUUID(), snapshotHash: context.snapshotHash! },
    };
  }
  it('atomically restores the approved original-expiry Money/Points policy with stock and one replay receipt across twenty callers', async () => {
    const { id, customerId, productId, service, input } = await cancellationWalletFixture(906050);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.create(operator, '1', id, input)),
    );
    expect(results.every((row) => JSON.stringify(row) === JSON.stringify(results[0]))).toBe(true);
    expect(results[0]?.benefits).toMatchObject({
      moneyCredited: '15',
      moneyExpired: '10',
      pointsCredited: '30',
      pointsExpired: '0',
    });
    const [balances] = await connection.query<RowDataPacket[]>(
      'SELECT tss_money,tss_points,cashback FROM users WHERE id=?',
      [customerId],
    );
    expect(balances[0]).toMatchObject({ tss_money: 115, tss_points: 230, cashback: 7 });
    const [stocks] = await connection.query<RowDataPacket[]>(
      'SELECT stock FROM product_store WHERE product_id=? AND store_id=1',
      [productId],
    );
    expect(stocks[0]?.stock).toBe(12);
    const [entries] = await connection.query<RowDataPacket[]>(
      'SELECT platform,added_amt FROM tss_money_history WHERE order_id=? ORDER BY id',
      [id],
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((row) => row.added_amt).sort((a, b) => a - b)).toEqual([-10, 15]);
    expect(await service.get(operator, '1', id, input.operationId)).toEqual(results[0]);
  });
  it('rolls benefit restoration, stock, status and command back together on a late cancellation ledger failure', async () => {
    const { id, customerId, productId, service, input } = await cancellationWalletFixture(906051);
    await connection.query(
      `CREATE TRIGGER reject_wallet_cancel BEFORE INSERT ON pos_transaction_logs FOR EACH ROW BEGIN IF NEW.order_id=906051 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='controlled wallet cancellation rollback'; END IF; END`,
    );
    try {
      await expect(service.create(operator, '1', id, input)).rejects.toThrow();
    } finally {
      await connection.query('DROP TRIGGER reject_wallet_cancel');
    }
    const [balances] = await connection.query<RowDataPacket[]>(
      'SELECT tss_money,tss_points,cashback FROM users WHERE id=?',
      [customerId],
    );
    expect(balances[0]).toMatchObject({ tss_money: 100, tss_points: 200, cashback: 7 });
    const [stocks] = await connection.query<RowDataPacket[]>(
      'SELECT stock FROM product_store WHERE product_id=? AND store_id=1',
      [productId],
    );
    expect(stocks[0]?.stock).toBe(10);
    const [entries] = await connection.query<RowDataPacket[]>(
      'SELECT id FROM tss_money_history WHERE order_id=?',
      [id],
    );
    expect(entries).toHaveLength(0);
    expect((await service.context(operator, '1', id)).eligible).toBe(true);
    await expect(service.get(operator, '1', id, input.operationId)).rejects.toMatchObject({
      code: 'CANCELLATION_NOT_FOUND',
    });
    expect((await service.create(operator, '1', id, input)).benefits?.moneyCredited).toBe('15');
  });
  async function legacyFixture(orderId: number, provider: 'pine' | 'paytm' = 'pine') {
    const id = await paymentFixture(orderId);
    await seed(provider === 'pine' ? PosTerminalTransaction : PosPaytmTransaction, {
      order_id: orderId,
      store_id: 1,
      transaction_id: `OLD${orderId}`,
      amount: '59.95',
      cash_amount: '40.00',
      cash_recieved: '100.00',
      total_amount: '99.95',
      payment_mode: provider === 'pine' ? 1 : 1003,
      platform: 'txn_created',
      is_active: true,
      ...(provider === 'pine'
        ? { plutus_id: `P${orderId}`, store_pos_code: 'fixture', imei: 'fixture' }
        : { paytm_mid: 'fixture-mid', paytm_tid: 'fixture-tid' }),
    });
    const service = payments(inactiveGateway),
      context = await service.paymentContext(operator, '1', id);
    return { id, service, input: { operationId: crypto.randomUUID(), ...context.legacyPayment! } };
  }
  it('adopts one original terminal dispatch across twenty callers and settles by status only', async () => {
    const { id, input } = await legacyFixture(905601);
    let starts = 0,
      statuses = 0;
    const service = payments({
      ...inactiveGateway,
      start: async () => {
        starts++;
        throw new Error('Must not start');
      },
      status: async () => {
        statuses++;
        return { status: 'paid', reference: 'P905601', code: 'TXN APPROVED' };
      },
    });
    expect(await service.paymentContext(operator, '1', id)).toMatchObject({
      canRecordPayment: false,
      activeAttemptId: null,
      legacyPayment: { provider: 'pine', legacyId: input.legacyId },
    });
    const adopted = await Promise.all(
      Array.from({ length: 20 }, () => service.adoptLegacy(operator, '1', id, input)),
    );
    expect(adopted.every((row) => row.id === input.operationId && row.status === 'uncertain')).toBe(
      true,
    );
    expect(starts + statuses).toBe(0);
    expect(JSON.stringify(adopted)).not.toContain('inputHash');
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT * FROM pos_rewrite_legacy_payment_recoveries WHERE order_id=?',
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(await service.reconcile(operator, '1', id, input.operationId)).toMatchObject({
      status: 'paid',
      cashAmount: '40.00',
      onlineAmount: '59.95',
    });
    expect(starts).toBe(0);
    expect(statuses).toBe(1);
    expect((await service.adoptLegacy(operator, '1', id, input)).status).toBe('paid');
    expect((await service.paymentContext(operator, '1', id)).activeAttemptId).toBe(
      input.operationId,
    );
  });
  it('reads and reconciles versionless legacy fingerprints without re-dispatching or weakening tamper detection', async () => {
    const { id, input } = await legacyFixture(905609);
    let statuses = 0;
    const service = payments({
      ...inactiveGateway,
      status: async () => {
        statuses++;
        return { status: 'failed', reference: 'P905609', code: 'FAILED' };
      },
    });
    await service.adoptLegacy(operator, '1', id, input);
    const original = await db
      .get('writer')
      .transaction((tx) => readOrderPaymentEvidence(tx, id, signingEnvironment.hs256));
    const source = original.records.find(
      (row) => row.provider === 'pine' && row.id === input.legacyId,
    )!;
    await connection.execute(
      "UPDATE pos_rewrite_payment_attempts SET state=JSON_SET(JSON_REMOVE(state,'$.legacySource.version'),'$.legacySource.inputHash',?) WHERE id=?",
      [legacyPaymentSourceHash(source, signingEnvironment.hs256), input.operationId],
    );
    expect((await service.get(operator, '1', id, input.operationId)).status).toBe('uncertain');
    expect((await service.reconcile(operator, '1', id, input.operationId)).status).toBe('failed');
    expect(statuses).toBe(1);
    await connection.execute(
      "UPDATE pos_terminal_transactions SET store_pos_code='changed-device' WHERE order_id=? AND platform='txn_created'",
      [id],
    );
    await expect(service.paymentContext(operator, '1', id)).rejects.toMatchObject({
      code: 'LEGACY_PAYMENT_REVIEW_REQUIRED',
    });
  });
  it('retains locally cancelled Paytm evidence until provider failure is confirmed and never sends a cancellation', async () => {
    const { id, input } = await legacyFixture(905602, 'paytm');
    await connection.execute('UPDATE pos_paytm_transactions SET is_active=0 WHERE order_id=?', [
      id,
    ]);
    await seed(PosPaytmTransaction, {
      order_id: Number(id),
      store_id: 1,
      transaction_id: `OLD${id}`,
      platform: 'txn_cancelled',
      is_active: false,
      api_response: 'NIL',
    });
    const service = payments({
      ...inactiveGateway,
      status: async () => ({ status: 'failed', reference: `OLD${id}`, code: '0011' }),
    });
    await expect(service.start(operator, '1', id, paymentInput())).rejects.toMatchObject({
      code: 'LEGACY_PAYMENT_ACTIVE',
    });
    await service.adoptLegacy(operator, '1', id, input);
    await expect(service.cancel(operator, '1', id, input.operationId)).rejects.toMatchObject({
      code: 'PAYTM_CANCELLATION_UNCONFIRMED',
    });
    expect((await service.reconcile(operator, '1', id, input.operationId)).status).toBe('failed');
    expect((await service.paymentContext(operator, '1', id)).canRecordPayment).toBe(true);
    await connection.execute(
      "UPDATE pos_paytm_transactions SET amount=59.94 WHERE order_id=? AND platform='txn_created'",
      [id],
    );
    await expect(service.start(operator, '1', id, paymentInput())).rejects.toMatchObject({
      code: 'LEGACY_PAYMENT_REVIEW_REQUIRED',
    });
  });
  it('rejects ambiguous machines, source tampering, cross-store scope and missing projection before adopting legacy money', async () => {
    const { id, input, service } = await legacyFixture(905603);
    await seed(PosMachine, {
      id: 99,
      store_id: 1,
      counter_id: 3,
      is_active: 1,
      merchant_store_pos_code: 'fixture',
      imei_no: 'fixture',
    });
    try {
      await expect(service.adoptLegacy(operator, '1', id, input)).rejects.toMatchObject({
        code: 'LEGACY_PAYMENT_REVIEW_REQUIRED',
      });
    } finally {
      await connection.execute('DELETE FROM pos_machines WHERE id=99');
    }
    await connection.execute('DELETE FROM pos_rewrite_checkout_projections WHERE order_id=?', [id]);
    await expect(service.adoptLegacy(operator, '1', id, input)).rejects.toMatchObject({
      code: 'CHECKOUT_PROJECTION_UNCONFIRMED',
    });
    await connection.execute('DELETE FROM pos_rewrite_checkout_projection_lines WHERE order_id=?', [
      id,
    ]);
    await projectionFixture(Number(id));
    await service.adoptLegacy(operator, '1', id, input);
    await connection.execute(
      "UPDATE pos_terminal_transactions SET amount=59.94 WHERE order_id=? AND platform='txn_created'",
      [id],
    );
    await expect(service.get(operator, '1', id, input.operationId)).rejects.toMatchObject({
      code: 'LEGACY_PAYMENT_REVIEW_REQUIRED',
    });
    await expect(service.paymentContext(operator, '2', id)).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
  });
  it('refuses money already recorded in legacy completion or tender columns even after status reset', async () => {
    const { id, service } = await legacyFixture(905604);
    await seed(PosTerminalTransaction, {
      order_id: Number(id),
      store_id: 1,
      transaction_id: `OLD${id}`,
      platform: 'txn_completed',
      amount: '59.95',
      cash_amount: '40.00',
      cash_recieved: '100.00',
      is_active: false,
    });
    expect(await service.paymentContext(operator, '1', id)).toMatchObject({
      canRecordPayment: false,
      legacyPayment: null,
      blocker: 'LEGACY_PAYMENT_REVIEW_REQUIRED',
    });
    await expect(service.start(operator, '1', id, paymentInput())).rejects.toMatchObject({
      code: 'LEGACY_PAYMENT_ACTIVE',
    });
    const another = await paymentFixture(905605);
    await connection.execute('UPDATE order_stores SET offline_payment=99.95 WHERE order_id=?', [
      another,
    ]);
    await expect(service.start(operator, '1', another, paymentInput())).rejects.toMatchObject({
      code: 'ORDER_NOT_PAYABLE',
    });
  });
  it('freezes the original server note into one cash payment and rejects changed checkout/hash/amount before settlement', async () => {
    const orderId = await paymentFixture(905101),
      fixture = new FixtureGateway(),
      checkout = checkoutService(repository, fixture, signingEnvironment, {
        migrationV2: true,
        assertCheckIn: async () => {},
        verifyRefundAllocations: async () => {},
      });
    fixture.intercept = async (path) =>
      path === 'processorder'
        ? { ...fixture.empty(), meta: { items: [{ name: 'calculations', total: '99.95' }] } }
        : undefined;
    const created = await checkout.create(operator, '1', '3');
    await checkout.quote(operator, '1', created.id, {
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
    });
    const note =
      '#Cash Received:100.00\n#Cash To Be Accepted:99.95\n#Cash To Be Return:0.05\nCafé € — “cash”';
    await checkout.settlementNote(
      operator,
      '1',
      created.id,
      { operationId: crypto.randomUUID(), expectedVersion: 1 },
      note,
      '100.00',
    );
    const saved = (await repository.get(operator.id, '1', created.id))!;
    expect(saved.settlementNote?.message).toBe(note);
    await connection.execute('UPDATE pos_rewrite_checkout_sessions SET state=? WHERE id=?', [
      JSON.stringify({ ...saved, phase: 'submitted', orderId }),
      created.id,
    ]);
    const service = payments(inactiveGateway),
      input = {
        ...paymentInput(),
        checkoutNote: { checkoutId: created.id, noteHash: saved.settlementNote!.hash },
      };
    for (const altered of [
      { ...input, checkoutNote: { ...input.checkoutNote, noteHash: 'f'.repeat(64) } },
      { ...input, checkoutNote: { ...input.checkoutNote, checkoutId: crypto.randomUUID() } },
      { ...input, cashReceived: '101.00' },
    ]) {
      await expect(service.start(operator, '1', orderId, altered)).rejects.toMatchObject({
        code: 'PAYMENT_NOTE_MISMATCH',
      });
      const [attempts] = await connection.query<RowDataPacket[]>(
        'SELECT id FROM pos_rewrite_payment_attempts WHERE order_id=?',
        [orderId],
      );
      expect(attempts).toHaveLength(0);
    }
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.start(operator, '1', orderId, input)),
    );
    expect(results.every((result) => ['paid', 'dispatching'].includes(result.status))).toBe(true);
    const paid = await service.get(operator, '1', orderId, input.operationId);
    expect(paid).toMatchObject({ status: 'paid', checkoutNote: input.checkoutNote });
    expect(JSON.stringify(paid)).not.toContain('Café');
    const [records] = await connection.query<RowDataPacket[]>(
      'SELECT message,offline_payment,offline_payment_recieved FROM order_stores WHERE order_id=?',
      [orderId],
    );
    expect(records[0]).toMatchObject({
      message: note,
      offline_payment: '99.95',
      offline_payment_recieved: '100.00',
    });
    const [logs] = await connection.query<RowDataPacket[]>(
      'SELECT id FROM pos_transaction_logs WHERE order_id=?',
      [orderId],
    );
    expect(logs).toHaveLength(1);
    expect((await service.start(operator, '1', orderId, input)).status).toBe('paid');
    await expect(
      service.start(operator, '1', orderId, {
        ...input,
        checkoutNote: { ...input.checkoutNote, noteHash: 'f'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    // Simulate a crash after the accepted attempt, then a late SQL failure.
    // The attempt's frozen text must survive independently of the mutable cart.
    const retryOrderId = await paymentFixture(905102),
      retryState = {
        ...saved,
        id: crypto.randomUUID(),
        draftId: crypto.randomUUID(),
        phase: 'submitted' as const,
        orderId: retryOrderId,
      };
    retryState.settlementNote = createSettlementNote(
      retryState,
      note,
      '99.95',
      '100.00',
      signingEnvironment.hs256,
    );
    await repository.create(retryState);
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'payment-note-test-secret-'.repeat(3),
      }),
      writer = paymentRepository(db, config, {
        hashSecret: signingEnvironment.hs256,
        projection: signingEnvironment,
        assertCheckIn: async () => {},
      }),
      retryInput = {
        ...paymentInput(),
        checkoutNote: { checkoutId: retryState.id, noteHash: retryState.settlementNote.hash },
      },
      accepted = await writer.begin(operator, '1', retryOrderId, retryInput);
    await connection.execute('UPDATE pos_rewrite_checkout_sessions SET state=? WHERE id=?', [
      JSON.stringify({
        ...retryState,
        settlementNote: { ...retryState.settlementNote, message: 'Changed after acceptance' },
      }),
      retryState.id,
    ]);
    await connection.query(`CREATE TRIGGER reject_note_cash_log BEFORE INSERT ON pos_transaction_logs FOR EACH ROW
      BEGIN IF NEW.order_id=905102 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='controlled late note rollback'; END IF; END`);
    try {
      await expect(
        writer.decision(
          operator,
          '1',
          retryOrderId,
          retryInput.operationId,
          { status: 'paid', reference: null, code: 'OPERATOR_RECORDED' },
          null,
          accepted.attempt.busyOperationId,
        ),
      ).rejects.toThrow();
      const [rolledBack] = await connection.query<RowDataPacket[]>(
        'SELECT message,offline_payment FROM order_stores WHERE order_id=?',
        [retryOrderId],
      );
      expect(rolledBack[0]).toMatchObject({ message: '', offline_payment: '0.00' });
      expect((await writer.get(operator, '1', retryOrderId, retryInput.operationId)).status).toBe(
        'dispatching',
      );
    } finally {
      await connection.query('DROP TRIGGER reject_note_cash_log');
    }
    expect(
      (
        await writer.decision(
          operator,
          '1',
          retryOrderId,
          retryInput.operationId,
          { status: 'paid', reference: null, code: 'OPERATOR_RECORDED' },
          null,
          accepted.attempt.busyOperationId,
        )
      ).status,
    ).toBe('paid');
    const [repaired] = await connection.query<RowDataPacket[]>(
      'SELECT message,offline_payment FROM order_stores WHERE order_id=?',
      [retryOrderId],
    );
    expect(repaired[0]).toMatchObject({ message: note, offline_payment: '99.95' });
  });
  it('rejects missing/changed refund deployment contracts and legacy per-product overwrite before provider dispatch', async () => {
    const orderId = await paymentFixture(905001),
      input = {
        operationId: crypto.randomUUID(),
        channel: 'pine-card' as const,
        machineId: '1',
        onlineAmount: '99.95',
        cashAmount: '0.00',
        cashReceived: '0.00',
      };
    for (const projection of [
      { ...signingEnvironment, refundAllocationContract: '' },
      { ...signingEnvironment, refundSourcePatchHash: '0'.repeat(64) },
    ])
      await expect(
        payments(inactiveGateway, projection).start(operator, '1', orderId, input),
      ).rejects.toMatchObject({ code: 'REFUND_ALLOCATION_CONTRACT_UNVERIFIED' });
    await connection.execute(
      'UPDATE amount_to_be_refunded_log SET amount_to_be_refunded=10.01 WHERE order_id=?',
      [orderId],
    );
    await expect(
      payments(inactiveGateway).start(operator, '1', orderId, input),
    ).rejects.toMatchObject({ code: 'REFUND_ALLOCATION_UNCONFIRMED' });
    await connection.execute('DELETE FROM amount_to_be_refunded_log WHERE order_id=?', [orderId]);
    await expect(
      payments(inactiveGateway).start(operator, '1', orderId, input),
    ).rejects.toMatchObject({ code: 'REFUND_ALLOCATION_UNCONFIRMED' });
    const [attempts] = await connection.execute<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM pos_rewrite_payment_attempts WHERE order_id=?',
      [orderId],
    );
    expect(Number(attempts[0]!.count)).toBe(0);
  });
  it('freezes a provider-paid result if refund rows change during the charge and never dispatches that charge again', async () => {
    const orderId = await paymentFixture(905002),
      input = {
        operationId: crypto.randomUUID(),
        channel: 'pine-card' as const,
        machineId: '1',
        onlineAmount: '99.95',
        cashAmount: '0.00',
        cashReceived: '0.00',
      };
    let charges = 0;
    const gateway: PaymentGateway = {
      ...inactiveGateway,
      start: async () => {
        charges++;
        await connection.execute(
          'UPDATE amount_to_be_refunded_log SET amount_to_be_refunded=10.01 WHERE order_id=?',
          [orderId],
        );
        return { status: 'paid', reference: 'fixture-provider-paid', code: 'APPROVED' };
      },
    };
    const service = payments(gateway);
    await expect(service.start(operator, '1', orderId, input)).rejects.toMatchObject({
      code: 'REFUND_ALLOCATION_UNCONFIRMED',
    });
    expect((await service.get(operator, '1', orderId, input.operationId)).status).toBe('uncertain');
    expect((await service.start(operator, '1', orderId, input)).status).toBe('uncertain');
    expect(charges).toBe(1);
    const [orders] = await connection.execute<mysql.RowDataPacket[]>(
      'SELECT payment_status FROM orders WHERE id=?',
      [orderId],
    );
    expect(orders[0]!.payment_status).toBe(1);
  });
  it('checks current customer status/block flags before confirmation or any terminal charge, accepting a nullable clear flag', async () => {
    const orderId = await paymentFixture(905003);
    try {
      for (const [status, blocked, disabled] of [
        [0, null, null],
        [1, 1, null],
        [1, 2, null],
        [1, null, 1],
        [1, null, 2],
      ] as const) {
        await connection.execute(
          'UPDATE users SET status=?,is_block=?,is_disabled=? WHERE id=777',
          [status, blocked, disabled],
        );
        await expect(
          payments(inactiveGateway).start(operator, '1', orderId, paymentInput('pine-card')),
        ).rejects.toMatchObject({ code: 'CHECKOUT_CUSTOMER_UNAVAILABLE' });
        await expect(
          db.get('writer').transaction((tx) =>
            assertOrderRefundAllocations(tx, {
              orderId,
              storeId: '1',
              counterId: '3',
              customerId: '777',
            }),
          ),
        ).rejects.toMatchObject({ code: 'CHECKOUT_CUSTOMER_UNAVAILABLE' });
      }
      const [attempts] = await connection.execute<RowDataPacket[]>(
        'SELECT COUNT(*) count FROM pos_rewrite_payment_attempts WHERE order_id=?',
        [orderId],
      );
      expect(Number(attempts[0]!.count)).toBe(0);
    } finally {
      await connection.execute(
        'UPDATE users SET status=1,is_block=NULL,is_disabled=NULL WHERE id=777',
      );
    }
    await expect(
      db.get('writer').transaction((tx) =>
        assertCheckoutProjection(tx, {
          orderId,
          storeId: '1',
          counterId: '3',
          customerId: '777',
        }),
      ),
    ).resolves.toBeUndefined();
  });
  it('freezes a provider-paid result when the customer is blocked during charge without another provider dispatch', async () => {
    const orderId = await paymentFixture(905004),
      input = paymentInput('pine-card');
    let charges = 0;
    const service = payments({
      ...inactiveGateway,
      start: async () => {
        charges++;
        await connection.execute('UPDATE users SET is_block=1 WHERE id=777');
        return { status: 'paid', reference: 'fixture-provider-paid', code: 'APPROVED' };
      },
    });
    try {
      await expect(service.start(operator, '1', orderId, input)).rejects.toMatchObject({
        code: 'CHECKOUT_CUSTOMER_UNAVAILABLE',
      });
      expect((await service.get(operator, '1', orderId, input.operationId)).status).toBe(
        'uncertain',
      );
      expect((await service.start(operator, '1', orderId, input)).status).toBe('uncertain');
      expect(charges).toBe(1);
    } finally {
      await connection.execute('UPDATE users SET status=1,is_block=NULL WHERE id=777');
    }
  });
  it('blocks dispatch without a verified ordinary projection contract before reserving or charging', async () => {
    const orderId = await paymentFixture(8701);
    for (const projection of [
      { ...signingEnvironment, checkoutProjectionContract: '' },
      { ...signingEnvironment, checkoutProjectionKey: '' },
      { ...signingEnvironment, checkoutProjectionKey: 'invalid-header\n'.repeat(4) },
    ]) {
      await expect(
        payments(inactiveGateway, projection).start(
          operator,
          '1',
          orderId,
          paymentInput('pine-card'),
        ),
      ).rejects.toMatchObject({ code: 'CHECKOUT_PROJECTION_CONTRACT_UNVERIFIED' });
    }
    const [attempts] = await connection.query<RowDataPacket[]>(
      'SELECT id FROM pos_rewrite_payment_attempts WHERE order_id=?',
      [orderId],
    );
    expect(attempts).toHaveLength(0);
  });
  it('rejects missing, stale, cross-scope and incomplete allocation proofs before any terminal charge', async () => {
    const cases = [
      'DELETE FROM pos_rewrite_checkout_projections WHERE order_id=?',
      "UPDATE pos_rewrite_checkout_projections SET contract_version='obsolete' WHERE order_id=?",
      'UPDATE pos_rewrite_checkout_projections SET store_id=2 WHERE order_id=?',
      'UPDATE pos_rewrite_checkout_projections SET counter_id=4 WHERE order_id=?',
      'UPDATE pos_rewrite_checkout_projections SET user_id=1001 WHERE order_id=?',
      'UPDATE pos_rewrite_checkout_projections SET line_count=2 WHERE order_id=?',
      'UPDATE orders SET user_id=1001 WHERE id=?',
      'UPDATE orders SET pay_amt=99.94 WHERE id=?',
      'UPDATE orders SET tss_money_used=0.01 WHERE id=?',
      'UPDATE orders SET voucher_amt_used=0.25 WHERE id=?',
      'UPDATE orders SET original_order_id=1 WHERE id=?',
      'UPDATE has_products SET price=0.01 WHERE order_id=?',
      'UPDATE has_products SET qty=2 WHERE order_id=?',
      'UPDATE has_products SET prod_id=11 WHERE order_id=?',
      'DELETE FROM pos_rewrite_checkout_projection_lines WHERE order_id=?',
      'UPDATE pos_rewrite_checkout_projection_lines SET quantity=2 WHERE order_id=?',
      "UPDATE pos_rewrite_checkout_projection_lines SET input_hash=REPEAT('0',64) WHERE order_id=?",
      'UPDATE order_stores SET counter_id=4 WHERE order_id=?',
    ];
    let dispatches = 0;
    const gateway: PaymentGateway = {
      ...inactiveGateway,
      async start() {
        dispatches++;
        return { status: 'paid', reference: 'fixture', code: 'APPROVED' };
      },
    };
    for (const [index, query] of cases.entries()) {
      const orderId = await paymentFixture(8750 + index);
      await connection.execute(query, [orderId]);
      await expect(
        payments(gateway).start(operator, '1', orderId, paymentInput('pine-card')),
      ).rejects.toMatchObject({ code: 'CHECKOUT_PROJECTION_UNCONFIRMED' });
      const [attempts] = await connection.query<RowDataPacket[]>(
        'SELECT id FROM pos_rewrite_payment_attempts WHERE order_id=?',
        [orderId],
      );
      expect(attempts).toHaveLength(0);
    }
    const orderId = await paymentFixture(8790);
    await connection.execute(
      "INSERT INTO pos_rewrite_checkout_projection_lines (order_id,has_product_id,product_id,quantity,input_hash) VALUES (?,900000000,10,1,REPEAT('0',64))",
      [orderId],
    );
    await expect(
      payments(gateway).start(operator, '1', orderId, paymentInput('pine-card')),
    ).rejects.toMatchObject({ code: 'CHECKOUT_PROJECTION_UNCONFIRMED' });
    expect(dispatches).toBe(0);
    const duplicate = await paymentFixture(8793);
    await seed(OrderStore, { order_id: Number(duplicate), store_id: 1, counter_id: 3 });
    await expect(
      payments(gateway).start(operator, '1', duplicate, paymentInput('pine-card')),
    ).rejects.toMatchObject({ code: 'CHECKOUT_PROJECTION_UNCONFIRMED' });
    expect(dispatches).toBe(0);
  });
  it('rechecks allocation proof on every paid get, list, operation replay and reconciliation', async () => {
    const orderId = await paymentFixture(8791),
      input = paymentInput(),
      service = payments(inactiveGateway);
    const paid = await service.start(operator, '1', orderId, input);
    expect(paid.status).toBe('paid');
    await connection.execute('UPDATE has_products SET price=0.01 WHERE order_id=?', [orderId]);
    for (const action of [
      () => service.get(operator, '1', orderId, input.operationId),
      () => service.list(operator, '1', orderId),
      () => service.start(operator, '1', orderId, input),
      () => service.reconcile(operator, '1', orderId, input.operationId),
    ])
      await expect(action()).rejects.toMatchObject({ code: 'CHECKOUT_PROJECTION_UNCONFIRMED' });
  });
  it('retains an uncertain charged attempt when the allocation proof changes during provider dispatch', async () => {
    const orderId = await paymentFixture(8792),
      input = paymentInput('pine-card');
    await seed(GiftVoucher, { order_id: Number(orderId), status: 0 });
    let dispatches = 0;
    const service = payments({
      ...inactiveGateway,
      async start() {
        dispatches++;
        await connection.execute('UPDATE has_products SET qty=2 WHERE order_id=?', [orderId]);
        return { status: 'paid', reference: 'FIXTURE-CHARGED', code: 'APPROVED' };
      },
    });
    await expect(service.start(operator, '1', orderId, input)).rejects.toMatchObject({
      code: 'CHECKOUT_PROJECTION_UNCONFIRMED',
    });
    expect((await service.get(operator, '1', orderId, input.operationId)).status).toBe('uncertain');
    expect((await service.start(operator, '1', orderId, input)).status).toBe('uncertain');
    expect(dispatches).toBe(1);
    const [orders] = await connection.query<RowDataPacket[]>(
      'SELECT payment_status,order_status FROM orders WHERE id=?',
      [orderId],
    );
    expect(orders[0]).toMatchObject({ payment_status: 1, order_status: 1 });
    const [ledgers] = await connection.query<RowDataPacket[]>(
      'SELECT id FROM pos_transaction_logs WHERE order_id=?',
      [orderId],
    );
    expect(ledgers).toHaveLength(0);
    const [gifts] = await connection.query<RowDataPacket[]>(
      'SELECT status FROM gift_vouchers WHERE order_id=?',
      [orderId],
    );
    expect(gifts[0]?.status).toBe(0);
  });
  it('checks current blocked/unprinted collection flags before any provider charge', async () => {
    const orderId = await paymentFixture(8850),
      input = paymentInput('pine-card');
    await physicalCardFixture(8850, 950);
    let charges = 0;
    const service = payments({
      ...inactiveGateway,
      async start() {
        charges++;
        return { status: 'paid', reference: 'FIXTURE-CHARGED', code: 'APPROVED' };
      },
    });
    for (const flags of [
      'is_block=1',
      'is_block=2',
      'is_block=0,is_printed=0',
      'is_printed=1,is_completed=0',
    ]) {
      await connection.query(`UPDATE gift_card_collection SET ${flags} WHERE id=950`);
      await expect(service.start(operator, '1', orderId, input)).rejects.toMatchObject({
        code: 'GIFT_CARD_ISSUANCE_UNCONFIRMED',
      });
    }
    expect(charges).toBe(0);
    const [attempts] = await connection.query<RowDataPacket[]>(
      'SELECT id FROM pos_rewrite_payment_attempts WHERE order_id=?',
      [orderId],
    );
    expect(attempts).toHaveLength(0);
  });
  it('keeps a charge uncertain if its collection is blocked during dispatch, then reconciles one exact payment', async () => {
    const orderId = await paymentFixture(8851),
      input = paymentInput('pine-card');
    await physicalCardFixture(8851, 951);
    let charges = 0,
      inquiries = 0;
    const service = payments({
      ...inactiveGateway,
      async start() {
        charges++;
        await connection.query('UPDATE gift_card_collection SET is_block=1 WHERE id=951');
        return { status: 'paid', reference: 'FIXTURE-CHARGED', code: 'APPROVED' };
      },
      async status() {
        inquiries++;
        return { status: 'paid', reference: 'FIXTURE-CHARGED', code: 'APPROVED' };
      },
    });
    await expect(service.start(operator, '1', orderId, input)).rejects.toMatchObject({
      code: 'GIFT_CARD_ISSUANCE_UNCONFIRMED',
    });
    expect((await service.get(operator, '1', orderId, input.operationId)).status).toBe('uncertain');
    expect((await service.start(operator, '1', orderId, input)).status).toBe('uncertain');
    expect(charges).toBe(1);
    const [unpaid] = await connection.query<RowDataPacket[]>(
      'SELECT status FROM gift_vouchers WHERE id=8851',
    );
    expect(unpaid[0]?.status).toBe(0);
    const [missing] = await connection.query<RowDataPacket[]>(
      'SELECT voucher_id FROM pos_rewrite_gift_card_issuances WHERE order_id=8851',
    );
    expect(missing).toHaveLength(0);
    await connection.query('UPDATE gift_card_collection SET is_block=0 WHERE id=951');
    expect((await service.reconcile(operator, '1', orderId, input.operationId)).status).toBe(
      'paid',
    );
    expect(charges).toBe(1);
    expect(inquiries).toBe(1);
    await connection.query('UPDATE gift_card_collection SET is_block=1 WHERE id=951');
    await connection.query('UPDATE gift_vouchers SET status=0 WHERE id=8851');
    // Later batch block/redemption preserves the original paid receipt.
    expect((await service.get(operator, '1', orderId, input.operationId)).status).toBe('paid');
    const [proofs] = await connection.query<RowDataPacket[]>(
      `SELECT p.input_hash,${giftCardIssuanceHashSql} AS native_hash FROM pos_rewrite_gift_card_issuances p JOIN gift_vouchers ON gift_vouchers.id=p.voucher_id WHERE p.order_id=8851`,
    );
    expect(proofs).toHaveLength(1);
    expect(proofs[0]?.input_hash).toBe(proofs[0]?.native_hash);
    await connection.query(
      "UPDATE pos_rewrite_gift_card_issuances SET input_hash=REPEAT('0',64) WHERE order_id=8851",
    );
    await expect(service.get(operator, '1', orderId, input.operationId)).rejects.toMatchObject({
      code: 'GIFT_CARD_ISSUANCE_UNCONFIRMED',
    });
  });
  it('commits one physical-card activation/proof for twenty concurrent cash callbacks', async () => {
    const orderId = await paymentFixture(8852),
      input = paymentInput(),
      service = payments(inactiveGateway);
    await physicalCardFixture(8852, 952);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.start(operator, '1', orderId, input)),
    );
    expect(results.every((result) => ['paid', 'dispatching'].includes(result.status))).toBe(true);
    expect((await service.get(operator, '1', orderId, input.operationId)).status).toBe('paid');
    const [proofs] = await connection.query<RowDataPacket[]>(
      'SELECT voucher_id FROM pos_rewrite_gift_card_issuances WHERE order_id=8852',
    );
    expect(proofs).toHaveLength(1);
    const [ledgers] = await connection.query<RowDataPacket[]>(
      'SELECT id FROM pos_transaction_logs WHERE order_id=8852',
    );
    expect(ledgers).toHaveLength(1);
    await db.get('writer').transaction((tx) => assertCompletedGiftCardIssuance(tx, orderId));
    await connection.query('DELETE FROM pos_rewrite_gift_card_issuances WHERE order_id=8852');
    await expect(service.start(operator, '1', orderId, input)).rejects.toMatchObject({
      code: 'GIFT_CARD_ISSUANCE_UNCONFIRMED',
    });
    expect(ledgers).toHaveLength(1);
  });
  it('rolls back voucher activation and its proof on a late transaction failure', async () => {
    await paymentFixture(8853);
    await physicalCardFixture(8853, 953);
    await expect(
      db.get('writer').transaction(async (tx) => {
        await tx
          .update(GiftVoucher)
          .set({ status: 1 })
          .where(sql`${GiftVoucher.id}=8853`);
        await recordGiftCardIssuance(tx, '8853');
        throw new Error('controlled late rollback');
      }),
    ).rejects.toThrow('controlled late rollback');
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT status FROM gift_vouchers WHERE id=8853',
    );
    expect(rows[0]?.status).toBe(0);
    const [proofs] = await connection.query<RowDataPacket[]>(
      'SELECT voucher_id FROM pos_rewrite_gift_card_issuances WHERE order_id=8853',
    );
    expect(proofs).toHaveLength(0);
  });
  it('atomically records one cash settlement, activates gift cards and marks the filed close stale', async () => {
    const orderId = await paymentFixture(8001),
      input = paymentInput(),
      service = payments(inactiveGateway);
    await seed(GiftVoucher, { id: 8001, order_id: 8001, status: 0 });
    await seed(StoreDayClose, { store_id: 1, close_date: '2026-11-16', status: 'CLOSED' });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.start(operator, '1', orderId, input)),
    );
    expect(results.every((result) => ['paid', 'dispatching'].includes(result.status))).toBe(true);
    expect((await service.start(operator, '1', orderId, input)).status).toBe('paid');
    const [orders] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT payment_status,order_status FROM orders WHERE id=8001',
    );
    expect(orders[0]).toMatchObject({ payment_status: 4, order_status: 3 });
    const [mapping] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT offline_payment,offline_payment_recieved,online_payment,is_manually_paid FROM order_stores WHERE order_id=8001',
    );
    expect(mapping[0]).toMatchObject({
      offline_payment: '99.95',
      offline_payment_recieved: '100.00',
      online_payment: '0.00',
      is_manually_paid: 1,
    });
    const [cards] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT status FROM gift_vouchers WHERE id=8001',
    );
    expect(cards[0]?.status).toBe(1);
    const [comments] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT id FROM comments WHERE order_id=8001',
    );
    expect(comments).toHaveLength(1);
    const [logs] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT pay_dict FROM pos_transaction_logs WHERE order_id=8001',
    );
    expect(logs).toHaveLength(1);
    expect(JSON.parse(String(logs[0]?.pay_dict))).toEqual({
      'cash payment': 99.95,
      'online payment': 0,
      'total amount on counter': 99.95,
    });
    const [events] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT kind FROM pos_rewrite_payment_outbox WHERE order_id=8001',
    );
    expect(events).toHaveLength(2);
    const [close] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT status,stale_reason,stale_trigger_ref FROM store_day_close WHERE store_id=1',
    );
    expect(close[0]).toMatchObject({
      status: 'STALE',
      stale_reason: 'PAYMENT',
      stale_trigger_ref: '8001',
    });
  });
  it('serializes provider reconciliation against cancellation and commits approved terminal evidence once', async () => {
    const orderId = await paymentFixture(8002),
      input = paymentInput('pine-card');
    let starts = 0,
      statuses = 0,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      gateway: PaymentGateway = {
        ...inactiveGateway,
        async start() {
          starts++;
          return { status: 'pending', reference: 'PLUTUS-8002', code: 'APPROVED' };
        },
        async status() {
          statuses++;
          await gate;
          return { status: 'paid', reference: 'PLUTUS-8002', code: 'TXN APPROVED' };
        },
      },
      service = payments(gateway);
    expect((await service.start(operator, '1', orderId, input)).status).toBe('pending');
    expect((await service.start(operator, '1', orderId, input)).status).toBe('pending');
    expect(starts).toBe(1);
    const reconciliation = service.reconcile(operator, '1', orderId, input.operationId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(service.cancel(operator, '1', orderId, input.operationId)).rejects.toMatchObject({
      code: 'PAYMENT_OPERATION_INFLIGHT',
    });
    release();
    expect((await reconciliation).status).toBe('paid');
    expect((await service.reconcile(operator, '1', orderId, input.operationId)).status).toBe(
      'paid',
    );
    expect(statuses).toBe(1);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT platform,is_active FROM pos_terminal_transactions WHERE order_id=8002',
    );
    expect(rows.map((row) => row.platform)).toEqual(['txn_created', 'txn_completed']);
    expect(rows.every((row) => row.is_active === 0)).toBe(true);
  });
  it('keeps a lost Paytm dispatch uncertain and uses a status enquiry without repeating the charge', async () => {
    const orderId = await paymentFixture(8003),
      input = paymentInput('paytm-card');
    let starts = 0;
    const gateway: PaymentGateway = {
        ...inactiveGateway,
        async start() {
          starts++;
          throw new Error('Fixture socket timeout');
        },
        async status(attempt) {
          return { status: 'paid', reference: attempt.transactionId, code: '0000' };
        },
      },
      service = payments(gateway);
    await expect(service.start(operator, '1', orderId, input)).rejects.toMatchObject({
      code: 'PAYMENT_OUTCOME_UNCERTAIN',
    });
    expect((await service.start(operator, '1', orderId, input)).status).toBe('uncertain');
    expect(starts).toBe(1);
    await expect(
      service.start(operator, '1', orderId, { ...input, operationId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_ACTIVE' });
    expect((await service.reconcile(operator, '1', orderId, input.operationId)).status).toBe(
      'paid',
    );
    expect(starts).toBe(1);
  });
  it('does not release a payment for another charge until cancellation is provider-confirmed', async () => {
    const orderId = await paymentFixture(8004),
      input = paymentInput('pine-upi');
    let decision: ProviderDecision = {
      status: 'uncertain',
      reference: 'PLUTUS-8004',
      code: 'IN_PROGRESS',
    };
    const gateway: PaymentGateway = {
        ...inactiveGateway,
        async start() {
          return { status: 'pending', reference: 'PLUTUS-8004', code: 'APPROVED' };
        },
        async cancel() {
          return decision;
        },
      },
      service = payments(gateway);
    await service.start(operator, '1', orderId, input);
    expect((await service.cancel(operator, '1', orderId, input.operationId)).status).toBe(
      'uncertain',
    );
    await expect(
      service.start(operator, '1', orderId, { ...input, operationId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_ACTIVE' });
    decision = { status: 'cancelled', reference: 'PLUTUS-8004', code: 'APPROVED' };
    expect((await service.cancel(operator, '1', orderId, input.operationId)).status).toBe(
      'cancelled',
    );
    expect(
      (await service.start(operator, '1', orderId, { ...input, operationId: crypto.randomUUID() }))
        .status,
    ).toBe('pending');
  });
  async function returnFixture(
    orderId: number,
    options: { oldDelivery?: boolean; duplicate?: boolean } = {},
  ) {
    await seed(Order, {
      id: orderId,
      user_id: 1001,
      payment_method: 14,
      payment_status: 4,
      order_status: 3,
      first_name: 'Private fixture customer',
      address1: 'Private fixture address',
    });
    await seed(OrderStore, { order_id: orderId, store_id: 2, counter_id: 99 });
    await seed(HasProduct, {
      id: orderId + 100,
      order_id: orderId,
      prod_id: 10,
      qty: 2,
      status: 'DELIVERED',
      return_status: 0,
    });
    await seed(AmountToBeRefundedLog, {
      order_id: orderId,
      prod_id: 10,
      has_product_id: orderId + 100,
      is_refunded: false,
      amount_to_be_refunded: 50.25,
      tss_money_used: 5,
      tss_point_used: 3,
      gift_voucher_amount: 2,
    });
    await seed(Comments, {
      order_id: orderId,
      status_id: 3,
      created_at: options.oldDelivery ? '2000-01-01 00:00:00' : '2026-11-16 00:00:00',
    });
    if (options.duplicate) {
      await seed(HasProduct, {
        id: orderId + 101,
        order_id: orderId,
        prod_id: 10,
        qty: 1,
        status: 'DELIVERED',
        return_status: 0,
      });
      await seed(AmountToBeRefundedLog, {
        order_id: orderId,
        prod_id: 10,
        has_product_id: orderId + 101,
        is_refunded: false,
        amount_to_be_refunded: 50.25,
      });
    }
    await connection.execute(
      'DELETE FROM pos_rewrite_return_verification_limits WHERE customer_id=?',
      ['1001'],
    );
    const verification = returnVerificationService(
        db,
        readConfig({
          NODE_ENV: 'test',
          DEMO_MODE: 'true',
          SESSION_SECRET: 'return-proof-fixture-'.repeat(3),
        }),
        repository,
        approvedReturn,
        { secret: signingEnvironment.hs256, assertCheckIn: async () => {} },
      ),
      proof = await verification.create(operator, '1', String(orderId), crypto.randomUUID(), '3');
    await verification.verify(operator, '1', proof.id, crypto.randomUUID(), '123456');
    const input = returnInputSchema.parse({
      operationId: crypto.randomUUID(),
      counterId: '3',
      verificationId: proof.id,
      reasonId: '1',
      saleable: false,
      qualityConfirmed: true,
      tagConfirmed: true,
      refundMode: 'tss-money',
    });
    return { orderId: String(orderId), lineId: String(orderId + 100), input };
  }
  function returns(gateway: ReturnGateway) {
    const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'return-test-secret-'.repeat(3),
    });
    return returnService(
      returnRepository(db, config, {
        hashSecret: signingEnvironment.hs256,
        returnPeriodDays: 30,
        assertCheckIn: async () => {},
      }),
      repository,
      gateway,
      signingEnvironment,
      config.BUSINESS_TIMEZONE,
    );
  }
  const returnCalls = { inbound: 0, refund: 0 };
  const approvedReturn: ReturnGateway = {
    configured() {},
    async sendOtp() {},
    async verifyOtp(_customer, otp) {
      return otp === '123456';
    },
    async eligibility() {
      return { allowed: true, until: '2099-01-01' };
    },
    async inbound() {
      returnCalls.inbound++;
    },
    async refund(value) {
      returnCalls.refund++;
      await connection.execute(
        'UPDATE amount_to_be_refunded_log SET is_refunded=1,refunded_amt=50.25 WHERE order_id=? AND has_product_id=?',
        [value.orderId, value.lineId],
      );
      return { returnAmount: '50.25' };
    },
  };
  it('recovers queued return verification and a lost wrong-code result without resend, then checks the proof in the acceptance transaction', async () => {
    const source = await returnFixture(8788),
      config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'local-return-otp-'.repeat(4),
      }),
      operations = new Map<string, CustomerOtpOperationView>();
    let current: CustomerOtpView | null = null,
      sends = 0,
      guesses = 0,
      loseSend = true,
      loseVerify = true,
      revoked = false,
      atomicProofChecks = 0;
    const customerOtp: CustomerVerificationClient = {
      async request(_user, scope, id, operationId, contact) {
        expect(scope).toMatchObject({
          purpose: 'order-return',
          orderId: source.orderId,
          customerId: '1001',
          storeId: '1',
          counterId: '3',
        });
        sends++;
        current = {
          id,
          status: 'uncertain',
          expiresAt: Date.now() + 300000,
          verifiedUntil: null,
          contact,
        };
        operations.set(operationId, { kind: 'request', result: current, error: null });
        if (loseSend) throw new Error('controlled lost request reply');
        return current;
      },
      async read() {
        return current!;
      },
      async verify(_user, _scope, _id, operationId, code) {
        guesses++;
        const error = code === '123456' ? null : 'CUSTOMER_OTP_INVALID';
        if (!error) current = { ...current!, verifiedUntil: Date.now() + 600000 };
        operations.set(operationId, { kind: 'verify', result: current, error });
        if (loseVerify) throw new Error('controlled lost verify reply');
        if (error) throw new AppError(422, error, 'Fixture wrong code.');
        return current!;
      },
      async readOperation(_user, _scope, _id, operationId) {
        const original = operations.get(operationId);
        return original ? { ...original, result: current } : null;
      },
      async assertVerified(tx, user, scope, challengeId, contact, verifiedUntil) {
        atomicProofChecks++;
        await tx.execute(sql`SELECT 1`);
        expect(user.id).toBe(operator.id);
        expect(scope.orderId).toBe(source.orderId);
        expect(challengeId).toBe(current!.id);
        expect(contact).toEqual(current!.contact);
        expect(verifiedUntil).toBe(current!.verifiedUntil);
        if (revoked)
          throw new AppError(403, 'CUSTOMER_VERIFICATION_REQUIRED', 'Fixture actor epoch revoked.');
      },
    };
    const verification = returnVerificationService(
      db,
      config,
      repository,
      {
        ...approvedReturn,
        async sendOtp() {
          throw new Error('Legacy OTP must not run.');
        },
        async verifyOtp() {
          throw new Error('Legacy OTP must not run.');
        },
      },
      { secret: signingEnvironment.hs256, assertCheckIn: async () => {}, customerOtp },
    );
    const id = crypto.randomUUID();
    await expect(verification.create(operator, '1', source.orderId, id, '3')).rejects.toMatchObject(
      { code: 'RETURN_OTP_DELIVERY_UNCONFIRMED' },
    );
    expect(await verification.read(operator, '1', id)).toMatchObject({
      pending: true,
      pendingOperationId: id,
      deliveryStatus: 'uncertain',
    });
    const requested = await verification.reconcile(operator, '1', id, id);
    expect(requested).toMatchObject({
      pending: false,
      deliveryStatus: 'uncertain',
      verifiedUntil: null,
    });
    loseSend = false;
    await verification.create(operator, '1', source.orderId, id, '3');
    expect(sends).toBe(1);
    const wrong = crypto.randomUUID();
    await expect(verification.verify(operator, '1', id, wrong, '654321')).rejects.toMatchObject({
      code: 'RETURN_OTP_VERIFICATION_UNCONFIRMED',
    });
    expect(await verification.reconcile(operator, '1', id, wrong)).toMatchObject({
      pending: false,
      errorCode: 'CUSTOMER_OTP_INVALID',
      verifiedUntil: null,
    });
    expect(guesses).toBe(1);
    loseVerify = false;
    const verified = await verification.verify(operator, '1', id, crypto.randomUUID(), '123456');
    expect(verified.verifiedUntil).toBe(current!.verifiedUntil);
    const lines = await verification.lines(operator, '1', id);
    expect(lines.data.some((line) => line.id === source.lineId)).toBe(true);
    expect(atomicProofChecks).toBe(1);
    revoked = true;
    const durable = returnService(
        returnRepository(db, config, {
          hashSecret: signingEnvironment.hs256,
          returnPeriodDays: 30,
          assertCheckIn: async () => {},
          customerOtp,
        }),
        repository,
        approvedReturn,
        signingEnvironment,
        config.BUSINESS_TIMEZONE,
      ),
      before = { ...returnCalls };
    await expect(
      durable.start(operator, '1', source.orderId, source.lineId, {
        ...source.input,
        verificationId: id,
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_VERIFICATION_REQUIRED' });
    expect(returnCalls).toEqual(before);
    expect(atomicProofChecks).toBe(2);
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM pos_rewrite_return_operations WHERE id=?',
      [source.input.operationId],
    );
    expect(rows).toHaveLength(0);
    expect(sends).toBe(1);
    expect(guesses).toBe(2);
    expect(JSON.stringify(await verification.read(operator, '1', id))).not.toContain(
      current!.contact.digest,
    );
  });
  it('executes one cross-store wallet return with a credit note, hold inventory and source audit', async () => {
    const fixture = await returnFixture(9001),
      service = returns(approvedReturn),
      before = { ...returnCalls };
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.start(operator, '1', fixture.orderId, fixture.lineId, fixture.input),
      ),
    );
    expect(
      results.every((result) =>
        [
          'inbound-dispatching',
          'inbound-accepted',
          'refund-dispatching',
          'refund-confirmed',
          'completed',
        ].includes(result.phase),
      ),
    ).toBe(true);
    const complete = await service.start(
      operator,
      '1',
      fixture.orderId,
      fixture.lineId,
      fixture.input,
    );
    expect(complete.phase).toBe('completed');
    expect(complete.creditNote).toMatch(/^FST1\d{4}CN00001$/);
    expect(complete.returnAmount).toBe('50.25');
    expect(returnCalls.inbound - before.inbound).toBe(1);
    expect(returnCalls.refund - before.refund).toBe(1);
    const [notes] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT * FROM return_orders WHERE order_id=9001',
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ store_id: 1, has_product_id: 9101, qty: 2 });
    const [hold] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT stock FROM hold_stock_store WHERE product_id=10 AND store_id=1',
    );
    expect(hold[0]?.stock).toBe(2);
    const [logs] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT pay_dict FROM pos_transaction_logs WHERE order_id=9001',
    );
    expect(logs).toHaveLength(1);
    expect(JSON.parse(String(logs[0]?.pay_dict))).toMatchObject({
      'pay amt refunded into tss money': 50.25,
      'total amount refunded': 53.25,
    });
    expect(JSON.stringify(complete)).not.toContain('Private fixture');
    await expect(
      ordersService(db, undefined, undefined, () => Date.parse('2026-11-16T12:00:00Z')).detail(
        operator,
        '1',
        fixture.orderId,
        { from: '2026-11-16', to: '2026-11-16' },
      ),
    ).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
    });
    repository = checkoutRepository(db);
  });
  it('freezes an unconfirmed warehouse call and does not reissue it', async () => {
    const fixture = await returnFixture(9002);
    let calls = 0;
    const gateway: ReturnGateway = {
        ...approvedReturn,
        async inbound() {
          calls++;
          throw new CheckoutGatewayError('FIXTURE_INBOUND_TIMEOUT', 'Fixture', true);
        },
      },
      service = returns(gateway);
    await expect(
      service.start(operator, '1', fixture.orderId, fixture.lineId, fixture.input),
    ).rejects.toMatchObject({ code: 'FIXTURE_INBOUND_TIMEOUT' });
    expect(
      (await service.start(operator, '1', fixture.orderId, fixture.lineId, fixture.input)).phase,
    ).toBe('uncertain');
    expect(calls).toBe(1);
    await expect(
      service.start(operator, '1', fixture.orderId, fixture.lineId, {
        ...fixture.input,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'RETURN_ALREADY_ACTIVE' });
    const [notes] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT id FROM return_orders WHERE order_id=9002',
    );
    expect(notes).toHaveLength(0);
  });
  it('keeps a warehouse credit note when the refund times out without adding inventory or repeating the refund', async () => {
    const fixture = await returnFixture(9003);
    let refunds = 0;
    const gateway: ReturnGateway = {
        ...approvedReturn,
        async refund() {
          refunds++;
          throw new CheckoutGatewayError('FIXTURE_REFUND_TIMEOUT', 'Fixture', true);
        },
      },
      service = returns(gateway);
    await expect(
      service.start(operator, '1', fixture.orderId, fixture.lineId, fixture.input),
    ).rejects.toMatchObject({ code: 'FIXTURE_REFUND_TIMEOUT' });
    const current = await service.read(operator, '1', fixture.input.operationId);
    expect(current.phase).toBe('uncertain');
    expect(current.uncertainStage).toBe('refund');
    expect(current.creditNote).toBeTruthy();
    expect(
      (await service.start(operator, '1', fixture.orderId, fixture.lineId, fixture.input)).phase,
    ).toBe('uncertain');
    expect(refunds).toBe(1);
    await expect(service.continue(operator, '1', fixture.input.operationId)).rejects.toMatchObject({
      code: 'RETURN_REVIEW_REQUIRED',
    });
    const [notes] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT id FROM return_orders WHERE order_id=9003',
    );
    expect(notes).toHaveLength(1);
  });
  it('repairs a local completion failure from the confirmed refund checkpoint without another refund', async () => {
    const fixture = await returnFixture(9004),
      service = returns(approvedReturn),
      before = returnCalls.refund;
    await connection.execute(
      'UPDATE hold_stock_store SET stock=2147483647 WHERE product_id=10 AND store_id=1',
    );
    await expect(
      service.start(operator, '1', fixture.orderId, fixture.lineId, fixture.input),
    ).rejects.toMatchObject({ code: 'RETURN_STOCK_OVERFLOW' });
    expect((await service.read(operator, '1', fixture.input.operationId)).phase).toBe(
      'refund-confirmed',
    );
    await connection.execute(
      'UPDATE hold_stock_store SET stock=2 WHERE product_id=10 AND store_id=1',
    );
    expect((await service.continue(operator, '1', fixture.input.operationId)).phase).toBe(
      'completed',
    );
    expect(returnCalls.refund - before).toBe(1);
  });
  it('enforces server OTP proof and the saleable-stock procedure gate before external actions', async () => {
    const fixture = await returnFixture(9005),
      service = returns(approvedReturn),
      before = { ...returnCalls };
    await expect(
      service.start(operator, '1', fixture.orderId, fixture.lineId, {
        ...fixture.input,
        verificationId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'RETURN_CUSTOMER_VERIFICATION_REQUIRED' });
    await expect(
      service.start(operator, '1', fixture.orderId, fixture.lineId, {
        ...fixture.input,
        saleable: true,
      }),
    ).rejects.toMatchObject({ code: 'RETURN_INVENTORY_UNVERIFIED' });
    expect(returnCalls).toEqual(before);
  });
  it('binds return OTP proofs to an order and caps attempts across replacement challenges', async () => {
    let clock = Date.now() + 61000,
      sends = 0,
      verifies = 0;
    const gateway: ReturnGateway = {
        ...approvedReturn,
        async sendOtp() {
          sends++;
        },
        async verifyOtp() {
          verifies++;
          return false;
        },
      },
      config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'return-limiter-secret-'.repeat(3),
      }),
      proofs = returnVerificationService(db, config, repository, gateway, {
        secret: signingEnvironment.hs256,
        assertCheckIn: async () => {},
        now: () => clock,
      });
    const proof = await proofs.create(operator, '1', '9005', crypto.randomUUID(), '3');
    await expect(
      proofs.create(operator, '1', '9005', crypto.randomUUID(), '3'),
    ).rejects.toMatchObject({ code: 'RETURN_OTP_SEND_LIMIT' });
    expect(sends).toBe(1);
    for (let index = 0; index < 4; index++)
      await expect(
        proofs.verify(operator, '1', proof.id, crypto.randomUUID(), '000000'),
      ).rejects.toMatchObject({ code: 'RETURN_OTP_INVALID' });
    // One attempt from the earlier successful proof shares this customer's window.
    await expect(
      proofs.verify(operator, '1', proof.id, crypto.randomUUID(), '000000'),
    ).rejects.toMatchObject({ code: 'RETURN_OTP_ATTEMPT_LIMIT' });
    expect(verifies).toBe(4);
    clock += 61000;
    const replacement = await proofs.create(operator, '1', '9005', crypto.randomUUID(), '3');
    await expect(
      proofs.verify(operator, '1', replacement.id, crypto.randomUUID(), '000000'),
    ).rejects.toMatchObject({ code: 'RETURN_OTP_ATTEMPT_LIMIT' });
  });
  it('scopes a return extension to its exact line when an order contains the same SKU twice', async () => {
    const fixture = await returnFixture(9006, { oldDelivery: true, duplicate: true }),
      service = returns(approvedReturn);
    await seed(ExtendApplicabilityForReturnExchange, {
      order_id: 9006,
      prod_id: 10,
      has_product_id: 9106,
      is_active: true,
      extended_date: '2099-01-01 00:00:00',
    });
    expect(
      (await service.start(operator, '1', fixture.orderId, fixture.lineId, fixture.input)).phase,
    ).toBe('completed');
    await expect(
      service.start(operator, '1', fixture.orderId, '9107', {
        ...fixture.input,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'RETURN_WINDOW_CLOSED' });
  });
  it('claims financial delivery events once across workers and freezes ambiguous notification delivery', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'outbox-fixture-secret-'.repeat(3),
      }),
      calls = new Map<string, number>();
    const fetcher: typeof fetch = async (_url, init) => {
        const id = new Headers(init?.headers).get('Idempotency-Key')!;
        calls.set(id, (calls.get(id) || 0) + 1);
        return new Response(null, { status: 204 });
      },
      dispatcher = paymentOutboxDispatcher(
        db,
        config,
        {
          orderProducerUrl: 'https://producer.example.test/',
          orderProducerAppId: 'fixture',
          orderProducerAppKey: 'fixture-secret-'.repeat(3),
          engagementUrl: 'https://engagement.example.test/',
        },
        fetcher,
      );
    const runs = await Promise.all([dispatcher(100), dispatcher(100)]);
    expect(runs.reduce((count, run) => count + run.delivered, 0)).toBeGreaterThan(0);
    expect([...calls.values()].every((count) => count === 1)).toBe(true);
    expect((await dispatcher()).delivered).toBe(0);
    let notifications = 0;
    const returns = returnOutboxDispatcher(
      db,
      config,
      {
        TSS_RETURN_EMAIL_URL: 'https://mail.example.test/',
        TSS_EXCHANGE_EMAIL_URL: 'https://mail.example.test/exchange',
      },
      async () => {
        notifications++;
        if (notifications === 1) throw new Error('Fixture socket closed after delivery');
        return new Response(null, { status: 204 });
      },
    );
    const first = await returns(100);
    expect(first.uncertain).toBe(1);
    const before = notifications;
    expect(await returns()).toEqual({ delivered: 0, rejected: 0, uncertain: 0 });
    expect(notifications).toBe(before);
  });
  it('serves paid store invoices with their own CSP and never exposes the upstream receipt credential', async () => {
    const paidOrderId = '9007199254745993',
      unpaidOrderId = '9007199254745994',
      otherStoreOrderId = '9007199254745995';
    for (const [id, storeId, status] of [
      [paidOrderId, 1, 4],
      [unpaidOrderId, 1, 1],
      [otherStoreOrderId, 2, 4],
    ] as const) {
      await seed(Order, {
        id,
        user_id: 1001,
        pay_amt: 100,
        payment_status: status,
        payment_method: 14,
        order_status: 3,
      });
      await seed(OrderStore, {
        order_id: id,
        store_id: storeId,
        counter_id: 3,
        order_invoice: 'FIXTURE/INVOICE/EXACT',
      });
    }
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'invoice-fixture-secret-'.repeat(3),
      }),
      secret = 'private-receipt-secret-'.repeat(2),
      app = Fastify({ logger: false });
    let fetches = 0;
    let revokeDuringRender: 'inactive' | 'franchise' | null = null;
    let tamperBody = false;
    app.decorateRequest('principal', null);
    app.addHook('preHandler', async (request) => {
      request.principal = operator;
    });
    app.setErrorHandler((error, _request, reply) =>
      error instanceof AppError
        ? reply.code(error.status).send({ error: { code: error.code } })
        : reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } }),
    );
    registerInvoices(
      app,
      config,
      db,
      {
        storeUrl: 'https://invoice.example.test/internal/pos/invoices/store',
        serviceKey: secret,
        securityContract: invoiceSecurityContract,
        feedbackContract: feedbackProofContract,
      },
      async (input, options) => {
        fetches++;
        const url = new URL(String(input)),
          headers = new Headers(options?.headers);
        expect(url.searchParams.has('pos_token')).toBe(false);
        expect(String(input)).not.toContain(secret);
        expect(headers.get('x-pos-invoice-key')).toBe(secret);
        const html =
          '<table><tr><th>Invoice tax</th><td>18.00</td></tr></table><script>unsafe()</script>';
        const nonce = headers.get('x-pos-invoice-nonce') ?? '';
        if (revokeDuringRender)
          await connection.execute(
            `UPDATE ${mysql.escapeId(getTableConfig(PosUser).name)} SET ${revokeDuringRender === 'inactive' ? 'is_active=0' : 'user_type=2'} WHERE id=?`,
            [operator.id],
          );
        return new Response(tamperBody ? html + '<p>unproved</p>' : html, {
          headers: {
            'Content-Type': 'text/html',
            'X-POS-Invoice-Contract': invoiceSecurityContract,
            'X-POS-Feedback-Contract': feedbackProofContract,
            'X-POS-Invoice-Nonce': nonce,
            'X-POS-Invoice-Proof': invoiceResponseProof(
              {
                kind: 'store',
                orderId: url.searchParams.get('order_id') ?? '',
                operatorId: headers.get('x-pos-operator-id') ?? '',
                requestId: headers.get('x-request-id') ?? '',
                nonce,
              },
              html,
              secret,
            ),
          },
        });
      },
    );
    await app.ready();
    try {
      const response = await app.inject(`/api/v1/stores/1/orders/${paidOrderId}/invoice/preview`);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'self'");
      expect(response.headers['content-security-policy']).toContain(
        'sandbox allow-same-origin allow-modals',
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toContain('18.00');
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain('unsafe()');
      expect(
        (await app.inject(`/api/v1/stores/1/orders/${unpaidOrderId}/invoice`)).statusCode,
      ).toBe(409);
      expect(
        (await app.inject(`/api/v1/stores/1/orders/${otherStoreOrderId}/invoice`)).statusCode,
      ).toBe(404);
      expect(fetches).toBe(1);
      for (const change of ['inactive', 'franchise'] as const) {
        revokeDuringRender = change;
        const revoked = await app.inject(`/api/v1/stores/1/orders/${paidOrderId}/invoice`);
        expect(revoked.statusCode).toBe(change === 'inactive' ? 401 : 403);
        expect(revoked.body).not.toContain('18.00');
        const count = fetches;
        expect(
          (await app.inject(`/api/v1/stores/1/orders/${paidOrderId}/invoice`)).statusCode,
        ).toBe(change === 'inactive' ? 401 : 403);
        expect(fetches).toBe(count);
        await connection.execute(
          `UPDATE ${mysql.escapeId(getTableConfig(PosUser).name)} SET is_active=1,user_type=1 WHERE id=?`,
          [operator.id],
        );
      }
      revokeDuringRender = null;
      tamperBody = true;
      const substituted = await app.inject(`/api/v1/stores/1/orders/${paidOrderId}/invoice`);
      expect(substituted.statusCode).toBe(502);
      expect(substituted.json()).toEqual({ error: { code: 'INVOICE_SECURITY_UNCONFIRMED' } });
      expect(substituted.body).not.toContain('unproved');
    } finally {
      await connection.execute(
        `UPDATE ${mysql.escapeId(getTableConfig(PosUser).name)} SET is_active=1,user_type=1 WHERE id=?`,
        [operator.id],
      );
      await connection.execute('DELETE FROM order_stores WHERE order_id IN (?,?,?)', [
        paidOrderId,
        unpaidOrderId,
        otherStoreOrderId,
      ]);
      await connection.execute('DELETE FROM orders WHERE id IN (?,?,?)', [
        paidOrderId,
        unpaidOrderId,
        otherStoreOrderId,
      ]);
      await app.close();
    }
  });
  function exchangeWorkflow(gateway: FixtureGateway, finalize?: ReturnType<typeof orderFinalizer>) {
    const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'exchange-fixture-secret-'.repeat(3),
    });
    return exchangeService(
      returnRepository(db, config, {
        hashSecret: signingEnvironment.hs256,
        returnPeriodDays: 30,
        assertCheckIn: async () => {},
      }),
      repository,
      approvedReturn,
      gateway,
      signingEnvironment,
      config,
      db,
      finalize,
    );
  }
  const exchangeRequest = (input: ReturnType<typeof returnInputSchema.parse>) => {
    const { refundMode: _refundMode, overrideEligibility: _override, ...base } = input;
    return exchangeInputSchema.parse({ ...base, replacementProductId: '11', salespersonId: '5' });
  };
  const exchangeDate = () =>
    Temporal.Now.zonedDateTimeISO('Asia/Kolkata')
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  async function childProof(orderId: number, productId = 11) {
    const childId = orderId + 10000;
    await connection.execute("UPDATE has_products SET status='PLACED' WHERE order_id=?", [childId]);
    await seed(exchangeStockConfirmations, {
      order_id: childId,
      parent_order_id: orderId,
      parent_has_product_id: orderId + 100,
      has_product_id: childId + 100,
      store_id: 1,
      counter_id: 3,
      product_id: productId,
      quantity: 2,
      contract_version: exchangeStockContract,
      confirmed_at: exchangeDate(),
    });
    await seed(AmountToBeRefundedLog, {
      order_id: childId,
      has_product_id: childId + 100,
      prod_id: productId,
      is_refunded: false,
      amount_to_be_refunded: 50.25,
      created_at: exchangeDate(),
      updated_at: exchangeDate(),
    });
  }
  async function childOrder(orderId: number, productId = 11, confirmed = true) {
    const childId = orderId + 10000;
    await seed(Order, {
      id: childId,
      user_id: 1001,
      parent_order_id: orderId,
      order_status: confirmed ? 1 : 0,
      payment_status: confirmed ? 4 : 0,
      payment_method: 3,
      created_at: exchangeDate(),
      pay_amt: 0,
      tss_money_used: 50.25,
      order_ref_no: `EXCHANGE-${childId}`,
    });
    await seed(OrderStore, { order_id: childId, store_id: 1, counter_id: 3 });
    await seed(HasProduct, {
      id: childId + 100,
      order_id: childId,
      prod_id: productId,
      qty: 2,
      status: confirmed ? 'PLACED' : 'INCOMPLETE',
    });
    await seed(exchangeOrderLog, {
      parent_order_id: orderId,
      parent_has_product_id: orderId + 100,
      order_id: childId,
      has_product_id: childId + 100,
      created_at: exchangeDate(),
      updated_at: exchangeDate(),
    });
    if (confirmed) await childProof(orderId, productId);
    return childId;
  }
  function exchangeGateway(handler: (payload: Record<string, unknown>) => Promise<unknown>) {
    const gateway = new FixtureGateway();
    gateway.exchangeReasons = async () => [{ id: 1, reason: 'Size issue', sub_reason: [] }];
    gateway.intercept = async (path, payload) =>
      path === 'pos/exchange' ? handler(payload) : undefined;
    return gateway;
  }
  it('completes one cross-store exchange with zero new cash and correct source credit-note/child markers', async () => {
    const fixture = await returnFixture(9201),
      request = exchangeRequest(fixture.input);
    let dispatches = 0;
    const gateway = exchangeGateway(async (payload) => {
        dispatches++;
        expect(payload.admin_user_id).toBe(777);
        expect(payload.salesperson_id).toBe(5);
        expect(payload.size).toBe('L');
        return { status: 'SUCCESS', new_order_id: await childOrder(9201) };
      }),
      service = exchangeWorkflow(gateway),
      before = returnCalls.inbound;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.start(operator, '1', fixture.orderId, fixture.lineId, request),
      ),
    );
    expect(results.some((result) => result.phase === 'completed')).toBe(true);
    expect(dispatches).toBe(1);
    expect(returnCalls.inbound - before).toBe(1);
    const completed = await service.read(operator, '1', request.operationId);
    expect(completed.kind).toBe('exchange');
    expect(completed.newOrderId).toBe('19201');
    expect(completed.phase).toBe('completed');
    const [parent] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT order_status,payment_status FROM orders WHERE id=9201',
    );
    expect(parent[0]).toMatchObject({ order_status: 3, payment_status: 4 });
    const [parentLine] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT status,return_mode,return_status FROM has_products WHERE id=9301',
    );
    expect(parentLine[0]).toMatchObject({
      status: 'EXCHANGE_COMPLETED',
      return_mode: 5,
      return_status: 1,
    });
    const [child] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT order_status,payment_status FROM orders WHERE id=19201',
    );
    expect(child[0]).toMatchObject({ order_status: 3, payment_status: 4 });
    const [mapping] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT offline_payment,online_payment,online_other_payment,is_manually_paid,order_invoice FROM order_stores WHERE order_id=19201',
    );
    expect(mapping[0]).toMatchObject({
      offline_payment: '0.00',
      online_payment: '0.00',
      online_other_payment: '0.00',
      is_manually_paid: 0,
    });
    expect(String(mapping[0]?.order_invoice)).toMatch(/^FST1\d{4}INV\d+$/);
    const [logs] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT pay_dict FROM pos_transaction_logs WHERE order_id IN (9201,19201)',
    );
    expect(logs).toHaveLength(2);
    expect(
      logs.every((row) => JSON.parse(String(row.pay_dict))['total amount on counter'] === 0),
    ).toBe(true);
    const [tracking] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT status,new_order_id FROM pos_exchange_log WHERE order_id=9201',
    );
    expect(tracking[0]).toMatchObject({ status: 'SUCCESS', new_order_id: 19201 });
    await expect(
      returns(approvedReturn).continue(operator, '1', request.operationId),
    ).rejects.toMatchObject({ code: 'RETURN_KIND_MISMATCH' });
  });
  it('refuses exchange acceptance before warehouse or order dispatch when the upstream stock contract is unverified', async () => {
    const fixture = await returnFixture(9208),
      input = exchangeRequest(fixture.input),
      config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'stock-contract-gate-'.repeat(3),
      });
    let calls = 0;
    const service = exchangeService(
        returnRepository(db, config, {
          hashSecret: signingEnvironment.hs256,
          returnPeriodDays: 30,
          assertCheckIn: async () => {},
        }),
        repository,
        approvedReturn,
        exchangeGateway(async () => {
          calls++;
          return {};
        }),
        { ...signingEnvironment, exchangeStockContract: undefined },
        config,
        db,
      ),
      before = returnCalls.inbound;
    await expect(
      service.start(operator, '1', fixture.orderId, fixture.lineId, input),
    ).rejects.toMatchObject({ code: 'EXCHANGE_STOCK_CONTRACT_UNVERIFIED' });
    expect(returnCalls.inbound).toBe(before);
    expect(calls).toBe(0);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT id FROM pos_rewrite_return_operations WHERE id=?',
      [input.operationId],
    );
    expect(rows).toHaveLength(0);
  });
  it('retains a confirmed replacement child and repairs local completion without creating a second child', async () => {
    const fixture = await returnFixture(9202),
      request = exchangeRequest(fixture.input);
    let dispatches = 0,
      finalizations = 0;
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'exchange-repair-fixture-'.repeat(3),
      }),
      finalize = orderFinalizer(db, config, 'exchange'),
      gateway = exchangeGateway(async () => {
        dispatches++;
        return { status: 'SUCCESS', new_order_id: await childOrder(9202) };
      }),
      service = exchangeWorkflow(gateway, async (state, id) => {
        if (finalizations++ === 0)
          throw new AppError(503, 'FIXTURE_INVOICE_UNAVAILABLE', 'Fixture unavailable');
        return finalize(state, id);
      });
    await expect(
      service.start(operator, '1', fixture.orderId, fixture.lineId, request),
    ).rejects.toMatchObject({ code: 'FIXTURE_INVOICE_UNAVAILABLE' });
    expect((await service.read(operator, '1', request.operationId)).phase).toBe(
      'replacement-confirmed',
    );
    expect((await service.continue(operator, '1', request.operationId)).phase).toBe('completed');
    expect(dispatches).toBe(1);
    expect(finalizations).toBe(2);
  });
  it('retries a confirmed replacement rejection using stored picks without repeating the warehouse return', async () => {
    const fixture = await returnFixture(9203),
      request = exchangeRequest(fixture.input);
    let dispatches = 0;
    const before = returnCalls.inbound,
      gateway = exchangeGateway(async (payload) => {
        dispatches++;
        expect(payload.exchange_prod_id).toBe(11);
        return dispatches === 1
          ? { status: 'FAIL' }
          : { status: 'SUCCESS', new_order_id: await childOrder(9203) };
      }),
      service = exchangeWorkflow(gateway);
    await expect(
      service.start(operator, '1', fixture.orderId, fixture.lineId, request),
    ).rejects.toMatchObject({ code: 'EXCHANGE_REPLACEMENT_REJECTED' });
    expect((await service.read(operator, '1', request.operationId)).phase).toBe(
      'replacement-rejected',
    );
    expect((await service.retry(operator, '1', request.operationId, '5')).phase).toBe('completed');
    expect(returnCalls.inbound - before).toBe(1);
    expect(dispatches).toBe(2);
    const [notes] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT id FROM return_orders WHERE order_id=9203',
    );
    expect(notes).toHaveLength(1);
  });
  it('freezes a timeout after a child may have been created and never fabricates exchange success', async () => {
    const fixture = await returnFixture(9204),
      request = exchangeRequest(fixture.input);
    let dispatches = 0;
    const gateway = exchangeGateway(async () => {
        dispatches++;
        await childOrder(9204, 11, false);
        throw new CheckoutGatewayError('FIXTURE_EXCHANGE_TIMEOUT', 'Fixture timeout', true);
      }),
      service = exchangeWorkflow(gateway);
    await expect(
      service.start(operator, '1', fixture.orderId, fixture.lineId, request),
    ).rejects.toMatchObject({ code: 'FIXTURE_EXCHANGE_TIMEOUT' });
    const current = await service.read(operator, '1', request.operationId);
    expect(current.phase).toBe('uncertain');
    expect(current.uncertainStage).toBe('replacement');
    expect(current.newOrderId).toBe(null);
    expect(
      (await service.start(operator, '1', fixture.orderId, fixture.lineId, request)).phase,
    ).toBe('uncertain');
    await expect(service.retry(operator, '1', request.operationId, '5')).rejects.toMatchObject({
      code: 'EXCHANGE_REVIEW_REQUIRED',
    });
    expect(dispatches).toBe(1);
    const [child] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT payment_status FROM orders WHERE id=19204',
    );
    expect(child[0]?.payment_status).toBe(0);
  });
  it('requires writer payment and transactional stock proof after an exchange success acknowledgment', async () => {
    const fixture = await returnFixture(9205),
      input = exchangeRequest(fixture.input);
    let dispatches = 0;
    const service = exchangeWorkflow(
      exchangeGateway(async () => {
        dispatches++;
        return { status: 'SUCCESS', new_order_id: await childOrder(9205, 11, false) };
      }),
    );
    await expect(
      service.start(operator, '1', fixture.orderId, fixture.lineId, input),
    ).rejects.toMatchObject({ code: 'EXCHANGE_PAYMENT_UNCONFIRMED' });
    expect((await service.read(operator, '1', input.operationId)).phase).toBe(
      'replacement-confirmed',
    );
    await connection.execute('UPDATE orders SET payment_status=4,order_status=1 WHERE id=19205');
    await connection.execute("UPDATE has_products SET status='PLACED' WHERE order_id=19205");
    await expect(service.continue(operator, '1', input.operationId)).rejects.toMatchObject({
      code: 'EXCHANGE_STOCK_UNCONFIRMED',
    });
    const [unconfirmed] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT order_status FROM orders WHERE id=19205',
    );
    expect(unconfirmed[0]?.order_status).toBe(1);
    await childProof(9205);
    expect((await service.continue(operator, '1', input.operationId)).phase).toBe('completed');
    expect(dispatches).toBe(1);
  });
  it('reconciles a timed-out child from exact writer linkage and stock proof without another external dispatch', async () => {
    const fixture = await returnFixture(9206),
      input = exchangeRequest(fixture.input);
    let dispatches = 0;
    const service = exchangeWorkflow(
      exchangeGateway(async () => {
        dispatches++;
        await childOrder(9206, 11, false);
        throw new CheckoutGatewayError('FIXTURE_TIMEOUT', 'Fixture timeout', true);
      }),
    );
    await expect(
      service.start(operator, '1', fixture.orderId, fixture.lineId, input),
    ).rejects.toMatchObject({ code: 'FIXTURE_TIMEOUT' });
    expect((await service.reconcile(operator, '1', input.operationId)).phase).toBe('uncertain');
    await connection.execute('UPDATE orders SET payment_status=4,order_status=1 WHERE id=19206');
    await childProof(9206);
    await connection.execute('UPDATE order_stores SET counter_id=99 WHERE order_id=19206');
    expect((await service.reconcile(operator, '1', input.operationId)).phase).toBe('uncertain');
    await connection.execute('UPDATE order_stores SET counter_id=3 WHERE order_id=19206');
    await connection.execute(
      'UPDATE pos_rewrite_exchange_stock_confirmations SET parent_has_product_id=999 WHERE order_id=19206',
    );
    expect((await service.reconcile(operator, '1', input.operationId)).phase).toBe('uncertain');
    await connection.execute(
      'UPDATE pos_rewrite_exchange_stock_confirmations SET parent_has_product_id=9306 WHERE order_id=19206',
    );
    expect((await service.reconcile(operator, '1', input.operationId)).phase).toBe(
      'replacement-confirmed',
    );
    expect((await service.continue(operator, '1', input.operationId)).phase).toBe('completed');
    expect(dispatches).toBe(1);
  });
  it('blocks a second child after a rejected request left an orphan upstream order', async () => {
    const fixture = await returnFixture(9207),
      input = exchangeRequest(fixture.input);
    let dispatches = 0;
    const service = exchangeWorkflow(
      exchangeGateway(async () => {
        dispatches++;
        const child = await childOrder(9207, 11, false);
        await connection.execute('DELETE FROM exchange_order_log WHERE order_id=?', [child]);
        throw new CheckoutGatewayError(
          'FIXTURE_CHILD_REJECTED',
          'Fixture upstream 4xx',
          false,
          422,
        );
      }),
    );
    await expect(
      service.start(operator, '1', fixture.orderId, fixture.lineId, input),
    ).rejects.toMatchObject({ code: 'FIXTURE_CHILD_REJECTED' });
    expect((await service.read(operator, '1', input.operationId)).phase).toBe(
      'replacement-rejected',
    );
    await expect(service.retry(operator, '1', input.operationId, '5')).rejects.toMatchObject({
      code: 'EXCHANGE_CHILD_RECONCILIATION_REQUIRED',
    });
    expect((await service.read(operator, '1', input.operationId)).phase).toBe('uncertain');
    expect(dispatches).toBe(1);
  });
  it('proves a zero-total prepaid settlement from writer state without fabricating a counter attempt', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'prepaid-fixture-secret-'.repeat(3),
      }),
      gateway = new FixtureGateway(),
      service = checkoutService(repository, gateway, signingEnvironment, {
        migrationV2: true,
        verifyRefundAllocations: async () => {},
        assertCheckIn: async () => {},
        finalizeOrder: orderFinalizer(db, config),
        prepaidSettlement: prepaidSettlementReader(db),
      });
    gateway.intercept = async (path, payload) => {
      if (path === 'processorder')
        return {
          products: { items: [{ prod_id: 10, quantity: 1, prod_type: 1 }] },
          giftvouchers: { items: [] },
          meta: { items: [{ name: 'calculations', total: 0 }] },
        };
      if (path === 'pos/order') {
        expect(payload.payment_method).toBe('prepaid');
        await seed(Order, {
          id: 8101,
          user_id: 777,
          payment_method: 3,
          payment_status: 4,
          order_status: 3,
          pay_amt: 0,
          order_ref_no: 'PREPAID-8101',
        });
        await seed(OrderStore, { order_id: 8101, store_id: 1, counter_id: 3 });
        await seed(HasProduct, { order_id: 8101, prod_id: 10, qty: 1, status: 'DELIVERED' });
        await projectionFixture(8101);
        await seed(GiftVoucher, { order_id: 8101, voucher_code: 'FIXTURE-PREPAID', status: 0 });
        return { order: 8101, method: 'prepaid', isValid: true, name: 'Fixture' };
      }
      return undefined;
    };
    const state = await service.create(operator, '1', '3');
    await service.quote(operator, '1', state.id, mutation(0));
    const input = mutation(1),
      reply = await service.submit(operator, '1', state.id, input);
    expect(reply.status).toBe('succeeded');
    if (reply.status !== 'succeeded') throw new Error('Expected completed submission');
    expect(reply.result.paymentStatus).toBe('paid');
    expect(reply.result.settlement).toMatchObject({
      status: 'paid',
      source: 'prepaid',
      orderId: '8101',
      receiptId: input.operationId,
      checkoutId: state.id,
      checkoutOperationId: input.operationId,
      cashAmount: '0.00',
      onlineAmount: '0.00',
    });
    const [attempts] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT id FROM pos_rewrite_payment_attempts WHERE order_id=8101',
    );
    expect(attempts).toHaveLength(0);
    const [gift] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT status FROM gift_vouchers WHERE order_id=8101',
    );
    expect(gift[0]?.status).toBe(1);
    expect((await service.read(operator, '1', state.id)).settlement).toBeTruthy();
    await connection.execute('DELETE FROM pos_rewrite_checkout_projections WHERE order_id=8101');
    await expect(service.read(operator, '1', state.id)).rejects.toMatchObject({
      code: 'CHECKOUT_PROJECTION_UNCONFIRMED',
    });
    await expect(service.submit(operator, '1', state.id, input)).rejects.toMatchObject({
      code: 'CHECKOUT_PROJECTION_UNCONFIRMED',
    });
    await expect(
      service.operation(operator, '1', state.id, input.operationId),
    ).rejects.toMatchObject({ code: 'CHECKOUT_PROJECTION_UNCONFIRMED' });
    await connection.execute(
      'DELETE FROM pos_rewrite_checkout_projection_lines WHERE order_id=8101',
    );
    await projectionFixture(8101);
    await connection.execute('UPDATE orders SET payment_status=5,order_status=6 WHERE id=8101');
    expect((await service.read(operator, '1', state.id)).settlement).toBe(null);
    const replay = await service.submit(operator, '1', state.id, input);
    expect(replay.status).toBe('succeeded');
    if (replay.status === 'succeeded') expect(replay.result.settlement).toBe(null);
    const operation = await service.operation(operator, '1', state.id, input.operationId);
    if (!('result' in operation)) throw new Error('Expected completed operation result');
    expect(operation.result?.settlement).toBe(null);
  });
  it('reconciles a lost confirmation from writer proof with one lease and no repeat upstream dispatch', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'confirmation-recovery-fixture-'.repeat(3),
      }),
      gateway = new FixtureGateway(),
      service = checkoutService(repository, gateway, signingEnvironment, {
        migrationV2: true,
        verifyRefundAllocations: async () => {},
        assertCheckIn: async () => {},
        finalizeOrder: orderFinalizer(db, config),
        verifyProjection: (state, orderId) =>
          db.get('writer').transaction((tx) =>
            assertCheckoutProjection(tx, {
              orderId,
              storeId: state.storeId,
              counterId: state.counterId,
              customerId: state.customerId || state.operatorCustomerId,
            }),
          ),
      });
    gateway.intercept = async (path) => {
      if (path === 'pos/order') {
        await seed(Order, {
          id: 87001,
          user_id: 777,
          payment_method: 14,
          payment_status: 1,
          order_status: 1,
          pay_amt: 99,
        });
        await seed(OrderStore, { order_id: 87001, store_id: 1, counter_id: 3 });
        await seed(HasProduct, { order_id: 87001, prod_id: 10, qty: 1, status: 'PLACED' });
        return { order: 87001, method: 'coc', isValid: true, name: 'Fixture' };
      }
      if (path === 'payment-confirm')
        throw new CheckoutGatewayError(
          'CHECKOUT_OUTCOME_UNCERTAIN',
          'Fixture lost confirmation',
          true,
        );
      return undefined;
    };
    const state = await service.create(operator, '1', '3');
    await service.quote(operator, '1', state.id, mutation(0));
    const submit = mutation(1);
    await expect(service.submit(operator, '1', state.id, submit)).rejects.toMatchObject({
      code: 'CHECKOUT_OUTCOME_UNCERTAIN',
    });
    await expect(
      service.reconcileConfirmation(operator, '1', state.id, mutation(1)),
    ).rejects.toMatchObject({ code: 'CHECKOUT_PROJECTION_UNCONFIRMED' });
    const [before] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT order_invoice FROM order_stores WHERE order_id=87001',
    );
    expect(before[0]?.order_invoice).toBeFalsy();
    await projectionFixture(87001);
    const input = mutation(1),
      hash = operationHash('order.confirmation.reconcile', {}, signingEnvironment.hs256),
      first = await repository.begin(operator.id, '1', state.id, input, hash, {
        leaseId: crypto.randomUUID(),
        now: Date.now(),
      });
    const expireLease = () =>
      connection.execute(
        "UPDATE pos_rewrite_checkout_sessions SET state=JSON_SET(state,'$.confirmationRecovery.expiresAt',?) WHERE id=?",
        [Date.now() - 1, state.id],
      );
    await expireLease();
    const replacement = await repository.begin(operator.id, '1', state.id, input, hash, {
      leaseId: crypto.randomUUID(),
      now: Date.now(),
    });
    expect(replacement.replay).toBe(false);
    expect(replacement.state.confirmationRecovery?.leaseId).not.toBe(
      first.state.confirmationRecovery?.leaseId,
    );
    await expect(repository.checkpoint(first.state, input.operationId)).rejects.toMatchObject({
      code: 'CHECKOUT_OPERATION_CHANGED',
    });
    await expect(repository.finish(first.state, input.operationId, {})).rejects.toMatchObject({
      code: 'CHECKOUT_OPERATION_CHANGED',
    });
    await repository.fail(first.state, input.operationId, true, 'FIXTURE_STALE_WORKER');
    expect((await repository.get(operator.id, '1', state.id))?.confirmationRecovery?.leaseId).toBe(
      replacement.state.confirmationRecovery?.leaseId,
    );
    await expireLease();
    const replies = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.reconcileConfirmation(operator, '1', state.id, input),
      ),
    );
    expect(replies.every((reply) => ['inflight', 'succeeded'].includes(reply.status))).toBe(true);
    const done = await service.reconcileConfirmation(operator, '1', state.id, input);
    expect(done.status).toBe('succeeded');
    expect(done.state).toMatchObject({
      orderId: '87001',
      phase: 'submitted',
      confirmationPhase: 'acknowledged',
      busyOperationId: null,
    });
    expect((await service.operation(operator, '1', state.id, submit.operationId)).status).toBe(
      'succeeded',
    );
    expect(gateway.calls.filter((call) => call.path === 'pos/order')).toHaveLength(1);
    expect(gateway.calls.filter((call) => call.path === 'payment-confirm')).toHaveLength(1);
    const [after] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT order_invoice FROM order_stores WHERE order_id=87001',
    );
    expect(after[0]?.order_invoice).toBeTruthy();
  });
  it('retains financial HTTP request and actor correlation through durable delivery', async () => {
    const orderId = await paymentFixture(8005),
      config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'delivery-context-fixture-'.repeat(3),
      }),
      app = Fastify({ logger: false, genReqId: () => 'financial-request-fixture' });
    app.decorateRequest('principal', null);
    registerRequestTrace(app);
    app.addHook('preHandler', async (request) => {
      request.principal = operator;
    });
    registerPayments(app, config, db, {
      hashSecret: signingEnvironment.hs256,
      projection: signingEnvironment,
      gateway: inactiveGateway,
      assertCheckIn: async () => {},
    });
    await app.ready();
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/stores/1/orders/${orderId}/payment-attempts`,
            payload: paymentInput(),
          })
        ).statusCode,
      ).toBe(201);
    } finally {
      await app.close();
    }
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT request_id,operator_id FROM pos_rewrite_payment_outbox WHERE order_id=8005',
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) => row.request_id === 'financial-request-fixture' && row.operator_id === '44',
      ),
    ).toBe(true);
    const observed: { requestId: string | null; operatorId: string | null }[] = [],
      dispatch = paymentOutboxDispatcher(
        db,
        config,
        {
          orderProducerUrl: 'https://producer.example.test/',
          orderProducerAppId: 'fixture',
          orderProducerAppKey: 'fixture-secret-'.repeat(3),
          engagementUrl: 'https://engagement.example.test/',
        },
        async () => new Response(null, { status: 204 }),
        (event) => {
          observed.push(event);
        },
      );
    expect((await dispatch(100)).delivered).toBe(2);
    expect(
      observed.every(
        (event) => event.requestId === 'financial-request-fixture' && event.operatorId === '44',
      ),
    ).toBe(true);
  });
  it('delivers the source exchange email payload once after confirmed local exchange completion', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'exchange-mail-fixture-'.repeat(3),
      }),
      bodies: unknown[] = [],
      dispatcher = returnOutboxDispatcher(
        db,
        config,
        {
          TSS_RETURN_EMAIL_URL: 'https://mail.example.test/returns',
          TSS_EXCHANGE_EMAIL_URL: 'https://mail.example.test/exchange',
        },
        async (url, init) => {
          expect(String(url)).toBe('https://mail.example.test/exchange');
          bodies.push(JSON.parse(String(init?.body)) as unknown);
          return new Response(null, { status: 204 });
        },
      );
    expect((await dispatcher(100)).delivered).toBe(5);
    expect(bodies).toHaveLength(5);
    expect(
      bodies.every(
        (body) =>
          typeof body === 'object' &&
          body !== null &&
          'product_id' in body &&
          body.product_id === 11 &&
          'has_product_id' in body &&
          !('product_ids' in body),
      ),
    ).toBe(true);
    expect((await dispatcher()).delivered).toBe(0);
  });
  const discountSecret = 'isolated-manager-approval-secret-'.repeat(3);
  let approvalClock = Date.now();
  function approvalFixture(extra: NodeJS.ProcessEnv = {}) {
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'approval-fixture-secret-'.repeat(3),
      }),
      gateway = new FixtureGateway();
    let clock = (approvalClock += 3600000),
      amount = '20.00';
    const approvals = discountApprovals(db, config, {
      signingSecret: signingEnvironment.hs256,
      approvalSecret: discountSecret,
      policy: discountPolicy(extra),
      assertDeliveryReady: () => {},
      now: () => clock,
    });
    gateway.intercept = async (path) =>
      path === 'processorder'
        ? {
            products: { items: [{ prod_id: 10, quantity: 1, prod_type: 1 }] },
            giftvouchers: { items: [] },
            meta: {
              items: [
                {
                  name: 'calculations',
                  products_total: 80,
                  total: new Decimal(100).minus(amount).toNumber(),
                  used_pg_discount: 0,
                  used_store_discount_pg: Number(amount),
                },
              ],
            },
          }
        : undefined;
    const service = checkoutService(repository, gateway, signingEnvironment, {
      migrationV2: true,
      verifyRefundAllocations: async () => {},
      assertCheckIn: async () => {},
      discounts: approvals,
      now: () => clock,
      finalizeOrder: async () => ({
        transactionId: 'APPROVAL-FIXTURE',
        invoice: 'FIXTURE-INVOICE',
      }),
    });
    return {
      service,
      gateway,
      approvals,
      advance: () => {
        clock += 61000;
        approvalClock = Math.max(approvalClock, clock);
      },
      price: (next: string) => {
        amount = next;
      },
      prepare: async () => {
        const checkout = await service.create(operator, '1', '3');
        await service.discount(operator, '1', checkout.id, mutation(0), {
          kind: 'store',
          amount,
          apply: true,
          remark: 'Price issue',
          reason: 'Price mismatch (Online v/s POS)',
        });
        await service.quote(operator, '1', checkout.id, mutation(1));
        return checkout.id;
      },
    };
  }
  it('binds a manager approval to the server quote and persists report-compatible audit once before order confirmation', async () => {
    const fixture = approvalFixture({
        PG_DISC_STORE_MANAGER_PERCENTAGE: JSON.stringify({
          '1': { '0': ['approver@example.test'] },
        }),
      }),
      id = await fixture.prepare();
    await expect(fixture.service.submit(operator, '1', id, mutation(2))).rejects.toMatchObject({
      code: 'DISCOUNT_APPROVAL_REQUIRED',
    });
    const input = mutation(2);
    const requests = await Promise.all(
      Array.from({ length: 10 }, () =>
        fixture.service.requestDiscountApproval(operator, '1', id, input),
      ),
    );
    expect(requests.every((value) => ['succeeded', 'inflight'].includes(value.status))).toBe(true);
    const [queued] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT id,target_id,encrypted_code FROM pos_rewrite_discount_deliveries WHERE checkout_id=?',
      [id],
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.target_id).toBe('46');
    const code = decryptCode(
      discountSecret,
      String(queued[0]!.id),
      String(queued[0]!.encrypted_code),
    );
    const [stored] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT state FROM pos_rewrite_discount_approvals WHERE checkout_id=?',
      [id],
    );
    expect(JSON.stringify(stored)).not.toContain(code);
    const emails: Record<string, unknown>[] = [],
      dispatch = discountOutboxDispatcher(
        db,
        {
          url: 'https://mail.example.test/send',
          apiKey: 'fixture',
          approvalSecret: discountSecret,
        },
        async (_url, init) => {
          emails.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Response.json({ status: 'success' });
        },
      );
    expect((await dispatch(100)).delivered).toBe(1);
    expect(JSON.stringify(emails)).toContain(code);
    expect(JSON.stringify(emails)).toContain('approver@example.test');
    await fixture.service.confirmDiscountApproval(operator, '1', id, mutation(3), code);
    expect((await fixture.service.discountApproval(operator, '1', id)).status).toBe('approved');
    fixture.price('19.75');
    await expect(fixture.service.submit(operator, '1', id, mutation(4))).rejects.toMatchObject({
      code: 'CHECKOUT_QUOTE_CHANGED',
    });
    expect(fixture.gateway.calls.filter((value) => value.path === 'pos/order')).toHaveLength(0);
    await fixture.service.quote(operator, '1', id, mutation(4));
    expect((await fixture.service.discountApproval(operator, '1', id)).status).toBe('required');
    await expect(
      fixture.service.requestDiscountApproval(operator, '1', id, mutation(5)),
    ).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_SEND_LIMIT' });
    fixture.advance();
    await fixture.service.requestDiscountApproval(operator, '1', id, mutation(5));
    const [replacement] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT id,encrypted_code FROM pos_rewrite_discount_deliveries WHERE checkout_id=? AND status='pending'",
      [id],
    );
    const nextCode = decryptCode(
      discountSecret,
      String(replacement[0]!.id),
      String(replacement[0]!.encrypted_code),
    );
    expect((await dispatch(100)).delivered).toBe(1);
    await fixture.service.confirmDiscountApproval(operator, '1', id, mutation(6), nextCode);
    const previous = fixture.gateway.intercept;
    fixture.gateway.intercept = async (path, payload) => {
      if (path === 'pos/order') {
        await seed(Order, {
          id: 9701,
          user_id: 777,
          payment_status: 1,
          order_status: 1,
          pay_amt: 80.25,
        });
        await seed(OrderStore, { order_id: 9701, store_id: 1, counter_id: 3 });
        return { order: 9701, method: 'coc', isValid: true, name: 'Fixture' };
      }
      return previous?.(path, payload);
    };
    const submission = mutation(7);
    expect((await fixture.service.submit(operator, '1', id, submission)).status).toBe('succeeded');
    expect((await fixture.service.submit(operator, '1', id, submission)).status).toBe('succeeded');
    const [audit] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT * FROM store_pg_disc_addons WHERE order_id=9701',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      pg_disc_desc: '|Price issue',
      pg_disc_amount_in_rs: 19,
      pg_disc_otp: null,
      otp_provided_by: 46,
      otp_provided_by_name: 'Policy approver',
      otp_applied_by: 44,
      otp_applied_by_name: 'Fixture operator',
      store_id: 1,
      counter_id: 3,
    });
    const [precise] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT amount FROM pos_rewrite_discount_audits WHERE order_id=9701',
    );
    expect(precise[0]?.amount).toBe('19.75');
    expect(fixture.gateway.calls.filter((value) => value.path === 'pos/order')).toHaveLength(1);
    expect((await dispatch(100)).delivered).toBe(1);
    expect((await dispatch()).delivered).toBe(0);
    expect(emails).toHaveLength(3);
    expect(JSON.stringify(emails[2])).toContain('PG Discount Used For Order - 9701');
    expect(JSON.stringify(emails[2])).not.toContain(nextCode);
  });
  it('enforces shared attempt limits, live approver eligibility and expiry across a service restart', async () => {
    const fixture = approvalFixture(),
      id = await fixture.prepare();
    await fixture.service.requestDiscountApproval(operator, '1', id, mutation(2));
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT id,target_id,encrypted_code FROM pos_rewrite_discount_deliveries WHERE checkout_id=?',
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_id).toBe('45');
    const code = decryptCode(discountSecret, String(rows[0]!.id), String(rows[0]!.encrypted_code));
    for (let index = 0; index < 5; index++)
      await expect(
        fixture.service.confirmDiscountApproval(
          operator,
          '1',
          id,
          mutation(3),
          '111111' === code ? '222222' : '111111',
        ),
      ).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_CODE_INVALID' });
    await expect(
      fixture.service.confirmDiscountApproval(operator, '1', id, mutation(3), code),
    ).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_ATTEMPT_LIMIT' });
    expect((await fixture.service.discountApproval(operator, '1', id)).status).toBe('locked');
    fixture.advance();
    await expect(
      fixture.service.requestDiscountApproval(operator, '1', id, mutation(3)),
    ).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_ATTEMPT_LIMIT' });
    for (let index = 0; index < 9; index++) fixture.advance();
    await fixture.service.requestDiscountApproval(operator, '1', id, mutation(3));
    const [renewed] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT id,encrypted_code FROM pos_rewrite_discount_deliveries WHERE checkout_id=? AND status='pending' ORDER BY created_at DESC,id",
      [id],
    );
    const fresh = renewed.find((row) => String(row.id) !== String(rows[0]!.id))!,
      renewedCode = decryptCode(discountSecret, String(fresh.id), String(fresh.encrypted_code));
    await connection.execute('UPDATE pos_user SET is_active=0 WHERE id=45');
    try {
      await expect(
        fixture.service.confirmDiscountApproval(operator, '1', id, mutation(4), renewedCode),
      ).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_CODE_INVALID' });
    } finally {
      await connection.execute('UPDATE pos_user SET is_active=1 WHERE id=45');
    }
    for (let index = 0; index < 10; index++) fixture.advance();
    expect((await fixture.service.discountApproval(operator, '1', id)).status).toBe('expired');
    await expect(
      fixture.service.confirmDiscountApproval(operator, '1', id, mutation(4), renewedCode),
    ).rejects.toMatchObject({ code: 'DISCOUNT_APPROVAL_CHALLENGE_REQUIRED' });
  });
  it('queues the source order SMS once with NPS metadata and freezes unknown delivery without resending', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'notification-fixture-'.repeat(3),
      }),
      finalize = orderFinalizer(db, config);
    const state = {
      storeId: '1',
      counterId: '3',
      operatorId: operator.id,
      customerId: null,
      operatorCustomerId: '777',
      lineSalespersons: {},
      salespersonId: null,
      orderNotifications: { sendSms: true, npsFeedback: true },
    };
    for (const id of [8401, 8402, 8403]) {
      await seed(Order, {
        id,
        user_id: 777,
        payment_method: 14,
        payment_status: 1,
        order_status: 1,
        pay_amt: 100,
      });
      await seed(OrderStore, { order_id: id, store_id: 1, counter_id: 3 });
      await seed(HasProduct, { order_id: id, prod_id: 10, qty: 1, price: 100, status: 'PLACED' });
      await projectionFixture(id);
    }
    await Promise.all(Array.from({ length: 10 }, () => finalize(state, '8401')));
    const [addons] = await connection.execute<RowDataPacket[]>(
      'SELECT shipped_location,is_nps_notification_checked,is_nps_mail_sent FROM order_addons WHERE order_id=8401',
    );
    expect(addons).toEqual([
      expect.objectContaining({
        shipped_location: 'MW1',
        is_nps_notification_checked: 1,
        is_nps_mail_sent: 0,
      }),
    ]);
    const [jobs] = await connection.execute<RowDataPacket[]>(
      'SELECT id,operator_id,status FROM pos_rewrite_payment_outbox WHERE order_id=8401 AND kind=?',
      ['order-sms'],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'order-sms:8401', operator_id: '44', status: 'pending' });
    await finalize(
      { ...state, orderNotifications: { sendSms: false, npsFeedback: false } },
      '8403',
    );
    const [disabled] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM pos_rewrite_payment_outbox WHERE order_id=8403 AND kind=?',
      ['order-sms'],
    );
    expect(disabled).toHaveLength(0);
    await finalize({ ...state, orderNotifications: { sendSms: true, npsFeedback: false } }, '8402');
    const calls: number[] = [],
      observed: string[] = [],
      environment = {
        orderProducerUrl: 'https://producer.example.test/',
        orderProducerAppId: 'fixture',
        orderProducerAppKey: 'fixture-key-'.repeat(3),
        engagementUrl: 'https://engagement.example.test/',
        orderSmsUrl: 'https://sms.example.test/internal/pos/order-messages',
        orderSmsContract: orderMessageContract,
        orderSmsKey: 'distinct-private-order-message-fixture-'.repeat(2),
      };
    let blockedCalls = 0;
    for (const unverified of [
      { ...environment, orderSmsContract: undefined },
      { ...environment, orderSmsUrl: 'https://sms.example.test/omnichannel-sms' },
      { ...environment, orderSmsKey: environment.orderProducerAppKey },
    ]) {
      await paymentOutboxDispatcher(db, config, unverified, async (input) => {
        if (String(input).includes('sms.example.test')) blockedCalls++;
        return new Response(null, { status: 204 });
      })(100);
    }
    expect(blockedCalls).toBe(0);
    const [held] = await connection.execute<RowDataPacket[]>(
      "SELECT status FROM pos_rewrite_payment_outbox WHERE order_id IN (8401,8402) AND kind='order-sms'",
    );
    expect(held).toHaveLength(2);
    expect(held.every((row) => row.status === 'pending')).toBe(true);
    // Queuing an order confirmation is separate from receiving cash. Do not
    // dispatch its customer notification until writer payment is confirmed.
    await connection.execute(
      'UPDATE orders SET payment_status=4,order_status=3 WHERE id IN(8401,8402)',
    );
    const dispatcher = paymentOutboxDispatcher(
      db,
      config,
      environment,
      async (url, init) => {
        if (String(url) !== environment.orderSmsUrl) return new Response(null, { status: 204 });
        const payload: unknown = JSON.parse(String(init?.body));
        if (
          typeof payload !== 'object' ||
          payload === null ||
          !('order_id' in payload) ||
          typeof payload.order_id !== 'number'
        )
          throw new Error('Invalid source SMS fixture payload');
        calls.push(payload.order_id);
        if (payload.order_id === 8402) throw new Error('PRIVATE-UNKNOWN-DELIVERY');
        const body = JSON.stringify({ message: 'SMS Sent' }),
          headers = new Headers(init?.headers),
          nonce = headers.get('x-pos-order-sms-nonce') ?? '';
        expect(headers.get('x-pos-order-sms-key')).toBe(environment.orderSmsKey);
        expect(headers.get('x-pos-order-sms-contract')).toBe(orderMessageContract);
        expect(headers.get('x-pos-operator-id')).toBe('44');
        return new Response(body, {
          headers: {
            'Content-Type': 'application/json',
            'X-POS-Order-SMS-Contract': orderMessageContract,
            'X-POS-Feedback-Contract': feedbackProofContract,
            'X-POS-Order-SMS-Nonce': nonce,
            'X-POS-Order-SMS-Proof': orderMessageResponseProof(
              {
                eventId: headers.get('idempotency-key') ?? '',
                orderId: String(payload.order_id),
                operatorId: headers.get('x-pos-operator-id') ?? '',
                requestId: headers.get('x-request-id') ?? '',
                nonce,
              },
              body,
              environment.orderSmsKey,
            ),
          },
        });
      },
      (event) => {
        if (event.resource === 'order-sms') observed.push(event.outcome);
      },
    );
    await Promise.all([dispatcher(100), dispatcher(100)]);
    await dispatcher(100);
    expect(calls.filter((id) => id === 8401)).toHaveLength(1);
    expect(calls.filter((id) => id === 8402)).toHaveLength(1);
    expect(observed).toContain('uncertain');
    const [unknown] = await connection.execute<RowDataPacket[]>(
      'SELECT status FROM pos_rewrite_payment_outbox WHERE order_id=8402 AND kind=?',
      ['order-sms'],
    );
    expect(unknown[0]?.status).toBe('uncertain');
  });
  it('delivers source-derived SMS only after paid projection proof and freezes unknown or interrupted acknowledgments across workers', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'local-sms-fixture-'.repeat(3),
      }),
      finalize = orderFinalizer(db, config),
      state = {
        storeId: '1',
        counterId: '3',
        operatorId: operator.id,
        customerId: null,
        operatorCustomerId: '777',
        lineSalespersons: {},
        salespersonId: null,
      },
      ids = [8414, 8415, 8416],
      calls: { message: string; url: string; body: URLSearchParams }[] = [],
      outcomes: string[] = [];
    for (const id of ids) {
      await seed(Order, {
        id,
        user_id: 777,
        payment_method: 14,
        payment_status: 1,
        order_status: 1,
        pay_amt: 100,
      });
      await seed(OrderStore, { order_id: id, store_id: 1, counter_id: 3 });
      await seed(HasProduct, { order_id: id, prod_id: 10, qty: 1, price: 100, status: 'PLACED' });
      await projectionFixture(id);
      await finalize(
        { ...state, orderNotifications: { sendSms: true, npsFeedback: id === 8415 } },
        String(id),
      );
    }
    const env = orderMessageFixtureEnvironment,
      local = localOrderMessageDelivery(
        { DEMO_MODE: false },
        orderMessageOptions(env),
        env,
        async (input, init) => {
          const url = new URL(String(input)),
            body = new URLSearchParams(String(init?.body));
          expect(url.origin + url.pathname).toBe(
            'https://enterprise.smsgupshup.com/GatewayAPI/rest',
          );
          expect(url.search).toBe('');
          expect(init?.method).toBe('POST');
          expect(init?.redirect).toBe('error');
          expect(new Headers(init?.headers).get('content-type')).toBe(
            'application/x-www-form-urlencoded',
          );
          expect(body.get('userid')).toBe(env.GUPSHUP_SMS_USER_ID);
          expect(body.get('password')).toBe(env.GUPSHUP_SMS_PASSWORD);
          expect(body.get('send_to')).toBe('9000000000');
          const message = body.get('msg')!;
          calls.push({ message, url: url.href, body });
          if (message.includes('(ID: 8416)')) throw new Error('PRIVATE-PROVIDER-REPLY-CANARY');
          return new Response('success | synthetic-provider-reference');
        },
      )!,
      delivery = paymentOutboxDispatcher(
        db,
        config,
        {
          orderProducerUrl: 'https://producer.example.test/',
          orderProducerAppId: 'fixture',
          orderProducerAppKey: 'fixture-order-producer-key-0123456789',
          engagementUrl: 'https://engagement.example.test/',
        },
        async () => new Response(null, { status: 204 }),
        (event) => {
          if (event.resource === 'order-sms') outcomes.push(event.outcome);
        },
        local,
      );
    await delivery(100);
    expect(calls).toHaveLength(0);
    const [queued] = await connection.execute<RowDataPacket[]>(
      "SELECT status FROM pos_rewrite_payment_outbox WHERE order_id IN(8414,8415,8416) AND kind='order-sms'",
    );
    expect(queued).toHaveLength(3);
    expect(queued.every((row) => row.status === 'pending')).toBe(true);
    await connection.execute(
      'UPDATE orders SET payment_status=4,order_status=3 WHERE id IN(8414,8415,8416)',
    );
    await connection.execute(
      "UPDATE has_products SET status='DELIVERED' WHERE order_id IN(8414,8415,8416)",
    );
    await connection.execute(
      "UPDATE pos_rewrite_checkout_projections SET input_hash=REPEAT('0',64) WHERE order_id=8414",
    );
    await expect(delivery(1)).rejects.toMatchObject({ code: 'CHECKOUT_PROJECTION_UNCONFIRMED' });
    expect(calls).toHaveLength(0);
    await connection.execute(
      `UPDATE pos_rewrite_checkout_projections proof JOIN orders ON orders.id=proof.order_id SET proof.input_hash=${checkoutHeaderHashSql} WHERE proof.order_id=8414`,
    );
    await connection.query(`CREATE TRIGGER fixture_sms_ack_failure BEFORE UPDATE ON pos_rewrite_payment_outbox FOR EACH ROW
      BEGIN IF NEW.order_id='8414' AND NEW.status='delivered' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='controlled SMS outcome write failure'; END IF; END`);
    try {
      await Promise.allSettled(Array.from({ length: 10 }, () => delivery(100)));
      await delivery(100);
    } finally {
      await connection.query('DROP TRIGGER fixture_sms_ack_failure');
    }
    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => call.message.includes('(ID: 8414)'))).toHaveLength(1);
    expect(calls.filter((call) => call.message.includes('(ID: 8416)'))).toHaveLength(1);
    const nps = calls.find((call) => call.message.includes('shopping experience here:'))!;
    expect(nps).toBeDefined();
    const url = new URL(nps.message.split('shopping experience here: ')[1]!),
      proof = new URLSearchParams(url.hash.slice(1)).get('feedback_proof')!;
    expect(url.search).toBe('');
    expect(
      feedbackVerifier({
        keys: [{ id: env.POS_INVOICE_FEEDBACK_KEY_ID, key: env.POS_INVOICE_FEEDBACK_KEY }],
        maxTtlSeconds: 600,
        forbiddenKeys: [env.TSS_JWT_HS256_KEY, env.TSS_JWT_HS512_KEY],
      })(proof, Date.now(), '8415').orderId,
    ).toBe('8415');
    const [records] = await connection.execute<RowDataPacket[]>(
      "SELECT order_id,status FROM pos_rewrite_payment_outbox WHERE order_id IN(8414,8415,8416) AND kind='order-sms' ORDER BY order_id",
    );
    expect(records.map((row) => [row.order_id, row.status])).toEqual([
      ['8414', 'processing'],
      ['8415', 'delivered'],
      ['8416', 'uncertain'],
    ]);
    await delivery(100);
    expect(calls).toHaveLength(3);
    expect(outcomes).toContain('uncertain');
    const [index] = await connection.query<RowDataPacket[]>(
      "SHOW INDEX FROM pos_rewrite_payment_outbox WHERE Key_name='ix_payment_outbox_pending'",
    );
    expect(
      index
        .sort((left, right) => Number(left.Seq_in_index) - Number(right.Seq_in_index))
        .map((row) => row.Column_name),
    ).toEqual(['status', 'created_at', 'id', 'kind']);
    const [plan] = await connection.query<RowDataPacket[]>(
      "EXPLAIN SELECT id,kind,order_id FROM pos_rewrite_payment_outbox WHERE status='pending' AND kind IN('order-kinesis','order-engagement','order-sms') ORDER BY created_at,id LIMIT 10",
    );
    expect(String(plan[0]?.possible_keys)).toContain('ix_payment_outbox_pending');
  });
  it('keeps approval email delivery uncertain after a timeout and never resends it automatically', async () => {
    const fixture = approvalFixture(),
      id = await fixture.prepare();
    await fixture.service.requestDiscountApproval(operator, '1', id, mutation(2));
    let calls = 0;
    const dispatcher = discountOutboxDispatcher(
      db,
      { url: 'https://mail.example.test/send', apiKey: 'fixture', approvalSecret: discountSecret },
      async () => {
        calls++;
        throw new Error('PRIVATE-CONTACT-MUST-NOT-BE-LOGGED');
      },
    );
    // Older expired/locked jobs are discarded. Only the current valid challenge is dispatched.
    await connection.execute(
      "UPDATE pos_rewrite_discount_deliveries SET status='rejected',encrypted_code=NULL WHERE checkout_id<>? AND status='pending'",
      [id],
    );
    expect((await dispatcher(100)).uncertain).toBe(1);
    expect((await dispatcher(100)).uncertain).toBe(0);
    expect(calls).toBe(1);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT status,encrypted_code FROM pos_rewrite_discount_deliveries WHERE checkout_id=?',
      [id],
    );
    expect(rows[0]).toMatchObject({ status: 'uncertain', encrypted_code: null });
    expect((await fixture.service.discountApproval(operator, '1', id)).status).toBe('pending');
  });
});
