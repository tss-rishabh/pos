import { assertImportOrderMutationAvailable } from '../../legacy-order-imports/financial-adapter-proof.js';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
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
import { assertCurrentOperatorRole } from '../../administration/authorization.js';
import { requireRole, requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { enqueueInventorySynchronization } from '../../administration/inventory.js';
import type { StockProcedure } from '../../administration/stock-procedure.js';
import { returnVerificationSchema } from './verification.js';
import { readCustomerContactBinding, sameCustomerContact } from '../customer-contact-authority.js';
import type { CustomerVerificationClient } from '../customer-verification.js';
import { returnCustomerOtpScope } from './verification-state.js';
import { operationHash } from '../crypto.js';
import { financialYear } from '../finalizer.js';
import { exchangeRetryable } from '../returns.js';
import { wireId } from '../payloads.js';
import { currentRequestTrace } from '../../../observability/context.js';
import {
  returnOperationSchema,
  type ReturnInput,
  type ReturnOperation,
  type InboundReturn,
  type ReturnWindowScope,
} from './contracts.js';
import { returnOperations, returnOutbox, returnVerifications } from './schema.js';
import { exchangeOrderLog } from './exchange-ledger.js';
import { exchangeStockConfirmations, exchangeStockContract } from './stock-proof.js';
import {
  recordRejectedReturnRepair,
  lockRejectedReturnScope,
} from '../../legacy-order-status/repair-obligations.js';
export interface ReturnRepositoryOptions {
  rejectedInboundRepairDispatcherEnabled?: boolean;
  hashSecret: string;
  returnPeriodDays: number | undefined;
  inventoryProcedureVerified?: boolean;
  stockProcedure?: StockProcedure;
  customerOtp?: CustomerVerificationClient;
  assertCheckIn?: (
    userId: string,
    storeId: string,
    counterId: string,
    transaction: AdministrationTransaction,
  ) => Promise<void>;
}
export function returnRepository(db: Databases, config: Config, options: ReturnRepositoryOptions) {
  const checkIns = checkInService(db, config),
    checkIn =
      options.assertCheckIn ||
      ((user, store, counter, tx) => checkIns.assertCheckIn(user, store, counter, tx)),
    now = () => Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDateTime(),
    timestamp = () => now().toString({ smallestUnit: 'second' }).replace('T', ' ');
  // Evidence mode is confined to preserving a remote response/failed attempt.
  // Every effect/checkpoint authority retains the imported-order hold check.
  async function context(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
    lineId: string,
    counterId: string,
    purpose: 'authority' | 'evidence' = 'authority',
    relatedOrderIds: readonly string[] = [],
  ) {
    requireStore(user, storeId);
    await checkIn(user.id, storeId, counterId, tx);
    const [store] = await tx
      .select({ id: Store.id, locationCode: Store.location_code, name: Store.store_name })
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
    if (order && purpose === 'authority')
      for (const id of lockIds) await assertImportOrderMutationAvailable(tx, String(id));
    const [line] = await tx
      .select()
      .from(HasProduct)
      .where(and(eq(HasProduct.id, BigInt(lineId)), eq(HasProduct.order, BigInt(orderId))))
      .for('update');
    if (!store || !order || !line)
      throw new AppError(404, 'RETURN_LINE_NOT_FOUND', 'Return line was not found.');
    return { store, order, line };
  }
  async function verifiedCustomer(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
    counterId: string,
    verificationId: string,
    customerId: string,
  ) {
    const [session] = await tx
      .select({ state: returnVerifications.state })
      .from(returnVerifications)
      .where(eq(returnVerifications.id, verificationId))
      .limit(1)
      .for('update');
    const proof = session ? returnVerificationSchema.parse(session.state) : null;
    if (
      !proof ||
      proof.operatorId !== user.id ||
      proof.storeId !== storeId ||
      proof.orderId !== orderId ||
      proof.customerId !== customerId ||
      proof.counterId !== counterId ||
      !proof.verifiedUntil ||
      proof.verifiedUntil <= Date.now()
    )
      throw new AppError(
        403,
        'RETURN_CUSTOMER_VERIFICATION_REQUIRED',
        'Verify the order customer in this store before accepting a return.',
      );
    if (!sameCustomerContact(proof.contact, await readCustomerContactBinding(tx, proof.customerId)))
      throw new AppError(
        403,
        'RETURN_CUSTOMER_VERIFICATION_REQUIRED',
        'Customer contact changed. Verify the order customer again before accepting a return.',
      );
    if (options.customerOtp || proof.requestOperationId) {
      if (
        !options.customerOtp?.assertVerified ||
        !proof.requestOperationId ||
        !proof.otpChallengeId ||
        !proof.contact
      )
        throw new AppError(
          503,
          'CUSTOMER_OTP_UNAVAILABLE',
          'The purpose-bound customer proof must be verified before accepting a return.',
        );
      await options.customerOtp.assertVerified(
        tx,
        user,
        returnCustomerOtpScope(proof),
        proof.otpChallengeId,
        proof.contact,
        proof.verifiedUntil,
      );
    }
  }
  async function owned(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    id: string,
    purpose: 'authority' | 'evidence' = 'authority',
  ) {
    const [first] = await tx
      .select({ state: returnOperations.state })
      .from(returnOperations)
      .where(and(eq(returnOperations.id, id), eq(returnOperations.storeId, storeId)))
      .limit(1);
    if (!first)
      throw new AppError(404, 'RETURN_OPERATION_NOT_FOUND', 'Return operation was not found.');
    const initial = returnOperationSchema.parse(first.state),
      scope = await context(
        tx,
        user,
        storeId,
        initial.orderId,
        initial.lineId,
        initial.input.counterId,
        purpose,
        initial.exchange?.childOrderId ? [initial.exchange.childOrderId] : [],
      );
    const [locked] = await tx
      .select({ state: returnOperations.state })
      .from(returnOperations)
      .where(eq(returnOperations.id, id))
      .for('update');
    if (!locked)
      throw new AppError(404, 'RETURN_OPERATION_NOT_FOUND', 'Return operation was not found.');
    const operation = returnOperationSchema.parse(locked.state);
    if (
      operation.orderId !== initial.orderId ||
      operation.lineId !== initial.lineId ||
      operation.input.counterId !== initial.input.counterId ||
      operation.exchange?.childOrderId !== initial.exchange?.childOrderId
    )
      throw new AppError(
        409,
        'RETURN_OPERATION_CHANGED',
        'The return operation changed while its orders were being locked. Read its original status before continuing.',
      );
    return { operation, ...scope };
  }
  async function save(tx: AdministrationTransaction, operation: ReturnOperation) {
    const next = { ...operation, updatedAt: timestamp() };
    await tx
      .update(returnOperations)
      .set({ phase: next.phase, state: next, updatedAt: next.updatedAt })
      .where(eq(returnOperations.id, next.id));
    return next;
  }
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
          .where(eq(HoldStockStore.id, current.id));
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
  async function exchangeSelection(
    tx: AdministrationTransaction,
    scope: Awaited<ReturnType<typeof context>>,
    selection: { replacementProductId: string; salespersonId: string },
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
    if (
      !original ||
      original.parent <= 0n ||
      !replacement ||
      replacement.parent !== original.parent ||
      BigInt(replacement.stock) < scope.line.qty
    )
      throw new AppError(
        409,
        'EXCHANGE_SIZE_UNAVAILABLE',
        'Choose an available size of the same product.',
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
        'Choose an active salesperson at this store.',
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
      labels = new Map(sizes.map((size) => [String(size.product), size.value]));
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
      oldSize: labels.get(String(original.id)) ?? null,
      salespersonId: selection.salespersonId,
    };
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
        'This exchange no longer has a confirmed return leg at this store.',
      );
  }
  async function assertNoReplacementChild(
    tx: AdministrationTransaction,
    operation: Pick<ReturnOperation, 'orderId' | 'lineId' | 'createdAt'>,
    allOrphans = false,
  ) {
    const alive = or(isNull(Order.order_statuses), notInArray(Order.order_statuses, [4n, 22n]));
    const [linked] = await tx
      .select({ id: exchangeOrderLog.id })
      .from(exchangeOrderLog)
      .innerJoin(Order, eq(Order.id, exchangeOrderLog.orderId))
      .where(
        and(
          eq(exchangeOrderLog.parentOrderId, BigInt(operation.orderId)),
          eq(exchangeOrderLog.parentLineId, BigInt(operation.lineId)),
          alive,
        ),
      )
      .limit(1);
    const [orphan] = await tx
      .select({ id: Order.id })
      .from(Order)
      .leftJoin(exchangeOrderLog, eq(exchangeOrderLog.orderId, Order.id))
      .where(
        and(
          eq(Order.parent_order_id, BigInt(operation.orderId)),
          allOrphans ? undefined : gte(Order.created_at, operation.createdAt),
          isNull(exchangeOrderLog.id),
          alive,
        ),
      )
      .limit(1);
    if (linked || orphan)
      throw new AppError(
        409,
        'EXCHANGE_CHILD_RECONCILIATION_REQUIRED',
        'A replacement child already exists or is incomplete. Reconcile it before continuing.',
      );
  }
  async function stockProof(
    tx: AdministrationTransaction,
    operation: ReturnOperation,
    childId: bigint,
    lineId: bigint,
  ) {
    const [proof] = await tx
      .select({ id: exchangeStockConfirmations.orderId })
      .from(exchangeStockConfirmations)
      .where(
        and(
          eq(exchangeStockConfirmations.orderId, childId),
          eq(exchangeStockConfirmations.parentOrderId, BigInt(operation.orderId)),
          eq(exchangeStockConfirmations.parentLineId, BigInt(operation.lineId)),
          eq(exchangeStockConfirmations.lineId, lineId),
          eq(exchangeStockConfirmations.storeId, BigInt(operation.storeId)),
          eq(exchangeStockConfirmations.counterId, BigInt(operation.input.counterId)),
          eq(exchangeStockConfirmations.productId, BigInt(operation.exchange!.newProductId)),
          eq(exchangeStockConfirmations.quantity, BigInt(operation.quantity)),
          eq(exchangeStockConfirmations.contractVersion, exchangeStockContract),
        ),
      )
      .limit(1);
    return Boolean(proof);
  }
  async function completedProof(
    tx: AdministrationTransaction,
    operation: ReturnOperation,
    childId: bigint,
    lineId: bigint,
    parentStatus: string | null,
    childStatus: bigint | null,
    lineStatus: string | null,
  ) {
    if (parentStatus !== 'EXCHANGE_COMPLETED' || childStatus !== 3n || lineStatus !== 'DELIVERED')
      return false;
    const [link] = await tx
      .select({ id: exchangeOrderLog.id })
      .from(exchangeOrderLog)
      .where(
        and(
          eq(exchangeOrderLog.parentOrderId, BigInt(operation.orderId)),
          eq(exchangeOrderLog.parentLineId, BigInt(operation.lineId)),
          eq(exchangeOrderLog.orderId, childId),
          eq(exchangeOrderLog.lineId, lineId),
        ),
      )
      .limit(1);
    const [ledger] = await tx
      .select({ id: PosTransactionLog.id })
      .from(PosTransactionLog)
      .where(
        and(
          eq(PosTransactionLog.order_id, childId),
          eq(PosTransactionLog.store_id, BigInt(operation.storeId)),
          eq(PosTransactionLog.payment_status, 4n),
          eq(PosTransactionLog.order_status, 3n),
        ),
      )
      .limit(1);
    return Boolean(link && ledger);
  }
  return {
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
      await verifiedCustomer(
        tx,
        user,
        storeId,
        orderId,
        input.counterId,
        input.verificationId,
        String(scope.order.customerId),
      );
      const active = await tx
        .select({ id: returnOperations.id })
        .from(returnOperations)
        .where(and(eq(returnOperations.lineId, lineId), ne(returnOperations.phase, 'rejected')))
        .limit(1)
        .for('update');
      if (active.length)
        throw new AppError(
          409,
          'RETURN_ALREADY_ACTIVE',
          'An earlier return or exchange for this line needs review.',
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
    async begin(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ReturnInput,
      exchange?: { replacementProductId: string; salespersonId: string },
    ) {
      return db.get('writer').transaction(async (tx) => {
        if (input.saleable && !options.inventoryProcedureVerified)
          throw new AppError(
            503,
            'RETURN_INVENTORY_UNVERIFIED',
            'The deployed inventory procedure must be verified before restoring saleable stock.',
          );
        if (options.returnPeriodDays === undefined)
          throw new AppError(503, 'RETURN_POLICY_UNAVAILABLE', 'Return policy is not configured.');
        if (input.overrideEligibility) requireRole(user, [1]);
        const scope = await context(tx, user, storeId, orderId, lineId, input.counterId),
          hash = operationHash(
            exchange ? 'exchange.create' : 'return.create',
            { storeId, orderId, lineId, input, ...(exchange ? { exchange } : {}) },
            options.hashSecret,
          );
        const [previous] = await tx
          .select({ state: returnOperations.state })
          .from(returnOperations)
          .where(eq(returnOperations.id, input.operationId))
          .for('update');
        if (previous) {
          const operation = returnOperationSchema.parse(previous.state);
          if (
            operation.storeId !== storeId ||
            operation.orderId !== orderId ||
            operation.lineId !== lineId ||
            operation.operatorId !== user.id ||
            operation.requestHash !== hash
          )
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This return key was used with different data.',
            );
          return { operation, replay: true };
        }
        if (scope.line.status !== 'DELIVERED' || scope.line.return_status !== 0)
          throw new AppError(
            409,
            'RETURN_LINE_INELIGIBLE',
            'This line is no longer available for a new return.',
          );
        const [active] = await tx
          .select({ id: returnOperations.id })
          .from(returnOperations)
          .where(and(eq(returnOperations.lineId, lineId), ne(returnOperations.phase, 'rejected')))
          .limit(1);
        if (active)
          throw new AppError(
            409,
            'RETURN_ALREADY_ACTIVE',
            'An earlier return for this line needs review.',
          );
        await verifiedCustomer(
          tx,
          user,
          storeId,
          orderId,
          input.counterId,
          input.verificationId,
          String(scope.order.customerId),
        );
        const [delivery] = await tx
            .select({ date: Comments.created_at })
            .from(Comments)
            .where(and(eq(Comments.order_id, BigInt(orderId)), eq(Comments.status_id, 3n)))
            .orderBy(desc(Comments.created_at))
            .limit(1),
          [extension] = await tx
            .select({ date: ExtendApplicabilityForReturnExchange.extended_date })
            .from(ExtendApplicabilityForReturnExchange)
            .where(
              and(
                eq(ExtendApplicabilityForReturnExchange.order_id, BigInt(orderId)),
                eq(ExtendApplicabilityForReturnExchange.prod_id, scope.line.product),
                eq(ExtendApplicabilityForReturnExchange.has_product_id, BigInt(lineId)),
                eq(ExtendApplicabilityForReturnExchange.is_active, true),
              ),
            )
            .limit(1);
        if (!delivery)
          throw new AppError(
            409,
            'RETURN_DELIVERY_UNCONFIRMED',
            'No delivered record exists for this order.',
          );
        const deliveryAge = Temporal.PlainDateTime.from(delivery.date.replace(' ', 'T'))
            .until(now())
            .total('days'),
          extended =
            extension &&
            Temporal.PlainDateTime.compare(
              Temporal.PlainDateTime.from(extension.date.replace(' ', 'T')),
              now(),
            ) >= 0;
        if (
          Math.floor(deliveryAge) > options.returnPeriodDays &&
          !extended &&
          !input.overrideEligibility
        )
          throw new AppError(
            409,
            'RETURN_WINDOW_CLOSED',
            'This line is outside the return window.',
          );
        const [refundable] = await tx
          .select({ id: AmountToBeRefundedLog.id })
          .from(AmountToBeRefundedLog)
          .where(
            and(
              eq(AmountToBeRefundedLog.order_id, BigInt(orderId)),
              eq(AmountToBeRefundedLog.prod_id, scope.line.product),
              eq(AmountToBeRefundedLog.has_product_id, BigInt(lineId)),
              eq(AmountToBeRefundedLog.is_refunded, false),
            ),
          )
          .limit(1)
          .for('update');
        if (!refundable)
          throw new AppError(
            409,
            'RETURN_ALREADY_REFUNDED',
            'This line has no unrefunded ledger amount.',
          );
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
          throw new AppError(422, 'RETURN_REASON_UNAVAILABLE', 'Select a supported return reason.');
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
          await assertNoReplacementChild(tx, { orderId, lineId, createdAt: date }, true);
          const selected = await exchangeSelection(tx, scope, exchange);
          if (
            [
              orderId,
              lineId,
              storeId,
              String(scope.line.product),
              selected.newProductId,
              selected.parentProductId,
              user.id,
              exchange.salespersonId,
            ].some((value) => BigInt(value) > 2147483647n)
          )
            throw new AppError(
              409,
              'EXCHANGE_IDENTIFIER_UNSUPPORTED',
              'This exchange exceeds the supported legacy ledger identifiers.',
            );
          const [legacy] = await tx
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
          if (legacy) {
            if (legacy.status === 'SUCCESS')
              throw new AppError(
                409,
                'EXCHANGE_ALREADY_COMPLETED',
                'This line was already exchanged.',
              );
            const [credit] = await tx
              .select({ id: ReturnOrder.id })
              .from(ReturnOrder)
              .where(
                and(
                  eq(ReturnOrder.order_id, BigInt(orderId)),
                  eq(ReturnOrder.has_product_id, BigInt(lineId)),
                  eq(ReturnOrder.store_id, legacy.store_id),
                  gte(ReturnOrder.created_at, legacy.created_at),
                  ne(ReturnOrder.credit_note_no, ''),
                ),
              )
              .limit(1);
            if (
              credit ||
              (legacy.status === 'PENDING' &&
                Temporal.PlainDateTime.from(legacy.updated_at.replace(' ', 'T'))
                  .until(now())
                  .total('minutes') < 10)
            )
              throw new AppError(
                409,
                'LEGACY_EXCHANGE_REVIEW_REQUIRED',
                'An earlier exchange for this line needs reconciliation.',
              );
          }
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
            new_order_id: null,
            status: 'PENDING',
            retry_count: legacy?.retry_count || 0,
            last_error: null,
            updated_at: date,
          };
          if (legacy)
            await tx.update(PosExchangeLog).set(values).where(eq(PosExchangeLog.id, legacy.id));
          else await tx.insert(PosExchangeLog).values({ ...values, created_at: date });
          const [log] = await tx
            .select({ id: PosExchangeLog.id })
            .from(PosExchangeLog)
            .where(
              and(
                eq(PosExchangeLog.order_id, Number(orderId)),
                eq(PosExchangeLog.has_prod_id, Number(lineId)),
              ),
            )
            .orderBy(asc(PosExchangeLog.id))
            .limit(1);
          if (!log)
            throw new AppError(
              503,
              'EXCHANGE_LEDGER_UNAVAILABLE',
              'The exchange ledger could not be recorded.',
            );
          exchangeState = { ...selected, logId: String(log.id), childOrderId: null };
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
          input,
          requestHash: hash,
          phase: 'inbound-dispatching',
          uncertainStage: null,
          creditNote: null,
          returnAmount: null,
          errorCode: null,
          createdAt: date,
          updatedAt: date,
        };
        await tx.insert(returnOperations).values({
          id: operation.id,
          lineId,
          storeId,
          phase: operation.phase,
          state: operation,
          createdAt: date,
          updatedAt: date,
        });
        return { operation, replay: false };
      });
    },
    async inboundData(user: Principal, storeId: string, id: string): Promise<InboundReturn> {
      return db.get('writer').transaction(async (tx) => {
        const { operation, store, order, line } = await owned(tx, user, storeId, id),
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
    async accepted(user: Principal, storeId: string, id: string) {
      return db.get('writer').transaction(async (tx) => {
        const { operation, store, line } = await owned(tx, user, storeId, id);
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
          orderStatus = lines
            .filter((row) => row.id !== line.id)
            .every((row) => ['PRODUCT_RETURNED', 'EXCHANGE_COMPLETED'].includes(row.status || ''))
            ? 6
            : 37;
        const fy = financialYear(timestamp()),
          [last] = await tx
            .select({ number: ReturnOrder.credit_note_no })
            .from(ReturnOrder)
            .where(
              and(
                eq(ReturnOrder.store_id, Number(storeId)),
                or(
                  like(ReturnOrder.credit_note_no, `${store.locationCode}/${fy}/CN/%`),
                  like(ReturnOrder.credit_note_no, `${store.locationCode}${fy}CN%`),
                ),
              ),
            )
            .orderBy(desc(ReturnOrder.credit_note_no))
            .limit(1)
            .for('update'),
          sequence = last?.number ? Number(/(\d+)$/.exec(last.number)?.[1] || 0) + 1 : 1,
          creditNote = `${store.locationCode}${fy}CN${String(sequence).padStart(5, '0')}`,
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
        return save(tx, { ...operation, phase: 'inbound-accepted', creditNote });
      });
    },
    async claimRefund(user: Principal, storeId: string, id: string) {
      return db.get('writer').transaction(async (tx) => {
        const { operation, order } = await owned(tx, user, storeId, id);
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
        return save(tx, { ...operation, phase: 'refund-dispatching' });
      });
    },
    async refundConfirmed(user: Principal, storeId: string, id: string, returnAmount: string) {
      return db.get('writer').transaction(async (tx) => {
        const { operation } = await owned(tx, user, storeId, id, 'evidence');
        if (operation.phase !== 'refund-dispatching')
          throw new AppError(
            409,
            'RETURN_PHASE_CHANGED',
            'The return phase changed. Review its current status.',
          );
        return save(tx, { ...operation, phase: 'refund-confirmed', returnAmount });
      });
    },
    async complete(user: Principal, storeId: string, id: string) {
      return db.get('writer').transaction(async (tx) => {
        const { operation, store } = await owned(tx, user, storeId, id);
        if (operation.kind !== 'return')
          throw new AppError(409, 'RETURN_KIND_MISMATCH', 'This operation is not a refund return.');
        if (operation.phase === 'completed') return operation;
        if (operation.phase !== 'refund-confirmed' || operation.returnAmount === null)
          throw new AppError(
            409,
            'RETURN_REFUND_UNCONFIRMED',
            'The refund must be confirmed before returning stock.',
          );
        await restore(tx, user, operation);
        const [ledger] = await tx
            .select()
            .from(AmountToBeRefundedLog)
            .where(
              and(
                eq(AmountToBeRefundedLog.order_id, BigInt(operation.orderId)),
                eq(AmountToBeRefundedLog.prod_id, BigInt(operation.productId)),
                eq(AmountToBeRefundedLog.has_product_id, BigInt(operation.lineId)),
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
        const date = timestamp();
        await tx.insert(PosTransactionLog).values({
          order_id: BigInt(operation.orderId),
          store_id: BigInt(storeId),
          order_status: order.status ?? 0n,
          payment_status: order.paymentStatus ?? 0n,
          user_id: 0n,
          pos_user_id: BigInt(user.id),
          pay_dict: JSON.stringify({
            'tss point refunded': ledger.tss_point_used,
            'tss money refunded': ledger.tss_money_used,
            'gift voucher amount refunded': ledger.gift_voucher_amount,
            [operation.input.refundMode === 'cash'
              ? 'pay amt refunded into cash'
              : 'pay amt refunded into tss money']: Number(operation.returnAmount),
            'total amount refunded': ledger.amount_to_be_refunded + ledger.tss_point_used,
          }),
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
        await tx.insert(returnOutbox).values({
          id: operation.id,
          kind: 'return-email',
          orderId: operation.orderId,
          storeId,
          productId: operation.productId,
          lineId: operation.lineId,
          status: 'pending',
          requestId: currentRequestTrace()?.requestId || null,
          operatorId: user.id,
          createdAt: date,
        });
        return save(tx, { ...operation, phase: 'completed', errorCode: null });
      });
    },
    async restoreExchange(user: Principal, storeId: string, id: string) {
      return db.get('writer').transaction(async (tx) => {
        const { operation, line } = await owned(tx, user, storeId, id);
        if (operation.kind !== 'exchange' || !operation.exchange)
          throw new AppError(409, 'EXCHANGE_NOT_FOUND', 'This operation is not an exchange.');
        if (operation.phase === 'old-item-restored') return operation;
        if (operation.phase !== 'inbound-accepted')
          throw new AppError(
            409,
            'EXCHANGE_PHASE_CHANGED',
            'This exchange is not ready for stock restoration.',
          );
        await phaseOneProof(tx, operation, line.status);
        await restore(tx, user, operation);
        return save(tx, { ...operation, phase: 'old-item-restored' });
      });
    },
    async claimReplacement(
      user: Principal,
      storeId: string,
      id: string,
      retrySalespersonId?: string,
    ) {
      return db.get('writer').transaction(async (tx) => {
        const scope = await owned(tx, user, storeId, id),
          operation = scope.operation;
        if (
          operation.kind !== 'exchange' ||
          !operation.exchange ||
          !['old-item-restored', 'replacement-rejected'].includes(operation.phase)
        )
          throw new AppError(
            409,
            'EXCHANGE_REVIEW_REQUIRED',
            'This exchange requires reconciliation before a replacement request can be made.',
          );
        await phaseOneProof(tx, operation, scope.line.status);
        await assertNoReplacementChild(tx, operation);
        const selected = await exchangeSelection(tx, scope, {
          replacementProductId: operation.exchange.newProductId,
          salespersonId: retrySalespersonId || operation.exchange.salespersonId,
        });
        if (
          selected.newSize !== operation.exchange.newSize ||
          selected.parentProductId !== operation.exchange.parentProductId
        )
          throw new AppError(
            409,
            'EXCHANGE_PRODUCT_CHANGED',
            'The stored replacement size changed. Review this exchange.',
          );
        const [log] = await tx
          .select({ retryCount: PosExchangeLog.retry_count })
          .from(PosExchangeLog)
          .where(eq(PosExchangeLog.id, BigInt(operation.exchange.logId)))
          .limit(1)
          .for('update');
        if (!log || log.retryCount >= 65535)
          throw new AppError(
            409,
            'EXCHANGE_LEDGER_UNAVAILABLE',
            'The exchange tracking record is unavailable.',
          );
        await tx
          .update(PosExchangeLog)
          .set({
            status: 'PENDING',
            staff_user_id: Number(user.id),
            retry_count: log.retryCount + (operation.phase === 'replacement-rejected' ? 1 : 0),
            last_error: null,
            updated_at: timestamp(),
          })
          .where(eq(PosExchangeLog.id, BigInt(operation.exchange.logId)));
        return save(tx, {
          ...operation,
          exchange: { ...operation.exchange, salespersonId: selected.salespersonId },
          phase: 'replacement-dispatching',
          uncertainStage: null,
          errorCode: null,
        });
      });
    },
    async replacementConfirmed(user: Principal, storeId: string, id: string, childOrderId: string) {
      return db.get('writer').transaction(async (tx) => {
        const { operation } = await owned(tx, user, storeId, id, 'evidence');
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
        await tx
          .update(PosExchangeLog)
          .set({
            new_order_id: BigInt(childOrderId) <= 2147483647n ? Number(childOrderId) : null,
            updated_at: timestamp(),
          })
          .where(eq(PosExchangeLog.id, BigInt(operation.exchange.logId)));
        return save(tx, {
          ...operation,
          phase: 'replacement-confirmed',
          exchange: { ...operation.exchange, childOrderId },
        });
      });
    },
    async reconcileReplacement(user: Principal, storeId: string, id: string) {
      return db.get('writer').transaction(async (tx) => {
        const { operation, line } = await owned(tx, user, storeId, id);
        if (operation.kind !== 'exchange' || !operation.exchange)
          throw new AppError(404, 'EXCHANGE_NOT_FOUND', 'Exchange was not found.');
        if (['completed', 'replacement-confirmed'].includes(operation.phase)) return operation;
        if (
          !(operation.phase === 'uncertain' && operation.uncertainStage === 'replacement') &&
          operation.phase !== 'replacement-rejected'
        )
          throw new AppError(
            409,
            'EXCHANGE_REVIEW_REQUIRED',
            'This exchange is not awaiting replacement reconciliation.',
          );
        await phaseOneProof(tx, operation, line.status, true);
        const rows = await tx
          .select({
            childId: Order.id,
            parentId: Order.parent_order_id,
            customerId: Order.user,
            paymentStatus: Order.payment_statuses,
            method: Order.payment_methods,
            payable: Order.pay_amt,
            status: Order.order_statuses,
            storeId: OrderStore.store,
            counterId: OrderStore.counter,
            lineId: HasProduct.id,
            productId: HasProduct.product,
            quantity: HasProduct.qty,
            lineStatus: HasProduct.status,
            childCreatedAt: Order.created_at,
          })
          .from(exchangeOrderLog)
          .innerJoin(Order, eq(Order.id, exchangeOrderLog.orderId))
          .leftJoin(OrderStore, eq(OrderStore.order, Order.id))
          .leftJoin(HasProduct, eq(HasProduct.id, exchangeOrderLog.lineId))
          .where(
            and(
              eq(exchangeOrderLog.parentOrderId, BigInt(operation.orderId)),
              eq(exchangeOrderLog.parentLineId, BigInt(operation.lineId)),
              or(isNull(Order.order_statuses), notInArray(Order.order_statuses, [4n, 22n])),
            ),
          )
          .orderBy(desc(Order.id))
          .limit(3)
          .for('update');
        if (rows.length !== 1) return operation;
        const child = rows[0]!;
        await assertImportOrderMutationAvailable(tx, String(child.childId));
        if (
          child.parentId !== BigInt(operation.orderId) ||
          String(child.customerId) !== operation.customerId ||
          child.storeId !== BigInt(storeId) ||
          child.counterId !== BigInt(operation.input.counterId) ||
          String(child.productId) !== operation.exchange.newProductId ||
          child.quantity !== BigInt(operation.quantity) ||
          child.childCreatedAt < operation.createdAt
        )
          return operation;
        if (
          child.paymentStatus !== 4n ||
          child.method !== 3n ||
          child.payable !== 0 ||
          ![1n, 3n].includes(child.status || 0n) ||
          !['PLACED', 'DELIVERED'].includes(child.lineStatus || '') ||
          !child.lineId
        )
          return operation;
        if (
          !(await stockProof(tx, operation, child.childId, child.lineId)) &&
          !(await completedProof(
            tx,
            operation,
            child.childId,
            child.lineId,
            line.status,
            child.status,
            child.lineStatus,
          ))
        )
          return operation;
        const [allocation] = await tx
          .select({ id: AmountToBeRefundedLog.id })
          .from(AmountToBeRefundedLog)
          .where(
            and(
              eq(AmountToBeRefundedLog.order_id, child.childId),
              eq(AmountToBeRefundedLog.has_product_id, child.lineId),
              eq(AmountToBeRefundedLog.prod_id, BigInt(operation.exchange.newProductId)),
              eq(AmountToBeRefundedLog.is_refunded, false),
            ),
          )
          .limit(1);
        const lines = await tx
          .select({ id: HasProduct.id })
          .from(HasProduct)
          .where(eq(HasProduct.order, child.childId))
          .limit(2);
        if (!allocation || lines.length !== 1) return operation;
        await tx
          .update(PosExchangeLog)
          .set({
            new_order_id: child.childId <= 2147483647n ? Number(child.childId) : null,
            updated_at: timestamp(),
          })
          .where(eq(PosExchangeLog.id, BigInt(operation.exchange.logId)));
        return save(tx, {
          ...operation,
          phase: 'replacement-confirmed',
          uncertainStage: null,
          errorCode: null,
          exchange: { ...operation.exchange, childOrderId: String(child.childId) },
        });
      });
    },
    async replacementFailure(
      user: Principal,
      storeId: string,
      id: string,
      uncertain: boolean,
      errorCode: string,
    ) {
      return db.get('writer').transaction(async (tx) => {
        const { operation } = await owned(tx, user, storeId, id, 'evidence');
        if (operation.kind !== 'exchange' || !operation.exchange)
          throw new AppError(409, 'EXCHANGE_NOT_FOUND', 'This operation is not an exchange.');
        if (
          ['completed', 'replacement-confirmed', 'old-item-restored', 'inbound-accepted'].includes(
            operation.phase,
          )
        )
          return operation;
        await tx
          .update(PosExchangeLog)
          .set({
            status: 'FAILED_NEEDS_MANUAL_FIX',
            last_error: errorCode,
            updated_at: timestamp(),
          })
          .where(eq(PosExchangeLog.id, BigInt(operation.exchange.logId)));
        return save(tx, {
          ...operation,
          phase: uncertain ? 'uncertain' : 'replacement-rejected',
          uncertainStage: uncertain ? 'replacement' : null,
          errorCode,
        });
      });
    },
    async assertExchangeFinalizationAvailable(user: Principal, storeId: string, id: string) {
      return db.get('writer').transaction(async (tx) => {
        const { operation } = await owned(tx, user, storeId, id);
        const childId = operation.exchange?.childOrderId;
        if (operation.kind !== 'exchange' || !childId)
          throw new AppError(
            409,
            'EXCHANGE_CHILD_UNCONFIRMED',
            'The replacement order has not been confirmed.',
          );
        // owned() already holds both orders in ID order and checks both holds.
        // The actual finalizer repeats this boundary in its mutation transaction.
      });
    },
    async completeExchange(user: Principal, storeId: string, id: string) {
      return db.get('writer').transaction(async (tx) => {
        const { operation, line, order } = await owned(tx, user, storeId, id);
        if (operation.kind !== 'exchange' || !operation.exchange)
          throw new AppError(409, 'EXCHANGE_NOT_FOUND', 'This operation is not an exchange.');
        if (operation.phase === 'completed') return operation;
        const exchange = operation.exchange,
          childId = exchange.childOrderId;
        if (operation.phase !== 'replacement-confirmed' || !childId)
          throw new AppError(
            409,
            'EXCHANGE_CHILD_UNCONFIRMED',
            'The replacement order must be confirmed first.',
          );
        await phaseOneProof(tx, operation, line.status, true);
        if (BigInt(childId) > 2147483647n)
          throw new AppError(
            409,
            'EXCHANGE_IDENTIFIER_UNSUPPORTED',
            'This replacement order exceeds the supported legacy ledger identifiers.',
          );
        const [child] = await tx
            .select({
              id: Order.id,
              parentId: Order.parent_order_id,
              customerId: Order.user,
              status: Order.order_statuses,
              wallet: Order.tss_money_used,
              paymentStatus: Order.payment_statuses,
              method: Order.payment_methods,
              payable: Order.pay_amt,
            })
            .from(OrderStore)
            .innerJoin(Order, eq(Order.id, OrderStore.order))
            .where(
              and(
                eq(OrderStore.order, BigInt(childId)),
                eq(OrderStore.store, BigInt(storeId)),
                eq(OrderStore.counter, BigInt(operation.input.counterId)),
              ),
            )
            .limit(1)
            .for('update'),
          childLines = await tx
            .select({
              id: HasProduct.id,
              productId: HasProduct.product,
              quantity: HasProduct.qty,
              status: HasProduct.status,
            })
            .from(HasProduct)
            .where(eq(HasProduct.order, BigInt(childId)))
            .orderBy(asc(HasProduct.id))
            .for('update');
        if (child) await assertImportOrderMutationAvailable(tx, String(child.id));
        const replacement = childLines.find(
          (row) =>
            String(row.productId) === exchange.newProductId &&
            row.quantity === BigInt(operation.quantity),
        );
        if (
          !child ||
          child.parentId !== BigInt(operation.orderId) ||
          String(child.customerId) !== operation.customerId ||
          !replacement
        )
          throw new AppError(
            409,
            'EXCHANGE_CHILD_SCOPE_MISMATCH',
            'The replacement order does not match this exchange.',
          );
        if (child.paymentStatus !== 4n || child.method !== 3n || child.payable !== 0)
          throw new AppError(
            409,
            'EXCHANGE_PAYMENT_UNCONFIRMED',
            'The replacement payment is still being confirmed. Check its status before handover.',
          );
        if (
          ![1n, 3n].includes(child.status || 0n) ||
          !['PLACED', 'DELIVERED'].includes(replacement.status || '')
        )
          throw new AppError(
            409,
            'EXCHANGE_CHILD_STATE_CHANGED',
            'The replacement state changed. Review its status before handover.',
          );
        if (
          childLines.length !== 1 ||
          (!(await stockProof(tx, operation, child.id, replacement.id)) &&
            !(await completedProof(
              tx,
              operation,
              child.id,
              replacement.id,
              line.status,
              child.status,
              replacement.status,
            )))
        )
          throw new AppError(
            503,
            'EXCHANGE_STOCK_UNCONFIRMED',
            'Replacement inventory confirmation is unavailable. Keep this reference and check again before handover.',
          );
        const [allocation] = await tx
          .select({ id: AmountToBeRefundedLog.id })
          .from(AmountToBeRefundedLog)
          .where(
            and(
              eq(AmountToBeRefundedLog.order_id, child.id),
              eq(AmountToBeRefundedLog.has_product_id, replacement.id),
              eq(AmountToBeRefundedLog.prod_id, replacement.productId),
              eq(AmountToBeRefundedLog.is_refunded, false),
            ),
          )
          .limit(1)
          .for('update');
        if (!allocation)
          throw new AppError(
            503,
            'EXCHANGE_REFUND_ALLOCATION_UNCONFIRMED',
            'Replacement refund allocation is not confirmed. Keep this reference and check again before handover.',
          );
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
        const date = timestamp(),
          alreadyFinished = child.status === 3n;
        await tx.update(Order).set({ order_statuses: 3n }).where(eq(Order.id, child.id));
        await tx
          .update(HasProduct)
          .set({ status: status.name, salesperson_id: Number(exchange.salespersonId) })
          .where(eq(HasProduct.order, child.id));
        await tx
          .update(HasProduct)
          .set({ status: 'EXCHANGE_COMPLETED' })
          .where(eq(HasProduct.id, line.id));
        if (!alreadyFinished) {
          await tx.insert(Comments).values({
            order_id: child.id,
            status_id: 3n,
            comment: `Store Order: ${status.name} status changed by pos admin (exchange).`,
            notify: 0,
            user_id: BigInt(user.id),
            package_details: '',
            has_product_id: replacement.id,
            prod_id: BigInt(exchange.newProductId),
            created_at: date,
            updated_at: date,
          });
          const pay = { 'tss money used': child.wallet, 'total amount on counter': 0 };
          await tx.insert(PosTransactionLog).values([
            {
              order_id: BigInt(operation.orderId),
              store_id: BigInt(storeId),
              order_status: order.status ?? 0n,
              payment_status: order.paymentStatus ?? 0n,
              user_id: 0n,
              pos_user_id: BigInt(user.id),
              pay_dict: JSON.stringify({
                ...pay,
                'has_product id': Number(operation.lineId),
                'sku id': Number(operation.productId),
              }),
              comment: `Exchanged : TSS Money Used ${child.wallet} (New order ${childId} created)`,
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
              pay_dict: JSON.stringify(pay),
              comment: `Order Delivered : TSS Money Used ${child.wallet} (Exchange from order ${operation.orderId})`,
              created_at: date,
              updated_at: date,
            },
          ]);
          await tx.insert(returnOutbox).values({
            id: operation.id,
            kind: 'exchange-email',
            orderId: childId,
            storeId,
            productId: exchange.newProductId,
            lineId: String(replacement.id),
            status: 'pending',
            requestId: currentRequestTrace()?.requestId || null,
            operatorId: user.id,
            createdAt: date,
          });
        }
        const [parentAddon] = await tx
            .select({ checked: OrderAddon.is_nps_notification_checked })
            .from(OrderAddon)
            .where(eq(OrderAddon.order_id, BigInt(operation.orderId)))
            .limit(1),
          [childAddon] = await tx
            .select({ id: OrderAddon.id })
            .from(OrderAddon)
            .where(eq(OrderAddon.order_id, BigInt(childId)))
            .limit(1)
            .for('update'),
          addon = {
            shipped_location: 'MW1',
            is_nps_mail_sent: 0,
            is_nps_notification_checked: parentAddon ? parentAddon.checked : 0,
          };
        if (childAddon)
          await tx.update(OrderAddon).set(addon).where(eq(OrderAddon.id, childAddon.id));
        else
          await tx.insert(OrderAddon).values({
            ...addon,
            order_id: BigInt(childId),
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
        return save(tx, {
          ...operation,
          phase: 'completed',
          errorCode: null,
          uncertainStage: null,
        });
      });
    },
    async read(user: Principal, storeId: string, id: string) {
      return db
        .get('writer')
        .transaction(async (tx) => (await owned(tx, user, storeId, id)).operation);
    },
    async failure(
      user: Principal,
      storeId: string,
      id: string,
      stage: 'inbound' | 'refund',
      uncertain: boolean,
      errorCode: string,
    ) {
      return db.get('writer').transaction(async (tx) => {
        const definite =
          stage === 'inbound' && !uncertain && errorCode === 'RETURN_INBOUND_REJECTED';
        let operation: ReturnOperation;
        if (definite) {
          const [initial] = await tx
            .select({ state: returnOperations.state })
            .from(returnOperations)
            .where(eq(returnOperations.id, id))
            .limit(1);
          if (!initial)
            throw new AppError(
              404,
              'RETURN_OPERATION_NOT_FOUND',
              'Return operation was not found.',
            );
          const initialOperation = returnOperationSchema.parse(initial.state);
          if (initialOperation.operatorId !== user.id || initialOperation.storeId !== storeId)
            throw new AppError(
              403,
              'RETURN_OPERATION_OWNER_CHANGED',
              'The retained return owner changed.',
            );
          await lockRejectedReturnScope(tx, user.id, storeId, initialOperation.orderId);
          const [row] = await tx
            .select()
            .from(returnOperations)
            .where(eq(returnOperations.id, id))
            .limit(1)
            .for('update');
          operation = returnOperationSchema.parse(row?.state);
          if (
            operation.id !== id ||
            operation.operatorId !== user.id ||
            operation.storeId !== storeId
          )
            throw new AppError(
              403,
              'RETURN_OPERATION_OWNER_CHANGED',
              'The retained return owner changed.',
            );
          if (
            !['inbound-dispatching', 'rejected'].includes(operation.phase) ||
            (operation.phase === 'rejected' && operation.errorCode !== 'RETURN_INBOUND_REJECTED')
          )
            return operation;
        } else operation = (await owned(tx, user, storeId, id, 'evidence')).operation;
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
          await tx
            .update(PosExchangeLog)
            .set({
              status: 'FAILED_NEEDS_MANUAL_FIX',
              last_error: errorCode,
              updated_at: timestamp(),
            })
            .where(eq(PosExchangeLog.id, BigInt(operation.exchange.logId)));
        const saved = await save(tx, {
          ...operation,
          phase: uncertain ? 'uncertain' : 'rejected',
          uncertainStage: uncertain ? stage : null,
          errorCode,
        });
        if (definite)
          await recordRejectedReturnRepair(
            tx,
            user,
            saved,
            options.rejectedInboundRepairDispatcherEnabled === true && !config.DEMO_MODE,
            currentRequestTrace()?.requestId,
          );
        return saved;
      });
    },
  };
}
export type ReturnRepository = ReturnType<typeof returnRepository>;
