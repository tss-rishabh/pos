import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { checkInService } from '../administration/checkins.js';
import type { Databases } from '../../db/pools.js';
import { PosUser, OrderStore, Store, Order } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { currentAuthenticationVersion } from '../../auth/revocation.js';
import { retryTransaction } from '../../db/retry.js';
import { assertCurrentStoreAccess } from '../administration/authorization.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import {
  returnOperationSchema,
  type ReturnOperation,
} from '../checkout/return-workflow/contracts.js';
import { returnOperations } from '../checkout/return-workflow/schema.js';
import { statusDigest, type StatusReceipt } from './domain.js';
import type { StatusCommand } from './transport.js';
import { wholeOrderStatusCommands } from './schema.js';
import type { WholeOrderStatusRepository } from './repository.js';
import { returnRepairObligations, returnRepairRecoveries } from './repair-schema.js';
type Obligation = typeof returnRepairObligations.$inferSelect;
/** Retained negative-ack metadata uses the same account/Store→Order lock order. */
export async function lockRejectedReturnScope(
  tx: AdministrationTransaction,
  operatorId: string,
  storeId: string,
  orderId: string,
) {
  await tx
    .select({ id: PosUser.id })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(operatorId)))
    .limit(1)
    .for('share');
  await tx
    .select({ id: Store.id })
    .from(Store)
    .where(eq(Store.id, BigInt(storeId)))
    .limit(1)
    .for('update');
  await tx
    .select({ id: Order.id })
    .from(Order)
    .where(eq(Order.id, BigInt(orderId)))
    .limit(1)
    .for('update');
}
const rejected = (value: ReturnOperation) =>
  value.phase === 'rejected' &&
  value.uncertainStage === null &&
  value.errorCode === 'RETURN_INBOUND_REJECTED';
const rejectedHash = (value: ReturnOperation) =>
  statusDigest([
    value.id,
    value.operatorId,
    value.storeId,
    value.orderId,
    value.lineId,
    value.productId,
    value.customerId,
    value.quantity,
    value.input.operationId,
    value.input.counterId,
    value.kind,
    'RETURN_INBOUND_REJECTED',
  ]);
