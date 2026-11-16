import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  ExpressLineItem,
  HasProduct,
  Order,
  PosTransactionLog,
  PosUser,
  Product,
  ProductStore,
  Store,
} from '../../db/legacy-schema.js';
import { generatedId } from '../../db/generated-id.js';
import { retryTransaction } from '../../db/retry.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { assertCurrentStoreAccess } from '../administration/authorization.js';
import { checkInService, type AdministrationTransaction } from '../administration/checkins.js';
import { enqueueInventorySynchronization } from '../administration/inventory-synchronization.js';
import { administrationOutbox, operatorCheckIns } from '../administration/schema.js';
import type { StockProcedure } from '../administration/stock-procedure.js';
import {
  legacyActionSchema,
  legacyAuditComment,
  legacyCancellationAudit,
  legacyReceiptSchema,
  legacyRequestSchema,
  legacyRtoCorrectionContract,
  legacyRtoPlan,
  legacyTrackingUrl,
  sourceLegacyStatus,
  type LegacyAction,
  type LegacyReceipt,
} from './domain.js';
import { legacyCommands, legacyHyperlocalLogs, legacyRtoReceipts } from './schema.js';
import { deliveryOrders } from './lifecycle/schema.js';
import { lifecycleOrderState } from './lifecycle/contracts.js';
import { verifyOrderMovement } from './lifecycle/movement.js';

export interface LegacyFulfillmentOptions {
  stockProcedure?: StockProcedure;
  synchronizationAvailable?: boolean;
  clock?: () => Temporal.Instant;
}
const incompatible = () =>
  new AppError(
    409,
    'LEGACY_FULFILLMENT_RECONCILIATION_REQUIRED',
    'This local delivery state requires reconciliation.',
  );
const sameLog = (row: typeof legacyHyperlocalLogs.$inferSelect) =>
  JSON.stringify([row.action, row.borzoId.toString(), row.createdInBorzo, row.mainStoreId || 0]);
