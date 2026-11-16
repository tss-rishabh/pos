import { Temporal } from '@js-temporal/polyfill';
import { asc, eq, sql } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { OrderAddon } from '../../../db/legacy-schema.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { legacyCommands } from '../schema.js';
import { lifecycleAuthority, assertSnapshot } from './authority.js';
import { deliveryAudit } from './audit.js';
import {
  deliverySnapshot,
  lifecycleOrderState,
  lifecycleReceipt,
  providerRequest,
  type LifecycleActor,
  type LifecycleOrderState,
  type LifecycleReceipt,
  type ProviderKind,
  type ProviderRequest,
} from './contracts.js';
import { storedLifecycleInput } from './command-input.js';
import { eventId, providerRequestHash, reconciliation } from './domain.js';
import { lifecycleInventory, type LifecycleInventoryOptions } from './inventory.js';
import { deliveryNotice } from './notice.js';
import type { LegacyLifecycleOptions } from './options.js';
import type { LegacyProvider } from './provider.js';
import { deliveryCalls, deliveryCommands, deliveryJobs, deliveryOrders } from './schema.js';
import { assertInitialDeliveryLogContract } from './source-log.js';

export type DeliveryCommand = typeof deliveryCommands.$inferSelect;
export function parsedCommand(row: DeliveryCommand): DeliveryCommand {
  if (row.phase !== row.state.phase) throw reconciliation();
  return {
    ...row,
    state: lifecycleReceipt.parse(row.state),
    snapshot: deliverySnapshot.parse(row.snapshot),
    input: storedLifecycleInput.parse(row.input),
  };
}
export interface LifecycleDependencies extends LifecycleInventoryOptions {
  provider: LegacyProvider;
  clock?: () => Temporal.Instant;
}
export function lifecycleRuntime(
  config: Config,
  db: Databases,
  options: LegacyLifecycleOptions,
  dependencies: LifecycleDependencies,
) {
  const clock = dependencies.clock || (() => Temporal.Now.instant()),
    authority = lifecycleAuthority(config, db),
    inventory = lifecycleInventory(dependencies),
    notice = deliveryNotice(config, db);
  const instant = () => clock().epochMilliseconds,
    timestamp = () =>
      clock()
        .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' })
        .replace('T', ' ');
  const actor = (command: DeliveryCommand): LifecycleActor =>
    command.state.recoveryActorId
      ? { kind: 'operator', id: command.state.recoveryActorId }
      : command.state.actorId === 'service'
        ? { kind: 'service', id: 'service' }
        : { kind: 'operator', id: command.state.actorId };
  const api = {
    config,
    db,
    options,
    dependencies,
    clock,
    instant,
    timestamp,
    authority,
    inventory,
    notice,
    actor,
    async command(tx: AdministrationTransaction, id: string) {
      const [row] = await tx
        .select()
        .from(deliveryCommands)
        .where(eq(deliveryCommands.id, id))
        .limit(1)
        .for('update');
      if (!row) throw reconciliation();
      return parsedCommand(row);
    },
    async orderState(tx: AdministrationTransaction, orderId: string, initialStoreId: string) {
      const state = lifecycleOrderState.parse({
        version: 1,
        orderId,
        initialStoreId,
        activeCommandId: null,
        reservations: [],
        acceptedStoreId: null,
        arrivalCommandId: null,
        rtoCommandId: null,
      });
      await tx
        .insert(deliveryOrders)
        .values({ orderId: BigInt(orderId), state, version: 1, updatedAt: instant() })
        .onDuplicateKeyUpdate({ set: { orderId: BigInt(orderId) } });
      const [row] = await tx
        .select()
        .from(deliveryOrders)
        .where(eq(deliveryOrders.orderId, BigInt(orderId)))
        .limit(1)
        .for('update');
      if (!row) throw reconciliation();
      const parsed = lifecycleOrderState.parse(row.state);
      if (parsed.orderId !== orderId) throw reconciliation();
      return parsed;
    },
    async saveOrder(tx: AdministrationTransaction, state: LifecycleOrderState) {
      await tx
        .update(deliveryOrders)
        .set({
          state: lifecycleOrderState.parse(state),
          version: sql`${deliveryOrders.version}+1`,
          updatedAt: instant(),
        })
        .where(eq(deliveryOrders.orderId, BigInt(state.orderId)));
    },
    async save(
      tx: AdministrationTransaction,
      command: DeliveryCommand,
      update: Partial<LifecycleReceipt>,
      stage = command.stage,
    ) {
      const next = lifecycleReceipt.parse({
        ...command.state,
        ...update,
        version: command.state.version + 1,
        updatedAt: instant(),
      });
      await tx
        .update(deliveryCommands)
        .set({ state: next, stage, phase: next.phase })
        .where(eq(deliveryCommands.id, command.id));
      command.state = next;
      command.stage = stage;
      return next;
    },
    async finish(
      tx: AdministrationTransaction,
      command: DeliveryCommand,
      state: LifecycleOrderState,
      update: Partial<LifecycleReceipt>,
    ) {
      const next = await api.save(
        tx,
        command,
        { ...update, phase: 'completed', errorCode: null },
        'done',
      );
      await tx
        .update(legacyCommands)
        .set({ result: next })
        .where(eq(legacyCommands.id, command.id));
      await api.saveOrder(tx, {
        ...state,
        activeCommandId: state.activeCommandId === command.id ? null : state.activeCommandId,
      });
      return next;
    },
    async context(tx: AdministrationTransaction, command: DeliveryCommand) {
      const subject: LifecycleActor = actor(command),
        current = await authority.context(
          tx,
          subject,
          command.state.storeId,
          command.state.orderId,
          {
            allowBackup: command.state.action === 'create',
            checkedIn: subject.kind === 'operator',
          },
        );
      assertSnapshot(command.snapshot, current.snapshot);
      if (!current.logs.length) await assertInitialDeliveryLogContract(tx);
      if (command.state.recoveryActorId) {
        const operator = await authority.operator(tx, subject);
        if (operator.id !== command.state.recoveryActorId || operator.role < 1 || operator.role > 4)
          throw reconciliation();
      }
      if (
        ['create', 'cancel', 'observer-cancel'].includes(command.state.action) &&
        subject.kind === 'operator' &&
        BigInt(subject.id) > 2147483647n
      )
        throw reconciliation();
      return current;
    },
    async addCall(
      tx: AdministrationTransaction,
      command: DeliveryCommand,
      kind: ProviderKind,
      sequence: number,
      extra: Partial<ProviderRequest> = {},
    ) {
      const id = eventId('local-delivery-provider', command.id, String(sequence), kind),
        request = providerRequest.parse({
          id,
          commandId: command.id,
          kind,
          orderId: command.state.orderId,
          storeId: command.state.storeId,
          customerId: command.snapshot.customerId,
          productId: null,
          split: command.snapshot.split,
          reason: command.input.reason,
          platform: command.state.action === 'observer-cancel' ? 'webhook' : '',
          newOrderId: command.state.newOrderId,
          subject: '',
          description: '',
          customerName: '',
          ...extra,
        }),
        requestHash = providerRequestHash(request);
      await tx
        .insert(deliveryCalls)
        .values({
          id,
          commandId: command.id,
          sequence,
          request,
          requestHash,
          status: 'PENDING',
          attempts: 0,
          createdAt: instant(),
        })
        .onDuplicateKeyUpdate({ set: { commandId: command.id } });
      const [existing] = await tx
        .select({ requestHash: deliveryCalls.requestHash })
        .from(deliveryCalls)
        .where(eq(deliveryCalls.id, id))
        .limit(1)
        .for('share');
      if (existing?.requestHash !== requestHash) throw reconciliation();
      if (!command.state.providerCallIds.includes(id))
        await api.save(tx, command, {
          providerCallIds: [...command.state.providerCallIds, id],
          integrationState: 'pending',
        });
      return id;
    },
    async addJob(
      tx: AdministrationTransaction,
      command: DeliveryCommand,
      kind: 'advance-notification' | 'auto-transfer' | 'auto-convert',
      dueAt: number,
      requestId: string,
    ) {
      const id = eventId('local-delivery-job', command.id, kind);
      await tx
        .insert(deliveryJobs)
        .values({
          id,
          commandId: command.id,
          orderId: BigInt(command.state.orderId),
          storeId: BigInt(command.state.storeId),
          kind,
          status: 'PENDING',
          dueAt,
          requestId,
        })
        .onDuplicateKeyUpdate({ set: { id } });
      return id;
    },
    async audit(
      tx: AdministrationTransaction,
      command: DeliveryCommand,
      context: Awaited<ReturnType<typeof authority.context>>,
      comment: string,
      sourceActor: string = '0',
      payment?: Record<string, number>,
    ) {
      const id = await deliveryAudit(tx, {
        orderId: command.state.orderId,
        storeId: command.state.storeId,
        operatorId: sourceActor,
        orderStatus: context.order.orderStatus!,
        paymentStatus: context.order.paymentStatus!,
        comment,
        timestamp: timestamp(),
        payment,
      });
      await api.save(tx, command, { auditIds: [...command.state.auditIds, id] });
      return id;
    },
    async calls(tx: AdministrationTransaction, command: DeliveryCommand) {
      return tx
        .select()
        .from(deliveryCalls)
        .where(eq(deliveryCalls.commandId, command.id))
        .orderBy(asc(deliveryCalls.sequence))
        .for('update');
    },
    async setSuccessTimestamp(tx: AdministrationTransaction, orderId: string, value: string) {
      await tx
        .update(OrderAddon)
        .set({ order_success_timestamp: value })
        .where(eq(OrderAddon.order_id, BigInt(orderId)));
    },
  };
  return api;
}
export type LifecycleRuntime = ReturnType<typeof lifecycleRuntime>;
