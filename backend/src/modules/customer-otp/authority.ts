import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { checkInService, type AdministrationTransaction } from '../administration/checkins.js';
import {
  readCustomerContactBinding,
  sameCustomerContact,
  customerContactBindingSchema,
  type CustomerContactBinding,
} from '../checkout/customer-contact-authority.js';
import type { CheckoutSessionStore } from '../checkout/session-store.js';
import { readJson, type PosStateStore } from '../checkout/state-store.js';
import type { CustomerOtpScope } from './contracts.js';

export const customerOtpChanged = () =>
  new AppError(
    409,
    'CUSTOMER_OTP_SCOPE_CHANGED',
    'The customer or sale changed. Request a new verification code.',
  );
/** Return verification state (table-disposition.md: `pos:return_verification:{verificationId}`). */
export const returnVerificationKey = (verificationId: string) =>
  `pos:return_verification:${verificationId}`;
const returnScope = z.object({
  id: z.uuid(),
  operatorId: identifier,
  storeId: identifier,
  counterId: identifier,
  customerId: identifier,
  orderId: identifier,
  otpChallengeId: z.uuid(),
  contact: customerContactBindingSchema,
  busyOperationId: z.uuid().nullable(),
});
export function assertCustomerOtpActor(user: Principal, scope: CustomerOtpScope) {
  if (scope.operatorId !== user.id) throw customerOtpChanged();
  requireStore(user, scope.storeId);
}
export interface CustomerOtpAuthority {
  contact: CustomerContactBinding;
  /** Set only when an order already froze this proof as its customer consent. */
  frozenConsentUntil: number | null;
}
/**
 * Confirms that the scope still names the operator's current sale (or return verification), the
 * operator is checked in at that counter, and the customer and contact are unchanged. Sale state
 * is read from the checkout session store (no lock: the checkout caller already holds it).
 */
export function customerOtpAuthority(
  config: Config,
  db: Databases,
  sessions: CheckoutSessionStore,
  store: PosStateStore,
) {
  const checkIns = checkInService(db, config);
  return async function authorize(
    tx: AdministrationTransaction,
    scope: CustomerOtpScope,
    challengeId: string,
    operationId?: string,
    allowFrozenConsent = false,
  ): Promise<CustomerOtpAuthority> {
    await checkIns.assertCheckIn(scope.operatorId, scope.storeId, scope.counterId, tx);
    let persistedContact: CustomerContactBinding | null | undefined;
    let frozenConsentUntil: number | null = null;
    if (scope.purpose === 'checkout-benefits') {
      const state = await sessions.readScoped(scope.operatorId, scope.storeId, scope.subjectId);
      if (!state) throw customerOtpChanged();
      const consent = state.orderCustomerConsent;
      const frozenConsent = Boolean(
        allowFrozenConsent &&
        state.phase === 'order-created' &&
        state.orderId &&
        consent &&
        consent.orderId === state.orderId &&
        consent.customerId === scope.customerId &&
        consent.operatorId === scope.operatorId &&
        consent.storeId === scope.storeId &&
        consent.counterId === scope.counterId &&
        consent.expiresAt === state.verifiedCustomerUntil &&
        sameCustomerContact(consent.contact, state.verifiedCustomerContact) &&
        sameCustomerContact(consent.contact, state.verificationChallenge?.contact),
      );
      if (frozenConsent && consent) frozenConsentUntil = consent.expiresAt;
      if (
        state.id !== scope.subjectId ||
        state.counterId !== scope.counterId ||
        state.customerId !== scope.customerId ||
        (!frozenConsent && (!['open', 'quoted'].includes(state.phase) || state.orderId !== null)) ||
        state.draftImport?.status === 'pending' ||
        state.verificationChallenge?.id !== challengeId ||
        (operationId && state.busyOperationId && state.busyOperationId !== operationId)
      )
        throw customerOtpChanged();
      persistedContact = state.verificationChallenge?.contact;
    } else {
      const saved = await readJson(store, returnVerificationKey(scope.subjectId), returnScope);
      if (
        !saved ||
        saved.id !== scope.subjectId ||
        saved.operatorId !== scope.operatorId ||
        saved.storeId !== scope.storeId ||
        saved.counterId !== scope.counterId ||
        saved.customerId !== scope.customerId ||
        saved.orderId !== scope.orderId ||
        saved.otpChallengeId !== challengeId ||
        (operationId && saved.busyOperationId && saved.busyOperationId !== operationId)
      )
        throw customerOtpChanged();
      persistedContact = saved.contact;
    }
    // Also refuses an inactive, blocked or disabled customer (CHECKOUT_CUSTOMER_UNAVAILABLE).
    const contact = await readCustomerContactBinding(tx, scope.customerId);
    if (!sameCustomerContact(persistedContact, contact)) throw customerOtpChanged();
    return { contact, frozenConsentUntil };
  };
}
