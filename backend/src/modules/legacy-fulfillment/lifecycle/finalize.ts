import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  HasProduct,
  HyperlocalToOnlineOrderLog,
  Order,
  OrderAddon,
  TssMoneyHistory,
  Product,
  ProductStore,
} from '../../../db/legacy-schema.js';
import {
  legacyCancellationAudit,
  legacyRtoCorrectionContract,
  legacyRtoPlan,
  type RtoStep,
} from '../domain.js';
import { legacyHyperlocalLogs } from '../schema.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import {
  enqueueInventorySynchronization,
  enqueueSystemInventorySynchronization,
} from '../../administration/inventory-synchronization.js';
import { heldLines } from './inventory.js';
import { eventId, reconciliation } from './domain.js';
import { cancellationMovement, providerResult, type LifecycleOrderState } from './contracts.js';
import { assertCancelledProjection, assertConvertedProjection } from './proofs.js';
import { readOrderMovement, recordCancellationMovement } from './movement.js';
import { refundOnlineCharge, pythonRoundMoney } from './money.js';
import type { DeliveryCommand, LifecycleRuntime } from './runtime.js';
import { beginConversion } from './transitions.js';
import { ensureDeliveryLog } from './source-log.js';

type Context = Awaited<ReturnType<LifecycleRuntime['context']>>;
async function releaseReservations(
  runtime: LifecycleRuntime,
  tx: AdministrationTransaction,
  command: DeliveryCommand,
  state: LifecycleOrderState,
  requestId: string,
  consumeStore?: string,
) {
  const stores = [
      ...new Set(
        state.reservations.filter((row) => row.state === 'held').map((row) => row.storeId),
      ),
    ],
    operations = stores.map((storeId) => ({
      kind: storeId === consumeStore ? ('consume' as const) : ('release' as const),
      storeId,
      lines: heldLines(state.reservations, storeId),
      comment: consumeStore
        ? `Hyperlocal Order accepted, inventory reservation settled for order ${command.state.orderId}`
        : `Hyperlocal order converted/canceled, inventory unhold for order ${command.state.orderId}`,
    }));
  return runtime.inventory.apply(tx, {
    commandId: command.id,
    orderId: command.state.orderId,
    actor: runtime.actor(command),
    requestId,
    timestamp: runtime.timestamp(),
    state,
    operations,
  });
}
async function restoreUntracked(
  runtime: LifecycleRuntime,
  tx: AdministrationTransaction,
  command: DeliveryCommand,
  context: Context,
  requestId: string,
) {
  const actor = runtime.actor(command),
    ids = [...new Set(context.selected.map((line) => line.productId))];
  await tx
    .select({ id: Product.id })
    .from(Product)
    .where(inArray(Product.id, ids.map(BigInt)))
    .orderBy(asc(Product.id))
    .for('update');
  const stocks = await tx
      .select({ productId: ProductStore.product, stock: ProductStore.stock })
      .from(ProductStore)
      .where(
        and(
          eq(ProductStore.store, BigInt(command.state.storeId)),
          inArray(ProductStore.product, ids.map(BigInt)),
        ),
      )
      .orderBy(asc(ProductStore.product))
      .limit(1001)
      .for('update'),
    plan = legacyRtoPlan(
      command.snapshot.split,
      command.snapshot.lines.map((line) => ({
        hasProductId: line.id,
        productId: line.productId,
        subProductId: '0',
        quantity: String(line.quantity),
        platform: line.platform,
      })),
      stocks.map((row) => ({ productId: String(row.productId), stock: row.stock })),
    );
  for (const step of plan.steps) {
    const value = {
      storeId: command.state.storeId,
      productId: step.productId,
      stock: step.after,
      comment: `Product inventory added from admin panel on order cancel, [Order ID:${command.state.orderId}]`,
    };
    if (actor.kind === 'service')
      await runtime.dependencies.systemStockProcedure!(tx, { ...value, operatorId: '0' });
    else await runtime.dependencies.stockProcedure!(tx, { ...value, operatorId: actor.id });
  }
  const event = {
    id: eventId('legacy-delivery-sync', command.id, command.state.storeId),
    storeId: command.state.storeId,
    productIds: ids,
    reason: 'legacy-delivery' as const,
    requestId,
  };
  if (actor.kind === 'service') await enqueueSystemInventorySynchronization(tx, event);
  else await enqueueInventorySynchronization(tx, { ...event, operatorId: actor.id });
  return plan.steps;
}
export async function finalizeLifecycle(
  runtime: LifecycleRuntime,
  tx: AdministrationTransaction,
  command: DeliveryCommand,
  context: Context,
  state: LifecycleOrderState,
  requestId: string,
) {
  const calls = await runtime.calls(tx, command),
    core = calls.filter((call) => call.sequence < 10000);
  if (!core.length || core.some((call) => call.status !== 'ACKNOWLEDGED')) return command.state;
  if (command.stage === 'create-provider') {
    await ensureDeliveryLog(tx, command.state.orderId, runtime.timestamp());
    const result = providerResult.parse(
      core.find((call) => call.request.kind === 'borzo-create')?.result,
    );
    if (result.kind === 'rejected') {
      await tx
        .update(legacyHyperlocalLogs)
        .set({
          action: 'CREATION_FAILED',
          createdInBorzo: 0,
          borzoId: 0n,
          sourceTracking: '',
          destinationTracking: '',
          posAdminId:
            runtime.actor(command).kind === 'service' ? 0 : Number(runtime.actor(command).id),
          updatedAt: runtime.timestamp(),
        })
        .where(eq(legacyHyperlocalLogs.orderId, BigInt(command.state.orderId)));
      // A definitive courier rejection can fall back. A timeout never reaches here.
      return beginConversion(runtime, tx, command, context);
    }
    if (result.kind !== 'courier-created') throw reconciliation();
    const released = await releaseReservations(
      runtime,
      tx,
      command,
      state,
      requestId,
      command.state.storeId,
    );
    state = { ...released.state, acceptedStoreId: command.state.storeId };
    await tx
      .update(legacyHyperlocalLogs)
      .set({
        action: 'ACCEPTED',
        createdInBorzo: 1,
        borzoId: BigInt(result.courierOrderId),
        sourceTracking: result.sourceTracking,
        destinationTracking: result.destinationTracking,
        posAdminId:
          runtime.actor(command).kind === 'service' ? 0 : Number(runtime.actor(command).id),
        updatedAt: runtime.timestamp(),
      })
      .where(eq(legacyHyperlocalLogs.orderId, BigInt(command.state.orderId)));
    if (BigInt(command.state.storeId) > 2147483647n) throw reconciliation();
    await tx
      .update(Order)
      .set({ location_id: Number(command.state.storeId), order_statuses: 21n })
      .where(eq(Order.id, BigInt(command.state.orderId)));
    await tx
      .update(HasProduct)
      .set({ status: 'PROCESSING' })
      .where(
        and(
          eq(HasProduct.order, BigInt(command.state.orderId)),
          command.snapshot.split ? eq(HasProduct.order_platform, 4n) : undefined,
        ),
      );
    await runtime.audit(
      tx,
      command,
      context,
      `Hyperlocal Order Created in Borzo, Order location : ${context.store.name}`,
      runtime.actor(command).kind === 'service' ? '0' : runtime.actor(command).id,
    );
    await runtime.save(tx, command, { courierOrderId: result.courierOrderId });
    if (!command.snapshot.split) await runtime.addCall(tx, command, 'order-producer', 10000);
    await runtime.addCall(tx, command, 'slack', 10001, {
      description: `Hyperlocal Order ID:${command.state.orderId} Accepted at ${context.store.name}, and created in Borzo Succesfully`,
    });
    return runtime.finish(tx, command, state, {
      outcome: 'created',
      courierOrderId: result.courierOrderId,
    });
  }
  if (command.stage === 'cancel-provider') {
    await assertCancelledProjection(tx, command.snapshot);
    if (command.state.action !== 'observer-cancel')
      await ensureDeliveryLog(tx, command.state.orderId, runtime.timestamp());
    const existing = await readOrderMovement(tx, command.state.orderId, command.state.storeId);
    const released = await releaseReservations(runtime, tx, command, state, requestId);
    state = released.state;
    let steps: RtoStep[] = released.movements
      .filter((movement) => movement.storeId === command.state.storeId)
      .map((movement) => movement.step);
    if (existing && steps.length) throw reconciliation();
    if (!existing && !steps.length && command.state.action === 'observer-cancel')
      steps = await restoreUntracked(runtime, tx, command, context, requestId);
    await tx
      .update(HasProduct)
      .set({ status: 'CANCELLED' })
      .where(
        and(
          eq(HasProduct.order, BigInt(command.state.orderId)),
          command.snapshot.split ? eq(HasProduct.order_platform, 4n) : undefined,
        ),
      );
    const otherActive =
      command.snapshot.split &&
      command.snapshot.lines.some(
        (line) => ['1', '2', '3'].includes(line.platform) && line.status !== 'CANCELLED',
      );
    if (!otherActive)
      await tx
        .update(Order)
        .set({ payment_statuses: 5n, order_statuses: 4n })
        .where(eq(Order.id, BigInt(command.state.orderId)));
    if (command.state.action !== 'observer-cancel')
      await tx
        .update(legacyHyperlocalLogs)
        .set({
          action: 'DECLINED',
          borzoId: 0n,
          createdInBorzo: 0,
          sourceTracking: '',
          destinationTracking: '',
          posAdminId:
            runtime.actor(command).kind === 'service' ? 0 : Number(runtime.actor(command).id),
          updatedAt: runtime.timestamp(),
        })
        .where(eq(legacyHyperlocalLogs.orderId, BigInt(command.state.orderId)));
    else if (command.input.reason === 'RTO-intransit')
      await tx
        .update(legacyHyperlocalLogs)
        .set({ rto: 1 })
        .where(eq(legacyHyperlocalLogs.orderId, BigInt(command.state.orderId)));
    await tx
      .update(legacyHyperlocalLogs)
      .set({ refunded: 1 })
      .where(eq(legacyHyperlocalLogs.orderId, BigInt(command.state.orderId)));
    const auditId = await runtime.audit(
      tx,
      command,
      context,
      legacyCancellationAudit,
      runtime.actor(command).kind === 'service' ? '0' : runtime.actor(command).id,
    );
    if (!existing && steps.length) {
      await recordCancellationMovement(
        tx,
        cancellationMovement.parse({
          kind: 'local-delivery-cancellation',
          version: 1,
          commandId: command.id,
          actorId: command.state.actorId,
          orderId: command.state.orderId,
          storeId: command.state.storeId,
          correctionContract: legacyRtoCorrectionContract,
          steps,
          restoredUnits: steps
            .reduce((total, step) => total + BigInt(step.quantity), 0n)
            .toString(),
          auditId,
          createdAt: runtime.instant(),
        }),
      );
      await runtime.save(tx, command, { inventoryMovementCommandId: command.id });
    } else if (existing)
      await runtime.save(tx, command, { inventoryMovementCommandId: existing.receipt.commandId });
    if (['pass', 'create'].includes(command.state.action)) {
      const customer = await runtime.authority.customer(tx, command.snapshot.customerId),
        subject = 'Online Conversion Failed: Stock not available at online warehouse';
      await runtime.addCall(tx, command, 'support-ticket', 10001, {
        customerName: customer.firstName,
        subject,
        description: `Order ID : ${command.state.orderId} | User Mobile ${customer.telephone} and email ${customer.email} |Status:Cancelled/refund`,
      });
    }
    return runtime.finish(
      tx,
      command,
      { ...state, cancellationCommandId: command.id },
      { outcome: 'cancelled' },
    );
  }
  if (command.stage === 'convert-provider' || command.stage === 'split-charge-refund') {
    const result = providerResult.parse(
      core.find((call) => call.request.kind === 'online-convert')?.result,
    );
    if (result.kind !== 'online-created') throw reconciliation();
    await assertConvertedProjection(tx, command.snapshot, result.newOrderId);
    await runtime.save(tx, command, { newOrderId: result.newOrderId });
    if (command.snapshot.split && command.stage === 'convert-provider') {
      await tx
        .update(HasProduct)
        .set({ status: 'CANCELLED' })
        .where(
          and(
            eq(HasProduct.order, BigInt(command.state.orderId)),
            eq(HasProduct.order_platform, 4n),
          ),
        );
      await runtime.addCall(tx, command, 'split-charge-refund', 1001);
      return runtime.save(tx, command, { phase: 'queued' }, 'split-charge-refund');
    }
    const movement = await readOrderMovement(tx, command.state.orderId, command.state.storeId),
      released = await releaseReservations(runtime, tx, command, state, requestId);
    state = released.state;
    if (
      movement &&
      released.movements.some((movement) => movement.storeId === command.state.storeId)
    )
      throw reconciliation();
    let moneyHistoryId: string | null = null;
    if (command.snapshot.split) {
      const [addon] = await tx
          .select({ refunded: OrderAddon.hl_charges_refunded })
          .from(OrderAddon)
          .where(eq(OrderAddon.order_id, BigInt(command.state.orderId)))
          .limit(1)
          .for('share'),
        relevant = context.snapshot.lines.filter((line) => ['3', '4'].includes(line.platform)),
        eligible =
          !!addon &&
          context.order.hlCharges > 0 &&
          relevant.length > 0 &&
          relevant.every((line) =>
            [
              'DELIVERY_EXCEPTION',
              'RTO_INITIATED',
              'RTO_IN_TRANSIT',
              'RTO_DELIVERED',
              'UNDELIVERED',
              'CANCELLED',
            ].includes(line.status),
          );
      if (eligible) {
        const history = await tx
          .select({
            id: TssMoneyHistory.id,
            added: TssMoneyHistory.added_amt,
            used: TssMoneyHistory.used_amt,
            before: TssMoneyHistory.amt_before_update,
            after: TssMoneyHistory.amt_after_update,
          })
          .from(TssMoneyHistory)
          .where(
            and(
              eq(TssMoneyHistory.order_id, BigInt(command.state.orderId)),
              eq(TssMoneyHistory.user_id, BigInt(command.snapshot.customerId)),
              eq(TssMoneyHistory.platform, 'ORDER_REFUND'),
              eq(TssMoneyHistory.comment, 'Fast Delivery Charges Refunded'),
            ),
          )
          .orderBy(asc(TssMoneyHistory.id))
          .limit(2)
          .for('share');
        const [refund] = history;
        // tss_money_history amounts are nullable; a NULL refund row never matches.
        if (
          addon.refunded !== 1 ||
          history.length !== 1 ||
          !refund ||
          refund.added === null ||
          refund.before === null ||
          refund.added !== context.order.hlCharges ||
          refund.used !== 0 ||
          refund.after !== pythonRoundMoney(refund.before + refund.added)
        )
          throw reconciliation();
        moneyHistoryId = String(refund.id);
      }
    }
    if (!command.snapshot.split)
      moneyHistoryId = await refundOnlineCharge(runtime, tx, command, result.hlCharges, context);
    await ensureDeliveryLog(tx, command.state.orderId, runtime.timestamp());
    await tx.insert(HyperlocalToOnlineOrderLog).values({
      order_id: BigInt(command.state.orderId),
      new_order_id: BigInt(result.newOrderId),
      platform: command.input.platform,
      location_type: 'SW',
      location_id: BigInt(command.state.storeId),
      location_ids: command.input.locationIds,
      reason: command.input.reasonCategory,
      remark: command.input.reason,
      created_at: runtime.timestamp(),
      updated_at: runtime.timestamp(),
    });
    await tx
      .update(legacyHyperlocalLogs)
      .set({
        action: 'CONVERT_ONLINE',
        borzoId: 0n,
        createdInBorzo: 0,
        sourceTracking: '',
        destinationTracking: '',
        posAdminId: 0,
        updatedAt: runtime.timestamp(),
      })
      .where(eq(legacyHyperlocalLogs.orderId, BigInt(command.state.orderId)));
    await tx
      .update(HasProduct)
      .set({ status: 'CANCELLED' })
      .where(
        and(
          eq(HasProduct.order, BigInt(command.state.orderId)),
          command.snapshot.split ? eq(HasProduct.order_platform, 4n) : undefined,
        ),
      );
    if (
      !command.snapshot.split ||
      !command.snapshot.lines.some((line) => ['1', '2', '3'].includes(line.platform))
    )
      await tx
        .update(Order)
        .set({ payment_statuses: 5n, order_statuses: 4n })
        .where(eq(Order.id, BigInt(command.state.orderId)));
    await runtime.audit(
      tx,
      command,
      context,
      `Hyperlocal Order Convert into the New Online order, Order ID : # ${result.newOrderId}` +
        (command.input.staffName ? ` | By Staff User: ${command.input.staffName}` : ''),
    );
    await runtime.addCall(tx, command, 'new-order-email', 10000, { newOrderId: result.newOrderId });
    if (command.input.platform === 'CONVERT_ONLINE') {
      const customer = await runtime.authority.customer(tx, command.snapshot.customerId);
      await runtime.addCall(tx, command, 'support-ticket', 10001, {
        newOrderId: result.newOrderId,
        customerName: customer.firstName,
        subject: 'Hyperlocal order convert into online',
        description:
          `User Mobile ${customer.telephone} and email ${customer.email} | Order ID : ${command.state.orderId} | New Order ID : ${result.newOrderId}` +
          (command.input.reason ? ` | Reason : ${command.input.reason}` : ''),
      });
    }
    return runtime.finish(
      tx,
      command,
      { ...state, convertedCommandId: command.id },
      {
        outcome: 'converted',
        newOrderId: result.newOrderId,
        moneyHistoryId,
        inventoryMovementCommandId: movement?.receipt.commandId || null,
      },
    );
  }
  throw reconciliation();
}
