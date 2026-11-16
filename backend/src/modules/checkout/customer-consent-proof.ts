import { eq } from 'drizzle-orm';
import { bigint, char, mysqlTable, tinyint, varchar } from 'drizzle-orm/mysql-core';
import type { Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';

export const customerConsentContract = 'pos-customer-contact-consent-v1';
/** Written only in the source confirmation/import transaction, retained permanently. */
export const checkoutCustomerConsents = mysqlTable('pos_rewrite_checkout_customer_consents', {
  orderId: bigint('order_id', { mode: 'bigint' }).primaryKey(),
  storeId: bigint('store_id', { mode: 'bigint' }).notNull(),
  counterId: bigint('counter_id', { mode: 'bigint' }).notNull(),
  customerId: bigint('user_id', { mode: 'bigint' }).notNull(),
  operatorId: bigint('operator_id', { mode: 'bigint' }),
  inputHash: char('input_hash', { length: 64 }).notNull(),
  required: tinyint('required').notNull(),
  contactRevision: bigint('contact_revision', { mode: 'bigint', unsigned: true }),
  contactDigest: char('contact_digest', { length: 64 }),
  verifiedUntilMs: bigint('verified_until_ms', { mode: 'bigint' }),
  acceptedAtMs: bigint('accepted_at_ms', { mode: 'bigint' }).notNull(),
  contractVersion: varchar('contract_version', { length: 40 }).notNull(),
});
export interface CheckoutCustomerConsentScope {
  orderId: string;
  storeId: string;
  counterId: string;
  customerId: string;
  inputHash: string;
  moneyUsed: number;
  pointsUsed: number;
  voucherAmountUsed: number | null;
}
type ConsentReader = Pick<ReturnType<Databases['get']>, 'select'>;
const identifier = /^[1-9]\d{0,18}$/;
const digest = /^[a-f0-9]{64}$/;
function unavailable(): never {
  throw new AppError(
    503,
    'CHECKOUT_CUSTOMER_CONSENT_UNCONFIRMED',
    'The original customer verification is unconfirmed. Keep this order reference and reconcile before taking payment.',
  );
}
/** A committed attestation is checked against the immutable native order header.
 * Current contacts, current revision and wall-clock expiry MUST NOT invalidate it. */
export async function assertCheckoutCustomerConsent(
  tx: ConsentReader,
  scope: CheckoutCustomerConsentScope,
): Promise<void> {
  if (
    [scope.orderId, scope.storeId, scope.counterId, scope.customerId].some(
      (value) => !identifier.test(value) || BigInt(value) > 9223372036854775807n,
    ) ||
    !digest.test(scope.inputHash)
  )
    unavailable();
  const assets = [scope.moneyUsed, scope.pointsUsed, scope.voucherAmountUsed ?? 0];
  if (assets.some((value) => !Number.isFinite(value) || value < 0)) unavailable();
  const [proof] = await tx
    .select()
    .from(checkoutCustomerConsents)
    .where(eq(checkoutCustomerConsents.orderId, BigInt(scope.orderId)))
    .limit(1)
    .for('update');
  if (
    !proof ||
    proof.orderId !== BigInt(scope.orderId) ||
    proof.storeId !== BigInt(scope.storeId) ||
    proof.counterId !== BigInt(scope.counterId) ||
    proof.customerId !== BigInt(scope.customerId) ||
    proof.inputHash !== scope.inputHash ||
    proof.contractVersion !== customerConsentContract ||
    ![0, 1].includes(proof.required) ||
    proof.acceptedAtMs <= 0n ||
    proof.acceptedAtMs > 9007199254740991n ||
    (proof.operatorId !== null &&
      (proof.operatorId <= 0n || proof.operatorId > 9223372036854775807n))
  )
    unavailable();
  if (assets.some((value) => value > 0) && proof.required !== 1) unavailable();
  if (proof.required === 0) {
    if (
      proof.contactRevision !== null ||
      proof.contactDigest !== null ||
      proof.verifiedUntilMs !== null
    )
      unavailable();
    return;
  }
  // Employee-coupon eligibility is frozen by the source writer. Re-reading its
  // mutable current flag could invalidate an already paid order after an edit.
  if (
    proof.operatorId === null ||
    proof.contactRevision === null ||
    proof.contactRevision < 0n ||
    proof.contactRevision > 18446744073709551615n ||
    proof.contactDigest === null ||
    !digest.test(proof.contactDigest) ||
    proof.verifiedUntilMs === null ||
    proof.verifiedUntilMs <= proof.acceptedAtMs ||
    proof.verifiedUntilMs > proof.acceptedAtMs + 900000n ||
    proof.verifiedUntilMs > 9007199254740991n
  )
    unavailable();
}
