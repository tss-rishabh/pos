import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { Store } from '../../../db/legacy-schema.js';
import { retryTransaction } from '../../../db/retry.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { amount, minorUnits } from '../../../domain/money.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { operationHash } from '../crypto.js';
import type {
  PaymentReversalInput,
  PaymentReversalReceipt,
  PaymentReversalOptions,
} from './contracts.js';
import {
  cashReturnAttestInput,
  cashReturnCancelInput,
  cashReturnIntentContract,
  cashReturnPrepareInput,
  type CashReturnAction,
  type CashReturnIntentBody,
  type CashReturnPrepareInput,
} from './intent-contracts.js';
import {
  advanceIntentControl,
  advanceFinancialControl,
  assertIntentSession,
  canonicalInstant,
  instantSql,
  intentHash,
  intentReview,
  publicIntent,
  verifiedIntent,
} from './intent-evidence.js';
import { cashReturnControlHeads } from './intent-guards.js';
import { cashReturnCommands, cashReturnIntents } from './intent-schema.js';

type Transaction = AdministrationTransaction;
export interface CashReturnSnapshot {
  counterId: string;
  snapshotHash: string;
  originalPaymentId: string;
  originalPaymentHash: string;
  returnedCash: string;
  orderDate: string;
  originalFundingAt: string;
}
export interface CashReturnServiceOptions extends PaymentReversalOptions {
  hashSecret: string;
  clock?: () => Temporal.Instant;
  assertCheckIn?: (
    userId: string,
    storeId: string,
    counterId: string | undefined,
    tx: Transaction,
  ) => Promise<void>;
}
type CommandRow = typeof cashReturnCommands.$inferSelect;
export function commandProof(row: Omit<CommandRow, 'proofHash' | 'body'>, secret: string) {
  return operationHash('cash-return.command.v1', row, secret);
}
export function verifiedIntentCommand(row: CommandRow, secret: string) {
  const { proofHash, body, ...fields } = row;
  if (
    row.bodyHash !== intentHash(body, secret) ||
    proofHash !== commandProof(fields, secret) ||
    body.id !== row.intentId
  )
    throw intentReview();
  return body;
}
export async function persistIntent(
  tx: Transaction,
  body: CashReturnIntentBody,
  secret: string,
  zone: string,
  now: string,
) {
  const row = {
    id: body.id,
    orderId: body.orderId,
    storeId: body.storeId,
    counterId: body.counterId,
    preparedBy: body.preparedBy,
    originalPaymentId: body.prepare.originalPaymentId,
    activePaymentId: body.phase === 'CANCELLED' ? null : body.prepare.originalPaymentId,
    correctionId: body.prepare.correctionId,
    cashReturnReceiptId: body.prepare.cashReturnReceiptId,
    phase: body.phase,
    body,
    bodyHash: intentHash(body, secret),
    impactFrom: [
      body.orderDate,
      body.originalFundingAt.slice(0, 10),
      ...(body.armed
        ? [Temporal.Instant.from(body.armed.at).toZonedDateTimeISO(zone).toPlainDate().toString()]
        : []),
    ].sort()[0]!,
    createdAt: instantSql(Temporal.Instant.from(body.preparedAt)),
    updatedAt: now,
  };
  verifiedIntent(row, secret);
  const [existing] = await tx
    .select()
    .from(cashReturnIntents)
    .where(eq(cashReturnIntents.id, body.id))
    .limit(1)
    .for('update');
  if (existing) {
    const previous = verifiedIntent(existing, secret);
    if (previous.preparedHash !== body.preparedHash || body.revision !== previous.revision + 1)
      throw intentReview();
    await tx.update(cashReturnIntents).set(row).where(eq(cashReturnIntents.id, body.id));
  } else {
    // Never upsert a financial intent through a secondary unique key: a colliding
    // correction/receipt/active-payment ID must not overwrite another intent.
    if (body.phase !== 'PREPARED' || body.revision !== 1) throw intentReview();
    await tx.insert(cashReturnIntents).values(row);
  }
}
export async function appendIntentCommand(
  tx: Transaction,
  body: CashReturnIntentBody,
  kind: CashReturnAction,
  id: string,
  userId: string,
  sessionHash: string,
  requestHash: string,
  secret: string,
  now: string,
) {
  const fields = {
    id,
    intentId: body.id,
    kind,
    actorId: userId,
    sessionHash,
    requestHash,
    bodyHash: intentHash(body, secret),
    requestId: currentRequestTrace()?.requestId || null,
    recordedAt: now,
  };
  await tx
    .insert(cashReturnCommands)
    .values({ ...fields, body, proofHash: commandProof(fields, secret) });
}
export function intentReversalInput(body: CashReturnIntentBody): PaymentReversalInput {
  return {
    operationId: body.prepare.correctionId,
    intentId: body.id,
    originalPaymentId: body.prepare.originalPaymentId,
    counterId: body.counterId,
    snapshotHash: body.prepare.snapshotHash,
    cashReturnReceiptId: body.prepare.cashReturnReceiptId,
    returnedCash: body.prepare.returnedCash,
    reason: body.prepare.reason,
    confirmCashReturned: true,
    confirmNoHandover: true,
  };
}
export async function lockAttestedIntent(
  tx: Transaction,
  user: Principal,
  storeId: string,
  orderId: string,
  input: PaymentReversalInput,
  sessionId: string,
  secret: string,
) {
  const sessionHash = await assertIntentSession(tx, user.id, sessionId, secret);
  const [row] = await tx
    .select()
    .from(cashReturnIntents)
    .where(eq(cashReturnIntents.id, z.uuid().parse(input.intentId)))
    .limit(1)
    .for('update');
  if (!row) throw intentReview('CASH_RETURN_INTENT_NOT_FOUND');
  const body = verifiedIntent(row, secret);
  if (
    body.storeId !== storeId ||
    body.orderId !== orderId ||
    !['ATTESTED', 'RECORDED'].includes(body.phase) ||
    operationHash('cash-return.bound-reversal.v1', input, secret) !==
      operationHash('cash-return.bound-reversal.v1', intentReversalInput(body), secret)
  )
    throw intentReview('CASH_RETURN_INTENT_MISMATCH');
  return { body, sessionHash };
}
export async function resolveIntent(
  tx: Transaction,
  body: CashReturnIntentBody,
  receipt: PaymentReversalReceipt,
  user: Principal,
  sessionHash: string,
  secret: string,
  zone: string,
  instant: Temporal.Instant,
) {
  if (body.phase !== 'ATTESTED' || !body.attestation || receipt.id !== body.prepare.correctionId)
    throw intentReview();
  const now = instantSql(instant),
    next: CashReturnIntentBody = {
      ...body,
      revision: body.revision + 1,
      phase: 'RECORDED',
      resolution: {
        actorId: user.id,
        at: canonicalInstant(instant),
        correctionId: receipt.id,
        receiptHash: operationHash('payment-correction.receipt.v1', receipt, secret),
      },
    };
  await persistIntent(tx, next, secret, zone, now);
  await appendIntentCommand(
    tx,
    next,
    'resolve',
    receipt.id,
    user.id,
    sessionHash,
    operationHash(
      'cash-return.resolve.v1',
      { intentId: body.id, correctionId: receipt.id },
      secret,
    ),
    secret,
    now,
  );
  await advanceIntentControl(tx, next, -1, secret, now);
}
export function cashReturnIntentService<Proof>(
  db: Databases,
  config: Config,
  options: CashReturnServiceOptions,
  port: {
    scope: (tx: Transaction, user: Principal, storeId: string, orderId: string) => Promise<Proof>;
    inspect: (
      tx: Transaction,
      storeId: string,
      orderId: string,
      proof: Proof,
    ) => Promise<CashReturnSnapshot>;
    armed?: (tx: Transaction, body: CashReturnIntentBody) => Promise<void>;
  },
) {
  const checks = checkInService(db, config),
    checkIn =
      options.assertCheckIn ??
      ((userId, storeId, counterId, tx) => checks.assertCheckIn(userId, storeId, counterId, tx)),
    clock = options.clock ?? (() => Temporal.Now.instant()),
    secret = options.hashSecret,
    transact = <T>(fn: (tx: Transaction) => Promise<T>) =>
      retryTransaction(() => db.get('writer').transaction(fn));
  const enabled = () => {
    if (options.intentContract !== cashReturnIntentContract || secret.length < 32)
      throw new AppError(
        503,
        'CASH_RETURN_INTENT_CONTRACT_UNVERIFIED',
        'Verify the durable cash-return integration before preparing a handback.',
      );
  };
  async function scope(
    tx: Transaction,
    user: Principal,
    storeId: string,
    orderId: string,
    sessionId: string,
  ) {
    const proof = await port.scope(tx, user, storeId, orderId);
    return { proof, sessionHash: await assertIntentSession(tx, user.id, sessionId, secret) };
  }
  async function locked(tx: Transaction, storeId: string, orderId: string, id: string) {
    const [row] = await tx
      .select()
      .from(cashReturnIntents)
      .where(
        and(
          eq(cashReturnIntents.id, z.uuid().parse(id)),
          eq(cashReturnIntents.storeId, storeId),
          eq(cashReturnIntents.orderId, orderId),
        ),
      )
      .limit(1)
      .for('update');
    if (!row)
      throw new AppError(
        404,
        'CASH_RETURN_INTENT_NOT_FOUND',
        'The original cash-return intent was not found.',
      );
    return verifiedIntent(row, secret);
  }
  async function replay(
    tx: Transaction,
    user: Principal,
    kind: CashReturnAction,
    operationId: string,
    hash: string,
    intentId?: string,
  ) {
    const [row] = await tx
      .select()
      .from(cashReturnCommands)
      .where(eq(cashReturnCommands.id, operationId))
      .limit(1);
    if (!row) return null;
    verifiedIntentCommand(row, secret);
    if (
      row.actorId !== user.id ||
      row.kind !== kind ||
      row.requestHash !== hash ||
      (intentId && row.intentId !== intentId)
    )
      throw intentReview('IDEMPOTENCY_CONFLICT');
    return row;
  }
  const response = (
    body: CashReturnIntentBody,
    command: Pick<CommandRow, 'id' | 'kind' | 'actorId'>,
    newlyArmed = false,
  ) => ({
    operationId: command.id,
    kind: command.kind,
    actorId: command.actorId,
    intent: publicIntent(body),
    newlyArmed,
  });
  async function action(
    user: Principal,
    storeId: string,
    orderId: string,
    id: string,
    sessionId: string,
    kind: 'arm' | 'attest' | 'cancel',
    input: { operationId: string },
    mutate: (
      tx: Transaction,
      body: CashReturnIntentBody,
      proof: Proof,
      sessionHash: string,
    ) => Promise<CashReturnIntentBody>,
  ) {
    const hash = operationHash(
      'cash-return.action.v1',
      { kind, storeId, orderId, intentId: id, userId: user.id, input },
      secret,
    );
    return transact(async (tx) => {
      const auth = await scope(tx, user, storeId, orderId, sessionId),
        body = await locked(tx, storeId, orderId, id),
        previous = await replay(tx, user, kind, input.operationId, hash, id);
      if (
        [body.id, body.prepare.correctionId, body.prepare.cashReturnReceiptId].includes(
          input.operationId,
        )
      )
        throw intentReview('CASH_RETURN_OPERATION_RESERVED');
      if (previous) return response(body, previous);
      const next = await mutate(tx, body, auth.proof, auth.sessionHash),
        now = instantSql(clock());
      await persistIntent(tx, next, secret, config.BUSINESS_TIMEZONE, now);
      await appendIntentCommand(
        tx,
        next,
        kind,
        input.operationId,
        user.id,
        auth.sessionHash,
        hash,
        secret,
        now,
      );
      if (kind !== 'cancel' && next.phase !== body.phase)
        await advanceIntentControl(tx, next, kind === 'arm' ? 1 : 0, secret, now);
      if (kind === 'arm' && body.phase === 'PREPARED' && next.phase === 'RETURN_PENDING')
        await port.armed?.(tx, next);
      await assertIntentSession(tx, user.id, sessionId, secret);
      return response(
        next,
        { id: input.operationId, kind, actorId: user.id },
        kind === 'arm' && body.phase === 'PREPARED' && next.phase === 'RETURN_PENDING',
      );
    });
  }
  return {
    async prepare(
      user: Principal,
      storeId: string,
      orderId: string,
      raw: CashReturnPrepareInput,
      sessionId: string,
    ) {
      enabled();
      const input = cashReturnPrepareInput.parse(raw),
        hash = operationHash(
          'cash-return.prepare-command.v1',
          { userId: user.id, storeId, orderId, input },
          secret,
        );
      return transact(async (tx) => {
        const auth = await scope(tx, user, storeId, orderId, sessionId),
          previous = await replay(tx, user, 'prepare', input.operationId, hash);
        if (previous)
          return response(await locked(tx, storeId, orderId, previous.intentId), previous);
        const snapshot = await port.inspect(tx, storeId, orderId, auth.proof);
        if (
          snapshot.counterId !== input.counterId ||
          snapshot.snapshotHash !== input.snapshotHash ||
          snapshot.originalPaymentId !== input.originalPaymentId ||
          minorUnits(snapshot.returnedCash) !== minorUnits(input.returnedCash)
        )
          throw intentReview('PAYMENT_REVERSAL_STATE_CHANGED');
        const [existing] = await tx
          .select({ id: cashReturnIntents.id })
          .from(cashReturnIntents)
          .where(eq(cashReturnIntents.activePaymentId, input.originalPaymentId))
          .limit(1);
        if (existing) throw intentReview('CASH_RETURN_INTENT_ALREADY_EXISTS');
        const instant = clock(),
          preparedAt = canonicalInstant(instant),
          prepare = { ...input, returnedCash: amount(minorUnits(input.returnedCash)) },
          frozen = {
            id: input.operationId,
            orderId,
            storeId,
            preparedBy: user.id,
            preparedAt,
            prepare,
            originalPaymentHash: snapshot.originalPaymentHash,
            orderDate: snapshot.orderDate,
            originalFundingAt: snapshot.originalFundingAt,
            businessTimezone: config.BUSINESS_TIMEZONE,
          },
          body: CashReturnIntentBody = {
            ...frozen,
            contract: cashReturnIntentContract,
            revision: 1,
            counterId: input.counterId,
            preparedSessionHash: auth.sessionHash,
            preparedHash: operationHash('cash-return.prepared.v1', frozen, secret),
            phase: 'PREPARED',
            armed: null,
            attestation: null,
            cancellation: null,
            resolution: null,
          };
        await cashReturnControlHeads(tx, [storeId], secret, false);
        await persistIntent(tx, body, secret, config.BUSINESS_TIMEZONE, instantSql(instant));
        await advanceFinancialControl(
          tx,
          { storeId, id: body.id, hash: intentHash(body, secret), dates: [] },
          0,
          secret,
          instantSql(instant),
        );
        await appendIntentCommand(
          tx,
          body,
          'prepare',
          input.operationId,
          user.id,
          auth.sessionHash,
          hash,
          secret,
          instantSql(instant),
        );
        await assertIntentSession(tx, user.id, sessionId, secret);
        return response(body, { id: input.operationId, kind: 'prepare', actorId: user.id });
      });
    },
    async arm(
      user: Principal,
      storeId: string,
      orderId: string,
      id: string,
      raw: { operationId: string },
      sessionId: string,
    ) {
      enabled();
      const input = z.object({ operationId: z.uuid() }).strict().parse(raw);
      return action(
        user,
        storeId,
        orderId,
        id,
        sessionId,
        'arm',
        input,
        async (tx, body, proof, sessionHash) => {
          if (body.phase !== 'PREPARED') throw intentReview('CASH_RETURN_ALREADY_PENDING');
          if (body.businessTimezone !== config.BUSINESS_TIMEZONE)
            throw intentReview('CASH_RETURN_TIMEZONE_CHANGED');
          const current = await port.inspect(tx, storeId, orderId, proof);
          if (
            current.snapshotHash !== body.prepare.snapshotHash ||
            current.originalPaymentHash !== body.originalPaymentHash
          )
            throw intentReview('PAYMENT_REVERSAL_STATE_CHANGED');
          return {
            ...body,
            revision: body.revision + 1,
            phase: 'RETURN_PENDING',
            armed: {
              operationId: input.operationId,
              actorId: user.id,
              sessionHash,
              at: canonicalInstant(clock()),
            },
          };
        },
      );
    },
    async attest(
      user: Principal,
      storeId: string,
      orderId: string,
      id: string,
      raw: z.input<typeof cashReturnAttestInput>,
      sessionId: string,
    ) {
      const input = cashReturnAttestInput.parse(raw);
      return action(
        user,
        storeId,
        orderId,
        id,
        sessionId,
        'attest',
        input,
        async (_tx, body, _proof, sessionHash) => {
          if (body.phase !== 'RETURN_PENDING' || !body.armed)
            throw intentReview('CASH_RETURN_ATTESTATION_STATE_CHANGED');
          if (
            input.basis === 'own-return' &&
            (body.armed.actorId !== user.id || body.armed.sessionHash !== sessionHash)
          )
            throw intentReview('CASH_RETURN_ORIGINAL_SESSION_CHANGED');
          const returned = Temporal.Instant.from(input.returnedAt),
            instant = clock();
          if (
            Temporal.Instant.compare(returned, Temporal.Instant.from(body.armed.at)) < 0 ||
            Temporal.Instant.compare(returned, instant) > 0
          )
            throw intentReview('CASH_RETURN_TIME_INVALID');
          const local = returned
              .toZonedDateTimeISO(body.businessTimezone)
              .toPlainDateTime()
              .toString({ smallestUnit: 'second' })
              .replace('T', ' '),
            evidence = {
              intentId: body.id,
              attestationId: input.operationId,
              returnedBy: body.armed.actorId,
              attestedBy: user.id,
              returnedInstant: input.returnedAt,
              returnedAt: local,
              businessDate: local.slice(0, 10),
              businessTimezone: body.businessTimezone,
              preparedHash: body.preparedHash,
            };
          return {
            ...body,
            revision: body.revision + 1,
            phase: 'ATTESTED',
            attestation: {
              operationId: input.operationId,
              actorId: user.id,
              sessionHash,
              at: canonicalInstant(instant),
              input,
              evidence,
            },
          };
        },
      );
    },
    async cancel(
      user: Principal,
      storeId: string,
      orderId: string,
      id: string,
      raw: z.input<typeof cashReturnCancelInput>,
      sessionId: string,
    ) {
      const input = cashReturnCancelInput.parse(raw);
      return action(user, storeId, orderId, id, sessionId, 'cancel', input, async (_tx, body) => {
        if (body.phase !== 'PREPARED') throw intentReview('CASH_RETURN_CANNOT_CANCEL_PENDING');
        return {
          ...body,
          revision: body.revision + 1,
          phase: 'CANCELLED',
          cancellation: {
            operationId: input.operationId,
            actorId: user.id,
            at: canonicalInstant(clock()),
            input,
          },
        };
      });
    },
    async get(user: Principal, storeId: string, orderId: string, id: string, sessionId: string) {
      return transact(async (tx) => {
        await scope(tx, user, storeId, orderId, sessionId);
        return publicIntent(await locked(tx, storeId, orderId, id));
      });
    },
    async command(
      user: Principal,
      storeId: string,
      orderId: string,
      id: string,
      operationId: string,
      sessionId: string,
    ) {
      return transact(async (tx) => {
        await scope(tx, user, storeId, orderId, sessionId);
        const body = await locked(tx, storeId, orderId, id),
          [row] = await tx
            .select()
            .from(cashReturnCommands)
            .where(
              and(
                eq(cashReturnCommands.id, z.uuid().parse(operationId)),
                eq(cashReturnCommands.intentId, id),
              ),
            )
            .limit(1);
        if (!row)
          throw new AppError(
            404,
            'CASH_RETURN_OPERATION_NOT_FOUND',
            'The original cash-return operation was not found.',
          );
        verifiedIntentCommand(row, secret);
        return response(body, row);
      });
    },
    async list(user: Principal, storeId: string, sessionId: string, after?: string, limit = 50) {
      z.number().int().min(1).max(100).parse(limit);
      if (after) z.uuid().parse(after);
      return transact(async (tx) => {
        requireStore(user, storeId);
        await checkIn(user.id, storeId, undefined, tx);
        await assertCurrentStoreAccess(tx, user.id, storeId, [1, 2, 3]);
        await tx
          .select({ id: Store.id })
          .from(Store)
          .where(eq(Store.id, BigInt(storeId)))
          .limit(1)
          .for('share');
        await assertIntentSession(tx, user.id, sessionId, secret);
        const rows = await tx
            .select()
            .from(cashReturnIntents)
            .where(
              and(
                eq(cashReturnIntents.storeId, storeId),
                inArray(cashReturnIntents.phase, ['PREPARED', 'RETURN_PENDING', 'ATTESTED']),
                after ? gt(cashReturnIntents.id, after) : undefined,
              ),
            )
            .orderBy(asc(cashReturnIntents.id))
            .limit(limit + 1),
          data = rows.slice(0, limit).map((row) => publicIntent(verifiedIntent(row, secret)));
        return { data, nextCursor: rows.length > limit ? data.at(-1)!.id : null };
      });
    },
  };
}
