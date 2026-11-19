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
  MUser,
  HoldStockStore,
  Order,
  OrderAddon,
  OrderStore,
  OrderStatus,
  PosExchangeLog,
  PosHoldStockLog,
  PosTransactionLog,
  Product,
  ProductStore,
  ReturnOrder,
  ReversePickupReason,
  Store,
  StoreDayClose,
  StoreSalesPerson,
  SalesPerson,
} from '../../../db/legacy-schema.js';
import { hasProductStatuses } from '../../../db/legacy-enums.js';
import { storedEnumValue } from '../../../db/legacy-columns.js';
import { assertCurrentOperatorRole } from '../../administration/authorization.js';
import { requireRole, requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { enqueueInventorySynchronization } from '../../administration/inventory.js';
import type { StockProcedure } from '../../administration/stock-procedure.js';
import { financialYear } from '../finalizer.js';
import { exchangeRetryable } from '../returns.js';
import { wireId } from '../payloads.js';
import { pythonFloat } from '../payments/legacy.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { exchangeFeatureEnabled } from '../legacy-flags.js';
import { exchangeRefusal, forceReturnRefusal, type CellRefusal } from './exchange-cell.js';
import {
  publicReturn,
  type ExchangeRecoveryScope,
  type ExchangeRecoveryClaim,
  type ReturnInput,
  type ReturnOperation,
  type InboundReturn,
  type ReturnWindowScope,
} from './contracts.js';
import {
  fingerprint,
  RECOVERY_CLAIM_TTL_SECONDS,
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
class CommittedFailure {
  constructor(readonly error: AppError) {}
}

/** order/libs/calculations.py:21 STALE_PENDING_EXCHANGE_MINUTES. */
const STALE_PENDING_MINUTES = 10;
const RETURNED_OR_EXCHANGED = ['PRODUCT_RETURNED', 'EXCHANGE_COMPLETED'];

export function returnRepository(db: Databases, config: Config, options: ReturnRepositoryOptions) {
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
                or(eq(Product.is_del, 0), sql`${ProductStore.stock} > 0`),
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
            or(eq(Product.is_del, 0), sql`${ProductStore.stock} > 0`),
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
    state,
    load,
    /**
     * The order's lines for the returns page (the `ShowOrderDetailsView` product rows), 100 per
     * page. No customer OTP step, as legacy; the operator must be checked in to this store.
     */
    async lines(user: Principal, storeId: string, orderId: string, counterId: string, after = '0') {
      requireStore(user, storeId);
      return db.get('writer').transaction(async (tx) => {
        await checkIn(user.id, storeId, counterId, tx);
        const [order] = await tx
          .select({ id: Order.id })
          .from(Order)
          .where(eq(Order.id, BigInt(orderId)))
          .limit(1);
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
        const rows = await tx
          .select({
            id: HasProduct.id,
            productId: HasProduct.product,
            name: Product.product,
            parentId: Product.parent_prod_id,
            productType: Product.prod_type,
            quantity: HasProduct.qty,
            status: HasProduct.status,
            returnStatus: HasProduct.return_status,
          })
          .from(HasProduct)
          .leftJoin(Product, eq(Product.id, HasProduct.product))
          .where(and(eq(HasProduct.order, BigInt(orderId)), gt(HasProduct.id, BigInt(after))))
          .orderBy(asc(HasProduct.id))
          .limit(101);
        return {
          data: rows.slice(0, 100).map((row) => ({
            ...row,
            id: String(row.id),
            productId: String(row.productId),
            parentId: String(row.parentId || 0),
            productType: row.productType === null ? null : Number(row.productType),
            quantity: String(row.quantity),
          })),
          nextCursor: rows.length > 100 ? String(rows[99]!.id) : null,
        };
      });
    },
    /** Facts the per-line eligibility response needs to choose the legacy cell branch. */
    async eligibilityScope(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ExchangeRecoveryScope,
    ) {
      return db.get('writer').transaction(async (tx) => {
        const scope = await context(tx, user, storeId, orderId, lineId, input.counterId);
        const guard = await guardFacts(tx, user.id, orderId, scope.line.product);
        // get_exchange_context (order/views.py:315-333).
        const log = await exchangeLog(tx, orderId, lineId);
        let failedExchange: { storeId: string; storeName: string; newSize: string } | null = null;
        if (
          log?.status === 'FAILED_NEEDS_MANUAL_FIX' &&
          exchangeRetryable(scope.line.status, Boolean(await phaseOneCommitted(tx, log)))
        ) {
          const [origin] = await tx
            .select({ name: Store.store_name })
            .from(Store)
            .where(eq(Store.id, BigInt(log.store_id)))
            .limit(1);
          failedExchange = {
            storeId: String(log.store_id),
            storeName: origin?.name ?? '',
            newSize: log.new_size ?? 'None',
          };
        }
        return {
          customerId: String(scope.order.customerId),
          lineStatus: scope.line.status,
          returnStatus: scope.line.return_status,
          productType: guard.productType,
          storeOrder: guard.variant === 'store',
          shopifyOrder: guard.shopifyOrder,
          checkinStoreId: guard.checkinStoreId,
          exchangeFeatureEnabled: guard.exchangeFeatureEnabled,
          failedExchange,
          binding: fingerprint('return.eligibility-scope', {
            user: user.id,
            storeId,
            orderId,
            lineId,
            input,
            customerId: scope.order.customerId,
            line: scope.line,
          }),
        };
      });
    },
    async exchangeRecovery(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ExchangeRecoveryScope,
    ) {
      return db
        .get('writer')
        .transaction(async (tx) =>
          recoveryView(await recoverySnapshot(tx, user, storeId, orderId, lineId, input), storeId),
        );
    },
    /** Read-only outcome of a lost claim; an actor cannot read another actor's receipt. */
    async exchangeRecoveryClaimStatus(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      claimId: string,
      input: ExchangeRecoveryScope,
    ) {
      // Actor, store and check-in validation of the current reader.
      await db
        .get('writer')
        .transaction((tx) => context(tx, user, storeId, orderId, lineId, input.counterId));
      const receipt = await readClaim(storeId, orderId, lineId, claimId);
      if (!receipt || receipt.operatorId !== user.id || receipt.status !== 'recorded')
        return { status: 'not-recorded' as const };
      const operation = receipt.operationId ? await state.readOperation(receipt.operationId) : null;
      if (
        operation &&
        (operation.orderId !== orderId ||
          operation.lineId !== lineId ||
          operation.storeId !== storeId ||
          operation.kind !== 'exchange')
      )
        throw new AppError(
          409,
          'EXCHANGE_RECOVERY_RECEIPT_CHANGED',
          'The recorded recovery binding needs reconciliation.',
        );
      return { status: 'recorded' as const, operationId: receipt.operationId! };
    },
    /**
     * Explicit takeover of a failed exchange (legacy retry button, order/views.py:1016-1035).
     * Metadata only: no provider, return, refund or stock effect. The durable takeover facts are
     * written by the retry itself (pos_exchange_log.staff_user_id, retry_count).
     */
    async claimExchangeRecovery(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ExchangeRecoveryClaim,
    ) {
      const requestHash = fingerprint('exchange.recovery-claim', {
          userId: user.id,
          storeId,
          orderId,
          lineId,
          input,
        }),
        receiptKey = returnStateKeys.claim(storeId, orderId, lineId, input.operationId),
        binding = `${storeId}:${orderId}:${lineId}`;
      const conflict = () =>
        new AppError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This recovery command has different original input. Read its original outcome.',
        );
      if (
        !(await state.store.set(
          returnStateKeys.claimId(input.operationId),
          binding,
          RECOVERY_CLAIM_TTL_SECONDS,
          true,
        )) &&
        (await state.store.get(returnStateKeys.claimId(input.operationId))) !== binding
      )
        throw conflict();
      const pending: RecoveryClaimReceipt = {
        v: 1,
        requestHash,
        operatorId: user.id,
        counterId: input.counterId,
        revision: input.expectedRevision,
        operationId: null,
        status: 'pending',
        recordedAt: null,
      };
      const pendingRaw = JSON.stringify(pending);
      if (!(await state.store.set(receiptKey, pendingRaw, RECOVERY_CLAIM_TTL_SECONDS, true))) {
        const prior = await readClaim(storeId, orderId, lineId, input.operationId);
        if (
          !prior ||
          prior.requestHash !== requestHash ||
          prior.operatorId !== user.id ||
          prior.counterId !== input.counterId
        )
          throw conflict();
        if (prior.status === 'recorded' && prior.operationId) {
          const operation = await state.readOperation(prior.operationId);
          if (!operation)
            throw new AppError(
              409,
              'EXCHANGE_RECOVERY_RECEIPT_CHANGED',
              'The recorded recovery operation needs reconciliation.',
            );
          return publicReturn(operation);
        }
      }
      const adopted = await state.withLine(orderId, lineId, () =>
        db.get('writer').transaction(async (tx) => {
          const snapshot = await recoverySnapshot(tx, user, storeId, orderId, lineId, {
            counterId: input.counterId,
          });
          const { scope, log, credit } = snapshot;
          // S35: the retry button of a failed exchange (order/views.py:1016-1035).
          await assertExchangeOffered(tx, user.id, orderId, scope.line.product, true);
          const claim = {
            id: input.operationId,
            revision: input.expectedRevision,
            operatorId: user.id,
            counterId: input.counterId,
            claimedAt: timestamp(),
            requestHash,
          };
          // A re-run of a pending claim finds its own operation already adopted.
          if (snapshot.operation?.recoveryClaim?.id === input.operationId)
            return snapshot.operation;
          if (snapshot.revision !== input.expectedRevision)
            throw new AppError(
              409,
              'EXCHANGE_RECOVERY_CHANGED',
              'The exchange changed. Read its current recovery status.',
            );
          if (snapshot.operation) {
            const operation = snapshot.operation;
            if (
              ![
                'replacement-rejected',
                'uncertain',
                'old-item-restored',
                'inbound-accepted',
                'replacement-confirmed',
                'completed',
              ].includes(operation.phase)
            )
              throw new AppError(
                409,
                'EXCHANGE_RECOVERY_BUSY',
                'An exchange for this item is already in progress.',
              );
            await phaseOneProof(tx, operation, scope.line.status, operation.phase === 'completed');
            return stamp({
              ...operation,
              authorityCounterId: input.counterId,
              recoveryClaim: claim,
            });
          }
          const view = recoveryView(snapshot, storeId);
          if (view.state === 'wrong-store' && log) {
            const [origin] = await tx
              .select({ name: Store.store_name })
              .from(Store)
              .where(eq(Store.id, BigInt(log.store_id)))
              .limit(1);
            throw new AppError(
              409,
              'EXCHANGE_WRONG_STORE',
              `This exchange was started at ${origin?.name || `store ${log.store_id}`}. Please retry it from there.`,
            );
          }
          if (view.state !== 'legacy' || !log || !credit)
            throw new AppError(
              409,
              'EXCHANGE_RECOVERY_UNCONFIRMED',
              'There is no failed exchange to retry for this item. Please refresh the page.',
            );
          if (!input.salespersonId)
            throw new AppError(
              422,
              'EXCHANGE_SALESPERSON_REQUIRED',
              'Salesperson selection is required for exchange.',
            );
          const date = timestamp();
          return {
            id: input.operationId,
            kind: 'exchange' as const,
            operatorId: user.id,
            storeId,
            orderId,
            lineId,
            productId: String(log.old_prod_id),
            customerId: String(scope.order.customerId),
            quantity: Number(scope.line.qty),
            authorityCounterId: input.counterId,
            recoveryClaim: claim,
            exchange: {
              newProductId: String(log.new_prod_id),
              parentProductId: String(log.exchange_parent_prod_id),
              newSize: log.new_size ?? '',
              oldSize: log.old_size,
              salespersonId: input.salespersonId,
              logId: String(log.id),
              childOrderId: null,
              // order/views.py:1071: counter_id = exchange_log.counter_id or 0
              sourceCounterId: String(log.counter_id || 0),
            },
            input: {
              operationId: input.operationId,
              counterId: input.counterId,
              reasonId: String(log.reason_id),
              ...(log.sub_reason_id ? { subReasonId: String(log.sub_reason_id) } : {}),
              comment: log.comment || '',
              qualityConfirmed: true,
              tagConfirmed: true,
              saleable: Boolean(log.saleable),
              refundMode: 'tss-money' as const,
              overrideEligibility: false,
              clickType: 'normal' as const,
            },
            requestHash,
            phase: 'replacement-rejected' as const,
            uncertainStage: null,
            creditNote: credit.creditNote,
            returnAmount: null,
            returnAmountRepr: null,
            errorCode: 'LEGACY_EXCHANGE_ADOPTED',
            message: log.last_error,
            createdAt: log.created_at,
            updatedAt: date,
          };
        }),
      );
      await state.saveOperation(adopted);
      const recorded: RecoveryClaimReceipt = {
        ...pending,
        operationId: adopted.id,
        status: 'recorded',
        recordedAt: timestamp(),
      };
      const current = await state.store.get(receiptKey);
      if (current !== null && current !== JSON.stringify(recorded))
        await state.store.compareAndSet(
          receiptKey,
          current,
          JSON.stringify(recorded),
          RECOVERY_CLAIM_TTL_SECONDS,
        );
      return publicReturn(adopted);
    },
    async extensionScope(
      tx: AdministrationTransaction,
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ReturnWindowScope,
    ) {
      requireRole(user, [1, 2, 3]);
      await assertCurrentOperatorRole(tx, user.id, [1, 2, 3]);
      const scope = await context(tx, user, storeId, orderId, lineId, input.counterId);
      if (
        String(scope.line.product) !== input.productId ||
        scope.line.status !== 'DELIVERED' ||
        scope.line.return_status !== 0
      )
        throw new AppError(
          409,
          'RETURN_EXTENSION_LINE_INELIGIBLE',
          'Select an unreturned delivered line belonging to this order.',
        );
      const actors = await tx
        .select({ id: MUser.id })
        .from(MUser)
        .where(eq(MUser.pos_admin_id, BigInt(user.id)))
        .limit(2)
        .for('share');
      if (actors.length !== 1 || !actors[0] || actors[0].id <= 0n)
        throw new AppError(
          409,
          'RETURN_EXTENSION_ACTOR_UNAVAILABLE',
          'The native manager audit identity needs review.',
        );
      if (options.returnPeriodDays === undefined)
        throw new AppError(503, 'RETURN_POLICY_UNAVAILABLE', 'Return policy is not configured.');
      const [delivery] = await tx
        .select({ date: Comments.created_at })
        .from(Comments)
        .where(and(eq(Comments.order_id, BigInt(orderId)), eq(Comments.status_id, 3n)))
        .orderBy(desc(Comments.created_at))
        .limit(1)
        .for('share');
      if (!delivery)
        throw new AppError(
          409,
          'RETURN_DELIVERY_UNCONFIRMED',
          'No delivered record exists for this order.',
        );
      return {
        nativeActorId: actors[0].id,
        deliveredAt: delivery.date,
        periodDays: options.returnPeriodDays,
      };
    },
    /**
     * Validates and records a new return/exchange (`AjaxProductReturnView` / `AjaxProductExchangeView`
     * up to the warehouse call). The caller holds the line lock.
     */
    async begin(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ReturnInput,
      exchange?: { replacementProductId: string; salespersonId: string },
    ): Promise<{ operation: ReturnOperation; replay: boolean }> {
      const hash = fingerprint(exchange ? 'exchange.create' : 'return.create', {
        storeId,
        orderId,
        lineId,
        input,
        ...(exchange ? { exchange } : {}),
      });
      const previous = await state.readOperation(input.operationId);
      if (previous) {
        if (
          previous.storeId !== storeId ||
          previous.orderId !== orderId ||
          previous.lineId !== lineId ||
          previous.operatorId !== user.id ||
          previous.requestHash !== hash
        )
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This return key was used with different data.',
          );
        return { operation: previous, replay: true };
      }
      if (input.saleable && !options.inventoryProcedureVerified)
        throw new AppError(
          503,
          'RETURN_INVENTORY_UNVERIFIED',
          'The deployed inventory procedure must be verified before restoring saleable stock.',
        );
      if (input.overrideEligibility) requireRole(user, [1]);
      if (!exchange) await assertNoActiveOperation(orderId, lineId);
      const result = await db.get('writer').transaction(async (tx) => {
        const scope = await context(tx, user, storeId, orderId, lineId, input.counterId);
        // S35: the exchange and force-return buttons are template-gated in legacy; the server
        // gives the same outcome before anything is written.
        const guard = exchange
          ? await assertExchangeOffered(tx, user.id, orderId, scope.line.product, false)
          : await guardFacts(tx, user.id, orderId, scope.line.product);
        if (!exchange && input.clickType === 'extreme') {
          const refusal = forceReturnRefusal({ ...guard, lineStatus: scope.line.status });
          if (refusal) throw refused(refusal);
        }
        const exchangeInitiated = scope.line.status === 'EXCHANGE_INITIATED';
        if (
          !(scope.line.status === 'DELIVERED' && scope.line.return_status === 0) &&
          !(exchange && exchangeInitiated)
        )
          throw new AppError(
            409,
            'RETURN_LINE_INELIGIBLE',
            'This line is no longer available for a new return.',
          );
        // return_processed checks the delivery, window and unrefunded amount before anything else.
        if (!exchange) {
          const failure = await returnWindow(
            tx,
            orderId,
            lineId,
            scope.line.product,
            input.clickType,
          );
          if (failure) throw failure;
        }
        const [reason] = await tx
          .select({ id: ReversePickupReason.id })
          .from(ReversePickupReason)
          .where(eq(ReversePickupReason.id, BigInt(input.reasonId)))
          .limit(1);
        if (
          (!reason && !exchange) ||
          BigInt(input.reasonId) > 2147483647n ||
          BigInt(storeId) > 2147483647n ||
          BigInt(input.subReasonId || '0') > 2147483647n
        )
          throw new AppError(422, 'RETURN_REASON_UNAVAILABLE', 'Please select correct reason');
        if (
          input.refundMode === 'cash' &&
          scope.order.paymentMethod === 3n &&
          !(user.role === 1 && scope.order.parentId > 0n && !scope.order.parentExpress)
        )
          throw new AppError(
            403,
            'CASH_REFUND_NOT_PERMITTED',
            'This prepaid line is eligible for wallet refund only.',
          );
        if (scope.line.qty < 1n || scope.line.qty > 2147483647n)
          throw new AppError(
            409,
            'RETURN_QUANTITY_INVALID',
            'This line has no supported returnable quantity.',
          );
        const date = timestamp();
        let exchangeState: ReturnOperation['exchange'] = null;
        if (exchange) {
          // order/views.py:1013-1050, in the same order.
          const log = await exchangeLog(tx, orderId, lineId);
          if (log) {
            if (log.status === 'SUCCESS')
              throw new AppError(
                409,
                'EXCHANGE_ALREADY_COMPLETED',
                'This item has already been exchanged.',
              );
            if (log.status === 'PENDING' && minutesSince(log.updated_at) < STALE_PENDING_MINUTES)
              throw new AppError(
                409,
                'EXCHANGE_IN_PROGRESS',
                'An exchange for this item is already in progress.',
              );
            const committed = Boolean(await phaseOneCommitted(tx, log));
            if (exchangeRetryable(scope.line.status, committed))
              throw new AppError(
                409,
                'EXCHANGE_RETRY_REQUIRED',
                'A previous exchange attempt for this item failed. Please refresh the page and use the retry button.',
              );
            if (committed)
              throw new AppError(
                409,
                'EXCHANGE_ALREADY_RETURNED',
                'This item has already been returned or refunded. Please contact tech support.',
              );
          }
          const selected = await exchangeSelection(tx, scope, exchange, false);
          if (
            [
              orderId,
              lineId,
              storeId,
              String(scope.line.product),
              selected.newProductId,
              selected.parentProductId,
              user.id,
              input.counterId,
              exchange.salespersonId,
            ].some((value) => BigInt(value) > 2147483647n)
          )
            throw new AppError(
              409,
              'EXCHANGE_IDENTIFIER_UNSUPPORTED',
              'This exchange exceeds the supported legacy ledger identifiers.',
            );
          const values = {
            order_id: Number(orderId),
            has_prod_id: Number(lineId),
            old_prod_id: Number(scope.line.product),
            old_size: selected.oldSize,
            new_prod_id: Number(selected.newProductId),
            new_size: selected.newSize,
            exchange_parent_prod_id: Number(selected.parentProductId),
            store_id: Number(storeId),
            counter_id: Number(input.counterId),
            staff_user_id: Number(user.id),
            reason_id: Number(input.reasonId),
            sub_reason_id: Number(input.subReasonId || '0'),
            comment: input.comment,
            saleable: input.saleable,
            status: 'PENDING',
            updated_at: date,
          };
          if (log) await tx.update(PosExchangeLog).set(values).where(eq(PosExchangeLog.id, log.id));
          else
            await tx.insert(PosExchangeLog).values({
              ...values,
              new_order_id: 0,
              retry_count: 0,
              last_error: null,
              created_at: date,
            });
          const saved = log ?? (await exchangeLog(tx, orderId, lineId));
          if (!saved)
            throw new AppError(
              503,
              'EXCHANGE_LEDGER_UNAVAILABLE',
              'The exchange ledger could not be recorded.',
            );
          exchangeState = { ...selected, logId: String(saved.id), childOrderId: null };
          // An exchange already marked on the line was approved once (order/views.py:1124-1126).
          const failure = await returnWindow(
            tx,
            orderId,
            lineId,
            scope.line.product,
            exchangeInitiated ? 'extreme' : 'normal',
          );
          if (failure) {
            await tx
              .update(PosExchangeLog)
              .set({
                status: 'FAILED_NEEDS_MANUAL_FIX',
                last_error: failure.message,
                updated_at: timestamp(),
              })
              .where(eq(PosExchangeLog.id, saved.id));
            return new CommittedFailure(failure);
          }
        }
        const operation: ReturnOperation = {
          id: input.operationId,
          kind: exchange ? 'exchange' : 'return',
          exchange: exchangeState,
          operatorId: user.id,
          storeId,
          orderId,
          lineId,
          productId: String(scope.line.product),
          customerId: String(scope.order.customerId),
          quantity: Number(scope.line.qty),
          guard: { variant: guard.variant, productType: guard.productType },
          input,
          requestHash: hash,
          phase: 'inbound-dispatching',
          uncertainStage: null,
          creditNote: null,
          returnAmount: null,
          returnAmountRepr: null,
          errorCode: null,
          message: null,
          createdAt: date,
          updatedAt: date,
        };
        return operation;
      });
      if (result instanceof CommittedFailure) throw result.error;
      if (!(await state.createOperation(result)))
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This return key is already in use.');
      return { operation: result, replay: false };
    },
    async inboundData(user: Principal, storeId: string, id: string): Promise<InboundReturn> {
      const operation = await load(user, storeId, id);
      return db.get('writer').transaction(async (tx) => {
        const { store, order, line } = await owned(tx, user, operation),
          [reason] = await tx
            .select({ reason: ReversePickupReason.reason })
            .from(ReversePickupReason)
            .where(eq(ReversePickupReason.id, BigInt(operation.input.reasonId)))
            .limit(1);
        const date = now();
        return {
          locationCode: store.locationCode,
          orderId: operation.orderId,
          trackingNumber: line.awb || wireId(operation.orderId),
          returnDate: `${String(date.day).padStart(2, '0')}/${String(date.month).padStart(2, '0')}/${date.year} ${String(date.hour).padStart(2, '0')}:${String(date.minute).padStart(2, '0')}:${String(date.second).padStart(2, '0')}`,
          customerName: order.name,
          address1: order.address1,
          address2: order.address2,
          state: String(order.state),
          city: order.city,
          pincode: order.pincode,
          remarks: operation.input.comment
            ? `${reason?.reason || ''}:${operation.input.comment}`
            : '',
          productId: operation.productId,
          lineId: operation.lineId,
          quantity: operation.quantity,
          reason: reason?.reason || '',
          exchange: operation.kind === 'exchange',
        };
      });
    },
    /** `add_to_return_orders`, `has_product_and_order_update`, `add_to_comment` (calculations.py:189-250). */
    async accepted(user: Principal, storeId: string, id: string) {
      const operation = await load(user, storeId, id);
      const next = await db.get('writer').transaction(async (tx) => {
        const { store, line } = await owned(tx, user, operation);
        if (operation.phase !== 'inbound-dispatching')
          throw new AppError(
            409,
            'RETURN_PHASE_CHANGED',
            'The return phase changed. Review its current status.',
          );
        const [reason] = await tx
            .select({ reason: ReversePickupReason.reason })
            .from(ReversePickupReason)
            .where(eq(ReversePickupReason.id, BigInt(operation.input.reasonId)))
            .limit(1),
          lines = await tx
            .select({ id: HasProduct.id, status: HasProduct.status })
            .from(HasProduct)
            .where(eq(HasProduct.order, BigInt(operation.orderId))),
          // calculations.py:112-117: count returned/exchanged lines including this one.
          done = lines.filter((row) => RETURNED_OR_EXCHANGED.includes(row.status || '')).length,
          orderStatus = lines.length - 1 === done ? 6 : 37;
        // Legacy helpers.py:2205,2284,2299 formats Store.location_code (nullable) in
        // f-strings, so a NULL code becomes 'None'.
        const storeCode = store.locationCode ?? 'None',
          fy = financialYear(timestamp()),
          [last] = await tx
            .select({ number: ReturnOrder.credit_note_no })
            .from(ReturnOrder)
            .where(
              and(
                eq(ReturnOrder.store_id, Number(storeId)),
                or(
                  like(ReturnOrder.credit_note_no, `${storeCode}/${fy}/CN/%`),
                  like(ReturnOrder.credit_note_no, `${storeCode}${fy}CN%`),
                ),
              ),
            )
            .orderBy(desc(ReturnOrder.credit_note_no))
            .limit(1)
            .for('update'),
          sequence = last?.number ? Number(/(\d+)$/.exec(last.number)?.[1] || 0) + 1 : 1,
          creditNote = `${storeCode}${fy}CN${String(sequence).padStart(5, '0')}`,
          date = timestamp();
        await tx.insert(ReturnOrder).values({
          order_status: orderStatus,
          order_id: BigInt(operation.orderId),
          prod_id: BigInt(operation.productId),
          sub_prod_id: line.sub_prod_id,
          qty: operation.quantity,
          received: 0,
          reason_id: Number(operation.input.reasonId),
          sub_reason_id: Number(operation.input.subReasonId || '0'),
          store_id: Number(storeId),
          other_reason: '',
          comment: reason?.reason || '',
          created_at: date,
          updated_at: date,
          has_product_id: BigInt(operation.lineId),
          credit_note_no: creditNote,
        });
        await tx
          .update(HasProduct)
          .set({
            return_status: operation.kind === 'exchange' ? 1 : 33,
            status: operation.kind === 'exchange' ? 'EXCHANGE_INITIATED' : 'PRODUCT_RETURNED',
            amount_refunded_mode: 0,
            return_mode: operation.kind === 'exchange' ? 5 : 3,
            return_request_date_time: date,
          })
          .where(eq(HasProduct.id, line.id));
        if (operation.kind !== 'exchange')
          await tx
            .update(Order)
            .set({
              order_statuses: BigInt(orderStatus),
              payment_statuses: orderStatus === 6 ? 5n : 9n,
            })
            .where(eq(Order.id, BigInt(operation.orderId)));
        await tx.insert(Comments).values({
          order_id: BigInt(operation.orderId),
          status_id: BigInt(orderStatus),
          comment:
            operation.kind === 'exchange'
              ? 'Store exchange initiated by POS dashbaord'
              : 'Store return initiated by POS dashbaord',
          notify: 1,
          user_id: 0n,
          package_details: '',
          has_product_id: BigInt(operation.lineId),
          prod_id: BigInt(operation.productId),
          created_at: date,
          updated_at: date,
        });
        return stamp({ ...operation, phase: 'inbound-accepted', creditNote });
      });
      return state.saveOperation(next);
    },
    async claimRefund(user: Principal, storeId: string, id: string) {
      const operation = await load(user, storeId, id);
      const next = await db.get('writer').transaction(async (tx) => {
        const { order } = await owned(tx, user, operation);
        if (operation.kind !== 'return')
          throw new AppError(409, 'RETURN_KIND_MISMATCH', 'This operation is not a refund return.');
        if (operation.phase !== 'inbound-accepted')
          throw new AppError(
            409,
            'RETURN_REFUND_ALREADY_DISPATCHED',
            'The refund was already dispatched or needs review.',
          );
        if (operation.input.overrideEligibility) requireRole(user, [1]);
        if (
          operation.input.refundMode === 'cash' &&
          order.paymentMethod === 3n &&
          !(user.role === 1 && order.parentId > 0n && !order.parentExpress)
        )
          throw new AppError(
            403,
            'CASH_REFUND_NOT_PERMITTED',
            'This prepaid line is eligible for wallet refund only.',
          );
        return stamp({ ...operation, phase: 'refund-dispatching' });
      });
      return state.saveOperation(next);
    },
    async refundConfirmed(
      user: Principal,
      storeId: string,
      id: string,
      returnAmount: string,
      returnAmountRepr: string,
    ) {
      const operation = await load(user, storeId, id);
      if (operation.phase !== 'refund-dispatching')
        throw new AppError(
          409,
          'RETURN_PHASE_CHANGED',
          'The return phase changed. Review its current status.',
        );
      return state.saveOperation(
        stamp({
          ...operation,
          phase: 'refund-confirmed',
          returnAmount,
          returnAmountRepr,
        }),
      );
    },
    /** order/views.py:938-941: "Already refunded" ends the request without stock or audit. */
    async alreadyRefunded(user: Principal, storeId: string, id: string) {
      const operation = await load(user, storeId, id);
      return state.saveOperation(
        stamp({
          ...operation,
          phase: 'rejected',
          uncertainStage: null,
          errorCode: 'RETURN_ALREADY_REFUNDED',
          message: 'Already refunded',
        }),
      );
    },
    /** Stock, `return_transaction_logger` and `mark_stale` (order/views.py:948-966). */
    async complete(user: Principal, storeId: string, id: string) {
      const operation = await load(user, storeId, id);
      if (operation.kind !== 'return')
        throw new AppError(409, 'RETURN_KIND_MISMATCH', 'This operation is not a refund return.');
      if (operation.phase === 'completed') return { operation, completedNow: false };
      if (operation.phase !== 'refund-confirmed' || operation.returnAmount === null)
        throw new AppError(
          409,
          'RETURN_REFUND_UNCONFIRMED',
          'The refund must be confirmed before returning stock.',
        );
      const next = await db.get('writer').transaction(async (tx) => {
        const { store } = await owned(tx, user, operation);
        await restore(tx, user, operation);
        // helpers.py:442: filter(order_id, prod_id).first() — no line filter.
        const [ledger] = await tx
            .select()
            .from(AmountToBeRefundedLog)
            .where(
              and(
                eq(AmountToBeRefundedLog.order_id, BigInt(operation.orderId)),
                eq(AmountToBeRefundedLog.prod_id, BigInt(operation.productId)),
              ),
            )
            .orderBy(asc(AmountToBeRefundedLog.id))
            .limit(1),
          [order] = await tx
            .select({ status: Order.order_statuses, paymentStatus: Order.payment_statuses })
            .from(Order)
            .where(eq(Order.id, BigInt(operation.orderId)))
            .limit(1);
        if (!ledger || !order)
          throw new AppError(409, 'RETURN_LEDGER_UNAVAILABLE', 'The return ledger is unavailable.');
        const date = timestamp(),
          amountRepr = operation.returnAmountRepr ?? operation.returnAmount!;
        await tx.insert(PosTransactionLog).values({
          order_id: BigInt(operation.orderId),
          store_id: BigInt(storeId),
          order_status: order.status ?? 0n,
          payment_status: order.paymentStatus ?? 0n,
          user_id: 0n,
          pos_user_id: BigInt(user.id),
          pay_dict:
            `{'tss point refunded': ${pythonFloat(ledger.tss_point_used)}, ` +
            `'tss money refunded': ${pythonFloat(ledger.tss_money_used)}, ` +
            `'gift voucher amount refunded': ${pythonFloat(ledger.gift_voucher_amount)}, ` +
            `'${operation.input.refundMode === 'cash' ? 'pay amt refunded into cash' : 'pay amt refunded into tss money'}': ${amountRepr}, ` +
            `'total amount refunded': ${pythonFloat(ledger.amount_to_be_refunded + ledger.tss_point_used)}}`,
          comment:
            `Product ID : ${operation.productId}, ${operation.quantity} Quantity Return to ${store.name}`.slice(
              0,
              255,
            ),
          created_at: date,
          updated_at: date,
        });
        if (operation.input.refundMode === 'cash')
          await tx
            .update(StoreDayClose)
            .set({
              status: 'STALE',
              stale_at: date,
              stale_reason: 'REFUND',
              stale_trigger_ref: operation.orderId,
              updated_at: date,
            })
            .where(
              and(
                eq(StoreDayClose.store_id, Number(storeId)),
                eq(StoreDayClose.close_date, now().toPlainDate().toString()),
                eq(StoreDayClose.status, 'CLOSED'),
              ),
            );
        return stamp({
          ...operation,
          phase: 'completed',
          errorCode: null,
          message: 'Product return request processed.',
        });
      });
      return { operation: await state.saveOperation(next), completedNow: true };
    },
    async restoreExchange(user: Principal, storeId: string, id: string) {
      const operation = await load(user, storeId, id);
      if (operation.kind !== 'exchange' || !operation.exchange)
        throw new AppError(409, 'EXCHANGE_NOT_FOUND', 'This operation is not an exchange.');
      if (operation.phase === 'old-item-restored') return operation;
      if (operation.phase !== 'inbound-accepted')
        throw new AppError(
          409,
          'EXCHANGE_PHASE_CHANGED',
          'This exchange is not ready for stock restoration.',
        );
      const next = await db.get('writer').transaction(async (tx) => {
        const { line } = await owned(tx, user, operation);
        await phaseOneProof(tx, operation, line.status);
        await restore(tx, user, operation);
        return stamp({ ...operation, phase: 'old-item-restored' });
      });
      return state.saveOperation(next);
    },
    /** Retry bookkeeping (order/views.py:1116-1122) and the live stock re-check. */
    async claimReplacement(
      user: Principal,
      storeId: string,
      id: string,
      retrySalespersonId?: string,
    ) {
      const operation = await load(user, storeId, id);
      if (
        operation.kind !== 'exchange' ||
        !operation.exchange ||
        !['old-item-restored', 'replacement-rejected'].includes(operation.phase)
      )
        throw new AppError(
          409,
          'EXCHANGE_REVIEW_REQUIRED',
          'This item is no longer awaiting an exchange. Please refresh the page.',
        );
      const exchange = operation.exchange,
        retry = operation.phase === 'replacement-rejected';
      const next = await db.get('writer').transaction(async (tx) => {
        const scope = await owned(tx, user, operation);
        // S35: the retry button of a failed exchange (order/views.py:1016-1035).
        if (retry)
          await assertExchangeOffered(tx, user.id, operation.orderId, scope.line.product, true);
        await phaseOneProof(tx, operation, scope.line.status);
        const [log] = await tx
          .select()
          .from(PosExchangeLog)
          .where(eq(PosExchangeLog.id, BigInt(exchange.logId)))
          .limit(1)
          .for('update');
        if (!log || log.retry_count >= 32767)
          throw new AppError(
            409,
            'EXCHANGE_LEDGER_UNAVAILABLE',
            'The exchange tracking record is unavailable.',
          );
        if (log.status === 'SUCCESS')
          throw new AppError(
            409,
            'EXCHANGE_ALREADY_COMPLETED',
            'This item has already been exchanged.',
          );
        if (retry && String(log.store_id) !== storeId) {
          const [origin] = await tx
            .select({ name: Store.store_name })
            .from(Store)
            .where(eq(Store.id, BigInt(log.store_id)))
            .limit(1);
          throw new AppError(
            409,
            'EXCHANGE_WRONG_STORE',
            `This exchange was started at ${origin?.name || `store ${log.store_id}`}. Please retry it from there.`,
          );
        }
        const selected = await exchangeSelection(
          tx,
          scope,
          {
            replacementProductId: exchange.newProductId,
            salespersonId: retrySalespersonId || exchange.salespersonId,
          },
          retry,
          exchange.newSize,
        );
        await tx
          .update(PosExchangeLog)
          .set({
            status: 'PENDING',
            staff_user_id: Number(user.id),
            retry_count: log.retry_count + (retry ? 1 : 0),
            updated_at: timestamp(),
          })
          .where(eq(PosExchangeLog.id, log.id));
        return stamp({
          ...operation,
          exchange: { ...exchange, salespersonId: selected.salespersonId },
          phase: 'replacement-dispatching',
          uncertainStage: null,
          errorCode: null,
          message: null,
        });
      });
      return state.saveOperation(next);
    },
    async replacementConfirmed(user: Principal, storeId: string, id: string, childOrderId: string) {
      const operation = await load(user, storeId, id);
      if (
        operation.kind !== 'exchange' ||
        !operation.exchange ||
        operation.phase !== 'replacement-dispatching'
      )
        throw new AppError(
          409,
          'EXCHANGE_PHASE_CHANGED',
          'This exchange phase changed. Review its current status.',
        );
      const exchange = operation.exchange;
      await db
        .get('writer')
        .update(PosExchangeLog)
        .set({
          new_order_id: BigInt(childOrderId) <= 2147483647n ? Number(childOrderId) : null,
          status: 'SUCCESS',
          updated_at: timestamp(),
        })
        .where(eq(PosExchangeLog.id, BigInt(exchange.logId)));
      return state.saveOperation(
        stamp({
          ...operation,
          phase: 'replacement-confirmed',
          exchange: { ...exchange, childOrderId },
        }),
      );
    },
    /** FAILED_NEEDS_MANUAL_FIX + last_error (order/views.py:1286-1290). */
    async replacementFailure(user: Principal, storeId: string, id: string, message: string) {
      const operation = await load(user, storeId, id);
      if (operation.kind !== 'exchange' || !operation.exchange)
        throw new AppError(409, 'EXCHANGE_NOT_FOUND', 'This operation is not an exchange.');
      if (operation.phase !== 'replacement-dispatching') return { operation, retryCount: null };
      const [log] = await db
        .get('writer')
        .select({ retryCount: PosExchangeLog.retry_count })
        .from(PosExchangeLog)
        .where(eq(PosExchangeLog.id, BigInt(operation.exchange.logId)))
        .limit(1);
      await db
        .get('writer')
        .update(PosExchangeLog)
        .set({
          status: 'FAILED_NEEDS_MANUAL_FIX',
          last_error: message,
          updated_at: timestamp(),
        })
        .where(eq(PosExchangeLog.id, BigInt(operation.exchange.logId)));
      return {
        operation: await state.saveOperation(
          stamp({
            ...operation,
            phase: 'replacement-rejected',
            uncertainStage: null,
            errorCode: 'EXCHANGE_REPLACEMENT_FAILED',
            message,
          }),
        ),
        retryCount: log?.retryCount ?? 0,
      };
    },
    /** order/views.py:1188-1278: invoice, delivered status, comments, logs, addon. */
    async completeExchange(
      user: Principal,
      storeId: string,
      id: string,
      onInvoiceError: (error: unknown) => void,
    ) {
      const operation = await load(user, storeId, id);
      if (operation.kind !== 'exchange' || !operation.exchange)
        throw new AppError(409, 'EXCHANGE_NOT_FOUND', 'This operation is not an exchange.');
      if (operation.phase === 'completed')
        return { operation, alreadyFinished: true, replacementLineId: null };
      const exchange = operation.exchange,
        childId = exchange.childOrderId;
      if (operation.phase !== 'replacement-confirmed' || !childId)
        throw new AppError(
          409,
          'EXCHANGE_CHILD_UNCONFIRMED',
          'The replacement order must be confirmed first.',
        );
      if (BigInt(childId) > 2147483647n)
        throw new AppError(
          409,
          'EXCHANGE_IDENTIFIER_UNSUPPORTED',
          'This replacement order exceeds the supported legacy ledger identifiers.',
        );
      const result = await db.get('writer').transaction(async (tx) => {
        const { line, order, store } = await owned(tx, user, operation);
        const [child] = await tx
          .select({
            id: Order.id,
            parentId: Order.parent_order_id,
            status: Order.order_statuses,
            wallet: Order.tss_money_used,
            updatedAt: Order.updated_at,
          })
          .from(Order)
          .where(eq(Order.id, BigInt(childId)))
          .limit(1)
          .for('update');
        // Secure option: never mark an order that is not this line's replacement child.
        if (!child || child.parentId !== BigInt(operation.orderId))
          throw new AppError(
            409,
            'EXCHANGE_CHILD_SCOPE_MISMATCH',
            'The replacement order does not match this exchange.',
          );
        // Invoice number as soon as the child exists (views.py:1192-1203); errors are only logged.
        try {
          await tx.transaction(async (savepoint) => {
            const stores = await savepoint
              .select({ id: OrderStore.id, invoice: OrderStore.order_invoice })
              .from(OrderStore)
              .where(eq(OrderStore.order, child.id))
              .orderBy(asc(OrderStore.id))
              .limit(1)
              .for('update');
            if (stores[0] && !stores[0].invoice) {
              const code = store.locationCode ?? 'None',
                fy = financialYear(
                  child.updatedAt && !child.updatedAt.startsWith('0000')
                    ? child.updatedAt
                    : timestamp(),
                );
              const [last] = await savepoint
                .select({ invoice: OrderStore.order_invoice })
                .from(OrderStore)
                .where(
                  and(
                    eq(OrderStore.store, BigInt(storeId)),
                    or(
                      like(OrderStore.order_invoice, `${code}/${fy}/INV/%`),
                      like(OrderStore.order_invoice, `${code}${fy}INV%`),
                    ),
                  ),
                )
                .orderBy(desc(OrderStore.order_invoice))
                .limit(1)
                .for('update');
              const sequence = last?.invoice
                ? Number(/(\d+)$/.exec(last.invoice)?.[1] || 0) + 1
                : 1;
              await savepoint
                .update(OrderStore)
                .set({ order_invoice: `${code}${fy}INV${String(sequence).padStart(5, '0')}` })
                .where(eq(OrderStore.order, child.id));
            }
          });
        } catch (error) {
          onInvoiceError(error);
        }
        const alreadyFinished = child.status === 3n;
        const [status] = await tx
          .select({ name: OrderStatus.order_status })
          .from(OrderStatus)
          .where(eq(OrderStatus.id, 3n))
          .limit(1);
        if (!status)
          throw new AppError(
            503,
            'ORDER_STATUS_UNAVAILABLE',
            'Delivered order status is unavailable.',
          );
        await tx
          .update(Order)
          .set({ payment_statuses: 4n, order_statuses: 3n })
          .where(eq(Order.id, child.id));
        const [replacement] = await tx
          .select({ id: HasProduct.id })
          .from(HasProduct)
          .where(eq(HasProduct.order, child.id))
          .orderBy(asc(HasProduct.id))
          .limit(1);
        const date = timestamp();
        if (!alreadyFinished)
          await tx.insert(Comments).values({
            order_id: child.id,
            status_id: 3n,
            comment: `Store Order: ${status.name} status changed by pos admin (exchange).`,
            notify: 0,
            user_id: BigInt(user.id),
            package_details: '',
            has_product_id: replacement?.id ?? 0n,
            prod_id: BigInt(exchange.newProductId),
            created_at: date,
            updated_at: date,
          });
        await tx
          .update(HasProduct)
          .set({ status: storedEnumValue(hasProductStatuses, status.name) })
          .where(eq(HasProduct.order, child.id));
        await tx
          .update(HasProduct)
          .set({ status: 'EXCHANGE_COMPLETED' })
          .where(and(eq(HasProduct.id, line.id), eq(HasProduct.order, BigInt(operation.orderId))));
        if (!alreadyFinished) {
          const wallet = pythonFloat(child.wallet);
          await tx.insert(PosTransactionLog).values([
            {
              order_id: BigInt(operation.orderId),
              store_id: BigInt(storeId),
              order_status: order.status ?? 0n,
              payment_status: order.paymentStatus ?? 0n,
              user_id: 0n,
              pos_user_id: BigInt(user.id),
              pay_dict: `{'tss money used': ${wallet}, 'total amount on counter': 0, 'has_product id': ${operation.lineId}, 'sku id': ${operation.productId}}`,
              comment: `Exchanged : TSS Money Used ${wallet} (New order ${childId} created)`,
              created_at: date,
              updated_at: date,
            },
            {
              order_id: child.id,
              store_id: BigInt(storeId),
              order_status: 3n,
              payment_status: 4n,
              user_id: 0n,
              pos_user_id: BigInt(user.id),
              pay_dict: `{'tss money used': ${wallet}, 'total amount on counter': 0}`,
              comment: `Order Delivered : TSS Money Used ${wallet} (Exchange from order ${operation.orderId})`,
              created_at: date,
              updated_at: date,
            },
          ]);
        }
        const [parentAddon] = await tx
            .select({ checked: OrderAddon.is_nps_notification_checked })
            .from(OrderAddon)
            .where(eq(OrderAddon.order_id, BigInt(operation.orderId)))
            .orderBy(asc(OrderAddon.id))
            .limit(1),
          [childAddon] = await tx
            .select({ id: OrderAddon.id })
            .from(OrderAddon)
            .where(eq(OrderAddon.order_id, child.id))
            .limit(1)
            .for('update'),
          addon = {
            shipped_location: 'MW1' as const,
            is_nps_mail_sent: 0,
            is_nps_notification_checked: parentAddon ? parentAddon.checked : 0,
          };
        if (childAddon)
          await tx.update(OrderAddon).set(addon).where(eq(OrderAddon.id, childAddon.id));
        else
          await tx.insert(OrderAddon).values({
            ...addon,
            order_id: child.id,
            hl_charges_refunded: 0,
            order_success_timestamp: date,
            order_transferred_timestamp: null,
            created_at: date,
            updated_at: date,
          });
        await tx
          .update(PosExchangeLog)
          .set({
            status: 'SUCCESS',
            new_order_id: Number(childId),
            last_error: null,
            updated_at: date,
          })
          .where(eq(PosExchangeLog.id, BigInt(exchange.logId)));
        return {
          next: stamp({
            ...operation,
            phase: 'completed',
            errorCode: null,
            uncertainStage: null,
            message: 'Exchange completed successfully.',
          }),
          alreadyFinished,
          replacementLineId: replacement ? String(replacement.id) : null,
        };
      });
      return {
        operation: await state.saveOperation(result.next),
        alreadyFinished: result.alreadyFinished,
        replacementLineId: result.replacementLineId,
      };
    },
    async read(user: Principal, storeId: string, id: string) {
      const operation = await load(user, storeId, id);
      await db.get('writer').transaction((tx) => owned(tx, user, operation));
      return operation;
    },
    async storeSlackUrl(storeId: string) {
      const [row] = await db
        .get('primary')
        .select({ url: Store.slack_group_url })
        .from(Store)
        .where(eq(Store.id, BigInt(storeId)))
        .limit(1);
      return row?.url || null;
    },
    async hasOrderStore(orderId: string) {
      const [row] = await db
        .get('writer')
        .select({ id: OrderStore.id })
        .from(OrderStore)
        .where(eq(OrderStore.order, BigInt(orderId)))
        .limit(1);
      return Boolean(row);
    },
    /**
     * A failed warehouse call (`return_processed` vinc failure, calculations.py:160-170): nothing
     * native is written for a return; an exchange's tracking row becomes FAILED_NEEDS_MANUAL_FIX.
     */
    async failure(
      user: Principal,
      storeId: string,
      id: string,
      stage: 'inbound' | 'refund',
      uncertain: boolean,
      errorCode: string,
      message: string | null,
    ) {
      const operation = await load(user, storeId, id);
      if (
        [
          'completed',
          'refund-confirmed',
          'inbound-accepted',
          'old-item-restored',
          'replacement-confirmed',
        ].includes(operation.phase)
      )
        return operation;
      if (operation.exchange)
        await db
          .get('writer')
          .update(PosExchangeLog)
          .set({
            status: 'FAILED_NEEDS_MANUAL_FIX',
            last_error: message ?? errorCode,
            updated_at: timestamp(),
          })
          .where(eq(PosExchangeLog.id, BigInt(operation.exchange.logId)));
      return state.saveOperation(
        stamp({
          ...operation,
          phase: uncertain ? 'uncertain' : 'rejected',
          uncertainStage: uncertain ? stage : null,
          errorCode,
          message,
        }),
      );
    },
  };
}
export type ReturnRepository = ReturnType<typeof returnRepository>;
