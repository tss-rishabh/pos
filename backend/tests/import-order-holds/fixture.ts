import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, getTableName } from 'drizzle-orm';
import {
  Attributes,
  ExtendApplicabilityForReturnExchange,
  HasOptions,
  HoldStockStore,
  OrderAddon,
  PosExchangeLog,
  PosHoldStockLog,
  PosMachine,
  PosPaytmMachine,
  PosPaytmTransaction,
  PosTerminalTransaction,
  PosTerminalPaymentModes,
  ReturnOrder,
  ReversePickupReason,
  SalesPerson,
  StoreSalesPerson,
} from '../../src/db/legacy-schema.js';
import { splitMigration } from '../../src/db/migrations.js';
import type { Principal } from '../../src/domain/access.js';
import {
  returnOperationSchema,
  returnInputSchema,
} from '../../src/modules/checkout/return-workflow/contracts.js';
import { returnOperations } from '../../src/modules/checkout/return-workflow/schema.js';
import { paymentAttemptSchema } from '../../src/modules/checkout/payments/contracts.js';
import { paymentAttempts } from '../../src/modules/checkout/payments/schema.js';
import { financialImportOrderBindings } from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import { importFinancialFixture } from '../legacy-import-financial/fixture.js';
import { runtimeImportSecret } from '../legacy-order-imports/runtime-fixture.js';
import { signingEnvironment } from '../checkout/fixtures.js';

export const orderId = '9007199254740995',
  lineId = '9007199254740997',
  productId = '9007199254740993';
