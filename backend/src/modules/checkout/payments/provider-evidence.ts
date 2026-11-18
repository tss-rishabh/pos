import { and, eq } from 'drizzle-orm';
import { bigint, index, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { PosUser, Store, Order } from '../../../db/legacy-schema.js';
import { operatorAuthEpochs } from '../../../auth/revocation.js';
import { AppError } from '../../../domain/errors.js';
import {
  storedPaymentAttemptSchema,
  type PaymentAttempt,
  type ProviderDecision,
} from './contracts.js';
import { paymentAttempts } from './schema.js';
import { operationHash } from '../crypto.js';
import type { PaymentTransaction } from './repository.js';
import {
  paymentDispatchFrameSchema,
  providerDecisionFactSchema,
  assertPaymentDispatchFrame,
  safeProviderDecisionFact,
  type PaymentDispatchFrame,
} from './dispatch-evidence.js';

export const providerFactSchema = z
  .object({
    contract: z.literal('pos-payment-provider-fact-v1'),
    frame: paymentDispatchFrameSchema,
    decision: providerDecisionFactSchema,
    receivedAt: z.number().int().positive().safe(),
  })
  .strict();
export const paymentProviderFacts = mysqlTable(
  'pos_rewrite_payment_provider_facts',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    attemptId: varchar('attempt_id', { length: 36 }).notNull(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    data: json('data').$type<z.infer<typeof providerFactSchema>>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('ix_payment_provider_fact_attempt').on(table.attemptId, table.createdAt, table.id),
  ],
);
const invalid = () =>
  new AppError(
    409,
    'PAYMENT_REPLY_PROVENANCE_REQUIRED',
    'The original provider reply needs reconciliation.',
  );
function sameAttempt(frame: PaymentDispatchFrame, attempt: PaymentAttempt) {
  return (
    frame.attemptId === attempt.id &&
    frame.originalOperatorId === attempt.operatorId &&
    frame.orderId === attempt.orderId &&
    frame.storeId === attempt.storeId &&
    frame.counterId === attempt.counterId &&
    frame.requestHash === attempt.requestHash &&
    frame.transactionId === attempt.transactionId &&
    frame.machineId === attempt.machineId &&
    frame.channel === attempt.channel &&
    frame.cashAmount === attempt.cashAmount &&
    frame.onlineAmount === attempt.onlineAmount &&
    frame.cashReceived === attempt.cashReceived
  );
}
export async function readPaymentProviderFact(
  tx: PaymentTransaction,
  attempt: PaymentAttempt,
  key: string,
) {
  if (!attempt.providerEvidenceId) return null;
  const [row] = await tx
    .select()
    .from(paymentProviderFacts)
    .where(
      and(
        eq(paymentProviderFacts.id, attempt.providerEvidenceId),
        eq(paymentProviderFacts.attemptId, attempt.id),
        eq(paymentProviderFacts.orderId, attempt.orderId),
      ),
    )
    .limit(1)
    .for('share');
  if (!row) throw invalid();
  const value = providerFactSchema.parse(row.data);
  if (
    !sameAttempt(value.frame, attempt) ||
    operationHash('payment.provider-fact', value, key) !== row.proofHash ||
    operationHash(
      'payment.provider-fact-id',
      { frame: value.frame, decision: value.decision },
      key,
    ) !== row.id
  )
    throw invalid();
  return { id: row.id, value };
}
/** Factual retention only. It never settles an Order, touches stock/wallet,
 * or authorizes a provider request. */
export async function retainPaymentProviderFact(
  db: Databases,
  frame: PaymentDispatchFrame | undefined,
  decision: ProviderDecision,
  key: string,
  clock: () => number = Date.now,
) {
  assertPaymentDispatchFrame(frame);
  if (key.length < 32) throw invalid();
  const checked = safeProviderDecisionFact(decision),
    id = operationHash('payment.provider-fact-id', { frame, decision: checked }, key);
  return db.get('writer').transaction(
    async (tx) => {
      await tx
        .select({ id: PosUser.id })
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(frame.actorId)))
        .limit(1)
        .for('share');
      await tx
        .select({ epoch: operatorAuthEpochs.epoch })
        .from(operatorAuthEpochs)
        .where(eq(operatorAuthEpochs.userId, frame.actorId))
        .limit(1)
        .for('share');
      const [store] = await tx
        .select({ id: Store.id })
        .from(Store)
        .where(eq(Store.id, BigInt(frame.storeId)))
        .limit(1)
        .for('update');
      if (!store) throw invalid();
      await tx
        .select({ id: Order.id })
        .from(Order)
        .where(eq(Order.id, BigInt(frame.orderId)))
        .limit(1)
        .for('update');
      const [row] = await tx
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, frame.attemptId))
        .limit(1)
        .for('update');
      const attempt = storedPaymentAttemptSchema.parse(row?.state);
      if (
        !row ||
        row.orderId !== frame.orderId ||
        row.storeId !== frame.storeId ||
        !sameAttempt(frame, attempt)
      )
        throw invalid();
      const [prior] = await tx
        .select()
        .from(paymentProviderFacts)
        .where(eq(paymentProviderFacts.id, id))
        .limit(1);
      if (prior) {
        const value = providerFactSchema.parse(prior.data);
        if (
          operationHash('payment.provider-fact', value, key) !== prior.proofHash ||
          !sameAttempt(value.frame, attempt) ||
          operationHash(
            'payment.provider-fact-id',
            { frame: value.frame, decision: value.decision },
            key,
          ) !== id
        )
          throw invalid();
      } else {
        const data = providerFactSchema.parse({
          contract: 'pos-payment-provider-fact-v1',
          frame,
          decision: checked,
          receivedAt: clock(),
        });
        await tx.insert(paymentProviderFacts).values({
          id,
          attemptId: frame.attemptId,
          orderId: frame.orderId,
          data,
          proofHash: operationHash('payment.provider-fact', data, key),
          createdAt: data.receivedAt,
        });
      }
      if (['paid', 'failed', 'cancelled', 'reversed'].includes(attempt.status)) return attempt;
      let old: Awaited<ReturnType<typeof readPaymentProviderFact>> = null;
      if (attempt.providerEvidenceId) {
        try {
          old = await readPaymentProviderFact(tx, attempt, key);
        } catch {
          /* Keep the new genuine fact even if an older evidence pointer is corrupt. */
        }
      }
      const choose = !old || ['pending', 'uncertain'].includes(old.value.decision.status);
      const next: PaymentAttempt = {
        ...attempt,
        status: 'uncertain',
        busyOperationId:
          attempt.busyOperationId === frame.busyOperationId ? null : attempt.busyOperationId,
        providerReference: choose
          ? (checked.reference ?? attempt.providerReference)
          : attempt.providerReference,
        providerEvidenceId: choose ? id : attempt.providerEvidenceId,
        heldProviderDecision: choose ? checked : attempt.heldProviderDecision,
        errorCode: 'PAYMENT_REPLY_RETAINED',
      };
      await tx
        .update(paymentAttempts)
        .set({ state: next, status: next.status })
        .where(eq(paymentAttempts.id, attempt.id));
      return next;
    },
    { isolationLevel: 'read committed' },
  );
}
