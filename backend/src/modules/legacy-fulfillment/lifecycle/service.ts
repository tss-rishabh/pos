import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { PosTransactionLog } from '../../../db/legacy-schema.js';
import { retryTransaction } from '../../../db/retry.js';
import { AppError } from '../../../domain/errors.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { identifier } from '../../../domain/validation.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { checkInService } from '../../administration/checkins.js';
import { legacyCancellationAudit } from '../domain.js';
import { legacyCommands } from '../schema.js';
import {
  lifecycleAction,
  lifecycleInput,
  lifecycleReceipt,
  commandId,
  providerObservation,
  type LifecycleAction,
  type LifecycleActor,
} from './contracts.js';
import { storedLifecycleInput } from './command-input.js';
import { hash, movementContract, reconciliation } from './domain.js';
import { beginLifecycle, pythonLocationIds } from './transitions.js';
import { finalizeLifecycle } from './finalize.js';
import { freezeCancellation } from './proofs.js';
import { readOrderMovement } from './movement.js';
import { deliveryCalls, deliveryCommands, deliveryOrders } from './schema.js';
import { slackDestination, ticketAcknowledged } from './effects.js';
import { parsedCommand, type LifecycleRuntime } from './runtime.js';
import { resultForRequest } from './provider.js';
import { assertInitialDeliveryLogContract } from './source-log.js';

const recoveryInput = z
  .object({
    commandId,
    expectedVersion: z.number().int().positive(),
    reason: z.string().min(1).max(200),
  })
  .strict();