/** Native rejection receipt only: no transport, stock, warehouse eligibility or handover check. */
export async function recordRejectedReturnRepair(
  tx: AdministrationTransaction,
  user: Principal,
  operation: ReturnOperation,
  dispatcherEnabled = false,
  requestId?: string,
  clock: () => number = Date.now,
) {
  if (!rejected(operation)) return null;
  if (operation.operatorId !== user.id)
    throw new AppError(
      403,
      'RETURN_REPAIR_OWNER_CHANGED',
      'The original return owner could not be confirmed.',
    );
  const [actor] = await tx
    .select()
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(user.id)))
    .limit(1)
    .for('share');
  const valid = actor?.is_active && actor.role === user.role && actor.user_type === user.userType,
    now = clock();
  const value: Obligation = {
    returnId: operation.id,
    commandId: operation.id,
    operatorId: operation.operatorId,
    authVersion: actor
      ? await currentAuthenticationVersion(tx, actor)
      : statusDigest(['missing-actor', user.id]),
    role: user.role,
    userType: user.userType,
    storeId: operation.storeId,
    orderId: operation.orderId,
    counterId: operation.input.counterId,
    rejectionHash: rejectedHash(operation),
    requestId: requestId ?? null,
    state: valid && dispatcherEnabled ? 'PENDING' : 'BLOCKED',
    errorCode: !valid
      ? 'RETURN_REPAIR_ACTOR_CHANGED'
      : !dispatcherEnabled
        ? 'RETURN_REPAIR_DISPATCHER_DISABLED'
        : null,
    version: 1,
    recoveryActorId: null,
    recoveryAuthVersion: null,
    createdAt: now,
    updatedAt: now,
  };
  await tx
    .insert(returnRepairObligations)
    .values(value)
    .onDuplicateKeyUpdate({ set: { returnId: sql`${returnRepairObligations.returnId}` } });
  const [saved] = await tx
    .select()
    .from(returnRepairObligations)
    .where(eq(returnRepairObligations.returnId, operation.id))
    .limit(1)
    .for('update');
  if (
    !saved ||
    saved.rejectionHash !== value.rejectionHash ||
    saved.operatorId !== value.operatorId ||
    saved.storeId !== value.storeId ||
    saved.orderId !== value.orderId
  )
    throw new AppError(
      409,
      'RETURN_REPAIR_RECEIPT_CONFLICT',
      'The retained return-repair receipt changed.',
    );
  return saved;
}
function publicObligation(
  row: Obligation,
  command: typeof wholeOrderStatusCommands.$inferSelect | null,
) {
  return {
    returnOperationId: row.returnId,
    operationId: row.commandId,
    operatorId: row.operatorId,
    storeId: row.storeId,
    orderId: row.orderId,
    state: row.state,
    errorCode: row.errorCode,
    version: row.version,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    command: command
      ? {
          operationId: command.id,
          state: command.state,
          platform: command.platform,
          errorCode: command.errorCode,
        }
      : null,
  };
}
export function rejectedReturnRepairs(
  config: Config,
  db: Databases,
  repository: WholeOrderStatusRepository,
  configuration: {
    enabled: boolean;
    configured: () => void;
    clock?: () => number;
    readReceipt?: (command: StatusCommand) => Promise<StatusReceipt | null>;
  },
) {
  const clock = configuration.clock ?? Date.now,
    writer = () => db.get('writer'),
    checkIns = checkInService(db, config);
  function ready() {
    if (!configuration.enabled)
      throw new AppError(
        503,
        'RETURN_REPAIR_DISPATCHER_DISABLED',
        'The qualified status dispatcher is disabled.',
      );
    configuration.configured();
  }
  async function manager(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
  ) {
    await assertCurrentStoreAccess(tx, user.id, storeId, [1, 2, 3, 4]);
    const [actor] = await tx
        .select()
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(user.id)))
        .limit(1)
        .for('share'),
      [association] = await tx
        .select({ id: OrderStore.id })
        .from(OrderStore)
        .where(and(eq(OrderStore.order, BigInt(orderId)), eq(OrderStore.store, BigInt(storeId))))
        .limit(1)
        .for('share');
    if (
      !actor?.is_active ||
      actor.role !== user.role ||
      actor.user_type !== user.userType ||
      !association
    )
      throw new AppError(
        403,
        'RETURN_REPAIR_MANAGER_CHANGED',
        'Current manager access is required for this repair.',
      );
    return currentAuthenticationVersion(tx, actor);
  }
  async function captureManager(
    user: Principal,
    storeId: string,
    orderId: string,
    returnId: string,
  ) {
    return writer().transaction(async (tx) => {
      const binding = await manager(tx, user, storeId, orderId);
      const [row] = await tx
        .select()
        .from(returnRepairObligations)
        .where(
          and(
            eq(returnRepairObligations.returnId, returnId),
            eq(returnRepairObligations.storeId, storeId),
            eq(returnRepairObligations.orderId, orderId),
          ),
        )
        .limit(1);
      if (!row)
        throw new AppError(
          404,
          'RETURN_REPAIR_NOT_FOUND',
          'This return-repair obligation was not found.',
        );
      const [command] = await tx
        .select()
        .from(wholeOrderStatusCommands)
        .where(eq(wholeOrderStatusCommands.id, row.commandId))
        .limit(1);
      if (
        row.commandId !== row.returnId ||
        (command &&
          (command.id !== row.returnId ||
            command.returnOperationId !== row.returnId ||
            command.source !== 'return-failure' ||
            command.operatorId !== row.operatorId ||
            command.storeId !== row.storeId ||
            command.orderId !== row.orderId ||
            command.authVersion !== row.authVersion ||
            command.snapshot.counterId !== row.counterId))
      )
        throw new AppError(
          409,
          'RETURN_REPAIR_RECEIPT_CONFLICT',
          'The retained repair command binding changed.',
        );
      return { row, command: command ?? null, binding };
    });
  }
  async function read(user: Principal, storeId: string, orderId: string, returnId: string) {
    const initial = await captureManager(user, storeId, orderId, returnId);
    let receiptRefreshError: string | null = null;
    if (
      initial.command &&
      ['SENDING', 'QUEUED', 'UNCERTAIN'].includes(initial.command.state) &&
      configuration.readReceipt
    ) {
      let receipt: StatusReceipt | null = null;
      try {
        receipt = await configuration.readReceipt(initial.command);
      } catch (error: unknown) {
        receiptRefreshError =
          error instanceof AppError && /^[A-Z0-9_]{1,64}$/.test(error.code)
            ? error.code
            : 'RETURN_REPAIR_RECEIPT_UNKNOWN';
      }
      const fresh = await captureManager(user, storeId, orderId, returnId);
      if (fresh.binding !== initial.binding)
        throw new AppError(
          403,
          'RETURN_REPAIR_MANAGER_CHANGED',
          'Current manager access changed while refreshing the receipt.',
        );
      if (receipt && fresh.command) await repository.complete(fresh.command, receipt);
    }
    const current = await captureManager(user, storeId, orderId, returnId);
    return { ...publicObligation(current.row, current.command), receiptRefreshError };
  }
  async function runOnce() {
    // Called only by an explicitly enabled/configured operational worker.
    ready();
    return retryTransaction(() =>
      writer().transaction(async (tx) => {
        const [candidate] = await tx
          .select()
          .from(returnRepairObligations)
          .where(eq(returnRepairObligations.state, 'PENDING'))
          .orderBy(returnRepairObligations.createdAt, returnRepairObligations.returnId)
          .limit(1);
        if (!candidate) return null;
        await lockRejectedReturnScope(
          tx,
          candidate.operatorId,
          candidate.storeId,
          candidate.orderId,
        );
        await tx
          .select({ id: returnOperations.id })
          .from(returnOperations)
          .where(eq(returnOperations.id, candidate.returnId))
          .limit(1)
          .for('update');
        const [row] = await tx
          .select()
          .from(returnRepairObligations)
          .where(
            and(
              eq(returnRepairObligations.returnId, candidate.returnId),
              eq(returnRepairObligations.state, 'PENDING'),
            ),
          )
          .limit(1)
          .for('update');
        if (!row) return null;
        try {
          await tx.transaction(async (scope) => {
            const [actor] = await scope
              .select()
              .from(PosUser)
              .where(eq(PosUser.id, BigInt(row.operatorId)))
              .limit(1)
              .for('share');
            if (
              !actor?.is_active ||
              actor.role !== row.role ||
              actor.user_type !== row.userType ||
              (await currentAuthenticationVersion(scope, actor)) !== row.authVersion
            )
              throw new AppError(
                403,
                'RETURN_REPAIR_ACTOR_CHANGED',
                'The original repair authority changed.',
              );
            if (row.recoveryActorId) {
              const [managerActor] = await scope
                .select()
                .from(PosUser)
                .where(eq(PosUser.id, BigInt(row.recoveryActorId)))
                .limit(1);
              if (
                !managerActor?.is_active ||
                (await currentAuthenticationVersion(scope, managerActor)) !==
                  row.recoveryAuthVersion
              )
                throw new AppError(
                  403,
                  'RETURN_REPAIR_MANAGER_CHANGED',
                  'The recovery manager authority changed.',
                );
              await assertCurrentStoreAccess(scope, row.recoveryActorId, row.storeId, [1, 2, 3, 4]);
              await checkIns.assertCheckIn(row.recoveryActorId, row.storeId, undefined, scope);
            }
            const [saved] = await scope
                .select()
                .from(returnOperations)
                .where(eq(returnOperations.id, row.returnId))
                .limit(1)
                .for('update'),
              parsedOperation = returnOperationSchema.safeParse(saved?.state);
            if (!parsedOperation.success)
              throw new AppError(
                409,
                'RETURN_REPAIR_SOURCE_CHANGED',
                'The retained rejected-return receipt could not be verified.',
              );
            const operation = parsedOperation.data;
            if (
              saved?.phase !== 'rejected' ||
              !rejected(operation) ||
              rejectedHash(operation) !== row.rejectionHash
            )
              throw new AppError(
                409,
                'RETURN_REPAIR_SOURCE_CHANGED',
                'The original definite rejection changed.',
              );
            const user: Principal = {
              id: row.operatorId,
              role: row.role as Principal['role'],
              userType: row.userType === 1 ? 1 : 2,
              storeIds: [row.storeId],
              name: '',
              email: '',
            };
            const command = await repository.enqueueRejectedReturn(
              scope,
              user,
              row.storeId,
              row.orderId,
              row.commandId,
              row.returnId,
              row.requestId ?? undefined,
            );
            const line = command.snapshot.lines.find((value) => value.id === operation.lineId);
            if (
              operation.input.operationId !== operation.id ||
              command.snapshot.customerId !== operation.customerId ||
              !line ||
              line.productId !== operation.productId ||
              line.quantity !== String(operation.quantity)
            )
              throw new AppError(
                409,
                'RETURN_REPAIR_SOURCE_CHANGED',
                'The original rejected customer or line changed.',
              );
          });
          await tx
            .update(returnRepairObligations)
            .set({ state: 'LINKED', errorCode: null, version: row.version + 1, updatedAt: clock() })
            .where(eq(returnRepairObligations.returnId, row.returnId));
        } catch (error: unknown) {
          if (!(error instanceof AppError)) throw error;
          await tx
            .update(returnRepairObligations)
            .set({
              state: 'BLOCKED',
              errorCode: /^[A-Z0-9_]{1,64}$/.test(error.code)
                ? error.code
                : 'RETURN_REPAIR_BLOCKED',
              version: row.version + 1,
              updatedAt: clock(),
            })
            .where(eq(returnRepairObligations.returnId, row.returnId));
        }
        const [current] = await tx
          .select()
          .from(returnRepairObligations)
          .where(eq(returnRepairObligations.returnId, row.returnId))
          .limit(1);
        return {
          eventId: 'whole-order-status.return-repair',
          eventInstanceId: row.returnId,
          requestId: row.requestId ?? row.returnId,
          userId: row.operatorId,
          state: current!.state,
          errorCode: current!.errorCode,
        };
      }),
    );
  }
  return {
    runOnce,
    read,
    async list(user: Principal, storeId: string, orderId: string) {
      return writer().transaction(async (tx) => {
        await manager(tx, user, storeId, orderId);
        const rows = await tx
          .select()
          .from(returnRepairObligations)
          .where(
            and(
              eq(returnRepairObligations.storeId, storeId),
              eq(returnRepairObligations.orderId, orderId),
            ),
          )
          .orderBy(sql`${returnRepairObligations.createdAt} DESC`)
          .limit(101);
        if (rows.length > 100)
          throw new AppError(
            413,
            'RETURN_REPAIR_SCOPE_TOO_WIDE',
            'Use the specific return receipt to inspect this order’s repair obligations.',
          );
        return { storeId, orderId, obligations: rows.map((row) => publicObligation(row, null)) };
      });
    },
    async recover(
      user: Principal,
      storeId: string,
      orderId: string,
      returnId: string,
      input: { operationId: string; expectedVersion: number },
    ) {
      z.object({ operationId: z.uuid(), expectedVersion: z.number().int().positive() })
        .strict()
        .parse(input);
      await retryTransaction(() =>
        writer().transaction(async (tx) => {
          const authVersion = await manager(tx, user, storeId, orderId);
          await lockRejectedReturnScope(tx, user.id, storeId, orderId);
          const [row] = await tx
            .select()
            .from(returnRepairObligations)
            .where(
              and(
                eq(returnRepairObligations.returnId, returnId),
                eq(returnRepairObligations.storeId, storeId),
                eq(returnRepairObligations.orderId, orderId),
              ),
            )
            .limit(1)
            .for('update');
          if (!row)
            throw new AppError(
              404,
              'RETURN_REPAIR_NOT_FOUND',
              'This return-repair obligation was not found.',
            );
          await checkIns.assertCheckIn(user.id, storeId, undefined, tx);
          const [prior] = await tx
            .select()
            .from(returnRepairRecoveries)
            .where(eq(returnRepairRecoveries.id, input.operationId))
            .limit(1)
            .for('share');
          if (prior) {
            if (
              prior.returnId !== returnId ||
              prior.actorId !== user.id ||
              prior.expectedVersion !== input.expectedVersion
            )
              throw new AppError(
                409,
                'RETURN_REPAIR_RECOVERY_CONFLICT',
                'This recovery operation belongs to another request.',
              );
            return;
          }
          if (row.state === 'LINKED') return;
          if (row.state !== 'BLOCKED' || row.version !== input.expectedVersion)
            throw new AppError(
              409,
              'RETURN_REPAIR_VERSION_CHANGED',
              'Refresh the repair receipt before recovering it.',
            );
          let errorCode: string | null = null;
          try {
            ready();
          } catch (error: unknown) {
            if (!(error instanceof AppError)) throw error;
            errorCode = error.code;
          }
          await tx.insert(returnRepairRecoveries).values({
            id: input.operationId,
            returnId,
            actorId: user.id,
            expectedVersion: input.expectedVersion,
            createdAt: clock(),
          });
          await tx
            .update(returnRepairObligations)
            .set({
              state: errorCode ? 'BLOCKED' : 'PENDING',
              errorCode,
              version: row.version + 1,
              recoveryActorId: user.id,
              recoveryAuthVersion: authVersion,
              updatedAt: clock(),
            })
            .where(eq(returnRepairObligations.returnId, returnId));
        }),
      );
      return read(user, storeId, orderId, returnId);
    },
  };
}
