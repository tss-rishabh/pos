import { and, asc, desc, eq, gt, gte, inArray, like, ne, or, sql } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import {
  AmountToBeRefundedLog,
  Attributes,
  Comments,
  ExtendApplicabilityForReturnExchange,
  HasOptions,
  HasProduct,
  HoldStockStore,
  Order,
  OrderStore,
  PosExchangeLog,
  PosHoldStockLog,
  Product,
  ProductStore,
  ReturnOrder,
  Store,
  StoreSalesPerson,
  SalesPerson,
} from '../../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { enqueueInventorySynchronization } from '../../administration/inventory.js';
import type { StockProcedure } from '../../administration/stock-procedure.js';
import { exchangeRetryable } from '../returns.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { exchangeFeatureEnabled } from '../legacy-flags.js';
import { exchangeRefusal, type CellRefusal } from './exchange-cell.js';
import { publicReturn, type ExchangeRecoveryScope, type ReturnOperation } from './contracts.js';
import {
  fingerprint,
  recoveryClaimReceiptSchema,
  returnStateKeys,
  type RecoveryClaimReceipt,
  type ReturnState,
} from './state.js';
import { readJson } from '../state-store.js';

export interface ReturnRepositoryOptions {
  returnPeriodDays: number | undefined;
  inventoryProcedureVerified?: boolean;
  stockProcedure?: StockProcedure;
  assertCheckIn?: (
    userId: string,
    storeId: string,
    counterId: string,
    transaction: AdministrationTransaction,
  ) => Promise<void>;
  /** The operator's legacy check-in store (`check_in_{uid}`, `Helpers.get_checkin_store`). */
  checkedInStore?: (userId: string) => Promise<string | null>;
  state: ReturnState;
}

/** A failure that is committed first (legacy saves FAILED_NEEDS_MANUAL_FIX) and thrown after. */
export class CommittedFailure {
  constructor(readonly error: AppError) {}
}

/** order/libs/calculations.py:21 STALE_PENDING_EXCHANGE_MINUTES. */
export const STALE_PENDING_MINUTES = 10;
export const RETURNED_OR_EXCHANGED = ['PRODUCT_RETURNED', 'EXCHANGE_COMPLETED'];

/**
 * What every return/exchange repository operation shares: the locked order/line context,
 * the S35 guard facts, operation load/ownership, phase-one proof, the return window and
 * the recovery snapshot. The operation groups in `repository-*.ts` build on it.
 */
