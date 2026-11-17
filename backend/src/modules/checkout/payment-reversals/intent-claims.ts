import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gt, notExists } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { retryTransaction } from '../../../db/retry.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { amount, minorUnits } from '../../../domain/money.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { operationHash } from '../crypto.js';
import type { PaymentReversalInput, PaymentReversalReceipt } from './contracts.js';
import { cashReturnClaimInput, type CashReturnClaimBody } from './intent-claim-contracts.js';
import { cashReturnClaims, cashReturnClaimResolutions } from './intent-claim-schema.js';
import {
  claimHash,
  claimResolutionProof,
  verifiedClaim,
  verifiedClaimResolution,
} from './intent-claim-evidence.js';
import {
  advanceFinancialControl,
  assertIntentSession,
  canonicalInstant,
  instantSql,
  intentReview,
} from './intent-evidence.js';
import { cashReturnIntents } from './intent-schema.js';
import { verifiedIntent } from './intent-evidence.js';
import type { CashReturnServiceOptions } from './intent-service.js';
type Transaction = AdministrationTransaction;
export const claimReversalInput = (body: CashReturnClaimBody): PaymentReversalInput => ({
  ...body.input.original,
  claimId: body.id,
});
export const publicClaim = (body: CashReturnClaimBody, resolved = false) => ({
  id: body.id,
  origin: 'retained-device' as const,
  phase: resolved ? ('RECORDED' as const) : ('ATTESTED' as const),
  orderId: body.orderId,
  storeId: body.storeId,
  counterId: body.counterId,
  registeredBy: body.registeredBy,
  registeredAt: body.registeredAt,
  returnedBy: body.input.returnedBy,
  returnedAt: body.returnedAt,
  returnedInstant: body.input.returnedAt,
  businessDate: body.businessDate,
  returnedCash: amount(minorUnits(body.input.original.returnedCash)),
  originalPaymentId: body.input.original.originalPaymentId,
  cashReturnReceiptId: body.input.original.cashReturnReceiptId,
});
export const retainedCashEvidence = (body: CashReturnClaimBody, secret: string) => ({
  intentId: body.id,
  attestationId: body.id,
  returnedBy: body.input.returnedBy,
  attestedBy: body.registeredBy,
  returnedInstant: body.input.returnedAt,
  returnedAt: body.returnedAt,
  businessDate: body.businessDate,
  businessTimezone: body.businessTimezone,
  preparedHash: claimHash(body, secret),
  origin: 'retained-device-claim' as const,
});
export async function lockRetainedClaim(
  tx: Transaction,
  user: Principal,
  storeId: string,
  orderId: string,
  input: PaymentReversalInput,
  sessionId: string,
  secret: string,
) {
  const sessionHash = await assertIntentSession(tx, user.id, sessionId, secret),
    [row] = await tx
      .select()
      .from(cashReturnClaims)
      .where(
        and(
          eq(cashReturnClaims.id, input.claimId!),
          eq(cashReturnClaims.storeId, storeId),
          eq(cashReturnClaims.orderId, orderId),
        ),
      )
      .limit(1)
      .for('update');
  if (!row) throw intentReview('CASH_RETURN_CLAIM_NOT_FOUND');
  const body = verifiedClaim(row, secret);
  if (
    operationHash('cash-return.claim-input.v1', input, secret) !==
    operationHash('cash-return.claim-input.v1', claimReversalInput(body), secret)
  )
    throw intentReview('CASH_RETURN_INTENT_MISMATCH');
  const [resolved] = await tx
    .select()
    .from(cashReturnClaimResolutions)
    .where(eq(cashReturnClaimResolutions.id, body.id))
    .limit(1);
  if (resolved) verifiedClaimResolution(resolved, secret);
  return { body, sessionHash, resolved };
}
export async function resolveRetainedClaim(
  tx: Transaction,
  body: CashReturnClaimBody,
  receipt: PaymentReversalReceipt,
  user: Principal,
  sessionHash: string,
  secret: string,
  at: Temporal.Instant,
) {
  if (Temporal.Instant.compare(at, Temporal.Instant.from(body.registeredAt)) < 0)
    throw intentReview('CASH_RETURN_CLOCK_MOVED_BACKWARD');
  if (receipt.id !== body.id || receipt.businessDate !== body.businessDate)
    throw intentReview('CASH_RETURN_RECORDED_DATE_REVIEW_REQUIRED');
  const fields = {
    id: body.id,
    actorId: user.id,
    sessionHash,
    receiptHash: operationHash('payment-correction.receipt.v1', receipt, secret),
    recordedAt: instantSql(at),
    requestId: currentRequestTrace()?.requestId || null,
  };
  await tx
    .insert(cashReturnClaimResolutions)
    .values({ ...fields, proofHash: claimResolutionProof(fields, secret) });
  await advanceFinancialControl(
    tx,
    {
      storeId: body.storeId,
      id: body.id,
      hash: fields.receiptHash,
      dates: [body.orderDate, body.originalFundingAt.slice(0, 10), body.businessDate],
    },
    -1,
    secret,
    instantSql(at),
  );
}
export function retainedCashReturnService<Proof>(
  db: Databases,
  config: Config,
  options: CashReturnServiceOptions,
  port: {
    scope: (tx: Transaction, user: Principal, storeId: string, orderId: string) => Promise<Proof>;
    registered?: (tx: Transaction, body: CashReturnClaimBody) => Promise<void>;
    funding: (
      tx: Transaction,
      storeId: string,
      orderId: string,
      proof: Proof,
      input: z.infer<typeof cashReturnClaimInput>,
    ) => Promise<{ orderDate: string; originalFundingAt: string; originalPaymentHash: string }>;
  },
) {
  const secret = options.hashSecret,
    clock = options.clock ?? (() => Temporal.Now.instant()),
    checks = checkInService(db, config),
    checkIn =
      options.assertCheckIn ??
      ((userId, storeId, counterId, tx) => checks.assertCheckIn(userId, storeId, counterId, tx)),
    transact = <T>(fn: (tx: Transaction) => Promise<T>) =>
      retryTransaction(() => db.get('writer').transaction(fn));
  async function read(tx: Transaction, storeId: string, orderId: string, id: string) {
    const [row] = await tx
      .select()
      .from(cashReturnClaims)
      .where(
        and(
          eq(cashReturnClaims.id, id),
          eq(cashReturnClaims.storeId, storeId),
          eq(cashReturnClaims.orderId, orderId),
        ),
      )
      .limit(1)
      .for('update');
    if (!row)
      throw new AppError(
        404,
        'CASH_RETURN_CLAIM_NOT_FOUND',
        'The retained original cash-return claim was not found.',
      );
    const body = verifiedClaim(row, secret),
      [resolved] = await tx
        .select()
        .from(cashReturnClaimResolutions)
        .where(eq(cashReturnClaimResolutions.id, id))
        .limit(1);
    if (resolved) verifiedClaimResolution(resolved, secret);
    return { body, resolved };
  }
  return {
    async register(
      user: Principal,
      storeId: string,
      orderId: string,
      raw: z.input<typeof cashReturnClaimInput>,
      sessionId: string,
    ) {
      const input = cashReturnClaimInput.parse(raw);
      if (secret.length < 32) throw intentReview('CASH_RETURN_PROOF_KEY_REQUIRED');
      return transact(async (tx) => {
        const proof = await port.scope(tx, user, storeId, orderId),
          sessionHash = await assertIntentSession(tx, user.id, sessionId, secret),
          [existing] = await tx
            .select()
            .from(cashReturnClaims)
            .where(eq(cashReturnClaims.id, input.original.operationId))
            .limit(1)
            .for('update');
        if (existing) {
          const body = verifiedClaim(existing, secret);
          if (
            body.storeId !== storeId ||
            body.orderId !== orderId ||
            operationHash('cash-return.claim-request.v1', body.input, secret) !==
              operationHash('cash-return.claim-request.v1', input, secret)
          )
            throw intentReview('IDEMPOTENCY_CONFLICT');
          const value = await read(tx, storeId, orderId, existing.id);
          return publicClaim(value.body, !!value.resolved);
        }
        const occupied = await tx
          .select()
          .from(cashReturnIntents)
          .where(eq(cashReturnIntents.originalPaymentId, input.original.originalPaymentId))
          .limit(1001)
          .for('update');
        if (
          occupied.length > 1000 ||
          occupied.some((row) => verifiedIntent(row, secret).phase !== 'CANCELLED')
        )
          throw intentReview('CASH_RETURN_INTENT_ALREADY_EXISTS');
        const [claim] = await tx
          .select({ id: cashReturnClaims.id })
          .from(cashReturnClaims)
          .where(eq(cashReturnClaims.originalPaymentId, input.original.originalPaymentId))
          .limit(1)
          .for('update');
        if (claim) throw intentReview('CASH_RETURN_CLAIM_ALREADY_EXISTS');
        const native = await port.funding(tx, storeId, orderId, proof, input),
          instant = clock();
        const funding = Temporal.PlainDateTime.from(native.originalFundingAt.replace(' ', 'T'))
          .toZonedDateTime(config.BUSINESS_TIMEZONE)
          .toInstant();
        if (
          Temporal.Instant.compare(Temporal.Instant.from(input.returnedAt), instant) > 0 ||
          Temporal.Instant.compare(Temporal.Instant.from(input.returnedAt), funding) < 0
        )
          throw intentReview('CASH_RETURN_TIME_INVALID');
        const local = Temporal.Instant.from(input.returnedAt)
            .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
            .toPlainDateTime()
            .toString({ smallestUnit: 'second' })
            .replace('T', ' '),
          body: CashReturnClaimBody = {
            id: input.original.operationId,
            contract: 'pos-retained-cash-return-v1',
            storeId,
            orderId,
            counterId: input.original.counterId,
            registeredBy: user.id,
            registeredAt: canonicalInstant(instant),
            sessionHash,
            input,
            ...native,
            businessTimezone: config.BUSINESS_TIMEZONE,
            returnedAt: local,
            businessDate: local.slice(0, 10),
          },
          now = instantSql(instant);
        await tx.insert(cashReturnClaims).values({
          id: body.id,
          storeId,
          orderId,
          counterId: body.counterId,
          originalPaymentId: input.original.originalPaymentId,
          cashReturnReceiptId: input.original.cashReturnReceiptId,
          body,
          bodyHash: claimHash(body, secret),
          impactFrom: [
            body.orderDate,
            body.originalFundingAt.slice(0, 10),
            body.businessDate,
          ].sort()[0]!,
          createdAt: now,
          requestId: currentRequestTrace()?.requestId || null,
        });
        await advanceFinancialControl(
          tx,
          {
            storeId,
            id: body.id,
            hash: claimHash(body, secret),
            dates: [body.orderDate, body.originalFundingAt.slice(0, 10), body.businessDate],
          },
          1,
          secret,
          now,
        );
        await port.registered?.(tx, body);
        await assertIntentSession(tx, user.id, sessionId, secret);
        return publicClaim(body);
      });
    },
    async get(user: Principal, storeId: string, orderId: string, id: string, sessionId: string) {
      return transact(async (tx) => {
        await port.scope(tx, user, storeId, orderId);
        await assertIntentSession(tx, user.id, sessionId, secret);
        const value = await read(tx, storeId, orderId, id);
        return publicClaim(value.body, !!value.resolved);
      });
    },
    async list(user: Principal, storeId: string, sessionId: string, after?: string, limit = 50) {
      limit = z.number().int().min(1).max(100).parse(limit);
      if (after !== undefined) after = z.uuid().parse(after);
      return transact(async (tx) => {
        requireStore(user, storeId);
        await checkIn(user.id, storeId, undefined, tx);
        await assertCurrentStoreAccess(tx, user.id, storeId, [1, 2, 3]);
        await assertIntentSession(tx, user.id, sessionId, secret);
        const rows = await tx
            .select()
            .from(cashReturnClaims)
            .where(
              and(
                eq(cashReturnClaims.storeId, storeId),
                after ? gt(cashReturnClaims.id, after) : undefined,
                notExists(
                  tx
                    .select({ id: cashReturnClaimResolutions.id })
                    .from(cashReturnClaimResolutions)
                    .where(eq(cashReturnClaimResolutions.id, cashReturnClaims.id)),
                ),
              ),
            )
            .orderBy(asc(cashReturnClaims.id))
            .limit(limit + 1),
          data = rows.slice(0, limit).map((row) => publicClaim(verifiedClaim(row, secret)));
        return { data, nextCursor: rows.length > limit ? data.at(-1)!.id : null };
      });
    },
  };
}