export function legacyFulfillmentService(
  config: Config,
  db: Databases,
  options: LegacyFulfillmentOptions = {},
) {
  const clock = options.clock || (() => Temporal.Now.instant()),
    checkins = checkInService(db, config),
    rtoReady = !!options.stockProcedure && options.synchronizationAvailable === true;
  const timestamp = () =>
      clock()
        .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' })
        .replace('T', ' '),
    utcNow = () =>
      clock()
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime()
        .toString({ smallestUnit: 'millisecond' })
        .replace('T', ' ');
  async function storeAccess(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    mutation = false,
    includeInactive = false,
  ) {
    requireStore(user, storeId);
    await assertCurrentStoreAccess(tx, user.id, storeId);
    if (mutation) await checkins.assertCheckIn(user.id, storeId, undefined, tx);
    const query = tx
        .select({ id: Store.id, active: Store.is_active })
        .from(Store)
        .where(eq(Store.id, BigInt(storeId)))
        .limit(1),
      [store] = await query.for(mutation ? 'update' : 'share');
    if (!store || (!store.active && !includeInactive))
      throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found.');
  }
  async function orderScope(
    tx: AdministrationTransaction,
    storeId: string,
    orderId: string,
    lock: 'share' | 'update',
  ) {
    const [order] = await tx
      .select({
        id: Order.id,
        reference: Order.order_ref_no,
        locationType: Order.location_type,
        storeId: Order.location_id,
        split: Order.is_split_order,
        orderStatus: Order.order_statuses,
        paymentStatus: Order.payment_statuses,
      })
      .from(Order)
      .where(eq(Order.id, BigInt(orderId)))
      .limit(1)
      .for(lock);
    if (!order || order.locationType !== 'SW' || String(order.storeId) !== storeId)
      throw new AppError(
        404,
        'LEGACY_ORDER_NOT_FOUND',
        'The local delivery order was not found in this store.',
      );
    const express = await tx
      .select({ id: ExpressLineItem.id })
      .from(ExpressLineItem)
      .where(eq(ExpressLineItem.order, BigInt(orderId)))
      .limit(1)
      .for('share');
    if (express.length)
      throw new AppError(
        409,
        'EXPRESS_FULFILLMENT_REQUIRED',
        'Use Express fulfillment for this order.',
      );
    if (order.orderStatus === null || order.paymentStatus === null) throw incompatible();
    return { ...order, orderStatus: order.orderStatus, paymentStatus: order.paymentStatus };
  }
  async function integration(
    tx: Pick<AdministrationTransaction, 'select'>,
    receipt: LegacyReceipt,
  ): Promise<LegacyReceipt> {
    if (!receipt.syncEventId) return receipt;
    const [event] = await tx
      .select({ deliveredAt: administrationOutbox.deliveredAt })
      .from(administrationOutbox)
      .where(eq(administrationOutbox.id, receipt.syncEventId))
      .limit(1);
    return {
      ...receipt,
      integrationState: !event ? 'unconfirmed' : event.deliveredAt ? 'delivered' : 'pending',
    };
  }
  async function saveAudit(
    tx: AdministrationTransaction,
    user: Principal,
    order: Awaited<ReturnType<typeof orderScope>>,
    action: LegacyAction,
    note: string,
  ) {
    const [operator] = await tx
      .select({ firstName: PosUser.first_name })
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(user.id)))
      .limit(1)
      .for('share');
    if (!operator) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    const comment = legacyAuditComment(action, note, operator.firstName),
      [encoding] = await tx
        .select({
          valid:
            sql<number>`(CAST(${comment} AS BINARY) = CAST(CONVERT(CONVERT(${comment} USING latin1) USING utf8mb4) AS BINARY))`.mapWith(
              Number,
            ),
        })
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(user.id)))
        .limit(1);
    if (encoding?.valid !== 1)
      throw new AppError(
        422,
        'LEGACY_COMMENT_ENCODING_UNSUPPORTED',
        'This note or operator name cannot be stored safely. Contact an administrator.',
      );
    const now = timestamp();
    return generatedId(
      await tx.insert(PosTransactionLog).values({
        order_id: order.id,
        store_id: 0n,
        order_status: order.orderStatus,
        payment_status: order.paymentStatus,
        user_id: 0n,
        pos_user_id: BigInt(user.id),
        pay_dict: '{}',
        comment,
        created_at: now,
        updated_at: now,
      }),
    ).toString();
  }
  async function priorCancellation(tx: AdministrationTransaction, orderId: bigint) {
    const [refunded] = await tx
      .select({ id: legacyHyperlocalLogs.id })
      .from(legacyHyperlocalLogs)
      .where(
        and(eq(legacyHyperlocalLogs.orderId, orderId), sql`${legacyHyperlocalLogs.refunded} <> 0`),
      )
      .limit(1)
      .for('share');
    if (refunded) return true;
    const [cancellation] = await tx
      .select({ id: PosTransactionLog.id })
      .from(PosTransactionLog)
      .where(
        and(
          eq(PosTransactionLog.order_id, orderId),
          eq(PosTransactionLog.comment, legacyCancellationAudit),
        ),
      )
      .limit(1)
      .for('share');
    return !!cancellation;
  }
  const api = {
    async status(user: Principal, storeId: string, orderId: string) {
      identifier.parse(storeId);
      identifier.parse(orderId);
      return db.get('writer').transaction(async (tx) => {
        await storeAccess(tx, user, storeId);
        const order = await orderScope(tx, storeId, orderId, 'share'),
          [workflow] = await tx
            .select({ state: deliveryOrders.state })
            .from(deliveryOrders)
            .where(eq(deliveryOrders.orderId, order.id))
            .limit(1),
          [recorded] = await tx
            .select()
            .from(legacyRtoReceipts)
            .where(eq(legacyRtoReceipts.orderId, order.id))
            .limit(1),
          [checkin] = await tx
            .select({ id: operatorCheckIns.operatorId })
            .from(operatorCheckIns)
            .where(
              and(
                eq(operatorCheckIns.operatorId, user.id),
                eq(operatorCheckIns.storeId, BigInt(storeId)),
                gt(operatorCheckIns.expiresAt, utcNow()),
              ),
            )
            .limit(1),
          [operator] = await tx
            .select({ firstName: PosUser.first_name })
            .from(PosUser)
            .where(eq(PosUser.id, BigInt(user.id)))
            .limit(1);
        const workflowState = workflow ? lifecycleOrderState.parse(workflow.state) : null,
          movement = recorded ? await verifyOrderMovement(tx, recorded, orderId, storeId) : null,
          cancellationUnconfirmed = !movement && (await priorCancellation(tx, order.id));
        const [logs, lines] = await db.get('primary').transaction(
            async (reader) =>
              Promise.all([
                reader
                  .select()
                  .from(legacyHyperlocalLogs)
                  .where(eq(legacyHyperlocalLogs.orderId, order.id))
                  .orderBy(asc(legacyHyperlocalLogs.id))
                  .limit(101),
                reader
                  .select({
                    id: HasProduct.id,
                    productId: HasProduct.product,
                    name: Product.product,
                    quantity: HasProduct.qty,
                    platform: HasProduct.order_platform,
                  })
                  .from(HasProduct)
                  .leftJoin(Product, eq(Product.id, HasProduct.product))
                  .where(eq(HasProduct.order, order.id))
                  .orderBy(asc(HasProduct.id))
                  .limit(1001),
              ]),
            { isolationLevel: 'repeatable read', accessMode: 'read only' },
          ),
          first = logs[0] || null,
          coherent =
            logs.length <= 100 &&
            new Set(logs.map(sameLog)).size <= 1 &&
            (!first ||
              first.action !== 'ACCEPTED' ||
              first.createdInBorzo !== 1 ||
              first.borzoId > 0n) &&
            (!recorded || String(recorded.storeId) === storeId),
          accepted =
            first?.action === 'ACCEPTED' && first.createdInBorzo === 1 && first.borzoId > 0n,
          received =
            logs.some((log) => !!log.received) ||
            movement?.kind === 'rto' ||
            !!workflowState?.rtoCommandId,
          eligibleRto = accepted && ([28n, 29n].includes(order.orderStatus) || !!first?.rto);
        const suffix = legacyAuditComment('rto-receipt', '', operator?.firstName || '');
        return {
          orderId,
          storeId,
          reference: order.reference,
          split: !!order.split,
          sourceStatus: sourceLegacyStatus(first),
          action: first?.action || null,
          borzoId: first && first.borzoId > 0n ? first.borzoId.toString() : null,
          packed: !!first?.packed,
          rtoReceived: received,
          rtoEligible: !!eligibleRto,
          checkedIn: !!checkin,
          workflowPending: !!workflowState?.activeCommandId,
          reconciliationRequired: !coherent || cancellationUnconfirmed,
          rtoReady: rtoReady || movement?.kind === 'cancellation',
          returnLines: lines
            .slice(0, 1000)
            .filter((line) => !order.split || line.platform === 4n)
            .map((line) => ({
              id: String(line.id),
              productId: String(line.productId),
              name: line.name,
              quantity: String(line.quantity),
            })),
          excludedLineCount: lines.filter((line) => order.split && line.platform !== 4n).length,
          linesTruncated: lines.length > 1000,
          maxNoteCharacters: Math.max(0, 255 - [...suffix].length),
          canPack:
            !!accepted &&
            coherent &&
            !!checkin &&
            !first?.packed &&
            !received &&
            !workflowState?.activeCommandId,
          canReceiveRto:
            !!eligibleRto &&
            coherent &&
            !cancellationUnconfirmed &&
            !workflowState?.activeCommandId &&
            !!checkin &&
            !received &&
            (rtoReady || movement?.kind === 'cancellation') &&
            lines.length <= 1000,
          tracking: accepted
            ? {
                source: legacyTrackingUrl(first.sourceTracking),
                destination: legacyTrackingUrl(first.destinationTracking),
              }
            : { source: null, destination: null },
        };
      });
    },
    async execute(
      user: Principal,
      storeId: string,
      orderId: string,
      action: LegacyAction,
      supplied: unknown,
      requestId: string,
    ) {
      identifier.parse(storeId);
      identifier.parse(orderId);
      legacyActionSchema.parse(action);
      const input = legacyRequestSchema.parse(supplied),
        hash = createHash('sha256')
          .update(JSON.stringify([1, user.id, storeId, orderId, action, input.note]))
          .digest('hex');
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await storeAccess(tx, user, storeId, true);
          const createdAt = clock().epochMilliseconds;
          await tx
            .insert(legacyCommands)
            .values({
              id: input.commandId,
              actorId: user.id,
              storeId,
              orderId,
              action,
              requestHash: hash,
              requestId,
              createdAt,
              result: null,
            })
            .onDuplicateKeyUpdate({ set: { id: input.commandId } });
          const [command] = await tx
            .select()
            .from(legacyCommands)
            .where(eq(legacyCommands.id, input.commandId))
            .limit(1)
            .for('update');
          if (
            !command ||
            command.actorId !== user.id ||
            command.storeId !== storeId ||
            command.orderId !== orderId ||
            command.action !== action ||
            command.requestHash !== hash
          )
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This command belongs to another operation.',
            );
          if (command.result) return integration(tx, legacyReceiptSchema.parse(command.result));
          const order = await orderScope(tx, storeId, orderId, 'update'),
            base = {
              commandId: input.commandId,
              actorId: user.id,
              storeId,
              orderId,
              action,
              auditId: null,
              restoredUnits: '0',
              steps: [],
              syncEventId: null,
              integrationState: 'not-required' as const,
              createdAt,
              correctionContract: action === 'rto-receipt' ? legacyRtoCorrectionContract : null,
              split: !!order.split,
              excludedLineCount: 0,
              originalCommandId: null,
              recordedBy: 'rewrite' as const,
            };
          const [workflow] = await tx
            .select({ state: deliveryOrders.state })
            .from(deliveryOrders)
            .where(eq(deliveryOrders.orderId, order.id))
            .limit(1)
            .for('share');
          if (workflow?.state.activeCommandId)
            throw new AppError(
              409,
              'LOCAL_DELIVERY_COMMAND_PENDING',
              'Wait for the pending delivery command to be reconciled.',
            );
          let receipt: LegacyReceipt;
          const [existing] =
            action === 'rto-receipt'
              ? await tx
                  .select()
                  .from(legacyRtoReceipts)
                  .where(eq(legacyRtoReceipts.orderId, order.id))
                  .limit(1)
                  .for('update')
              : [];
          if (existing) {
            const movement = await verifyOrderMovement(tx, existing, orderId, storeId);
            if (movement.kind === 'rto')
              receipt = legacyReceiptSchema.parse({
                ...base,
                outcome: 'already-recorded',
                originalCommandId: movement.receipt.commandId,
                recordedBy: movement.receipt.recordedBy,
                syncEventId: movement.receipt.syncEventId,
                integrationState: movement.receipt.integrationState,
                split: movement.receipt.split,
                excludedLineCount: movement.receipt.excludedLineCount,
              });
            else {
              if (!workflow) throw incompatible();
              const state = lifecycleOrderState.parse(workflow.state);
              if (state.rtoCommandId) {
                const [original] = await tx
                    .select({ result: legacyCommands.result })
                    .from(legacyCommands)
                    .where(eq(legacyCommands.id, state.rtoCommandId))
                    .limit(1)
                    .for('share'),
                  proof = legacyReceiptSchema.safeParse(original?.result);
                if (
                  !proof.success ||
                  proof.data.action !== 'rto-receipt' ||
                  proof.data.orderId !== orderId ||
                  proof.data.storeId !== storeId ||
                  !['rto-received', 'already-recorded'].includes(proof.data.outcome)
                )
                  throw incompatible();
                receipt = legacyReceiptSchema.parse({
                  ...base,
                  outcome: 'already-recorded',
                  originalCommandId: proof.data.commandId,
                  recordedBy: proof.data.recordedBy,
                });
              } else {
                const logs = await tx
                    .select()
                    .from(legacyHyperlocalLogs)
                    .where(eq(legacyHyperlocalLogs.orderId, order.id))
                    .orderBy(asc(legacyHyperlocalLogs.id))
                    .limit(101)
                    .for('update'),
                  first = logs[0];
                if (
                  !first ||
                  logs.length > 100 ||
                  new Set(logs.map(sameLog)).size !== 1 ||
                  first.action !== 'ACCEPTED' ||
                  first.createdInBorzo !== 1 ||
                  first.borzoId <= 0n ||
                  (!first.rto && ![28n, 29n].includes(order.orderStatus))
                )
                  throw incompatible();
                if (logs.some((log) => !!log.received))
                  receipt = legacyReceiptSchema.parse({
                    ...base,
                    outcome: 'already-recorded',
                    recordedBy: 'legacy',
                    originalCommandId: movement.receipt.commandId,
                  });
                else {
                  const auditId = await saveAudit(tx, user, order, action, input.note);
                  await tx
                    .update(legacyHyperlocalLogs)
                    .set({ received: 1 })
                    .where(eq(legacyHyperlocalLogs.orderId, order.id));
                  receipt = legacyReceiptSchema.parse({
                    ...base,
                    outcome: 'rto-received',
                    auditId,
                    originalCommandId: movement.receipt.commandId,
                  });
                }
                await tx
                  .update(deliveryOrders)
                  .set({
                    state: { ...state, rtoCommandId: input.commandId },
                    version: sql`${deliveryOrders.version}+1`,
                    updatedAt: createdAt,
                  })
                  .where(eq(deliveryOrders.orderId, order.id));
              }
            }
          } else {
            const logs = await tx
                .select()
                .from(legacyHyperlocalLogs)
                .where(eq(legacyHyperlocalLogs.orderId, order.id))
                .orderBy(asc(legacyHyperlocalLogs.id))
                .limit(101)
                .for('update'),
              first = logs[0];
            if (!first || logs.length > 100 || new Set(logs.map(sameLog)).size !== 1)
              throw incompatible();
            // The old webhook restores inventory without clearing ACCEPTED. Neither
            // a refund flag nor its audit proves how much stock already moved.
            // Only the order-scoped rewrite receipt above can resolve that state.
            if (action === 'rto-receipt' && (await priorCancellation(tx, order.id)))
              throw incompatible();
            if (
              (action === 'rto-receipt' && logs.some((log) => !!log.received)) ||
              (action === 'packing' && !!first.packed)
            ) {
              receipt = legacyReceiptSchema.parse({
                ...base,
                outcome: 'already-recorded',
                recordedBy: 'legacy',
              });
            } else {
              if (
                first.action !== 'ACCEPTED' ||
                first.createdInBorzo !== 1 ||
                first.borzoId <= 0n ||
                (action === 'packing' && logs.some((log) => !!log.received))
              )
                throw new AppError(
                  409,
                  'LEGACY_ACTION_UNAVAILABLE',
                  'This local delivery action is not available in the current state.',
                );
              if (action === 'packing') {
                const auditId = await saveAudit(tx, user, order, action, input.note);
                await tx
                  .update(legacyHyperlocalLogs)
                  .set({ packed: 1 })
                  .where(eq(legacyHyperlocalLogs.orderId, order.id));
                receipt = legacyReceiptSchema.parse({ ...base, outcome: 'packed', auditId });
              } else {
                if (!rtoReady || !options.stockProcedure)
                  throw new AppError(
                    503,
                    'LEGACY_RTO_STOCK_UNAVAILABLE',
                    'Receiving is unavailable. Contact the inventory administrator.',
                  );
                if (![28n, 29n].includes(order.orderStatus) && !first.rto)
                  throw new AppError(
                    409,
                    'LEGACY_RTO_NOT_ELIGIBLE',
                    'The courier return is not eligible to be received.',
                  );
                const lines = await tx
                    .select({
                      hasProductId: HasProduct.id,
                      productId: HasProduct.product,
                      subProductId: HasProduct.sub_prod_id,
                      quantity: HasProduct.qty,
                      platform: HasProduct.order_platform,
                    })
                    .from(HasProduct)
                    .where(eq(HasProduct.order, order.id))
                    .orderBy(asc(HasProduct.id))
                    .limit(1001)
                    .for('update'),
                  selected = lines.filter((line) => !order.split || line.platform === 4n),
                  ids = [...new Set(selected.map((line) => line.productId))];
                if (!ids.length || lines.length > 1000)
                  throw new AppError(
                    409,
                    'LEGACY_RTO_LINES_UNCONFIRMED',
                    'The returning line items require reconciliation.',
                  );
                await tx
                  .select({ id: Product.id })
                  .from(Product)
                  .where(inArray(Product.id, ids))
                  .orderBy(asc(Product.id))
                  .for('update');
                const stocks = await tx
                    .select({ productId: ProductStore.product, stock: ProductStore.stock })
                    .from(ProductStore)
                    .where(
                      and(
                        eq(ProductStore.store, BigInt(storeId)),
                        inArray(ProductStore.product, ids),
                      ),
                    )
                    .orderBy(asc(ProductStore.product))
                    .limit(1001)
                    .for('update'),
                  plan = legacyRtoPlan(
                    !!order.split,
                    lines.map((line) => ({
                      hasProductId: String(line.hasProductId),
                      productId: String(line.productId),
                      subProductId: String(line.subProductId),
                      quantity: String(line.quantity),
                      platform: String(line.platform),
                    })),
                    stocks.map((row) => ({ productId: String(row.productId), stock: row.stock })),
                  );
                const auditId = await saveAudit(tx, user, order, action, input.note);
                for (const step of plan.steps)
                  await options.stockProcedure(tx, {
                    storeId,
                    productId: step.productId,
                    stock: step.after,
                    operatorId: user.id,
                    comment: `Product inventory added from admin panel on Hyperlocal RTO, [Order ID:${orderId}]`,
                  });
                await enqueueInventorySynchronization(tx, {
                  id: input.commandId,
                  storeId,
                  productIds: ids.map(String),
                  operatorId: user.id,
                  reason: 'legacy-rto',
                  requestId,
                });
                await tx
                  .update(legacyHyperlocalLogs)
                  .set({ received: 1 })
                  .where(eq(legacyHyperlocalLogs.orderId, order.id));
                receipt = legacyReceiptSchema.parse({
                  ...base,
                  outcome: 'rto-received',
                  auditId,
                  steps: plan.steps,
                  restoredUnits: plan.totalUnits,
                  excludedLineCount: plan.excludedLineCount,
                  syncEventId: input.commandId,
                  integrationState: 'pending',
                });
              }
            }
            if (action === 'rto-receipt')
              await tx.insert(legacyRtoReceipts).values({
                orderId: order.id,
                storeId: BigInt(storeId),
                commandId: input.commandId,
                receipt,
                createdAt,
              });
          }
          await tx
            .update(legacyCommands)
            .set({ result: receipt })
            .where(eq(legacyCommands.id, input.commandId));
          return integration(tx, receipt);
        }),
      );
    },
    async receipt(user: Principal, commandId: string) {
      return db.get('writer').transaction(async (tx) => {
        const [command] = await tx
          .select()
          .from(legacyCommands)
          .where(eq(legacyCommands.id, commandId))
          .limit(1)
          .for('share');
        if (
          !command ||
          command.actorId !== user.id ||
          !command.result ||
          !legacyActionSchema.safeParse(command.action).success
        )
          throw new AppError(
            404,
            'LEGACY_COMMAND_NOT_FOUND',
            'The fulfillment command was not found.',
          );
        await storeAccess(tx, user, command.storeId, false, true);
        return integration(tx, legacyReceiptSchema.parse(command.result));
      });
    },
  };
  return api;
}
