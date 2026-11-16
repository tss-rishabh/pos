import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { eq } from 'drizzle-orm';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { checkoutSessions } from '../checkout/schema.js';
import { checkoutStateSchema, type CheckoutState } from '../checkout/contracts.js';
import { currentRequestTrace } from '../../observability/context.js';
import { contactEffectPayload, contactEffectsContract } from './contracts.js';
import { assertMissingContact, contactChanged, contactWallTime } from './authority.js';
import { openContactEnvelope, sealContact } from './crypto.js';
import { contactUsers, contactUserDetailLogs } from './legacy-schema.js';
import {
  assertEmailNotRegistered,
  assertNoEmployeeContactChange,
  carryCustomerEmailReferences,
} from './references.js';
import {
  customerContactChallenges as challenges,
  customerContactDeliveries as deliveries,
  type ContactMutationReceipt,
} from './schema.js';
import type { ContactChallenge } from './projection.js';
import type { CustomerContactOptions } from './options.js';
import type { ContactCustomer } from './authority.js';
import { bumpCurrentContactRevision } from './revisions.js';

export async function commitCustomerContact(
  tx: AdministrationTransaction,
  state: CheckoutState & { customerId: string },
  row: ContactChallenge,
  customer: ContactCustomer,
  operationId: string,
  options: CustomerContactOptions,
  zone: string,
  now: number,
): Promise<ContactMutationReceipt> {
  if (
    row.status !== 'READY' ||
    row.stage !== 'new' ||
    row.currentVerifiedAt === null ||
    row.newVerifiedAt === null ||
    row.expiresAt <= now ||
    row.newVerifiedAt + 600000 <= now
  )
    throw contactChanged();
  assertMissingContact(customer, row.kind);
  const secret = options.CUSTOMER_CONTACTS_SECRET!,
    input = openContactEnvelope(secret, row.id, row.encryptedInput),
    wall = contactWallTime(now, zone);
  let refundRemails: { orderId: string; refundRequestId: string }[] = [];
  if (row.kind === 'email') {
    await assertEmailNotRegistered(tx, input.value);
    await assertNoEmployeeContactChange(
      tx,
      row.customerId,
      Temporal.Instant.fromEpochMilliseconds(now),
    );
    const references = await carryCustomerEmailReferences(tx, {
      customerId: row.customerId,
      oldEmail: input.oldEmail,
      newEmail: input.value,
      wallTime: wall,
      refundSuccess: options.REFUND_SUCCESS_STATUS,
      refundFailed: options.REFUND_FAILED_STATUS,
    });
    refundRemails = references.refundRemails;
    await tx
      .update(contactUsers)
      .set({ email: input.value, emailVerified: 1 })
      .where(eq(contactUsers.id, customer.id));
  } else {
    const [taken] = await tx
      .select({ id: contactUsers.id })
      .from(contactUsers)
      .where(eq(contactUsers.telephone, input.value))
      .limit(1)
      .for('share');
    if (taken) throw contactChanged();
    await tx
      .update(contactUsers)
      .set({ telephone: input.value })
      .where(eq(contactUsers.id, customer.id));
  }
  // Source account audit denotes the customer whose two proofs authorize this
  // update. Cashier identity is separately retained in the challenge/outbox.
  await tx.insert(contactUserDetailLogs).values({
    userId: customer.id,
    userType: 2,
    kind: row.kind === 'email' ? 'EMAIL' : 'TELEPHONE',
    previousValue: row.kind === 'email' ? input.oldEmail : input.oldTelephone,
    newValue: input.value,
    addedBy: customer.id,
    createdAt: wall,
    updatedAt: wall,
  });
  await bumpCurrentContactRevision(tx, row.customerId);
  const next = checkoutStateSchema.parse({
    ...state,
    quote: null,
    phase: 'open',
    version: state.version + 1,
    verifiedCustomerUntil: null,
    verifiedCustomerContact: null,
    verificationChallenge: null,
    registrationId: null,
    updatedAt: now,
  });
  await tx
    .update(checkoutSessions)
    .set({ state: next, version: next.version })
    .where(eq(checkoutSessions.id, state.id));
  const deliveryId = randomUUID(),
    payload = contactEffectPayload.parse({
      contract: contactEffectsContract,
      operationId,
      challengeId: row.id,
      operatorId: row.operatorId,
      customerId: row.customerId,
      storeId: row.storeId,
      checkoutId: row.checkoutId,
      kind: row.kind,
      oldEmail: input.oldEmail,
      oldTelephone: input.oldTelephone,
      newValue: input.value,
      refundRemails,
      requestId: currentRequestTrace()?.requestId ?? row.requestId,
    });
  await tx.insert(deliveries).values({
    id: deliveryId,
    challengeId: row.id,
    operatorId: row.operatorId,
    customerId: row.customerId,
    kind: 'source-effects',
    encryptedPayload: sealContact(secret, deliveryId, payload),
    status: 'PENDING',
    attempts: 0,
    expiresAt: now + 30 * 86400000,
    requestId: payload.requestId,
    createdAt: now,
    updatedAt: now,
  });
  await tx
    .update(challenges)
    .set({ status: 'COMMITTING', version: row.version + 1, codeHash: '', updatedAt: now })
    .where(eq(challenges.id, row.id));
  return {
    id: operationId,
    challengeId: row.id,
    status: 'success',
    message:
      'Contact added. Synchronization is queued; verify the customer again before using account benefits.',
    checkoutVersion: next.version,
  };
}