export const actor: Principal = {
  id: '1',
  name: 'Fixture manager',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: ['1', '2'],
};
export const projection = { ...signingEnvironment, checkoutProjectionKey: runtimeImportSecret };
export async function importHoldFixture(template: string) {
  const f = await importFinancialFixture(template);
  const extra = [
    Attributes,
    ExtendApplicabilityForReturnExchange,
    HasOptions,
    HoldStockStore,
    OrderAddon,
    PosExchangeLog,
    PosHoldStockLog,
    PosMachine,
    PosPaytmMachine,
    PosPaytmTransaction,
    PosTerminalTransaction,
    PosTerminalPaymentModes,
    ReturnOrder,
    ReversePickupReason,
    SalesPerson,
    StoreSalesPerson,
  ].map(getTableName);
  await f.fixture.create(extra);
  for (const path of [
    'src/modules/administration/migration.sql',
    'src/modules/checkout/migrations/0002_checkout.sql',
    'src/modules/checkout/migrations/0004_returns.sql',
    'src/modules/checkout/migrations/0005_financial_delivery_context.sql',
    'src/modules/checkout/migrations/0007_exchange_stock_proof.sql',
    'src/modules/checkout/migrations/0011_offline_cash.sql',
    'src/modules/checkout/payments/legacy-migration.sql',
    'src/modules/checkout/cancellations/migration.sql',
    'src/modules/legacy-order-status/migration.sql',
    'src/modules/legacy-order-status/repair-migration.sql',
  ])
    for (const statement of splitMigration(readFileSync(path, 'utf8')))
      await f.connection.query(statement);
  async function reset() {
    for (const table of [
      'pos_rewrite_operator_checkins',
      'pos_rewrite_return_operations',
      'pos_rewrite_return_outbox',
      'pos_rewrite_return_verifications',
      'pos_rewrite_return_repair_obligations',
      'pos_rewrite_return_repair_recoveries',
      'pos_rewrite_exchange_stock_confirmations',
      'pos_rewrite_legacy_payment_recoveries',
      'pos_rewrite_pending_order_cancellations',
      ...extra,
    ])
      await f.connection.query('DELETE FROM `' + table + '`');
    await f.reset();
    await f.connection.execute(
      'INSERT INTO pos_rewrite_operator_checkins(operator_id,store_id,counter_id,checked_in_at,expires_at) VALUES (?,?,?,?,?)',
      ['1', '1', '2', '2026-01-01 00:00:00', '2099-12-31 00:00:00'],
    );
  }
  async function held() {
    const transport = f.transport(),
      original = transport.order,
      input = f.input();
    transport.order = async (value) => {
      await original(value);
      throw new Error('isolated lost source response');
    };
    const result = await legacyOrderImportFinancialAdapter(
      f.config,
      f.db,
      f.options,
      transport,
    ).start(input);
    if (result.status !== 'unknown' || result.orderId !== orderId)
      throw new Error('Isolated held order was not created.');
    const [binding] = await f.db
      .get('writer')
      .select()
      .from(financialImportOrderBindings)
      .where(eq(financialImportOrderBindings.orderId, orderId));
    if (!binding) throw new Error('Isolated held binding missing.');
    return {
      input,
      binding,
      async release() {
        await f.db
          .get('writer')
          .delete(financialImportOrderBindings)
          .where(eq(financialImportOrderBindings.orderId, orderId));
      },
      async restore() {
        await f.db.get('writer').insert(financialImportOrderBindings).values(binding);
      },
    };
  }
  async function payment() {
    const value = paymentAttemptSchema.parse({
      id: randomUUID(),
      operatorId: actor.id,
      storeId: '1',
      counterId: '2',
      orderId,
      channel: 'cash',
      onlineAmount: '0.00',
      cashAmount: '50.00',
      cashReceived: '50.00',
      machineId: null,
      externalReference: null,
      transactionId: 'FIXTURE-REF',
      providerReference: null,
      status: 'dispatching',
      requestHash: 'a'.repeat(64),
      busyOperationId: randomUUID(),
      errorCode: null,
      createdAt: '2026-06-15 12:00:00',
      updatedAt: '2026-06-15 12:00:00',
    });
    await f.db
      .get('writer')
      .insert(paymentAttempts)
      .values({
        id: value.id,
        orderId,
        storeId: '1',
        operatorId: actor.id,
        status: value.status,
        state: value,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      });
    return value;
  }
  async function operation(
    kind: 'return' | 'exchange' = 'return',
    phase:
      | 'inbound-dispatching'
      | 'inbound-accepted'
      | 'refund-dispatching'
      | 'refund-confirmed'
      | 'replacement-dispatching'
      | 'replacement-confirmed' = 'inbound-dispatching',
    childOrderId: string | null = null,
  ) {
    const id = randomUUID(),
      value = returnOperationSchema.parse({
        id,
        kind,
        exchange:
          kind === 'exchange'
            ? {
                newProductId: productId,
                parentProductId: productId,
                newSize: 'M',
                oldSize: 'S',
                salespersonId: '1',
                logId: '1',
                childOrderId,
              }
            : null,
        operatorId: actor.id,
        storeId: '1',
        orderId,
        lineId,
        productId,
        customerId: '77',
        quantity: 2,
        input: returnInputSchema.parse({
          operationId: id,
          counterId: '2',
          verificationId: randomUUID(),
          reasonId: '1',
          qualityConfirmed: true,
          tagConfirmed: true,
          saleable: false,
          refundMode: 'cash',
        }),
        requestHash: 'a'.repeat(64),
        phase,
        uncertainStage: null,
        creditNote: null,
        returnAmount: null,
        errorCode: null,
        createdAt: '2026-06-15 12:00:00',
        updatedAt: '2026-06-15 12:00:00',
      });
    // The old INT-only tracking row cannot represent these deliberately wide
    // fixture identities. This evidence-only response path addresses logId;
    // normal exchange creation retains its existing legacy-ID eligibility gate.
    if (kind === 'exchange')
      await f.fixture.insert('pos_exchange_log', {
        id: 1,
        order_id: 1,
        has_prod_id: 1,
        status: 'IN_PROGRESS',
      });
    await f.db
      .get('writer')
      .insert(returnOperations)
      .values({
        id,
        lineId,
        storeId: '1',
        phase,
        state: value,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      });
    return value;
  }
  async function effects() {
    const tables = [
      'pos_transaction_logs',
      'pos_rewrite_payment_outbox',
      'pos_rewrite_return_outbox',
      'return_orders',
      'pos_rewrite_pending_order_cancellations',
      'pos_product_inventory_logs',
      'store_day_close',
    ];
    const counts: Record<string, string> = {};
    for (const table of tables) {
      const [rows] = await f.connection.query<Array<import('mysql2').RowDataPacket>>(
        'SELECT CAST(COUNT(*) AS CHAR) n FROM `' + table + '`',
      );
      counts[table] = String(rows[0]!.n);
    }
    const [orders] = await f.connection.query(
        'SELECT CAST(id AS CHAR) id,payment_status,order_status FROM orders ORDER BY id',
      ),
      [lines] = await f.connection.query(
        'SELECT CAST(id AS CHAR) id,status FROM has_products ORDER BY id',
      ),
      [stock] = await f.connection.query('SELECT stock FROM product_store ORDER BY id');
    return { counts, orders, lines, stock };
  }
  return { ...f, reset, held, payment, operation, effects };
}
