import { and, asc, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { mysqlSchema, varchar } from 'drizzle-orm/mysql-core';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import {
  OrderStatus,
  ProductStore,
  Store,
  Comments,
  PosTransactionLog,
  Order,
} from '../../../db/legacy-schema.js';
import type { Config } from '../../../config.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import type { StockProcedure } from '../../administration/stock-procedure.js';
import { enqueueInventorySynchronization } from '../../administration/inventory-synchronization.js';
import { AppError } from '../../../domain/errors.js';
import { amount } from '../../../domain/money.js';
import { financialYear } from '../finalizer.js';
import { assertActiveCheckoutCustomer } from '../customer-access.js';
import { checkoutCustomerConsents, customerConsentContract } from '../customer-consent-proof.js';
import {
  checkoutHeaderHashSql,
  checkoutLineHashSql,
  checkoutProjections,
  checkoutProjectionLines,
  checkoutProjectionContract,
  assertCheckoutProjection,
} from '../projection.js';
import { paymentOutbox } from '../payments/schema.js';
import { cashDigest, type offlineCashSigner } from './crypto.js';
import type { CashAuthorization, CashPriceSnapshot, CashReceipt } from './contracts.js';
import {
  assertCashSourceTemplate,
  mapCashSourceRow,
  templateDecimal,
  type CashSourceTemplate,
} from './template.js';
import { cashOrders, cashOrderStores, cashHasProducts } from './legacy-import-schema.js';
import { cashFlagHistory, cashRefundAudit, cashCancellationMessages } from './source-ledger.js';
import { offlineCashOrderReference } from './order-reference.js';
import { retainCashSigningKey } from './signing-keys.js';
import { offlineCashImportProofs, offlineCashOrderLinks } from './schema.js';

export const cashOrderSchemaContract = 'pos-offline-cash-order-schema-v1';
const physicalColumns = mysqlSchema('information_schema').table('COLUMNS', {
  schema: varchar('TABLE_SCHEMA', { length: 64 }),
  table: varchar('TABLE_NAME', { length: 64 }),
  column: varchar('COLUMN_NAME', { length: 64 }),
  nullable: varchar('IS_NULLABLE', { length: 3 }),
  type: varchar('DATA_TYPE', { length: 64 }),
});
const schemaRequired = () =>
  new AppError(
    503,
    'OFFLINE_CASH_ORDER_SCHEMA_UNVERIFIED',
    'The reviewed strict-mode order schema must be verified before importing cash receipts.',
  );
export async function assertCashOrderSchema(
  tx: AdministrationTransaction,
  contract: string | undefined,
) {
  if (contract !== cashOrderSchemaContract) throw schemaRequired();
  const rows = await tx
    .select({
      column: physicalColumns.column,
      nullable: physicalColumns.nullable,
      type: physicalColumns.type,
    })
    .from(physicalColumns)
    .where(
      and(
        sql`${physicalColumns.schema}=DATABASE()`,
        eq(physicalColumns.table, 'orders'),
        inArray(physicalColumns.column, ['ship_date', 'ret_ex_request_date']),
      ),
    )
    .limit(3);
  if (
    rows.length !== 2 ||
    new Set(rows.map((row) => row.column)).size !== 2 ||
    rows.some((row) => row.nullable !== 'YES' || row.type !== 'datetime')
  )
    throw schemaRequired();
}
export interface CashImportWriterOptions {
  stockProcedure: StockProcedure;
  stockContract: 'pos-stock-projection-70b801-v1';
  orderSchemaContract: string | undefined;
  signer: ReturnType<typeof offlineCashSigner>;
  actorId: string;
  finalizedAt: number;
  requestId?: string;
}
export interface CashImportWriterInput {
  receipt: CashReceipt;
  authorization: CashAuthorization;
  snapshot: CashPriceSnapshot;
  receiptHash: string;
  template: CashSourceTemplate;
  orderCreatedAt: string;
}

/** Entirely database-local. Caller owns Store/receipt/authorization locks and approval. */
export async function writeCashOrder(
  tx: AdministrationTransaction,
  config: Config,
  input: CashImportWriterInput,
  options: CashImportWriterOptions,
) {
  await assertCashOrderSchema(tx, options.orderSchemaContract);
  if (options.stockContract !== 'pos-stock-projection-70b801-v1')
    throw new AppError(
      503,
      'OFFLINE_CASH_STOCK_UNVERIFIED',
      'A transaction-scoped inventory projection is required to import cash receipts.',
    );
  assertCashSourceTemplate(input.template, input);
  const { receipt, template, authorization } = input;
  await assertActiveCheckoutCustomer(tx, authorization.operatorCustomerId);
  const [status] = await tx
    .select({ name: OrderStatus.order_status })
    .from(OrderStatus)
    .where(eq(OrderStatus.id, 3n))
    .limit(1);
  const [store] = await tx
    .select({ id: Store.id, code: Store.location_code })
    .from(Store)
    .where(eq(Store.id, BigInt(receipt.storeId)))
    .for('update');
  if (!status || !store || !store.code)
    throw new AppError(
      503,
      'OFFLINE_CASH_SOURCE_REFERENCE_UNAVAILABLE',
      'Order status or store invoice settings require reconciliation.',
    );
  const available = await tx
    .select({
      id: ProductStore.id,
      productId: ProductStore.product,
      stock: ProductStore.stock,
      active: ProductStore.is_avail,
      deleted: ProductStore.is_del,
    })
    .from(ProductStore)
    .where(
      and(
        eq(ProductStore.store, BigInt(receipt.storeId)),
        inArray(
          ProductStore.product,
          receipt.lines.map((line) => BigInt(line.productId)),
        ),
      ),
    )
    .orderBy(asc(ProductStore.product), asc(ProductStore.id))
    .for('update');
  const stock = receipt.lines.map((line) => {
    const matches = available.filter((row) => String(row.productId) === line.productId),
      row = matches[0];
    if (matches.length !== 1 || !row || !row.active || row.deleted || row.stock < line.quantity)
      throw new AppError(
        409,
        'OFFLINE_CASH_STOCK_CONFLICT',
        'The received cash remains recorded. A manager must reconcile available stock before importing this sale.',
      );
    return {
      productId: line.productId,
      quantity: line.quantity,
      beforeAvailable: row.stock,
      afterAvailable: row.stock - line.quantity,
    };
  });
  const finalizedTimestamp = Temporal.Instant.fromEpochMilliseconds(options.finalizedAt)
    .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })
    .replace('T', ' ');
  await tx.insert(cashOrders).values(mapCashSourceRow(cashOrders, template.header));
  const idResult = await tx.execute(sql`SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id`);
  const id = z
    .array(z.object({ id: z.string().regex(/^[1-9]\d{0,18}$/) }))
    .length(1)
    .parse(idResult[0])[0]!.id;
  const orderId = BigInt(id),
    reference = offlineCashOrderReference(id),
    fy = financialYear(input.orderCreatedAt);
  const [lastInvoice] = await tx
    .select({ invoice: cashOrderStores.order_invoice })
    .from(cashOrderStores)
    .where(
      and(
        eq(cashOrderStores.store_id, BigInt(receipt.storeId)),
        or(
          like(cashOrderStores.order_invoice, `${store.code}/${fy}/INV/%`),
          like(cashOrderStores.order_invoice, `${store.code}${fy}INV%`),
        ),
      ),
    )
    .orderBy(desc(cashOrderStores.order_invoice))
    .limit(1)
    .for('update');
  const lastSequence = lastInvoice?.invoice
    ? Number(/(\d+)$/.exec(lastInvoice.invoice)?.[1] || 0)
    : 0;
  if (
    !Number.isSafeInteger(lastSequence) ||
    lastSequence < 0 ||
    lastSequence >= Number.MAX_SAFE_INTEGER
  )
    throw new AppError(
      503,
      'OFFLINE_CASH_INVOICE_SEQUENCE_INVALID',
      'The store invoice sequence requires reconciliation.',
    );
  const invoice = `${store.code}${fy}INV${String(lastSequence + 1).padStart(5, '0')}`;
  await tx
    .update(cashOrders)
    .set({
      order_ref_no: reference,
      shiplabel_tracking_id: reference,
      order_status: 3,
      payment_status: 4,
      is_stock_reduced: 1,
    })
    .where(eq(cashOrders.id, orderId));
  await tx.insert(cashOrderStores).values(
    mapCashSourceRow(cashOrderStores, {
      ...template.orderStore,
      order_id: id,
      transaction_id: receipt.receiptNumber,
      message: 'Complete',
      is_manually_paid: true,
      offline_payment: amount(BigInt(receipt.payableCents)),
      offline_payment_recieved: amount(BigInt(receipt.cashReceivedCents)),
      online_payment: '0',
      online_other_payment: '0',
      order_invoice: invoice,
    }),
  );
  await tx.insert(cashHasProducts).values(
    template.lines.map((line) =>
      mapCashSourceRow(cashHasProducts, {
        ...line,
        order_id: id,
        awb: reference,
        status: status.name,
        // Original model omits these physical nonnullable fields. They represent
        // absent return state and the unused anonymous-cart adjustment, respectively.
        return_qty: '',
        return_reason: '',
        hp_cart_additional_discount: '0',
        vinc_status: '',
      }),
    ),
  );
  const lines = await tx
    .select({
      id: cashHasProducts.id,
      productId: cashHasProducts.prod_id,
      quantity: cashHasProducts.qty,
      priceHash: sql<string>`${sql.raw(checkoutLineHashSql)}`,
      refundable: cashHasProducts.amount_to_be_refunded,
    })
    .from(cashHasProducts)
    .where(eq(cashHasProducts.order_id, orderId))
    .orderBy(asc(cashHasProducts.id))
    .for('update');
  if (lines.length !== template.lines.length)
    throw new AppError(
      503,
      'OFFLINE_CASH_LINE_PROJECTION_INVALID',
      'The inserted source line projection requires reconciliation.',
    );
  const nativeTotals = await tx
    .select({
      productId: cashHasProducts.prod_id,
      payable: sql<string>`CAST(SUM(${cashHasProducts.final_payable}) AS CHAR)`,
      taxable: sql<string>`CAST(ROUND(SUM(${cashHasProducts.pre_gst_amt}),2) AS CHAR)`,
    })
    .from(cashHasProducts)
    .where(eq(cashHasProducts.order_id, orderId))
    .groupBy(cashHasProducts.prod_id);
  for (const line of receipt.lines) {
    const totals = nativeTotals.find((value) => String(value.productId) === line.productId);
    if (
      !totals ||
      !templateDecimal(totals.payable).times(100).eq(line.mainSubtotalCents) ||
      !templateDecimal(totals.taxable).times(100).eq(line.taxableCents)
    )
      throw new AppError(
        503,
        'OFFLINE_CASH_LINE_STORAGE_MISMATCH',
        'The stored source line money differs from its immutable cash receipt.',
      );
  }
  for (const [index, line] of lines.entries())
    if (
      String(line.productId) !== template.lines[index]!.prod_id ||
      String(line.quantity) !== template.lines[index]!.qty
    )
      throw new AppError(
        503,
        'OFFLINE_CASH_LINE_PROJECTION_INVALID',
        'The inserted source line projection requires reconciliation.',
      );
  await tx.insert(cashRefundAudit).values(
    template.refundAllocations.map((allocation) => ({
      orderId,
      productId: lines[allocation.lineIndex]!.productId,
      lineId: lines[allocation.lineIndex]!.id,
      points: sql`${allocation.tssPointsUsed}`,
      money: sql`${allocation.tssMoneyUsed}`,
      voucher: sql`${allocation.giftVoucherAmount}`,
      coupon: sql`${allocation.couponAmountUsed}`,
      storeDiscount: sql`${allocation.storeDiscountPg}`,
      refundable: sql`${allocation.amountToBeRefunded}`,
      pg: 0,
      isRefunded: 0,
      refunded: 0,
      refundMode: null,
      comment: null,
      createdAt: finalizedTimestamp,
      updatedAt: finalizedTimestamp,
    })),
  );
  await tx
    .insert(cashCancellationMessages)
    .values({ orderId, messageId: Number(template.cancellationMessageId) });
  await tx.insert(cashFlagHistory).values(
    template.flagIds.map((flagId) => ({
      orderId,
      flagId: BigInt(flagId),
      comment: 'Order placed',
      customerId: BigInt(authorization.operatorCustomerId),
      createdAt: finalizedTimestamp,
      updatedAt: finalizedTimestamp,
    })),
  );
  for (const transition of [...stock].sort((left, right) =>
    BigInt(left.productId) < BigInt(right.productId) ? -1 : 1,
  )) {
    await options.stockProcedure(tx, {
      storeId: receipt.storeId,
      productId: transition.productId,
      operatorId: options.actorId,
      stock: transition.afterAvailable,
      comment: 'Offline cash order imported',
    });
    const [projected] = await tx
      .select({ stock: ProductStore.stock })
      .from(ProductStore)
      .where(
        and(
          eq(ProductStore.store, BigInt(receipt.storeId)),
          eq(ProductStore.product, BigInt(transition.productId)),
        ),
      )
      .limit(2);
    if (projected?.stock !== transition.afterAvailable)
      throw new AppError(
        503,
        'OFFLINE_CASH_STOCK_PROJECTION_INVALID',
        'The cash sale inventory transition could not be confirmed.',
      );
  }
  await enqueueInventorySynchronization(tx, {
    id: receipt.id,
    storeId: receipt.storeId,
    productIds: receipt.lines.map((line) => line.productId),
    operatorId: options.actorId,
    reason: 'offline-cash-import',
    ...(options.requestId ? { requestId: options.requestId } : {}),
  });
  await tx.insert(Comments).values({
    order_id: orderId,
    status_id: 3n,
    comment: `Store Order: ${status.name} status changed by pos admin.`,
    notify: 0,
    user_id: BigInt(options.actorId),
    package_details: '',
    created_at: finalizedTimestamp,
    updated_at: finalizedTimestamp,
    has_product_id: 0n,
    prod_id: 0n,
  });
  await tx.insert(PosTransactionLog).values({
    order_id: orderId,
    store_id: BigInt(receipt.storeId),
    order_status: 3n,
    payment_status: 4n,
    user_id: 0n,
    pos_user_id: BigInt(receipt.operatorId),
    pay_dict: JSON.stringify({
      'cash payment': receipt.payableCents / 100,
      'online payment': 0,
      'total amount on counter': receipt.payableCents / 100,
    }),
    comment: `Order Delivered : Total Amount Recieved at Counter in Cash: ${receipt.payableCents / 100}`,
    created_at: finalizedTimestamp,
    updated_at: finalizedTimestamp,
  });
  const [native] = await tx
    .select({ hash: sql<string>`${sql.raw(checkoutHeaderHashSql)}` })
    .from(Order)
    .where(eq(Order.id, orderId))
    .limit(1);
  if (!native)
    throw new AppError(
      503,
      'OFFLINE_CASH_ORDER_PROJECTION_INVALID',
      'The native cash order projection could not be confirmed.',
    );
  await tx.insert(checkoutProjections).values({
    orderId,
    storeId: BigInt(receipt.storeId),
    counterId: BigInt(receipt.counterId),
    userId: BigInt(authorization.operatorCustomerId),
    inputHash: native.hash,
    lineCount: lines.length,
    contractVersion: checkoutProjectionContract,
    confirmedAt: finalizedTimestamp,
  });
  // Offline cash never spends a wallet/voucher or employee-coupon grant. Record
  // that decision atomically; source template guards and the shared projection
  // checker independently reject positive asset fields for this zero-consent row.
  await tx.insert(checkoutCustomerConsents).values({
    orderId,
    storeId: BigInt(receipt.storeId),
    counterId: BigInt(receipt.counterId),
    customerId: BigInt(authorization.operatorCustomerId),
    operatorId: BigInt(receipt.operatorId),
    inputHash: native.hash,
    required: 0,
    contactRevision: null,
    contactDigest: null,
    verifiedUntilMs: null,
    acceptedAtMs: BigInt(options.finalizedAt),
    contractVersion: customerConsentContract,
  });
  await tx.insert(checkoutProjectionLines).values(
    lines.map((line) => ({
      orderId,
      lineId: line.id,
      productId: line.productId,
      quantity: line.quantity,
      inputHash: line.priceHash,
    })),
  );
  await assertCheckoutProjection(tx, {
    orderId: id,
    storeId: receipt.storeId,
    counterId: receipt.counterId,
    customerId: authorization.operatorCustomerId,
  });
  const sealed = options.signer.sealImport({
    version: 1,
    kind: 'pos-offline-cash-import-v1',
    receiptId: receipt.id,
    authorizationId: receipt.authorizationId,
    receiptHash: input.receiptHash,
    orderId: id,
    operatorId: receipt.operatorId,
    customerId: authorization.operatorCustomerId,
    storeId: receipt.storeId,
    counterId: receipt.counterId,
    businessDate: receipt.businessDate,
    receiptNumber: receipt.receiptNumber,
    payableCents: receipt.payableCents,
    cashReceivedCents: receipt.cashReceivedCents,
    changeCents: receipt.changeCents,
    finalizedAt: options.finalizedAt,
    orderCreatedAt: input.orderCreatedAt,
    headerHash: native.hash,
    lineItemsEnabled: input.snapshot.lineItemsEnabled,
    lines: lines.map((line) => ({
      hasProductId: String(line.id),
      productId: String(line.productId),
      quantity: Number(line.quantity),
      priceHash: line.priceHash,
    })),
    stock,
    stockContract: options.stockContract,
    sourceApiCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
    sourcePaymentsCommit: '434f3e438d1cb48c64e5723222c6efda506db571',
    refundAllocationContract: template.refundAllocationContract,
    refundSourcePatchHash: template.refundSourcePatchHash,
  });
  if (cashDigest(options.signer.publicKey) !== sealed.keyId)
    throw new AppError(
      503,
      'OFFLINE_CASH_SIGNING_KEY_INVALID',
      'The import signing key could not be verified.',
    );
  await retainCashSigningKey(tx, sealed.keyId, options.signer.publicKey, options.finalizedAt);
  await tx.insert(offlineCashImportProofs).values({
    receiptId: receipt.id,
    orderId: id,
    keyId: sealed.keyId,
    proof: JSON.stringify(sealed.proof),
    signature: sealed.signature,
    createdAt: options.finalizedAt,
  });
  await tx.insert(offlineCashOrderLinks).values({
    receiptId: receipt.id,
    orderId: id,
    payableCents: receipt.payableCents,
    businessDate: receipt.businessDate,
    projectionHash: sealed.proof.headerHash,
    finalizedAt: options.finalizedAt,
  });
  await tx.insert(paymentOutbox).values(
    ['order-kinesis', 'order-engagement'].map((kind) => ({
      id: `offline-cash:${receipt.id}:${kind}`,
      kind,
      orderId: id,
      storeId: receipt.storeId,
      status: 'pending',
      requestId: options.requestId || null,
      operatorId: options.actorId,
      createdAt: finalizedTimestamp,
    })),
  );
  return { orderId: id, importedAt: options.finalizedAt, invoice };
}
