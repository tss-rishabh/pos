import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  Order,
  OrderAddon,
  PosHyperlocalSlot,
  Store,
  TssSetting,
} from '../../../db/legacy-schema.js';
import { aggregateStock } from '../../../db/stock-projection/schema.js';
import { AppError } from '../../../domain/errors.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import type { LifecycleOrderState, ProviderKind } from './contracts.js';
import { assertDeliveryAuditText } from './audit.js';
import { cancellationSets } from './authority.js';
import {
  eventId,
  passDecision,
  reconciliation,
  scheduleArrival,
  sourceDateTime,
} from './domain.js';
import { heldLines } from './inventory.js';
import { addStoreSlack } from './effects.js';
import type { DeliveryCommand, LifecycleRuntime } from './runtime.js';

type Context = Awaited<ReturnType<LifecycleRuntime['context']>>;
export function requireProvider(runtime: LifecycleRuntime, ...kinds: ProviderKind[]) {
  if (kinds.some((kind) => !runtime.dependencies.provider.ready(kind)))
    throw new AppError(503, 'UPSTREAM_NOT_SENT', 'The local delivery integration is unavailable.');
}
export function pythonLocationIds(raw: string) {
  let values: unknown;
  try {
    values = JSON.parse(raw) as unknown;
  } catch {
    return '[]';
  }
  if (!Array.isArray(values)) throw reconciliation();
  return (
    '[' +
    values
      .map((value: unknown) => (typeof value === 'string' ? `'${value}'` : String(value)))
      .join(', ') +
    ']'
  );
}
async function bufferSeconds(tx: AdministrationTransaction) {
  const [setting] = await tx
    .select({ value: TssSetting.value })
    .from(TssSetting)
    .where(eq(TssSetting.platform, 'ORDER_CREATION_BUFFER_TIME_IN_SEC'))
    .orderBy(asc(TssSetting.id))
    .limit(1)
    .for('share');
  const value =
    setting?.value === undefined || setting.value === null ? 3600 : Number(setting.value);
  if (!Number.isSafeInteger(value) || value < 0 || value > 604800) throw reconciliation();
  return value;
}
export async function onlineAvailable(tx: AdministrationTransaction, context: Context) {
  const ids = [...new Set(context.selected.map((line) => line.productId))];
  const rows = await tx
    .select({ id: aggregateStock.productId, stock: aggregateStock.stock })
    .from(aggregateStock)
    .where(inArray(aggregateStock.productId, ids.map(BigInt)))
    .orderBy(asc(aggregateStock.productId))
    .for('share');
  return rows.length === ids.length && rows.every((row) => row.stock > 0n);
}
async function inventory(
  runtime: LifecycleRuntime,
  tx: AdministrationTransaction,
  command: DeliveryCommand,
  state: LifecycleOrderState,
  requestId: string,
  operations: Parameters<LifecycleRuntime['inventory']['apply']>[1]['operations'],
) {
  const result = await runtime.inventory.apply(tx, {
    commandId: command.id,
    orderId: command.state.orderId,
    actor: runtime.actor(command),
    requestId,
    timestamp: runtime.timestamp(),
    state,
    operations,
  });
  await runtime.saveOrder(tx, result.state);
  return result;
}
export async function beginCancellation(
  runtime: LifecycleRuntime,
  tx: AdministrationTransaction,
  command: DeliveryCommand,
  context: Context,
) {
  if (command.input.reason.length > 200)
    throw new AppError(
      422,
      'CANCELLATION_REASON_TOO_LONG',
      'Use a cancellation reason of 200 characters or fewer.',
    );
  const effects =
      runtime.options.BAMBOO_TOOTHBRUSH_EM && runtime.options.WELCOME_NOTE_PRODUCT_ID
        ? [runtime.options.BAMBOO_TOOTHBRUSH_EM, runtime.options.WELCOME_NOTE_PRODUCT_ID]
        : undefined,
    products = cancellationSets(command.snapshot, effects);
  requireProvider(runtime, command.snapshot.split ? 'cancel-item' : 'cancel-order');
  await assertDeliveryAuditText(tx, 'Hyperlocal Order Cancelled : Amount Refunded');
  if (
    command.state.action === 'cancel' &&
    (context.order.orderStatus !== 1n || context.selected.some((line) => line.status !== 'PLACED'))
  )
    throw new AppError(
      409,
      'LOCAL_DELIVERY_CANCELLATION_UNAVAILABLE',
      'Only an unaccepted delivery can be cancelled manually.',
    );
  const prior = await runtime.calls(tx, command),
    base = prior
      .filter((call) => call.sequence < 10000)
      .reduce((max, call) => Math.max(max, call.sequence + 1), 0);
  if (command.snapshot.split)
    for (const [index, productId] of products.entries())
      await runtime.addCall(tx, command, 'cancel-item', base + index, { productId });
  else await runtime.addCall(tx, command, 'cancel-order', base);
  return runtime.save(tx, command, { phase: 'queued' }, 'cancel-provider');
}
export async function beginConversion(
  runtime: LifecycleRuntime,
  tx: AdministrationTransaction,
  command: DeliveryCommand,
  context: Context,
) {
  if (!(await onlineAvailable(tx, context))) {
    if (command.input.platform === 'RTO_CONVERT_ONLINE')
      throw new AppError(
        409,
        'ONLINE_INVENTORY_UNAVAILABLE',
        'Online inventory is not available for this conversion.',
      );
    await runtime.audit(
      tx,
      command,
      context,
      'Online Conversion Failed: Stock not available at online warehouse',
    );
    return beginCancellation(runtime, tx, command, context);
  }
  requireProvider(runtime, 'online-convert');
  const prior = await runtime.calls(tx, command),
    sequence = prior
      .filter((call) => call.sequence < 10000)
      .reduce((max, call) => Math.max(max, call.sequence + 1), 0);
  await runtime.addCall(tx, command, 'online-convert', sequence);
  return runtime.save(tx, command, { phase: 'queued' }, 'convert-provider');
}
export async function beginLifecycle(
  runtime: LifecycleRuntime,
  tx: AdministrationTransaction,
  command: DeliveryCommand,
  context: Context,
  state: LifecycleOrderState,
  requestId: string,
) {
  const action = command.state.action,
    log = context.logs[0];
  if (
    ['create', 'cancel'].includes(action) &&
    runtime.actor(command).kind === 'operator' &&
    BigInt(runtime.actor(command).id) > 2147483647n
  )
    throw new AppError(
      422,
      'LOCAL_DELIVERY_ACTOR_RANGE',
      'This operator needs a compatible delivery audit identity.',
    );
  if (action === 'arrival') {
    if (
      state.arrivalCommandId ||
      ['ACCEPTED', 'DECLINED', 'CONVERT_ONLINE'].includes(log?.action || '')
    )
      return runtime.finish(tx, command, state, { outcome: 'already-recorded' });
    if (context.order.orderStatus !== 1n || !context.selected.length) throw reconciliation();
    const now = runtime.clock().toZonedDateTimeISO(runtime.config.BUSINESS_TIMEZONE),
      start = command.snapshot.startTimeslot;
    if (!start) throw reconciliation();
    const date = sourceDateTime(start).toPlainDate(),
      current = now.toPlainDate(),
      target = Temporal.PlainDate.compare(date, current) > 0 ? date : current,
      weekday = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'][target.dayOfWeek - 1]!,
      [slot] = await tx
        .select({ start: PosHyperlocalSlot.start_timeslot })
        .from(PosHyperlocalSlot)
        .where(
          and(
            eq(PosHyperlocalSlot.store_id, BigInt(command.state.storeId)),
            eq(PosHyperlocalSlot.weekday, weekday),
          ),
        )
        .orderBy(asc(PosHyperlocalSlot.id))
        .limit(1)
        .for('share');
    const schedule = scheduleArrival({
        now: runtime.clock(),
        zone: runtime.config.BUSINESS_TIMEZONE,
        orderStart: start,
        slotStart: slot?.start || null,
        cutoff: runtime.options.HYPERLOCAL_CUT_OFF_SWITCH,
        cutoffTime: runtime.options.HYPERLOCAL_CUT_OFF_TIME,
        bufferSeconds: await bufferSeconds(tx),
      }),
      result = await inventory(runtime, tx, command, state, requestId, [
        {
          kind: 'hold',
          storeId: command.state.storeId,
          lines: context.selected.map((line) => ({
            hasProductId: line.id,
            productId: line.productId,
            quantity: line.quantity,
          })),
          comment: `Hyperlocal Order placed, inventory hold for order ${command.state.orderId}`,
        },
      ]);
    state = { ...result.state, arrivalCommandId: command.id };
    if (schedule.successTimestamp)
      await runtime.setSuccessTimestamp(tx, command.state.orderId, schedule.successTimestamp);
    if (command.input.notify)
      await runtime.addJob(tx, command, 'advance-notification', schedule.notificationAt, requestId);
    await runtime.addJob(tx, command, 'auto-transfer', schedule.transferAt, requestId);
    const stores = command.snapshot.nextStoreIds.length
        ? await tx
            .select({ id: Store.id, name: Store.store_name })
            .from(Store)
            .where(inArray(Store.id, command.snapshot.nextStoreIds.map(BigInt)))
            .for('share')
        : [],
      names = new Map(stores.map((store) => [String(store.id), store.name]));
    if (stores.length !== command.snapshot.nextStoreIds.length) throw reconciliation();
    const backup = command.snapshot.nextStoreIds.map((id) => names.get(id) + ', ').join('');
    await runtime.audit(
      tx,
      command,
      context,
      `Hyperlocal Order first lands on ${context.store.name}` +
        (backup ? ` and backup stores are ${backup}` : ' and not a single backup store aligned'),
    );
    return runtime.finish(tx, command, state, {
      outcome: 'arrival-scheduled',
      nextJobAt: schedule.transferAt,
    });
  }
  if (action === 'pass') {
    if (['ACCEPTED', 'DECLINED', 'CONVERT_ONLINE'].includes(log?.action || ''))
      return runtime.finish(tx, command, state, { outcome: 'already-recorded' });
    if (command.input.automatic)
      await runtime.addCall(tx, command, 'slack', 20001, {
        description: `⏱️ Order wait time exceeded for ID: ${command.state.orderId}`,
      });
    const decision = passDecision({
      nextStoreIds: command.snapshot.nextStoreIds,
      isTransferred: command.snapshot.isTransferred,
      automatic: command.input.automatic,
      cutoff: runtime.options.HYPERLOCAL_CUT_OFF_SWITCH,
    });
    if (decision === 'convert') return beginConversion(runtime, tx, command, context);
    requireProvider(runtime, 'online-convert');
    const own = heldLines(state.reservations, command.state.storeId);
    if (own.length !== context.selected.length)
      throw new AppError(
        409,
        'LOCAL_DELIVERY_RESERVATIONS_UNCONFIRMED',
        'Reconcile the original order reservations before passing this delivery.',
      );
    const lines = context.selected.map((line) => ({
        hasProductId: line.id,
        productId: line.productId,
        quantity: line.quantity,
      })),
      operations: Parameters<typeof inventory>[5] = [
        {
          kind: 'release',
          storeId: command.state.storeId,
          lines: own,
          comment: `Hyperlocal order transferred, inventory unhold for order ${command.state.orderId}`,
        },
        ...command.snapshot.nextStoreIds.map((storeId) => ({
          kind: 'hold' as const,
          storeId,
          lines,
          comment: `Hyperlocal order transferred, inventory hold for order ${command.state.orderId}`,
        })),
      ],
      result = await inventory(runtime, tx, command, state, requestId, operations);
    await tx
      .update(Order)
      .set({ is_transfer: 1 })
      .where(eq(Order.id, BigInt(command.state.orderId)));
    await tx
      .update(OrderAddon)
      .set({ order_transferred_timestamp: runtime.timestamp() })
      .where(eq(OrderAddon.order_id, BigInt(command.state.orderId)));
    for (const storeId of command.snapshot.nextStoreIds) {
      await runtime.notice(tx, {
        eventId: eventId('local-delivery-transfer-notice', command.id, storeId),
        orderId: command.state.orderId,
        storeId,
        title: 'Hyperlocal Order Transferred',
        reason: command.input.reason,
        newOrder: false,
        timestamp: runtime.timestamp(),
        requestId,
      });
      const [store] = await tx
        .select({ name: Store.store_name })
        .from(Store)
        .where(eq(Store.id, BigInt(storeId)))
        .limit(1)
        .for('share');
      if (!store) throw reconciliation();
      const title =
          `Hyperlocal Order Transferred to ${store.name}` +
          (command.input.reason ? ` | Reason: ${command.input.reason}` : ''),
        message =
          `❌ 🛵 Order Id: ${command.state.orderId}, ${title}` +
          (command.input.staffName ? ` | Staff User : ${command.input.staffName}` : '');
      await addStoreSlack(
        runtime,
        tx,
        command,
        20010 + 2 * command.snapshot.nextStoreIds.indexOf(storeId),
        storeId,
        message,
      );
    }
    const now = runtime.clock().toZonedDateTimeISO(runtime.config.BUSINESS_TIMEZONE),
      cutoff = now
        .toPlainDate()
        .toPlainDateTime(Temporal.PlainTime.from(runtime.options.HYPERLOCAL_CUT_OFF_TIME))
        .toZonedDateTime(runtime.config.BUSINESS_TIMEZONE),
      due = runtime.options.HYPERLOCAL_CUT_OFF_SWITCH
        ? runtime.instant() +
          Math.max(0, Math.trunc(Number(cutoff.epochNanoseconds - now.epochNanoseconds) / 1e9)) *
            1000
        : runtime.instant() + (await bufferSeconds(tx)) * 1000;
    await runtime.addJob(tx, command, 'auto-convert', due, requestId);
    await runtime.audit(
      tx,
      command,
      context,
      `Hyperlocal Order has been Transferred to the other stores, ${pythonLocationIds(command.snapshot.rawNextIds)}`,
    );
    return runtime.finish(tx, command, result.state, {
      outcome: 'transferred',
      nextJobAt: due,
      nextStoreIds: command.snapshot.nextStoreIds,
    });
  }
  if (action === 'create') {
    if (BigInt(command.state.storeId) > 2147483647n) throw reconciliation();
    if (['ACCEPTED', 'DECLINED', 'CONVERT_ONLINE'].includes(log?.action || ''))
      return runtime.finish(tx, command, state, {
        outcome: 'already-recorded',
        courierOrderId: log?.borzoId && log.borzoId > 0n ? String(log.borzoId) : null,
      });
    if (context.order.orderStatus !== 1n) throw reconciliation();
    if (heldLines(state.reservations, command.state.storeId).length !== context.selected.length)
      throw new AppError(
        409,
        'LOCAL_DELIVERY_RESERVATIONS_UNCONFIRMED',
        'Reconcile the order reservations before accepting this delivery.',
      );
    requireProvider(
      runtime,
      'borzo-create',
      ...(context.order.split ? [] : ['order-producer' as const]),
    );
    await assertDeliveryAuditText(
      tx,
      `Hyperlocal Order Created in Borzo, Order location : ${context.store.name}`,
    );
    await runtime.addCall(tx, command, 'borzo-create', 0);
    return runtime.save(tx, command, { phase: 'queued' }, 'create-provider');
  }
  if (action === 'convert') {
    const blocked =
      command.input.platform === 'CONVERT_ONLINE'
        ? ['ACCEPTED', 'DECLINED', 'CONVERT_ONLINE']
        : ['DECLINED', 'CONVERT_ONLINE'];
    if (blocked.includes(log?.action || ''))
      return runtime.finish(tx, command, state, { outcome: 'already-recorded' });
    if (
      command.input.platform === 'RTO_CONVERT_ONLINE' &&
      !(log?.rto || [28n, 29n].includes(context.order.orderStatus!))
    )
      throw new AppError(
        409,
        'LOCAL_DELIVERY_RTO_UNCONFIRMED',
        'This delivery is not eligible for return conversion.',
      );
    return beginConversion(runtime, tx, command, context);
  }
  if (action === 'cancel' || action === 'observer-cancel')
    return beginCancellation(runtime, tx, command, context);
  throw reconciliation();
}
