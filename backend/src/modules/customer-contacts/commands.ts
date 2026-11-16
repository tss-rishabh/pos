import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { CheckoutState } from '../checkout/contracts.js';
import { AppError } from '../../domain/errors.js';
import { currentRequestTrace } from '../../observability/context.js';
import { contactNotFound } from './authority.js';
import { contactCode, contactCodeDigest, sealContact } from './crypto.js';
import { contactOtpPayload, contactMutationReceipt } from './contracts.js';
import type { CustomerContactOptions } from './options.js';
import { consumeContactSend } from './limits.js';
import { contactStageDestination, type ContactChallenge } from './projection.js';
import { openContactEnvelope } from './crypto.js';
import {
  customerContactChallenges as challenges,
  customerContactDeliveries as deliveries,
  customerContactMutations as mutations,
  type ContactMutationReceipt,
  type CustomerContactStage,
} from './schema.js';

export async function findContactChallenge(
  tx: AdministrationTransaction,
  state: CheckoutState,
  id: string,
  lock = false,
) {
  const query = tx.select().from(challenges).where(eq(challenges.id, id)).limit(1),
    [row] = lock ? await query.for('update') : await query;
  if (
    !row ||
    row.checkoutId !== state.id ||
    row.operatorId !== state.operatorId ||
    row.storeId !== state.storeId ||
    row.counterId !== state.counterId ||
    row.customerId !== state.customerId
  )
    throw contactNotFound();
  return row;
}
export async function queueContactCode(
  tx: AdministrationTransaction,
  row: ContactChallenge,
  stage: CustomerContactStage,
  options: CustomerContactOptions,
  zone: string,
  now: number,
) {
  const secret = options.CUSTOMER_CONTACTS_SECRET!,
    input = openContactEnvelope(secret, row.id, row.encryptedInput),
    destination = contactStageDestination({ ...row, stage }, input),
    code = contactCode(),
    id = randomUUID();
  await consumeContactSend(tx, {
    customerId: row.customerId,
    targetKey: row.targetKey,
    stage,
    channel: destination.channel,
    now,
    zone,
    options,
  });
  await tx
    .update(deliveries)
    .set({ status: 'CANCELLED', encryptedPayload: '', updatedAt: now })
    .where(
      and(
        eq(deliveries.challengeId, row.id),
        eq(deliveries.kind, 'otp'),
        eq(deliveries.status, 'PENDING'),
      ),
    );
  const ttl =
      stage === 'current' && destination.channel === 'sms'
        ? options.CHANGE_MOBILE_OTP_EXPIRY_IN_SEC * 1000
        : 600000,
    expiresAt = Math.min(row.expiresAt, now + ttl);
  await tx.insert(deliveries).values({
    id,
    challengeId: row.id,
    operatorId: row.operatorId,
    customerId: row.customerId,
    kind: 'otp',
    stage,
    encryptedPayload: sealContact(
      secret,
      id,
      contactOtpPayload.parse({
        purpose: 'customer-contact-otp-v1',
        challengeId: row.id,
        stage,
        ...destination,
        code,
      }),
    ),
    status: 'PENDING',
    attempts: 0,
    expiresAt,
    requestId: currentRequestTrace()?.requestId ?? row.requestId,
    createdAt: now,
    updatedAt: now,
  });
  return {
    stage,
    status: stage === 'current' ? ('PENDING_CURRENT' as const) : ('PENDING_NEW' as const),
    codeHash: contactCodeDigest(secret, row.id, stage, code),
    codeExpiresAt: expiresAt,
    attempts: 0,
    retryAt: now + 30000,
    updatedAt: now,
  };
}
export async function contactMutationReplay(
  tx: AdministrationTransaction,
  state: CheckoutState,
  id: string,
  challengeId: string,
  action: string,
  inputHash: string,
) {
  const [row] = await tx
    .select()
    .from(mutations)
    .where(eq(mutations.id, id))
    .limit(1)
    .for('update');
  if (!row) return null;
  if (
    row.operatorId !== state.operatorId ||
    row.checkoutId !== state.id ||
    row.challengeId !== challengeId ||
    row.action !== action ||
    row.inputHash !== inputHash
  )
    throw new AppError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'This contact operation identifier was used for another request.',
    );
  return contactMutationReceipt.parse(row.result);
}
export async function saveContactMutation(
  tx: AdministrationTransaction,
  state: CheckoutState,
  action: string,
  inputHash: string,
  receipt: ContactMutationReceipt,
  now: number,
) {
  await tx.insert(mutations).values({
    id: receipt.id,
    challengeId: receipt.challengeId,
    operatorId: state.operatorId,
    checkoutId: state.id,
    action,
    inputHash,
    result: contactMutationReceipt.parse(receipt),
    createdAt: now,
  });
}
export function contactReceiptError(receipt: ContactMutationReceipt) {
  if (receipt.status === 'error')
    throw new AppError(
      receipt.errorStatus ?? 409,
      receipt.errorCode ?? 'CUSTOMER_CONTACT_PROOF_INVALID',
      receipt.message,
    );
}
