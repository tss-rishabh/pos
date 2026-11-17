import { Temporal } from '@js-temporal/polyfill';
import { and, eq } from 'drizzle-orm';
import {
  Comments,
  GiftVoucher,
  HasProduct,
  Order,
  OrderStatus,
  OrderStore,
  PosTransactionLog,
  ProductStore,
  StoreDayClose,
} from '../../db/legacy-schema.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { enqueueInventorySynchronization } from '../administration/inventory-synchronization.js';
import { assertCheckoutProjection } from '../checkout/projection.js';
import { assertOrderRefundAllocations } from '../checkout/refund-allocation.js';
import { paymentOutbox } from '../checkout/payments/schema.js';
import { amount, minorUnits } from '../../domain/money.js';
import type { LegacyImportFinancialOptions } from './financial-adapter-options.js';
import type {
  ImportFinancialState,
  SourceOrderReceipt,
  ImportSettlementReceipt,
} from './financial-adapter-contracts.js';
import { importSettlementReceiptSchema } from './financial-adapter-contracts.js';
import { financialImportCloseImpacts } from './financial-adapter-schema.js';
import { financialImportHash, importFinancialError } from './financial-adapter-crypto.js';
import { nativeImportOrder } from './financial-adapter-proof.js';
import {
  currentImportClose,
  assertFinancialImportAuthority,
} from './financial-adapter-authority.js';
import type { LegacyOrderImportPlan } from './plans.js';

/** No prices/taxes are calculated here: native values must equal the sealed source result. */
export async function assertNativeImportOrder(
  tx: AdministrationTransaction,
  state: ImportFinancialState,
  plan: LegacyOrderImportPlan,
  receipt: SourceOrderReceipt,
) {
  const native = await nativeImportOrder(tx, receipt.orderId);
  if (
    receipt.operationId !== state.scope.operationId ||
    receipt.requestHash !== state.requestHash ||
    receipt.namespace !== state.namespace ||
    receipt.customerId !== state.authority.customerId ||
    receipt.storeId !== state.scope.storeId ||
    receipt.counterId !== state.scope.counterId ||
    receipt.createdAt !== plan.createdAt ||
    receipt.method !== (plan.kind === 'offline' ? 14 : 15) ||
    native.header.customerId !== BigInt(receipt.customerId) ||
    native.header.createdAt !== receipt.createdAt ||
    native.header.method !== BigInt(receipt.method) ||
    native.mapping.store !== BigInt(receipt.storeId) ||
    native.mapping.counter !== BigInt(receipt.counterId) ||
    native.header.headerHash !== receipt.headerHash ||
    native.lineHash !== receipt.lineHash ||
    JSON.stringify(native.lines) !== JSON.stringify(receipt.lines) ||
    !Number.isFinite(native.header.payable) ||
    native.header.payable < 0 ||
    amount(minorUnits(String(native.header.payable))) !== receipt.payable
  )
    throw importFinancialError('ORDER_IMPORT_NATIVE_SOURCE_MISMATCH');
  const actual = new Map<string, number>();
  for (const line of native.lines)
    actual.set(line.productId, (actual.get(line.productId) ?? 0) + line.quantity);
  if (
    actual.size !== plan.lines.length ||
    plan.lines.some((line) => actual.get(line.productId) !== line.quantity)
  )
    throw importFinancialError('ORDER_IMPORT_NATIVE_LINES_MISMATCH');
  if (plan.kind === 'offline' && receipt.payable !== plan.originalTenderAmount)
    throw importFinancialError('ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH');
  const [assets] = await tx
    .select({
      money: Order.tss_money_used,
      points: Order.tss_points_used,
      cashback: Order.cashback_used,
      voucherId: Order.voucher_used,
      voucher: Order.voucher_amt_used,
      coupon: Order.coupon_used,
      parent: Order.parent_order_id,
      original: Order.original_order_id,
    })
    .from(Order)
    .where(eq(Order.id, BigInt(receipt.orderId)))
    .limit(1)
    .for('update');
  const [funded] = await tx
    .select({ id: GiftVoucher.id })
    .from(GiftVoucher)
    .where(eq(GiftVoucher.order_id, BigInt(receipt.orderId)))
    .limit(1)
    .for('update');
  if (
    !assets ||
    assets.money !== 0 ||
    assets.points !== 0 ||
    assets.cashback !== 0 ||
    (assets.voucherId ?? 0n) !== 0n ||
    (assets.voucher ?? 0) !== 0 ||
    (assets.coupon ?? 0n) !== 0n ||
    (assets.parent ?? 0n) !== 0n ||
    (assets.original ?? 0n) !== 0n ||
    funded
  )
    throw importFinancialError('ORDER_IMPORT_UNQUALIFIED_BENEFITS');
  await assertOrderRefundAllocations(tx, {
    orderId: receipt.orderId,
    storeId: state.scope.storeId,
    counterId: state.scope.counterId,
    customerId: state.authority.customerId,
  });
  return native;
}