export function returnRepositoryCore(
  db: Databases,
  config: Config,
  options: ReturnRepositoryOptions,
) {
  const state = options.state,
    checkIns = checkInService(db, config),
    checkIn =
      options.assertCheckIn ||
      ((user, store, counter, tx) => checkIns.assertCheckIn(user, store, counter, tx)),
    checkedInStore = options.checkedInStore || ((userId) => checkIns.checkedInStore(userId)),
    now = () => Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDateTime(),
    timestamp = () => now().toString({ smallestUnit: 'second' }).replace('T', ' ');
  const stamp = (operation: ReturnOperation): ReturnOperation => ({
    ...operation,
    updatedAt: timestamp(),
  });
  const minutesSince = (value: string) =>
    Temporal.PlainDateTime.from(value.replace(' ', 'T')).until(now()).total('minutes');

  async function context(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
    lineId: string,
    counterId: string,
    relatedOrderIds: readonly string[] = [],
  ) {
    requireStore(user, storeId);
    await checkIn(user.id, storeId, counterId, tx);
    const [store] = await tx
      .select({
        id: Store.id,
        locationCode: Store.location_code,
        name: Store.store_name,
        slackUrl: Store.slack_group_url,
      })
      .from(Store)
      .where(eq(Store.id, BigInt(storeId)))
      .for('update');
    const lockIds = [...new Set([orderId, ...relatedOrderIds])]
      .map(BigInt)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    await tx
      .select({ id: Order.id })
      .from(Order)
      .where(inArray(Order.id, lockIds))
      .orderBy(asc(Order.id))
      .for('update');
    const [order] = await tx
      .select({
        id: Order.id,
        customerId: Order.user,
        name: Order.first_name,
        address1: Order.address1,
        address2: Order.address2,
        state: Order.zone_id,
        city: Order.city,
        pincode: Order.postal_code,
        status: Order.order_statuses,
        paymentStatus: Order.payment_statuses,
        paymentMethod: Order.payment_methods,
        parentId: Order.parent_order_id,
        parentExpress: Order.is_parent_express,
      })
      .from(Order)
      .where(eq(Order.id, BigInt(orderId)))
      .for('update');
    const [line] = await tx
      .select()
      .from(HasProduct)
      .where(and(eq(HasProduct.id, BigInt(lineId)), eq(HasProduct.order, BigInt(orderId))))
      .for('update');
    if (!store || !order || !line)
      throw new AppError(404, 'RETURN_LINE_NOT_FOUND', 'Product not found');
    return { store, order, line };
  }

  const refused = (value: CellRefusal) => new AppError(value.status, value.code, value.message);

  /**
   * The facts the S35 template guards need, read now: the CURRENT `products.prod_type` of the
   * line, whether the order is a store order (`order_stores`, show.html vs the online cells) and
   * `exchange_feature_enabled` of the operator's CHECK-IN store (`order/views.py:313,338-340`).
   */
  async function guardFacts(
    tx: AdministrationTransaction,
    userId: string,
    orderId: string,
    productId: bigint,
  ) {
    const [product] = await tx
      .select({ type: Product.prod_type })
      .from(Product)
      .where(eq(Product.id, productId))
      .limit(1);
    const [orderStore] = await tx
      .select({ shopify: OrderStore.is_shopify_order })
      .from(OrderStore)
      .where(eq(OrderStore.order, BigInt(orderId)))
      .orderBy(asc(OrderStore.id))
      .limit(1);
    const checkinStoreId = await checkedInStore(userId);
    return {
      variant: orderStore ? ('store' as const) : ('online' as const),
      shopifyOrder: Boolean(orderStore?.shopify),
      productType: product ? Number(product.type) : null,
      checkinStoreId,
      exchangeFeatureEnabled: exchangeFeatureEnabled(config, checkinStoreId),
    };
  }
  /** S35: an exchange or retry the template would not offer is refused before any write. */
  async function assertExchangeOffered(
    tx: AdministrationTransaction,
    userId: string,
    orderId: string,
    productId: bigint,
    retry: boolean,
  ) {
    const facts = await guardFacts(tx, userId, orderId, productId),
      refusal = exchangeRefusal({ ...facts, retry, merged: null });
    if (refusal) throw refused(refusal);
    return facts;
  }

  /** Reads an operation for an action; the claim holder alone may act on a claimed recovery. */
  async function load(user: Principal, storeId: string, id: string) {
    const operation = await state.readOperation(id);
    if (!operation || operation.storeId !== storeId)
      throw new AppError(404, 'RETURN_OPERATION_NOT_FOUND', 'Return operation was not found.');
    if (operation.recoveryClaim && operation.recoveryClaim.operatorId !== user.id)
      throw new AppError(
        403,
        'EXCHANGE_RECOVERY_CLAIM_REQUIRED',
        'Claim this exchange before continuing.',
      );
    return operation;
  }

  /** Native scope of an existing operation inside a writer transaction. */
  async function owned(tx: AdministrationTransaction, user: Principal, operation: ReturnOperation) {
    const scope = await context(
      tx,
      user,
      operation.storeId,
      operation.orderId,
      operation.lineId,
      operation.authorityCounterId ?? operation.input.counterId,
      operation.exchange?.childOrderId ? [operation.exchange.childOrderId] : [],
    );
    if (String(scope.order.customerId) !== operation.customerId)
      throw new AppError(409, 'EXCHANGE_CUSTOMER_CHANGED', 'The original order customer changed.');
    return scope;
  }

  /** `stockconfirmed` / `inward_product_to_store` / `hold_stock` (order/libs/calculations.py:252-347). */
  async function restore(
    tx: AdministrationTransaction,
    user: Principal,
    operation: ReturnOperation,
  ) {
    const productId = BigInt(operation.productId),
      storeId = BigInt(operation.storeId),
      quantity = operation.quantity;
    if (!operation.input.saleable) {
      const [current] = await tx
        .select()
        .from(HoldStockStore)
        .where(and(eq(HoldStockStore.product, productId), eq(HoldStockStore.store, storeId)))
        .limit(1)
        .for('update');
      const before = current?.stock || 0,
        after = before + quantity;
      if (after > 2147483647)
        throw new AppError(
          409,
          'RETURN_STOCK_OVERFLOW',
          'Returned quantity exceeds supported stock.',
        );
      if (current)
        await tx
          .update(HoldStockStore)
          .set({ stock: after })
          .where(and(eq(HoldStockStore.product, productId), eq(HoldStockStore.store, storeId)));
      else
        await tx
          .insert(HoldStockStore)
          .values({ product: productId, store: storeId, stock: after });
      await tx.insert(PosHoldStockLog).values({
        store_id: storeId,
        product_id: productId,
        stock_before: String(before),
        stock_after: String(after),
        pos_user_id: BigInt(user.id),
        comment: `Hold Stock inventory added from admin panel on order return, [Order ID:${operation.orderId}]`,
        created_at: timestamp(),
        updated_at: timestamp(),
      });
      return;
    }
    if (!options.inventoryProcedureVerified)
      throw new AppError(
        503,
        'RETURN_INVENTORY_UNVERIFIED',
        'The deployed inventory procedure must be verified before restoring saleable stock.',
      );
    const [product] = await tx
      .select({ id: Product.id, parentId: Product.parent_prod_id })
      .from(Product)
      .where(eq(Product.id, productId))
      .for('update');
    if (!product)
      throw new AppError(409, 'RETURN_PRODUCT_UNAVAILABLE', 'The returned product is unavailable.');
    const [original] = await tx
        .select({ store: OrderStore.store })
        .from(OrderStore)
        .where(eq(OrderStore.order, BigInt(operation.orderId)))
        .orderBy(asc(OrderStore.id))
        .limit(1),
      sameStore = original?.store === storeId;
    const [current] = await tx
      .select()
      .from(ProductStore)
      .where(and(eq(ProductStore.product, productId), eq(ProductStore.store, storeId)))
      .limit(1)
      .for('update');
    let ids = [productId];
    if (product.parentId > 0n) {
      const siblings = sameStore
        ? await tx
            .select({ id: Product.id })
            .from(Product)
            .innerJoin(ProductStore, eq(ProductStore.product, Product.id))
            .where(
              and(
                eq(Product.parent_prod_id, product.parentId),
                eq(ProductStore.store, storeId),
                or(eq(Product.is_del, 0), gt(ProductStore.stock, 0)),
              ),
            )
        : await tx
            .select({ id: Product.id })
            .from(Product)
            .where(and(eq(Product.parent_prod_id, product.parentId), eq(Product.is_del, 0)));
      ids = [...new Set([...siblings.map((row) => row.id), productId, product.parentId])];
    }
    for (const id of ids) {
      const [existing] = await tx
        .select({ id: ProductStore.id })
        .from(ProductStore)
        .where(and(eq(ProductStore.product, id), eq(ProductStore.store, storeId)))
        .limit(1)
        .for('update');
      if (existing)
        await tx
          .update(ProductStore)
          .set({ is_avail: true, is_del: false })
          .where(eq(ProductStore.id, existing.id));
      else if (!sameStore || id === productId)
        await tx
          .insert(ProductStore)
          .values({ product: id, store: storeId, stock: 0, is_avail: true, is_del: false });
    }
    const after = (current?.stock || 0) + quantity;
    if (after > 2147483647)
      throw new AppError(
        409,
        'RETURN_STOCK_OVERFLOW',
        'Returned quantity exceeds supported stock.',
      );
    const message = `Product inventory added from admin panel on ${sameStore ? 'order return' : original ? 'store order return' : 'online order return'}, [Order ID:${operation.orderId}]`;
    if (options.stockProcedure)
      await options.stockProcedure(tx, {
        storeId: String(storeId),
        productId: String(productId),
        stock: after,
        operatorId: user.id,
        comment: message,
      });
    else
      await tx.execute(
        sql`call pos_stock_syncer(${storeId},${productId},${after},${0},${BigInt(user.id)},${message})`,
      );
    await tx
      .update(ProductStore)
      .set({ stock: after })
      .where(and(eq(ProductStore.product, productId), eq(ProductStore.store, storeId)));
    await enqueueInventorySynchronization(tx, {
      id: operation.id,
      storeId: operation.storeId,
      productIds: ids.map(String),
      operatorId: user.id,
      ...(currentRequestTrace()?.requestId ? { requestId: currentRequestTrace()!.requestId } : {}),
      reason: operation.kind === 'exchange' ? 'exchange-return' : 'return',
    });
  }

  /** `get_exchange_size_options` live re-check plus the active store salesperson. */
  async function exchangeSelection(
    tx: AdministrationTransaction,
    scope: Awaited<ReturnType<typeof context>>,
    selection: { replacementProductId: string; salespersonId: string },
    retry: boolean,
    storedSize?: string | null,
  ) {
    const [original] = await tx
        .select({ id: Product.id, parent: Product.parent_prod_id })
        .from(Product)
        .where(eq(Product.id, scope.line.product))
        .limit(1),
      [replacement] = await tx
        .select({ id: Product.id, parent: Product.parent_prod_id, stock: ProductStore.stock })
        .from(ProductStore)
        .innerJoin(Product, eq(Product.id, ProductStore.product))
        .where(
          and(
            eq(ProductStore.store, scope.store.id),
            eq(ProductStore.product, BigInt(selection.replacementProductId)),
            eq(ProductStore.is_avail, true),
            eq(ProductStore.is_del, false),
            or(eq(Product.is_del, 0), gt(ProductStore.stock, 0)),
          ),
        )
        .limit(1)
        .for('update');
    // order/views.py:1080-1086: the chosen option must exist with stock > 0.
    if (
      !original ||
      original.parent <= 0n ||
      !replacement ||
      replacement.parent !== original.parent ||
      replacement.stock <= 0
    )
      throw new AppError(
        409,
        'EXCHANGE_SIZE_UNAVAILABLE',
        retry
          ? `Replacement size ${storedSize ?? 'None'} is no longer in stock at this store — please contact tech support.`
          : 'Selected size is no longer available at this store.',
      );
    const [salesperson] = await tx
      .select({ id: StoreSalesPerson.id })
      .from(StoreSalesPerson)
      .innerJoin(SalesPerson, eq(SalesPerson.id, StoreSalesPerson.salesperson))
      .where(
        and(
          eq(SalesPerson.is_active, 1),
          eq(StoreSalesPerson.store, scope.store.id),
          eq(StoreSalesPerson.salesperson, BigInt(selection.salespersonId)),
          eq(StoreSalesPerson.is_active, 1),
        ),
      )
      .limit(1);
    if (!salesperson)
      throw new AppError(
        422,
        'EXCHANGE_SALESPERSON_UNAVAILABLE',
        'Salesperson selection is required for exchange.',
      );
    const sizes = await tx
        .select({ product: HasOptions.prod_id, value: HasOptions.attr_val })
        .from(HasOptions)
        .innerJoin(Attributes, eq(Attributes.id, HasOptions.attr))
        .where(
          and(
            inArray(HasOptions.prod_id, [original.id, replacement.id]),
            like(Attributes.attr, '%Size%'),
          ),
        )
        .orderBy(asc(HasOptions.id)),
      labels = new Map<string, string>();
    for (const size of sizes)
      if (!labels.has(String(size.product))) labels.set(String(size.product), size.value);
    const newSize = labels.get(String(replacement.id));
    if (newSize === undefined)
      throw new AppError(
        409,
        'EXCHANGE_SIZE_UNAVAILABLE',
        'The replacement size could not be confirmed.',
      );
    return {
      newProductId: String(replacement.id),
      parentProductId: String(original.parent),
      newSize,
      // get_exchange_context: old_size_by_prod_id.get(p.product_id, '')
      oldSize: labels.get(String(original.id)) ?? '',
      salespersonId: selection.salespersonId,
    };
  }

  /** `pos_exchange_phase1_committed` (order/libs/calculations.py:25-36). */
  async function phaseOneCommitted(
    tx: AdministrationTransaction,
    log: typeof PosExchangeLog.$inferSelect,
  ) {
    const [credit] = await tx
      .select({ id: ReturnOrder.id, creditNote: ReturnOrder.credit_note_no })
      .from(ReturnOrder)
      .where(
        and(
          eq(ReturnOrder.order_id, BigInt(log.order_id)),
          eq(ReturnOrder.prod_id, BigInt(log.old_prod_id)),
          eq(ReturnOrder.has_product_id, BigInt(log.has_prod_id)),
          eq(ReturnOrder.store_id, log.store_id),
          gte(ReturnOrder.created_at, log.created_at),
          ne(ReturnOrder.credit_note_no, ''),
        ),
      )
      .limit(1);
    return credit ?? null;
  }

  async function exchangeLog(tx: AdministrationTransaction, orderId: string, lineId: string) {
    if (BigInt(orderId) > 2147483647n || BigInt(lineId) > 2147483647n) return null;
    const [log] = await tx
      .select()
      .from(PosExchangeLog)
      .where(
        and(
          eq(PosExchangeLog.order_id, Number(orderId)),
          eq(PosExchangeLog.has_prod_id, Number(lineId)),
        ),
      )
      .orderBy(asc(PosExchangeLog.id))
      .limit(1)
      .for('update');
    return log ?? null;
  }

  async function phaseOneProof(
    tx: AdministrationTransaction,
    operation: ReturnOperation,
    lineStatus: string | null,
    completion = false,
  ) {
    const [credit] = await tx
      .select({ id: ReturnOrder.id })
      .from(ReturnOrder)
      .where(
        and(
          eq(ReturnOrder.order_id, BigInt(operation.orderId)),
          eq(ReturnOrder.has_product_id, BigInt(operation.lineId)),
          eq(ReturnOrder.prod_id, BigInt(operation.productId)),
          eq(ReturnOrder.store_id, Number(operation.storeId)),
          gte(ReturnOrder.created_at, operation.createdAt),
          ne(ReturnOrder.credit_note_no, ''),
        ),
      )
      .limit(1);
    if (
      !exchangeRetryable(lineStatus, Boolean(credit)) &&
      !(completion && lineStatus === 'EXCHANGE_COMPLETED' && credit)
    )
      throw new AppError(
        409,
        'EXCHANGE_PHASE_ONE_UNCONFIRMED',
        'This item is no longer awaiting an exchange. Please refresh the page.',
      );
  }

  /** `return_processed` preconditions (order/libs/calculations.py:52-99,175-186). */
  async function returnWindow(
    tx: AdministrationTransaction,
    orderId: string,
    lineId: string,
    productId: bigint,
    clickType: 'normal' | 'extreme',
  ): Promise<AppError | null> {
    if (options.returnPeriodDays === undefined)
      throw new AppError(503, 'RETURN_POLICY_UNAVAILABLE', 'Return policy is not configured.');
    const [delivery] = await tx
      .select({ date: Comments.created_at })
      .from(Comments)
      .where(and(eq(Comments.order_id, BigInt(orderId)), eq(Comments.status_id, 3n)))
      .orderBy(desc(Comments.created_at))
      .limit(1);
    if (!delivery) return new AppError(409, 'RETURN_DELIVERY_UNCONFIRMED', 'Order not found');
    const [extension] = await tx
      .select({ date: ExtendApplicabilityForReturnExchange.extended_date })
      .from(ExtendApplicabilityForReturnExchange)
      .where(
        and(
          eq(ExtendApplicabilityForReturnExchange.order_id, BigInt(orderId)),
          eq(ExtendApplicabilityForReturnExchange.prod_id, productId),
          eq(ExtendApplicabilityForReturnExchange.has_product_id, BigInt(lineId)),
          eq(ExtendApplicabilityForReturnExchange.is_active, true),
        ),
      )
      .limit(1);
    const age = Math.floor(
        Temporal.PlainDateTime.from(delivery.date.replace(' ', 'T')).until(now()).total('days'),
      ),
      extended =
        extension &&
        Temporal.PlainDateTime.compare(
          Temporal.PlainDateTime.from(extension.date.replace(' ', 'T')),
          now(),
        ) >= 0;
    if (!(age <= options.returnPeriodDays || clickType === 'extreme' || extended))
      return new AppError(409, 'RETURN_WINDOW_CLOSED', 'This order is not applicable for return');
    const [refundable] = await tx
      .select({ id: AmountToBeRefundedLog.id })
      .from(AmountToBeRefundedLog)
      .where(
        and(
          eq(AmountToBeRefundedLog.order_id, BigInt(orderId)),
          eq(AmountToBeRefundedLog.prod_id, productId),
          eq(AmountToBeRefundedLog.has_product_id, BigInt(lineId)),
          eq(AmountToBeRefundedLog.is_refunded, false),
        ),
      )
      .limit(1)
      .for('update');
    if (!refundable)
      return new AppError(
        409,
        'RETURN_ALREADY_REFUNDED',
        'This order is already returned, Not applicable for return',
      );
    return null;
  }

  /** Operations that may still have an external call in flight block a new attempt. */
  async function assertNoActiveOperation(orderId: string, lineId: string) {
    const active = await state.lineOperation(orderId, lineId);
    if (
      active &&
      ['inbound-dispatching', 'refund-dispatching', 'replacement-dispatching'].includes(
        active.phase,
      ) &&
      minutesSince(active.updatedAt) < STALE_PENDING_MINUTES
    )
      throw new AppError(
        409,
        'RETURN_ALREADY_ACTIVE',
        'An earlier return or exchange for this item is still in progress.',
      );
  }

  async function recoverySnapshot(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
    lineId: string,
    input: ExchangeRecoveryScope,
  ) {
    const scope = await context(tx, user, storeId, orderId, lineId, input.counterId);
    const latest = await state.lineOperation(orderId, lineId);
    const operation =
      latest && latest.kind === 'exchange' && latest.phase !== 'rejected' ? latest : null;
    if (
      operation &&
      (operation.storeId !== storeId ||
        operation.customerId !== String(scope.order.customerId) ||
        operation.productId !== String(scope.line.product))
    )
      throw new AppError(
        409,
        'EXCHANGE_RECOVERY_SCOPE_CHANGED',
        'An earlier operation belongs to another return context.',
      );
    const log = await exchangeLog(tx, orderId, lineId);
    const credit = log ? await phaseOneCommitted(tx, log) : null;
    const revision = fingerprint('exchange.recovery', {
      actor: user.id,
      storeId,
      orderId,
      lineId,
      input,
      customer: scope.order.customerId,
      line: scope.line,
      operation: operation && { id: operation.id, phase: operation.phase, at: operation.updatedAt },
      log,
      credit,
    });
    return { scope, operation, log, credit, revision };
  }
  function recoveryView(value: Awaited<ReturnType<typeof recoverySnapshot>>, storeId: string) {
    const { operation, log, credit, scope, revision } = value;
    if (operation)
      return {
        revision,
        state: 'operation' as const,
        operation: publicReturn(operation),
        newSize: operation.exchange?.newSize ?? null,
      };
    // get_exchange_context: FAILED_NEEDS_MANUAL_FIX rows that pos_exchange_retryable accepts.
    if (
      !log ||
      log.status !== 'FAILED_NEEDS_MANUAL_FIX' ||
      !exchangeRetryable(scope.line.status, Boolean(credit))
    )
      return { revision, state: 'none' as const, operation: null, newSize: null };
    if (String(log.store_id) !== storeId)
      return { revision, state: 'wrong-store' as const, operation: null, newSize: null };
    return { revision, state: 'legacy' as const, operation: null, newSize: log.new_size };
  }

  async function readClaim(
    storeId: string,
    orderId: string,
    lineId: string,
    claimId: string,
  ): Promise<RecoveryClaimReceipt | null> {
    return readJson(
      state.store,
      returnStateKeys.claim(storeId, orderId, lineId, claimId),
      recoveryClaimReceiptSchema,
    );
  }

  return {
    db,
    config,
    options,
    state,
    checkIns,
    checkIn,
    checkedInStore,
    now,
    timestamp,
    stamp,
    minutesSince,
    context,
    refused,
    guardFacts,
    assertExchangeOffered,
    load,
    owned,
    restore,
    exchangeSelection,
    phaseOneCommitted,
    exchangeLog,
    phaseOneProof,
    returnWindow,
    assertNoActiveOperation,
    recoverySnapshot,
    recoveryView,
    readClaim,
  };
}
export type ReturnRepositoryCore = ReturnType<typeof returnRepositoryCore>;
