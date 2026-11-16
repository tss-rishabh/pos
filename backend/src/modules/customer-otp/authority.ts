import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { checkInService, type AdministrationTransaction } from '../administration/checkins.js';
import { checkoutStateSchema } from '../checkout/contracts.js';
import { checkoutSessions } from '../checkout/schema.js';
import { returnVerifications } from '../checkout/return-workflow/schema.js';
import {
  readCustomerContactBinding,
  sameCustomerContact,
  customerContactBindingSchema,
  type CustomerContactBinding,
} from '../checkout/customer-contact-authority.js';
import { contactActorVersion } from '../customer-contacts/authority.js';
import { contactUsers } from '../customer-contacts/legacy-schema.js';
import { hasRealCustomerEmail } from '../customer-contacts/references.js';
import type { CustomerOtpScope } from './contracts.js';
import type { CustomerOtpOptions } from './options.js';

export const customerOtpUnavailable = () =>
  new AppError(
    503,
    'CUSTOMER_OTP_UNAVAILABLE',
    'Customer verification requires configured secure delivery.',
  );
export const customerOtpChanged = () =>
  new AppError(
    409,
    'CUSTOMER_OTP_SCOPE_CHANGED',
    'The customer or sale changed. Request a new verification code.',
  );
export function assertCustomerOtpEnabled(
  config: Pick<Config, 'DEMO_MODE'>,
  options: CustomerOtpOptions,
) {
  if (
    config.DEMO_MODE ||
    !options.CUSTOMER_OTP_ENABLED ||
    options.CUSTOMER_OTP_CONTRACT !== 'pos-customer-otp-v1' ||
    !options.CUSTOMER_OTP_SECRET
  )
    throw customerOtpUnavailable();
}
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
/** Lock order shared with checkout/contact changes: check-in/actor -> scope -> MUser -> revision. */
export function customerOtpAuthority(config: Config, db: Databases) {
  const checkIns = checkInService(db, config);
  return async function lockAuthority(
    tx: AdministrationTransaction,
    scope: CustomerOtpScope,
    challengeId: string,
    operationId?: string,
    allowFrozenConsent = false,
  ) {
    await checkIns.assertCheckIn(scope.operatorId, scope.storeId, scope.counterId, tx);
    const actorVersion = await contactActorVersion(tx, scope.operatorId);
    let persistedContact: CustomerContactBinding | null | undefined;
    let frozenConsentUntil: number | null = null;
    if (scope.purpose === 'checkout-benefits') {
      const [row] = await tx
        .select()
        .from(checkoutSessions)
        .where(
          and(
            eq(checkoutSessions.id, scope.subjectId),
            eq(checkoutSessions.operatorId, scope.operatorId),
            eq(checkoutSessions.storeId, scope.storeId),
          ),
        )
        .limit(1)
        .for('update');
      const parsed = checkoutStateSchema.safeParse(row?.state);
      if (!parsed.success) throw customerOtpChanged();
      const state = parsed.data;
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
        state.operatorId !== scope.operatorId ||
        state.storeId !== scope.storeId ||
        state.counterId !== scope.counterId ||
        state.customerId !== scope.customerId ||
        state.version !== row?.version ||
        (!frozenConsent && (!['open', 'quoted'].includes(state.phase) || state.orderId !== null)) ||
        state.draftImport?.status === 'pending' ||
        state.verificationChallenge?.id !== challengeId ||
        (operationId && state.busyOperationId && state.busyOperationId !== operationId)
      )
        throw customerOtpChanged();
      persistedContact = state.verificationChallenge?.contact;
    } else {
      const [row] = await tx
        .select({ state: returnVerifications.state })
        .from(returnVerifications)
        .where(eq(returnVerifications.id, scope.subjectId))
        .limit(1)
        .for('update');
      const parsed = returnScope.safeParse(row?.state);
      if (
        !parsed.success ||
        parsed.data.id !== scope.subjectId ||
        parsed.data.operatorId !== scope.operatorId ||
        parsed.data.storeId !== scope.storeId ||
        parsed.data.counterId !== scope.counterId ||
        parsed.data.customerId !== scope.customerId ||
        parsed.data.orderId !== scope.orderId ||
        parsed.data.otpChallengeId !== challengeId ||
        (operationId && parsed.data.busyOperationId && parsed.data.busyOperationId !== operationId)
      )
        throw customerOtpChanged();
      persistedContact = parsed.data.contact;
    }
    const [customer] = await tx
      .select()
      .from(contactUsers)
      .where(eq(contactUsers.id, BigInt(scope.customerId)))
      .limit(1)
      .for('update');
    if (
      !customer ||
      customer.userType !== '2' ||
      customer.status !== 1 ||
      customer.blocked === 1 ||
      customer.disabled === 1
    )
      throw customerOtpChanged();
    const contact = await readCustomerContactBinding(tx, scope.customerId);
    if (!sameCustomerContact(persistedContact, contact)) throw customerOtpChanged();
    return { actorVersion, customer, contact, frozenConsentUntil };
  };
}
export type CustomerOtpAuthority = Awaited<ReturnType<ReturnType<typeof customerOtpAuthority>>>;
export function customerOtpDestinations(
  authority: CustomerOtpAuthority,
  options: CustomerOtpOptions,
) {
  const channels: { channel: 'sms' | 'email' | 'whatsapp'; destination: string }[] = [];
  const customer = authority.customer;
  const realEmail =
    hasRealCustomerEmail(customer.email) && z.email().max(96).safeParse(customer.email).success;
  const employeeEmail = realEmail && customer.email.toLowerCase().includes('@thesouledstore');
  if (
    /^[6-9]\d{9}$/.test(customer.telephone) &&
    (!employeeEmail || options.CUSTOMER_OTP_MOBILE_FOR_EMPLOYEES)
  ) {
    channels.push({ channel: 'sms', destination: customer.telephone });
    if (options.CUSTOMER_OTP_WHATSAPP_FALLBACK_ENABLED)
      channels.push({ channel: 'whatsapp', destination: customer.telephone });
  }
  if (realEmail) channels.push({ channel: 'email', destination: customer.email });
  if (!channels.length)
    throw new AppError(
      409,
      'CUSTOMER_OTP_CONTACT_UNAVAILABLE',
      'This customer needs a reachable real contact before verification.',
    );
  return channels;
}
export function assertCurrentOtpBinding(
  stored: { actorVersion: string; contact: CustomerOtpAuthority['contact'] },
  current: CustomerOtpAuthority,
) {
  if (
    stored.actorVersion !== current.actorVersion ||
    !sameCustomerContact(stored.contact, current.contact)
  )
    throw customerOtpChanged();
}