const actorFor = (user: Principal): LifecycleActor => ({ kind: 'operator', id: user.id });
export function localDeliveryService(runtime: LifecycleRuntime) {
  const checkins = checkInService(runtime.db, runtime.config);
  async function submit(
    subject: LifecycleActor,
    storeId: string,
    orderId: string,
    action: LifecycleAction,
    supplied: unknown,
    requestId: string,
    internal: {
      automatic?: boolean;
      platform?: 'CONVERT_ONLINE' | 'RTO_CONVERT_ONLINE';
      staffName?: string;
      locationIds?: string;
    } = {},
  ) {
    identifier.parse(storeId);
    identifier.parse(orderId);
    lifecycleAction.parse(action);
    const input = lifecycleInput.parse(supplied),
      requestHash = hash([
        1,
        subject,
        storeId,
        orderId,
        action,
        input.reason,
        input.reasonCategory,
        input.notify,
        input.notificationTitle,
        internal.automatic || false,
        internal.platform || '',
        internal.staffName ?? null,
        internal.locationIds ?? null,
      ]);
    if (runtime.options.LEGACY_DELIVERY_MOVEMENT_CONTRACT !== movementContract)
      throw new AppError(
        503,
        'LOCAL_DELIVERY_CONTRACT_UNAVAILABLE',
        'Activate the verified local delivery movement contract before recording these actions.',
      );
    if (!runtime.options.LEGACY_DELIVERY_WORKER_ENABLED)
      throw new AppError(
        503,
        'LOCAL_DELIVERY_WORKER_UNAVAILABLE',
        'Delivery processing is unavailable.',
      );
    return retryTransaction(() =>
      runtime.db.get('writer').transaction(async (tx) => {
        await runtime.authority.actor(tx, subject, storeId, subject.kind === 'operator');
        await tx
          .insert(legacyCommands)
          .values({
            id: input.commandId,
            actorId: subject.id,
            storeId,
            orderId,
            action,
            requestHash,
            requestId,
            createdAt: runtime.instant(),
            result: null,
          })
          .onDuplicateKeyUpdate({ set: { id: input.commandId } });
        const [identity] = await tx
          .select()
          .from(legacyCommands)
          .where(eq(legacyCommands.id, input.commandId))
          .limit(1)
          .for('update');
        if (
          !identity ||
          identity.actorId !== subject.id ||
          identity.orderId !== orderId ||
          identity.storeId !== storeId ||
          identity.action !== action ||
          identity.requestHash !== requestHash
        )
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This command belongs to another operation.',
          );
        const [existing] = await tx
          .select()
          .from(deliveryCommands)
          .where(eq(deliveryCommands.id, input.commandId))
          .limit(1)
          .for('update');
        if (existing) return parsedCommand(existing).state;
        const context = await runtime.authority.context(tx, subject, storeId, orderId, {
            allowBackup: action === 'create',
            checkedIn: subject.kind === 'operator',
          }),
          snapshot = await freezeCancellation(tx, context.snapshot),
          state = await runtime.orderState(tx, orderId, snapshot.ownerStoreId);
        if (!context.logs.length) await assertInitialDeliveryLogContract(tx);
        if (state.activeCommandId && state.activeCommandId !== input.commandId)
          throw new AppError(
            409,
            'LOCAL_DELIVERY_COMMAND_PENDING',
            'Reconcile the pending delivery command before starting another.',
          );
        const priorMovement = await readOrderMovement(tx, orderId, storeId);
        if (['cancel', 'observer-cancel'].includes(action) && state.convertedCommandId)
          throw reconciliation();
        if (
          ['cancel', 'observer-cancel'].includes(action) &&
          context.logs.some((log) => log.action === 'CONVERT_ONLINE')
        )
          throw reconciliation();
        if (
          (!priorMovement || priorMovement.kind === 'rto') &&
          !state.cancellationCommandId &&
          ['cancel', 'observer-cancel'].includes(action)
        ) {
          const [audit] = await tx
            .select({ id: PosTransactionLog.id })
            .from(PosTransactionLog)
            .where(
              and(
                eq(PosTransactionLog.order_id, BigInt(orderId)),
                eq(PosTransactionLog.comment, legacyCancellationAudit),
              ),
            )
            .limit(1)
            .for('share');
          if (audit || context.logs.some((log) => !!log.refunded)) throw reconciliation();
        }
        const operator = await runtime.authority.operator(tx, subject),
          receipt = lifecycleReceipt.parse({
            commandId: input.commandId,
            actorId: subject.id,
            storeId,
            orderId,
            action,
            phase: 'queued',
            version: 1,
            outcome: 'pending',
            nextStoreIds: snapshot.nextStoreIds,
            nextJobAt: null,
            newOrderId: null,
            courierOrderId: null,
            providerCallIds: [],
            auditIds: [],
            inventoryMovementCommandId: null,
            createdAt: runtime.instant(),
            updatedAt: runtime.instant(),
            errorCode: null,
            integrationState: 'not-required',
          }),
          stored = storedLifecycleInput.parse({
            reason: input.reason,
            reasonCategory: input.reasonCategory,
            notify: input.notify,
            notificationTitle: input.notificationTitle,
            automatic: internal.automatic || false,
            platform:
              internal.platform || (action === 'convert' ? 'RTO_CONVERT_ONLINE' : 'CONVERT_ONLINE'),
            staffName:
              internal.staffName ??
              (action === 'pass' && subject.kind === 'operator'
                ? `${operator.firstName} ${operator.lastName}`
                : ''),
            locationIds:
              internal.locationIds ??
              (action === 'pass' && !snapshot.isTransferred
                ? pythonLocationIds(snapshot.rawNextIds)
                : snapshot.rawNextIds),
          });
        const record = {
          id: input.commandId,
          phase: receipt.phase,
          state: receipt,
          snapshot,
          input: stored,
          stage: 'new',
        };
        await tx.insert(deliveryCommands).values(record);
        const next = { ...state, activeCommandId: input.commandId };
        await runtime.saveOrder(tx, next);
        if (state.cancellationCommandId && ['cancel', 'observer-cancel'].includes(action)) {
          const [original] = await tx
              .select({ result: legacyCommands.result })
              .from(legacyCommands)
              .where(eq(legacyCommands.id, state.cancellationCommandId))
              .limit(1)
              .for('share'),
            proof = lifecycleReceipt.safeParse(original?.result);
          if (
            !proof.success ||
            proof.data.phase !== 'completed' ||
            proof.data.outcome !== 'cancelled' ||
            proof.data.storeId !== storeId ||
            proof.data.orderId !== orderId
          )
            throw reconciliation();
          return runtime.finish(tx, record, next, {
            outcome: 'already-recorded',
            inventoryMovementCommandId: proof.data.inventoryMovementCommandId,
          });
        }
        if (
          priorMovement?.kind === 'cancellation' &&
          ['cancel', 'observer-cancel'].includes(action)
        )
          return runtime.finish(tx, record, next, {
            outcome: 'already-recorded',
            inventoryMovementCommandId: priorMovement.receipt.commandId,
          });
        if (priorMovement && !['convert', 'cancel', 'observer-cancel'].includes(action))
          throw reconciliation();
        if (action === 'observer-cancel' && input.notify)
          await runtime.notice(tx, {
            eventId: input.commandId,
            orderId,
            storeId,
            title: input.notificationTitle,
            reason: '',
            newOrder: false,
            timestamp: runtime.timestamp(),
            requestId,
          });
        return beginLifecycle(runtime, tx, record, context, next, requestId);
      }),
    );
  }
  async function apply(id: string) {
    return retryTransaction(() =>
      runtime.db.get('writer').transaction(async (tx) => {
        const command = await runtime.command(tx, id);
        if (command.state.phase === 'completed' || command.state.phase === 'rejected')
          return command.state;
        const context = await runtime.context(tx, command),
          state = await runtime.orderState(
            tx,
            command.state.orderId,
            command.snapshot.ownerStoreId,
          );
        if (state.activeCommandId !== command.id) throw reconciliation();
        const [identity] = await tx
          .select({ requestId: legacyCommands.requestId })
          .from(legacyCommands)
          .where(eq(legacyCommands.id, id))
          .limit(1)
          .for('share');
        if (!identity) throw reconciliation();
        return finalizeLifecycle(runtime, tx, command, context, state, identity.requestId);
      }),
    );
  }
  async function view(user: Principal, id: string) {
    commandId.parse(id);
    return runtime.db.get('writer').transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(deliveryCommands)
        .where(eq(deliveryCommands.id, id))
        .limit(1);
      if (!row)
        throw new AppError(404, 'LOCAL_DELIVERY_COMMAND_NOT_FOUND', 'Delivery command not found.');
      const command = parsedCommand(row);
      requireStore(user, command.state.storeId);
      await assertCurrentStoreAccess(tx, user.id, command.state.storeId);
      const calls = await tx
        .select({ status: deliveryCalls.status })
        .from(deliveryCalls)
        .where(eq(deliveryCalls.commandId, id));
      return {
        ...command.state,
        integrationState: !calls.length
          ? ('not-required' as const)
          : calls.some((call) => call.status === 'UNCERTAIN' || call.status === 'SENDING')
            ? ('uncertain' as const)
            : calls.every((call) => call.status === 'ACKNOWLEDGED')
              ? ('delivered' as const)
              : ('pending' as const),
      };
    });
  }
  return {
    runtime,
    apply,
    view,
    async submit(
      user: Principal,
      storeId: string,
      orderId: string,
      action: 'create' | 'pass' | 'convert' | 'cancel',
      input: unknown,
      requestId: string,
    ) {
      requireStore(user, storeId);
      return submit(actorFor(user), storeId, orderId, action, input, requestId);
    },
    async arrive(storeId: string, orderId: string, input: unknown, requestId: string) {
      return submit(
        { kind: 'service', id: 'service' },
        storeId,
        orderId,
        'arrival',
        input,
        requestId,
        { automatic: true },
      );
    },
    async observeCancellation(storeId: string, orderId: string, input: unknown, requestId: string) {
      return submit(
        { kind: 'service', id: 'service' },
        storeId,
        orderId,
        'observer-cancel',
        input,
        requestId,
        { automatic: true },
      );
    },
    async submitJob(
      storeId: string,
      orderId: string,
      action: 'pass' | 'convert',
      input: unknown,
      requestId: string,
      context: { staffName: string; locationIds: string },
    ) {
      return submit(
        { kind: 'service', id: 'service' },
        storeId,
        orderId,
        action,
        input,
        requestId,
        {
          automatic: true,
          platform: 'CONVERT_ONLINE',
          ...context,
          locationIds: action === 'pass' ? undefined : context.locationIds,
        },
      );
    },
    async capabilities(user: Principal, storeId: string, orderId: string) {
      requireStore(user, storeId);
      return runtime.db.get('writer').transaction(async (tx) => {
        const context = await runtime.authority.context(tx, actorFor(user), storeId, orderId, {
            allowBackup: true,
          }),
          [record] = await tx
            .select()
            .from(deliveryOrders)
            .where(eq(deliveryOrders.orderId, BigInt(orderId)))
            .limit(1),
          state = record?.state,
          checkedIn = (await checkins.checkedInStore(user.id)) === storeId,
          contractReady =
            runtime.options.LEGACY_DELIVERY_WORKER_ENABLED &&
            runtime.options.LEGACY_DELIVERY_MOVEMENT_CONTRACT === movementContract &&
            runtime.inventory.ready(actorFor(user)),
          busy = !!state?.activeCommandId,
          [current] = busy
            ? await tx
                .select()
                .from(deliveryCommands)
                .where(eq(deliveryCommands.id, state!.activeCommandId!))
                .limit(1)
            : [],
          held =
            state?.reservations.filter((row) => row.storeId === storeId && row.state === 'held') ||
            [],
          verifiedHolds = held.length === context.selected.length && context.selected.length > 0,
          action = context.logs[0]?.action || 'NO_ACTION',
          idle = !['ACCEPTED', 'DECLINED', 'CONVERT_ONLINE'].includes(action),
          owner = context.snapshot.ownerStoreId === storeId,
          eligible = checkedIn && contractReady && !busy;
        const initialLogReady =
          context.logs.length > 0 ||
          (await assertInitialDeliveryLogContract(tx)
            .then(() => true)
            .catch(() => false));
        return {
          timeZone: runtime.config.BUSINESS_TIMEZONE,
          orderId,
          storeId,
          ownerStoreId: context.snapshot.ownerStoreId,
          checkedIn,
          contractReady: contractReady && initialLogReady,
          arrivalRecorded: !!state?.arrivalCommandId,
          reservationsVerified: verifiedHolds,
          nextStoreIds: context.snapshot.nextStoreIds,
          canCreate:
            eligible &&
            initialLogReady &&
            idle &&
            verifiedHolds &&
            context.order.orderStatus === 1n &&
            runtime.dependencies.provider.ready('borzo-create'),
          canPass:
            eligible &&
            initialLogReady &&
            owner &&
            idle &&
            verifiedHolds &&
            runtime.dependencies.provider.ready('online-convert'),
          canCancel:
            eligible &&
            initialLogReady &&
            owner &&
            context.order.orderStatus === 1n &&
            runtime.dependencies.provider.ready(
              context.snapshot.split ? 'cancel-item' : 'cancel-order',
            ),
          canConvert:
            eligible &&
            initialLogReady &&
            owner &&
            action === 'ACCEPTED' &&
            !!(context.logs[0]?.rto || [28n, 29n].includes(context.order.orderStatus!)) &&
            runtime.dependencies.provider.ready('online-convert'),
          activeCommand:
            current && current.state.storeId === storeId ? parsedCommand(current).state : null,
          workflowPending: busy,
        };
      });
    },
    async recent(user: Principal, storeId: string, orderId: string) {
      requireStore(user, storeId);
      return runtime.db.get('writer').transaction(async (tx) => {
        await assertCurrentStoreAccess(tx, user.id, storeId);
        const identities = await tx
          .select({ id: legacyCommands.id })
          .from(legacyCommands)
          .where(
            and(
              eq(legacyCommands.storeId, storeId),
              eq(legacyCommands.orderId, orderId),
              inArray(legacyCommands.action, [
                'create',
                'pass',
                'convert',
                'cancel',
                'arrival',
                'observer-cancel',
              ]),
            ),
          )
          .orderBy(desc(legacyCommands.createdAt), asc(legacyCommands.id))
          .limit(20);
        if (!identities.length) return [];
        return (
          await tx
            .select()
            .from(deliveryCommands)
            .where(
              inArray(
                deliveryCommands.id,
                identities.map((row) => row.id),
              ),
            )
        ).map((row) => parsedCommand(row).state);
      });
    },
    async reconcile(user: Principal, id: string, supplied: unknown, requestId: string) {
      const input = recoveryInput.parse(supplied),
        receipt = await retryTransaction(() =>
          runtime.db.get('writer').transaction(async (tx) => {
            const command = await runtime.command(tx, id);
            requireStore(user, command.state.storeId);
            await runtime.authority.actor(tx, actorFor(user), command.state.storeId, true);
            const operator = await runtime.authority.operator(tx, actorFor(user));
            if (operator.role < 1 || operator.role > 4)
              throw new AppError(
                403,
                'MANAGER_REQUIRED',
                'A checked-in manager must reconcile this delivery.',
              );
            const requestHash = hash([1, id, input.expectedVersion, input.reason, user.id]);
            await tx
              .insert(legacyCommands)
              .values({
                id: input.commandId,
                actorId: user.id,
                storeId: command.state.storeId,
                orderId: command.state.orderId,
                action: 'reconcile',
                requestHash,
                requestId,
                createdAt: runtime.instant(),
                result: null,
              })
              .onDuplicateKeyUpdate({ set: { id: input.commandId } });
            const [operation] = await tx
              .select()
              .from(legacyCommands)
              .where(eq(legacyCommands.id, input.commandId))
              .limit(1)
              .for('update');
            if (operation?.requestHash !== requestHash || operation.actorId !== user.id)
              throw new AppError(
                409,
                'IDEMPOTENCY_CONFLICT',
                'This reconciliation belongs to another operation.',
              );
            if (operation.result) return lifecycleReceipt.parse(operation.result);
            if (command.state.version !== input.expectedVersion)
              throw new AppError(
                409,
                'VERSION_CONFLICT',
                'Refresh the delivery command before continuing.',
              );
            const next = await runtime.save(tx, command, { recoveryActorId: user.id });
            await tx
              .update(legacyCommands)
              .set({ result: next })
              .where(eq(legacyCommands.id, input.commandId));
            return next;
          }),
        );
      const calls = await runtime.db
        .get('writer')
        .select()
        .from(deliveryCalls)
        .where(
          and(
            eq(deliveryCalls.commandId, id),
            inArray(deliveryCalls.status, ['UNCERTAIN', 'BLOCKED']),
          ),
        )
        .orderBy(asc(deliveryCalls.sequence))
        .limit(10);
      for (const call of calls) {
        const destination = await runtime.db
          .get('writer')
          .transaction((tx) => slackDestination(runtime, tx, call.request))
          .catch(() => null);
        const observed =
          call.status === 'BLOCKED' &&
          destination !== null &&
          runtime.dependencies.provider.ready(call.request.kind, destination)
            ? {
                status: 'not-sent' as const,
                requestHash: call.requestHash,
                safeToSend: true as const,
              }
            : providerObservation.parse(
                await runtime.dependencies.provider.reconcile(call.request, requestId),
              );
        await retryTransaction(() =>
          runtime.db.get('writer').transaction(async (tx) => {
            const current = await runtime.command(tx, id);
            if (call.sequence >= 10000)
              await runtime.authority.auxiliary(tx, current.snapshot, call.request);
            else await runtime.context(tx, current);
            const [locked] = await tx
              .select()
              .from(deliveryCalls)
              .where(eq(deliveryCalls.id, call.id))
              .limit(1)
              .for('update');
            if (
              !locked ||
              !['UNCERTAIN', 'BLOCKED'].includes(locked.status) ||
              locked.requestHash !== call.requestHash
            )
              return;
            if (observed.status === 'completed' && observed.requestHash === call.requestHash) {
              await tx
                .update(deliveryCalls)
                .set({
                  status: 'ACKNOWLEDGED',
                  result: resultForRequest(call.request.kind, observed.result),
                  completedAt: runtime.instant(),
                })
                .where(eq(deliveryCalls.id, call.id));
              await ticketAcknowledged(runtime, tx, current, call.request);
              if (call.sequence < 10000)
                await runtime.save(tx, current, { phase: 'applying', errorCode: null });
            } else if (
              observed.status === 'not-sent' &&
              observed.requestHash === call.requestHash &&
              locked.attempts < 3
            ) {
              await tx
                .update(deliveryCalls)
                .set({ status: 'PENDING', claimedAt: null })
                .where(eq(deliveryCalls.id, call.id));
              if (call.sequence < 10000)
                await runtime.save(tx, current, { phase: 'queued', errorCode: null });
            }
          }),
        );
      }
      if (receipt.phase !== 'completed')
        try {
          await apply(id);
        } catch {
          /* The durable proof stays available for the next manager reconciliation. */
        }
      return view(user, id);
    },
  };
}