/** Original custom_date complete_order changes HP.updated_at, never HP.status. */
export async function settleNativeImport(
  tx: AdministrationTransaction,
  state: ImportFinancialState,
  plan: LegacyOrderImportPlan,
  receipt: SourceOrderReceipt,
  options: LegacyImportFinancialOptions,
): Promise<ImportSettlementReceipt> {
  await assertFinancialImportAuthority(tx, state.scope, state.authority);
  const currentClose = await currentImportClose(tx, state.scope, plan.createdAt.slice(0, 10));
  if (
    financialImportHash(options.secret, 'close', currentClose) !==
    financialImportHash(options.secret, 'close', state.authority.close)
  )
    throw importFinancialError('ORDER_IMPORT_APPROVAL_REQUIRED');
  const native = await assertNativeImportOrder(tx, state, plan, receipt),
    now = (options.clock ?? Date.now)();
  const zero = '0.00';
  if (
    native.header.paymentStatus !== 1n ||
    native.header.status !== 1n ||
    Number(native.mapping.offline_payment ?? 0) !== 0 ||
    Number(native.mapping.online_payment ?? 0) !== 0 ||
    Number(native.mapping.online_other_payment ?? 0) !== 0
  )
    throw importFinancialError('ORDER_IMPORT_SETTLEMENT_CHANGED');
  let stockHash: string,
    cash = zero,
    manualOther = zero,
    transactionId: string | null = null,
    smsJobId: string | null = null;
  if (plan.kind === 'offline') {
    await assertCheckoutProjection(tx, {
      orderId: receipt.orderId,
      storeId: state.scope.storeId,
      counterId: state.scope.counterId,
      customerId: state.authority.customerId,
    });
    if (native.lineStates.some((line) => line.status !== 'PLACED'))
      throw importFinancialError('ORDER_IMPORT_CONFIRMATION_UNCONFIRMED');
    stockHash = financialImportHash(options.secret, 'ordinary-projection', {
      orderId: receipt.orderId,
      headerHash: receipt.headerHash,
      lineHash: receipt.lineHash,
    });
    cash = plan.payment === 'cash' ? receipt.payable : zero;
    manualOther = plan.payment === 'manual-other' ? receipt.payable : zero;
    transactionId = native.header.orderRef || `transactionId_${receipt.orderId}`;
    const [status] = await tx
      .select({ label: OrderStatus.order_status })
      .from(OrderStatus)
      .where(eq(OrderStatus.id, 3n))
      .limit(1);
    if (!status) throw importFinancialError('ORDER_IMPORT_ORDER_STATUS_UNAVAILABLE');
    await tx
      .update(Order)
      .set({ payment_statuses: 4n, order_statuses: 3n, updated_at: plan.createdAt })
      .where(eq(Order.id, BigInt(receipt.orderId)));
    await tx
      .update(OrderStore)
      .set({
        is_manually_paid: true,
        transaction_id: transactionId,
        message: plan.message,
        offline_payment: cash,
        offline_payment_recieved: cash,
        online_payment: zero,
        online_other_payment: manualOther,
      })
      .where(eq(OrderStore.id, native.mapping.id));
    await tx
      .update(HasProduct)
      .set({ updated_at: plan.createdAt })
      .where(eq(HasProduct.order, BigInt(receipt.orderId)));
    await tx.insert(Comments).values({
      order_id: BigInt(receipt.orderId),
      status_id: 3n,
      comment: `Store Order: ${status.label} status changed by pos admin.`,
      notify: 0,
      user_id: BigInt(state.scope.actorId),
      package_details: '',
      created_at: plan.createdAt,
      updated_at: plan.createdAt,
      has_product_id: 0n,
      prod_id: 0n,
    });
    const others = plan.payment === 'manual-other',
      value = Number(receipt.payable);
    await tx.insert(PosTransactionLog).values({
      order_id: BigInt(receipt.orderId),
      store_id: BigInt(state.scope.storeId),
      order_status: 3n,
      payment_status: 4n,
      user_id: 0n,
      pos_user_id: BigInt(state.scope.actorId),
      pay_dict: JSON.stringify({
        'cash payment': Number(cash),
        [others ? 'online payment (others)' : 'online payment']: others ? value : 0,
        'total amount on counter': value,
      }),
      comment: `Order Delivered : Total Amount Recieved at Counter ${others ? 'online (others)' : 'in Cash'}: ${value}`,
      created_at: plan.createdAt,
      updated_at: plan.createdAt,
    });
    if (plan.sendOrderPlacedSms) {
      smsJobId = `order-sms:${receipt.orderId}`;
      await tx.insert(paymentOutbox).values({
        id: smsJobId,
        kind: 'order-sms',
        orderId: receipt.orderId,
        storeId: state.scope.storeId,
        status: 'pending',
        requestId: state.requestId,
        operatorId: state.scope.actorId,
        createdAt: plan.createdAt,
      });
    }
  } else {
    if (
      !options.stockProcedure ||
      options.stockContract !== 'pos-stock-projection-70b801-v1' ||
      native.lineStates.some((line) => line.status !== 'INCOMPLETE') ||
      native.header.stockReduced
    )
      throw importFinancialError('ORDER_IMPORT_STOCK_UNCONFIRMED');
    const changes: { productId: string; before: number; after: number }[] = [];
    for (const line of [...plan.lines].sort((a, b) =>
      BigInt(a.productId) < BigInt(b.productId) ? -1 : 1,
    )) {
      const rows = await tx
        .select()
        .from(ProductStore)
        .where(
          and(
            eq(ProductStore.store, BigInt(state.scope.storeId)),
            eq(ProductStore.product, BigInt(line.productId)),
          ),
        )
        .limit(2)
        .for('update');
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        row.is_del ||
        !row.is_avail ||
        !Number.isInteger(row.stock) ||
        row.stock < line.quantity
      )
        throw importFinancialError('ORDER_IMPORT_STOCK_SHORTAGE');
      const after = row.stock - line.quantity;
      await options.stockProcedure(tx, {
        storeId: state.scope.storeId,
        productId: line.productId,
        stock: after,
        operatorId: state.scope.actorId,
        comment: 'shopify order',
      });
      await tx.update(ProductStore).set({ stock: after }).where(eq(ProductStore.id, row.id));
      changes.push({ productId: line.productId, before: row.stock, after });
    }
    await enqueueInventorySynchronization(tx, {
      id: state.scope.operationId,
      storeId: state.scope.storeId,
      productIds: plan.lines.map((line) => line.productId),
      operatorId: state.scope.actorId,
      reason: 'legacy-order-import',
      requestId: state.requestId,
    });
    stockHash = financialImportHash(options.secret, 'shopify-stock', changes);
    // The original Shopify importer does not publish paid/DELIVERED flags or run ordinary confirmation.
  }
  const close = await currentImportClose(tx, state.scope, plan.createdAt.slice(0, 10));
  let closeImpactId: string | null = null;
  if (close) {
    closeImpactId = state.scope.operationId;
    await tx.insert(financialImportCloseImpacts).values({
      id: closeImpactId,
      operationId: state.scope.operationId,
      closeId: close.id,
      closeVersion: String(close.version),
      createdAt: now,
    });
    const timestamp = Temporal.Instant.fromEpochMilliseconds(now)
      .toZonedDateTimeISO('UTC')
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
    await tx
      .update(StoreDayClose)
      .set({
        status: 'STALE',
        stale_at: timestamp,
        stale_reason: 'LEGACY_ORDER_IMPORT',
        stale_trigger_ref: state.scope.operationId,
        updated_at: timestamp,
      })
      .where(and(eq(StoreDayClose.id, BigInt(close.id)), eq(StoreDayClose.version, close.version)));
  }
  return importSettlementReceiptSchema.parse({
    operationId: state.scope.operationId,
    orderId: receipt.orderId,
    kind: plan.kind,
    stockHash,
    transactionId,
    paymentId: null,
    cash,
    cashReceived: cash,
    manualOther,
    recordedAt: plan.createdAt,
    finalizedAt: now,
    closeImpactId,
    smsJobId,
  });
}
