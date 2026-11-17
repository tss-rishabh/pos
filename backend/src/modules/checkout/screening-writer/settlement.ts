import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Order, OrderStore } from '../../../db/legacy-schema.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { identifier } from '../../../domain/validation.js';
import { minorUnits } from '../../../domain/money.js';
import {
  storedPaymentAttemptSchema,
  paymentInputSchema,
  terminalPayment,
  type PaymentAttempt,
  type PaymentInput,
} from '../payments/contracts.js';
import { paymentAttempts } from '../payments/schema.js';
import { operationHash } from '../crypto.js';
import {
  assertCheckoutProjection,
  checkoutProjections,
  checkoutProjectionLines,
} from '../projection.js';
import { equalImportHash } from '../../legacy-order-imports/financial-adapter-crypto.js';
import {
  screeningReservations,
  screeningReservationSchema,
  screeningProof,
} from '../../legacy-order-imports/screening-profile.js';
import { publicScreeningPaymentEvidence, publicScreeningWork } from './schema.js';
import {
  publicScreeningCompletions,
  publicScreeningCompletionSchema,
  publicScreeningLineHash,
} from './completion.js';
import {
  publicScreeningHash,
  screeningReconciliationRequired,
  type PublicScreeningCreation,
} from './proof.js';
import { verifyPublicStructure } from './native.js';
import { assertPublicBenefits, type PublicBenefitVerification } from './benefits.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const paymentIntent = z
  .object({
    contract: z.literal('pos-node-screening-payment-intent-v1'),
    operationId: z.uuid(),
    orderId: identifier,
    attemptId: z.uuid(),
    operatorId: identifier,
    storeId: identifier,
    counterId: identifier,
    requestHash: hash,
    input: paymentInputSchema,
  })
  .strict();
const prepaidIntent = z
  .object({
    contract: z.literal('pos-node-screening-prepaid-v1'),
    operationId: z.uuid(),
    orderId: identifier,
    checkoutId: z.uuid(),
    creationHash: hash,
  })
  .strict();
const paidProof = z
  .object({
    contract: z.literal('pos-node-screening-paid-evidence-v1'),
    operationId: z.uuid(),
    orderId: identifier,
    receiptId: z.string().max(80),
    source: z.enum(['payment', 'prepaid']),
    intentHash: hash,
    projectionHash: hash,
    lineHash: hash,
    attemptHash: hash.nullable(),
    completedAt: z.number().int().positive().safe(),
  })
  .strict();
