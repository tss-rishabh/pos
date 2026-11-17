import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { PosUser, OrderStore } from '../../db/legacy-schema.js';
import { currentAuthenticationVersion } from '../../auth/revocation.js';
import { assertCurrentStoreAccess } from '../administration/authorization.js';
import { retryTransaction } from '../../db/retry.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { returnOperations } from '../checkout/return-workflow/schema.js';
import { returnOperationSchema } from '../checkout/return-workflow/contracts.js';
import { wholeOrderStatusAuthority, legacyWholeRequestCovers } from './authority.js';
import { wholeOrderStatusCommands } from './schema.js';
import {
  commandInput,
  immutableScopeHash,
  requiredStages,
  sourceStatusBody,
  sourceStatusPresentation,
  statusDigest,
  statusReconciliation,
  statusState,
  unknownStatusOutcome,
  receiptSchema,
  type StatusPlatform,
  type StatusReceipt,
} from './domain.js';
import type { AssertHandoverAvailable } from './handover.js';
type Command = typeof wholeOrderStatusCommands.$inferSelect;
export function publicStatusCommand(row: Command) {
  return {
    operationId: row.id,
    storeId: row.storeId,
    orderId: row.orderId,
    platform: row.platform,
    source: row.source,
    returnOperationId: row.returnOperationId,
    state: statusState.parse(row.state),
    requestHash: row.requestHash,
    lineCount: row.snapshot.lines.length,
    receipt: row.receipt,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    message:
      row.state === 'PENDING' || row.state === 'QUEUED'
        ? 'Request has been queued for processing'
        : row.state === 'SUCCEEDED'
          ? 'All requested fulfillment stages completed.'
          : row.state === 'BLOCKED'
            ? 'The status request was not sent.'
            : row.state === 'UNCERTAIN'
              ? 'The status outcome needs reconciliation.'
              : row.state === 'REJECTED'
                ? 'The status request was rejected.'
                : 'The status receipt is being verified.',
  };
}
export function wholeOrderStatusRepository(
  config: Config,
  db: Databases,
  clock: () => number = Date.now,
  barrier?: AssertHandoverAvailable,
) {
  const capture = wholeOrderStatusAuthority(config, db, barrier),
    stamp = () =>
      Temporal.Instant.fromEpochMilliseconds(clock())
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime()
        .toString({ smallestUnit: 'millisecond' })
        .replace('T', ' ');
  async function receiptAccess(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
  ) {
    await assertCurrentStoreAccess(tx, user.id, storeId);
    const [actor] = await tx
      .select()
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(user.id)))
      .limit(1)
      .for('share');
    const [association] = await tx
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
        'WHOLE_ORDER_STATUS_SCOPE_CHANGED',
        'Your current order permissions changed.',
      );
    return currentAuthenticationVersion(tx, actor);
  }
  async function existing(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
    id: string,
  ) {
    const [row] = await tx
      .select()
      .from(wholeOrderStatusCommands)
      .where(eq(wholeOrderStatusCommands.id, id))
      .limit(1)
      .for('update');
    if (!row) return null;
    if (row.operatorId !== user.id || row.storeId !== storeId || row.orderId !== orderId)
      throw new AppError(
        409,
        'WHOLE_ORDER_STATUS_COMMAND_CONFLICT',
        'This operation identifier belongs to another status request.',
      );
    return row;
  }
  async function create(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
    input: { operationId: string; platform: StatusPlatform; scopeHash?: string },
    source: 'manual' | 'return-failure',
    returnOperationId: string | null,
    requestId?: string,
  ) {
    await receiptAccess(tx, user, storeId, orderId);
    const saved = await existing(tx, user, storeId, orderId, input.operationId);
    if (saved) {
      if (
        saved.platform !== input.platform ||
        saved.source !== source ||
        saved.returnOperationId !== returnOperationId ||
        (input.scopeHash !== undefined && input.scopeHash !== saved.scopeHash)
      )
        throw new AppError(
          409,
          'WHOLE_ORDER_STATUS_COMMAND_CONFLICT',
          'This operation already has a different immutable request.',
        );
      return saved;
    }
    const fresh = await capture(tx, user, storeId, orderId, true),
      snapshot = fresh.snapshot,
      scopeHash = immutableScopeHash(snapshot),
      effectKey = statusDigest([orderId, input.platform, scopeHash]),
      requestHash = statusDigest(sourceStatusBody(snapshot, input.platform));
    if (input.scopeHash !== undefined && input.scopeHash !== fresh.scopeHash)
      throw new AppError(
        409,
        'WHOLE_ORDER_STATUS_SCOPE_CHANGED',
        'This whole-order line set changed. Refresh before requesting a status.',
      );
    if (
      source === 'manual' &&
      sourceStatusPresentation(fresh.logs)[input.platform].status === 'SUCCESS'
    )
      throw new AppError(
        409,
        'WHOLE_ORDER_STATUS_ALREADY_SUCCESSFUL',
        'This source stage already reports success. Refresh its status.',
      );
    // The legacy sync worker skips ANY order/platform SUCCESS. A partial row must
    // not cause it to certify an unprocessed whole order or a different HP set.
    for (const log of fresh.logs.filter(
      (row) =>
        row.status === 'SUCCESS' &&
        row.platform !== null &&
        requiredStages(input.platform).includes(row.platform as StatusPlatform),
    )) {
      if (!legacyWholeRequestCovers(log.request, snapshot, log.platform!))
        throw statusReconciliation();
    }
    const [active] = await tx
      .select({ id: wholeOrderStatusCommands.id })
      .from(wholeOrderStatusCommands)
      .where(
        and(
          eq(wholeOrderStatusCommands.orderId, orderId),
          inArray(wholeOrderStatusCommands.state, ['PENDING', 'SENDING', 'QUEUED', 'UNCERTAIN']),
        ),
      )
      .limit(1)
      .for('update');
    if (active)
      throw new AppError(
        409,
        'WHOLE_ORDER_STATUS_REQUEST_EXISTS',
        'A whole-order status chain is already active or uncertain. Refresh its receipt.',
      );
    const [effect] = await tx
      .select({ id: wholeOrderStatusCommands.id })
      .from(wholeOrderStatusCommands)
      .where(eq(wholeOrderStatusCommands.effectKey, effectKey))
      .limit(1)
      .for('update');
    if (effect)
      throw new AppError(
        409,
        'WHOLE_ORDER_STATUS_REQUEST_EXISTS',
        'A matching status request already exists. Refresh this order before continuing.',
      );
    const now = stamp(),
      value: Command = {
        id: input.operationId,
        effectKey,
        operatorId: user.id,
        authVersion: fresh.authVersion,
        storeId,
        orderId,
        platform: input.platform,
        source,
        returnOperationId,
        requestId: requestId ?? null,
        snapshot,
        scopeHash,
        requestHash,
        state: 'PENDING',
        attempts: 0,
        receipt: null,
        errorCode: null,
        claimedAt: null,
        createdAt: now,
        updatedAt: now,
      };
    if (requestId !== undefined)
      z.string()
        .min(1)
        .max(128)
        .regex(/^[\x21-\x7e]+$/)
        .parse(requestId);
    await tx.insert(wholeOrderStatusCommands).values(value);
    return value;
  }
  async function enqueueRejectedReturn(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
    operationId: string,
    returnOperationId: string,
    requestId?: string,
  ) {
    z.uuid().parse(operationId);
    z.uuid().parse(returnOperationId);
    if (operationId !== returnOperationId)
      throw new AppError(
        409,
        'RETURN_REPAIR_IDENTITY_CHANGED',
        'A rejected return retains its original UUID as the repair command identity.',
      );
    const [row] = await tx
      .select()
      .from(returnOperations)
      .where(eq(returnOperations.id, returnOperationId))
      .limit(1)
      .for('update');
    const parsed = returnOperationSchema.safeParse(row?.state);
    if (
      !parsed.success ||
      row?.phase !== 'rejected' ||
      parsed.data.phase !== 'rejected' ||
      parsed.data.operatorId !== user.id ||
      parsed.data.orderId !== orderId ||
      parsed.data.storeId !== storeId ||
      parsed.data.errorCode !== 'RETURN_INBOUND_REJECTED' ||
      parsed.data.uncertainStage !== null
    )
      throw new AppError(
        409,
        'WHOLE_ORDER_RETURN_REPAIR_NOT_PROVEN',
        'A definite rejected inbound return is required for this status repair.',
      );
    return create(
      tx,
      user,
      storeId,
      orderId,
      { operationId, platform: 'PACK' },
      'return-failure',
      returnOperationId,
      requestId,
    );
  }
  async function authorizeIn(tx: AdministrationTransaction, row: Command) {
    if (
      immutableScopeHash(row.snapshot) !== row.scopeHash ||
      statusDigest(sourceStatusBody(row.snapshot, row.platform)) !== row.requestHash ||
      row.orderId !== row.snapshot.orderId ||
      row.storeId !== row.snapshot.storeId
    )
      throw statusReconciliation();
    const actorRows = await tx
        .select({ role: PosUser.role, user_type: PosUser.user_type })
        .from(PosUser)
        .where(and(eq(PosUser.id, BigInt(row.operatorId)), eq(PosUser.is_active, true)))
        .limit(1),
      actor = z
        .array(
          z.object({
            role: z.number().int().min(1).max(5),
            user_type: z.union([z.literal(1), z.literal(2)]),
          }),
        )
        .safeParse(actorRows);
    if (!actor.success || !actor.data[0])
      throw new AppError(
        403,
        'WHOLE_ORDER_STATUS_AUTHORITY_CHANGED',
        'The original operator is no longer authorized.',
      );
    const value = actor.data[0],
      user: Principal = {
        id: row.operatorId,
        role: value.role as Principal['role'],
        userType: value.user_type,
        storeIds: [row.storeId],
        name: '',
        email: '',
      },
      authority = await capture(tx, user, row.storeId, row.orderId, true);
    if (authority.authVersion !== row.authVersion || authority.scopeHash !== row.scopeHash)
      throw new AppError(
        409,
        'WHOLE_ORDER_STATUS_AUTHORITY_CHANGED',
        'The accepted status scope changed before dispatch.',
      );
    return authority;
  }
  return {
    enqueueRejectedReturn,
    async submit(
      user: Principal,
      storeId: string,
      orderId: string,
      raw: unknown,
      requestId?: string,
    ) {
      const input = commandInput.parse(raw);
      return publicStatusCommand(
        await retryTransaction(() =>
          db
            .get('writer')
            .transaction((tx) =>
              create(tx, user, storeId, orderId, input, 'manual', null, requestId),
            ),
        ),
      );
    },
    async repair(
      user: Principal,
      storeId: string,
      orderId: string,
      input: { operationId: string; returnOperationId: string },
      requestId?: string,
    ) {
      return publicStatusCommand(
        await retryTransaction(() =>
          db
            .get('writer')
            .transaction((tx) =>
              enqueueRejectedReturn(
                tx,
                user,
                storeId,
                orderId,
                input.operationId,
                input.returnOperationId,
                requestId,
              ),
            ),
        ),
      );
    },
    async read(user: Principal, storeId: string, orderId: string, id: string) {
      return db.get('writer').transaction(async (tx) => {
        await receiptAccess(tx, user, storeId, orderId);
        const row = await existing(tx, user, storeId, orderId, id);
        if (!row)
          throw new AppError(
            404,
            'WHOLE_ORDER_STATUS_COMMAND_NOT_FOUND',
            'This status operation has not been recorded.',
          );
        return publicStatusCommand(row);
      });
    },
    async status(user: Principal, storeId: string, orderId: string) {
      return db.get('writer').transaction(async (tx) => {
        const authority = await capture(tx, user, storeId, orderId, false),
          commands = await tx
            .select()
            .from(wholeOrderStatusCommands)
            .where(
              and(
                eq(wholeOrderStatusCommands.orderId, orderId),
                eq(wholeOrderStatusCommands.storeId, storeId),
                eq(wholeOrderStatusCommands.operatorId, user.id),
              ),
            )
            .orderBy(sql`${wholeOrderStatusCommands.createdAt} DESC`)
            .limit(25);
        return {
          orderId,
          storeId,
          scopeHash: authority.scopeHash,
          eligible: authority.eligible,
          stages: sourceStatusPresentation(authority.logs),
          commands: commands.map(publicStatusCommand),
        };
      });
    },
    async claim() {
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          const [candidate] = await tx
            .select()
            .from(wholeOrderStatusCommands)
            .where(eq(wholeOrderStatusCommands.state, 'PENDING'))
            .orderBy(wholeOrderStatusCommands.createdAt, wholeOrderStatusCommands.id)
            .limit(1);
          if (!candidate) return null;
          let blocked = false;
          try {
            await authorizeIn(tx, candidate);
          } catch (error: unknown) {
            if (!(error instanceof AppError)) throw error;
            blocked = true;
          }
          const [row] = await tx
            .select()
            .from(wholeOrderStatusCommands)
            .where(
              and(
                eq(wholeOrderStatusCommands.id, candidate.id),
                eq(wholeOrderStatusCommands.state, 'PENDING'),
              ),
            )
            .limit(1)
            .for('update');
          if (!row) return null;
          if (row.attempts !== 0) throw statusReconciliation();
          if (blocked) {
            await tx
              .update(wholeOrderStatusCommands)
              .set({ state: 'BLOCKED', errorCode: 'STATUS_NOT_SENT', updatedAt: stamp() })
              .where(eq(wholeOrderStatusCommands.id, row.id));
            return { ...row, state: 'BLOCKED' as const };
          }
          await tx
            .update(wholeOrderStatusCommands)
            .set({ state: 'SENDING', attempts: 1, claimedAt: stamp(), updatedAt: stamp() })
            .where(eq(wholeOrderStatusCommands.id, row.id));
          return row;
        }),
      );
    },
    async authorizeDispatch(row: Command) {
      return db.get('writer').transaction((tx) => authorizeIn(tx, row));
    },
    async complete(row: Command, receipt: StatusReceipt) {
      receiptSchema.parse(receipt);
      const state =
        receipt.state === 'queued'
          ? 'QUEUED'
          : receipt.state === 'succeeded'
            ? 'SUCCEEDED'
            : receipt.state === 'rejected'
              ? 'REJECTED'
              : 'UNCERTAIN';
      return db.get('writer').transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(wholeOrderStatusCommands)
          .where(eq(wholeOrderStatusCommands.id, row.id))
          .limit(1)
          .for('update');
        if (!current) throw statusReconciliation();
        if (['SUCCEEDED', 'REJECTED'].includes(current.state)) return current.state;
        if (!['SENDING', 'UNCERTAIN', 'QUEUED'].includes(current.state))
          throw statusReconciliation();
        const prior = current.receipt;
        if (
          prior &&
          ((prior.acceptedAt !== null && receipt.acceptedAt !== prior.acceptedAt) ||
            (prior.taskId !== null && receipt.taskId !== prior.taskId) ||
            (prior.completedAt !== null && receipt.completedAt !== prior.completedAt) ||
            prior.stages.some((old) => {
              const next = receipt.stages.find((value) => value.platform === old.platform);
              return (
                !next ||
                Date.parse(next.updatedAt) < Date.parse(old.updatedAt) ||
                (old.status === 'SUCCESS' && next.status !== 'SUCCESS')
              );
            }))
        )
          throw unknownStatusOutcome();
        await tx
          .update(wholeOrderStatusCommands)
          .set({
            state,
            receipt,
            updatedAt: stamp(),
            errorCode: state === 'UNCERTAIN' ? 'REMOTE_STATUS_UNKNOWN' : null,
          })
          .where(eq(wholeOrderStatusCommands.id, row.id));
        return state;
      });
    },
    async failure(row: Command, knownNotSent: boolean) {
      await db
        .get('writer')
        .update(wholeOrderStatusCommands)
        .set({
          state: knownNotSent ? 'BLOCKED' : 'UNCERTAIN',
          errorCode: knownNotSent ? 'STATUS_NOT_SENT' : 'STATUS_OUTCOME_UNKNOWN',
          updatedAt: stamp(),
        })
        .where(
          and(
            eq(wholeOrderStatusCommands.id, row.id),
            eq(wholeOrderStatusCommands.state, 'SENDING'),
          ),
        );
    },
    async expireClaims(timeoutMs: number) {
      const older = Temporal.Instant.fromEpochMilliseconds(clock() - timeoutMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime()
        .toString({ smallestUnit: 'millisecond' })
        .replace('T', ' ');
      await db
        .get('writer')
        .update(wholeOrderStatusCommands)
        .set({ state: 'UNCERTAIN', errorCode: 'STATUS_WORKER_RESULT_UNKNOWN', updatedAt: stamp() })
        .where(
          and(
            eq(wholeOrderStatusCommands.state, 'SENDING'),
            lt(wholeOrderStatusCommands.claimedAt, older),
          ),
        );
    },
    async recoveryContext(user: Principal, storeId: string, orderId: string, id: string) {
      return db.get('writer').transaction(async (tx) => {
        const authVersion = await receiptAccess(tx, user, storeId, orderId),
          row = await existing(tx, user, storeId, orderId, id);
        if (!row)
          throw new AppError(
            404,
            'WHOLE_ORDER_STATUS_COMMAND_NOT_FOUND',
            'This status operation was not found.',
          );
        return { row, binding: statusDigest([user.id, authVersion, row.scopeHash]) };
      });
    },
  };
}
export type WholeOrderStatusRepository = ReturnType<typeof wholeOrderStatusRepository>;