export async function recordPublicPaymentIntent(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
  attempt: PaymentAttempt,
  input: PaymentInput,
  key: string,
  hashSecret: string,
) {
  const value = paymentIntent.parse({
    contract: 'pos-node-screening-payment-intent-v1',
    operationId: creation.operationId,
    orderId: attempt.orderId,
    attemptId: attempt.id,
    operatorId: attempt.operatorId,
    storeId: attempt.storeId,
    counterId: attempt.counterId,
    requestHash: attempt.requestHash,
    input,
  });
  if (
    value.orderId !== creation.orderId ||
    value.storeId !== creation.storeId ||
    value.counterId !== creation.counterId ||
    value.requestHash !==
      operationHash(
        'payment.start',
        { storeId: value.storeId, orderId: value.orderId, input },
        hashSecret,
      )
  )
    throw screeningReconciliationRequired();
  await tx.insert(publicScreeningPaymentEvidence).values({
    id: attempt.id,
    operationId: creation.operationId,
    orderId: creation.orderId,
    intent: value,
    intentHash: publicScreeningHash(key, 'payment-intent', value),
    paid: null,
    paidHash: null,
  });
}
async function projectionEvidence(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
) {
  await assertCheckoutProjection(tx, {
    orderId: creation.orderId,
    storeId: creation.storeId,
    counterId: creation.counterId,
    customerId: creation.customerId,
  });
  const [header] = await tx
    .select()
    .from(checkoutProjections)
    .where(eq(checkoutProjections.orderId, BigInt(creation.orderId)))
    .limit(1)
    .for('share');
  const lines = await tx
    .select()
    .from(checkoutProjectionLines)
    .where(eq(checkoutProjectionLines.orderId, BigInt(creation.orderId)))
    .orderBy(asc(checkoutProjectionLines.lineId))
    .limit(1001)
    .for('share');
  if (!header || lines.length !== header.lineCount) throw screeningReconciliationRequired();
  return {
    projectionHash: header.inputHash,
    lineHash: publicScreeningLineHash(
      lines.map((row) => ({
        id: String(row.lineId),
        productId: String(row.productId),
        quantity: String(row.quantity),
        inputHash: row.inputHash,
      })),
    ),
  };
}
async function paymentEvidence(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
  attempt: PaymentAttempt,
  key: string,
  hashSecret: string,
) {
  const [row] = await tx
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, attempt.id))
    .limit(1)
    .for('share');
  const stored = storedPaymentAttemptSchema.parse(row?.state);
  if (
    !row ||
    row.status !== 'paid' ||
    stored.status !== 'paid' ||
    row.id !== stored.id ||
    row.orderId !== stored.orderId ||
    row.storeId !== stored.storeId ||
    row.operatorId !== stored.operatorId ||
    JSON.stringify(stored) !== JSON.stringify(attempt) ||
    stored.orderId !== creation.orderId ||
    stored.storeId !== creation.storeId ||
    stored.counterId !== creation.counterId ||
    stored.legacySource ||
    stored.heldProviderDecision
  )
    throw screeningReconciliationRequired();
  const [evidence] = await tx
    .select()
    .from(publicScreeningPaymentEvidence)
    .where(eq(publicScreeningPaymentEvidence.id, attempt.id))
    .limit(1)
    .for('update');
  if (!evidence) throw screeningReconciliationRequired();
  const intent = paymentIntent.parse(evidence.intent);
  if (
    evidence.operationId !== creation.operationId ||
    evidence.orderId !== creation.orderId ||
    intent.operationId !== creation.operationId ||
    intent.orderId !== attempt.orderId ||
    intent.attemptId !== attempt.id ||
    intent.operatorId !== attempt.operatorId ||
    intent.storeId !== attempt.storeId ||
    intent.counterId !== attempt.counterId ||
    intent.requestHash !== attempt.requestHash ||
    !equalImportHash(publicScreeningHash(key, 'payment-intent', intent), evidence.intentHash) ||
    operationHash(
      'payment.start',
      { storeId: intent.storeId, orderId: intent.orderId, input: intent.input },
      hashSecret,
    ) !== attempt.requestHash
  )
    throw screeningReconciliationRequired();
  const original = intent.input;
  if (
    original.channel !== attempt.channel ||
    minorUnits(original.cashAmount) !== minorUnits(attempt.cashAmount) ||
    minorUnits(original.onlineAmount) !== minorUnits(attempt.onlineAmount) ||
    minorUnits(original.cashReceived) !== minorUnits(attempt.cashReceived) ||
    (original.machineId ?? null) !== attempt.machineId ||
    (original.externalReference ?? null) !== attempt.externalReference
  )
    throw screeningReconciliationRequired();
  const mappings = await tx
    .select({
      customer: Order.user,
      payment: Order.payment_statuses,
      status: Order.order_statuses,
      payable: Order.pay_amt,
      method: Order.payment_methods,
      store: OrderStore.store,
      counter: OrderStore.counter,
      transaction: OrderStore.transaction_id,
      cash: OrderStore.offline_payment,
      received: OrderStore.offline_payment_recieved,
      online: OrderStore.online_payment,
      other: OrderStore.online_other_payment,
    })
    .from(Order)
    .innerJoin(OrderStore, eq(OrderStore.order, Order.id))
    .where(eq(Order.id, BigInt(creation.orderId)))
    .limit(2)
    .for('update');
  const mapping = mappings[0];
  if (
    mappings.length !== 1 ||
    !mapping ||
    String(mapping.customer) !== creation.customerId ||
    mapping.payment !== 4n ||
    mapping.status !== 3n ||
    mapping.method !== 14n ||
    String(mapping.store) !== attempt.storeId ||
    String(mapping.counter) !== attempt.counterId ||
    mapping.transaction !== attempt.transactionId ||
    minorUnits(String(mapping.cash)) !== minorUnits(attempt.cashAmount) ||
    minorUnits(String(mapping.received)) !== minorUnits(attempt.cashReceived) ||
    minorUnits(String(mapping.online)) + minorUnits(String(mapping.other)) !==
      minorUnits(attempt.onlineAmount) ||
    minorUnits(String(mapping.payable)) !==
      minorUnits(attempt.cashAmount) + minorUnits(attempt.onlineAmount)
  )
    throw screeningReconciliationRequired();
  if (terminalPayment(attempt.channel)) {
    const table = attempt.channel.startsWith('pine-')
      ? 'pos_terminal_transactions'
      : 'pos_paytm_transactions';
    // Fixed reviewed table literals only. A completed provider audit must be
    // the same attempt/reference/amount; mutable order flags alone cannot pay.
    const [raw] = await tx.execute(
      sql`SELECT id FROM ${sql.raw(table)} WHERE order_id=${creation.orderId} AND store_id=${creation.storeId} AND transaction_id=${attempt.transactionId} AND platform='txn_completed' AND is_active=0 AND amount=${attempt.onlineAmount} AND cash_amount=${attempt.cashAmount} AND cash_recieved=${attempt.cashReceived} LIMIT 2 FOR SHARE`,
    );
    if (!Array.isArray(raw) || raw.length !== 1) throw screeningReconciliationRequired();
  }
  return {
    row: evidence,
    intentHash: evidence.intentHash,
    attemptHash: operationHash('screening-paid-attempt', stored, hashSecret),
  };
}
async function publishCompletion(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
  receiptId: string,
  proof: z.infer<typeof paidProof>,
  key: string,
) {
  if (proof.completedAt < creation.createdAt) throw screeningReconciliationRequired();
  const held = await verifyPublicStructure(tx, creation, key);
  const [prior] = await tx
    .select()
    .from(publicScreeningCompletions)
    .where(eq(publicScreeningCompletions.operationId, creation.operationId))
    .limit(1)
    .for('update');
  if (prior) {
    await readPublicCompletion(tx, creation, key);
    return;
  }
  if (held.value.phase !== 'BOUND') throw screeningReconciliationRequired();
  const value = publicScreeningCompletionSchema.parse({
    contract: 'pos-node-screening-completion-v1',
    operationId: creation.operationId,
    creationHash: publicScreeningHash(key, 'creation', creation),
    orderId: creation.orderId,
    customerId: creation.customerId,
    storeId: creation.storeId,
    counterId: creation.counterId,
    paymentReceiptId: receiptId,
    projectionHash: proof.projectionHash,
    lineHash: proof.lineHash,
    completedAt: proof.completedAt,
  });
  const seal = publicScreeningHash(key, 'completion', value);
  await tx.insert(publicScreeningCompletions).values({
    operationId: creation.operationId,
    orderId: creation.orderId,
    data: value,
    proofHash: seal,
  });
  const counted = screeningReservationSchema.parse({
    ...held.value,
    phase: 'COUNTED',
    completionHash: seal,
    version: held.value.version + 1,
    updatedAt: proof.completedAt,
  });
  await tx
    .update(screeningReservations)
    .set({ data: counted, proofHash: screeningProof(key, 'state', counted) })
    .where(eq(screeningReservations.operationId, creation.operationId));
  await tx
    .update(publicScreeningWork)
    .set({
      status: 'publication-pending',
      nextCheckAt: proof.completedAt,
      updatedAt: proof.completedAt,
    })
    .where(eq(publicScreeningWork.operationId, creation.operationId));
}
export async function completePublicPayment(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
  attempt: PaymentAttempt,
  key: string,
  hashSecret: string,
  clock: () => number,
  benefits: PublicBenefitVerification = {},
) {
  const evidence = await paymentEvidence(tx, creation, attempt, key, hashSecret),
    projection = await projectionEvidence(tx, creation);
  if (evidence.row.paid) {
    await readPublicCompletion(tx, creation, key);
    return;
  }
  await assertPublicBenefits(tx, creation, key, benefits, 'settled');
  const value = paidProof.parse({
    contract: 'pos-node-screening-paid-evidence-v1',
    operationId: creation.operationId,
    orderId: creation.orderId,
    receiptId: attempt.id,
    source: 'payment',
    intentHash: evidence.intentHash,
    ...projection,
    attemptHash: evidence.attemptHash,
    completedAt: clock(),
  });
  await tx
    .update(publicScreeningPaymentEvidence)
    .set({ paid: value, paidHash: publicScreeningHash(key, 'payment-paid', value) })
    .where(eq(publicScreeningPaymentEvidence.id, attempt.id));
  await publishCompletion(tx, creation, attempt.id, value, key);
}
export async function completePublicPrepaid(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
  key: string,
  clock: () => number,
  benefits: PublicBenefitVerification = {},
) {
  const [order] = await tx
    .select({
      method: Order.payment_methods,
      payable: Order.pay_amt,
      payment: Order.payment_statuses,
      status: Order.order_statuses,
    })
    .from(Order)
    .where(eq(Order.id, BigInt(creation.orderId)))
    .limit(1)
    .for('update');
  if (
    creation.method !== 3 ||
    order?.method !== 3n ||
    order.payable !== 0 ||
    order.payment !== 4n ||
    order.status !== 3n
  )
    throw screeningReconciliationRequired();
  const [attempt] = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, creation.orderId))
    .limit(1)
    .for('share');
  if (attempt) throw screeningReconciliationRequired();
  const intent = prepaidIntent.parse({
      contract: 'pos-node-screening-prepaid-v1',
      operationId: creation.operationId,
      orderId: creation.orderId,
      checkoutId: creation.checkoutId,
      creationHash: publicScreeningHash(key, 'creation', creation),
    }),
    intentHash = publicScreeningHash(key, 'payment-intent', intent);
  const [prior] = await tx
    .select()
    .from(publicScreeningPaymentEvidence)
    .where(eq(publicScreeningPaymentEvidence.id, creation.operationId))
    .limit(1)
    .for('update');
  if (prior) {
    await readPublicCompletion(tx, creation, key);
    return;
  }
  await assertPublicBenefits(tx, creation, key, benefits, 'settled');
  const projection = await projectionEvidence(tx, creation),
    value = paidProof.parse({
      contract: 'pos-node-screening-paid-evidence-v1',
      operationId: creation.operationId,
      orderId: creation.orderId,
      receiptId: creation.operationId,
      source: 'prepaid',
      intentHash,
      ...projection,
      attemptHash: null,
      completedAt: clock(),
    });
  // The original submission UUID is the existing zero/prepaid receipt identity.
  // Its native zero-pay projection is independently complete evidence; no cash
  // attempt, received-money amount or provider receipt is fabricated.
  await tx.insert(publicScreeningPaymentEvidence).values({
    id: creation.operationId,
    operationId: creation.operationId,
    orderId: creation.orderId,
    intent,
    intentHash,
    paid: value,
    paidHash: publicScreeningHash(key, 'payment-paid', value),
  });
  await publishCompletion(tx, creation, creation.operationId, value, key);
}
export async function readPublicCompletion(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
  key: string,
) {
  const [row] = await tx
    .select()
    .from(publicScreeningCompletions)
    .where(eq(publicScreeningCompletions.operationId, creation.operationId))
    .limit(1)
    .for('share');
  if (!row) return null;
  const value = publicScreeningCompletionSchema.parse(row.data);
  if (
    row.operationId !== creation.operationId ||
    value.operationId !== creation.operationId ||
    row.orderId !== creation.orderId ||
    value.creationHash !== publicScreeningHash(key, 'creation', creation) ||
    value.orderId !== creation.orderId ||
    value.customerId !== creation.customerId ||
    value.storeId !== creation.storeId ||
    value.counterId !== creation.counterId ||
    !equalImportHash(publicScreeningHash(key, 'completion', value), row.proofHash)
  )
    throw screeningReconciliationRequired();
  const [receipt] = await tx
    .select()
    .from(publicScreeningPaymentEvidence)
    .where(eq(publicScreeningPaymentEvidence.id, value.paymentReceiptId))
    .limit(1)
    .for('share');
  if (!receipt) throw screeningReconciliationRequired();
  const proof = paidProof.parse(receipt.paid);
  if (
    receipt.operationId !== creation.operationId ||
    receipt.orderId !== creation.orderId ||
    proof.operationId !== creation.operationId ||
    proof.orderId !== creation.orderId ||
    proof.receiptId !== value.paymentReceiptId ||
    proof.projectionHash !== value.projectionHash ||
    proof.lineHash !== value.lineHash ||
    proof.completedAt !== value.completedAt ||
    proof.intentHash !== receipt.intentHash ||
    !equalImportHash(publicScreeningHash(key, 'payment-paid', proof), receipt.paidHash ?? '')
  )
    throw screeningReconciliationRequired();
  const intent =
    proof.source === 'payment'
      ? paymentIntent.parse(receipt.intent)
      : prepaidIntent.parse(receipt.intent);
  if (
    intent.operationId !== creation.operationId ||
    intent.orderId !== creation.orderId ||
    !equalImportHash(publicScreeningHash(key, 'payment-intent', intent), receipt.intentHash) ||
    (proof.source === 'payment' && (creation.method !== 14 || !proof.attemptHash)) ||
    (proof.source === 'prepaid' &&
      (creation.method !== 3 ||
        value.paymentReceiptId !== creation.operationId ||
        proof.attemptHash !== null ||
        !('checkoutId' in intent) ||
        intent.checkoutId !== creation.checkoutId ||
        intent.creationHash !== value.creationHash))
  )
    throw screeningReconciliationRequired();
  const [reservation] = await tx
    .select()
    .from(screeningReservations)
    .where(eq(screeningReservations.operationId, creation.operationId))
    .limit(1)
    .for('share');
  if (!reservation) throw screeningReconciliationRequired();
  const held = screeningReservationSchema.parse(reservation.data);
  if (
    held.kind !== 'pos' ||
    held.phase !== 'COUNTED' ||
    held.orderId !== creation.orderId ||
    held.sourceReceiptHash !== value.creationHash ||
    held.completionHash !== row.proofHash ||
    !equalImportHash(screeningProof(key, 'state', held), reservation.proofHash)
  )
    throw screeningReconciliationRequired();
  return value;
}
