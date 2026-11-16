import { Temporal } from '@js-temporal/polyfill';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { currentAuthenticationVersion } from '../../auth/revocation.js';
import { PosUser } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { CheckoutState } from '../checkout/contracts.js';
import {
  customerRegistrationsTable,
  customerRegistrationClaims,
} from '../checkout/customers/schema.js';
import { customerProfileEditable } from '../customer-insights/checkout-scope.js';
import { contactUsers } from './legacy-schema.js';
import { contactDigest } from './crypto.js';
import { hasRealCustomerEmail } from './references.js';
import { ensureCustomerContactRevision } from './revisions.js';

export const contactChanged = () =>
  new AppError(
    409,
    'CUSTOMER_CONTACT_CHANGED',
    'Customer or sale details changed. Reload before continuing this contact change.',
  );
export const contactNotFound = () =>
  new AppError(404, 'CUSTOMER_CONTACT_NOT_FOUND', 'This contact verification was not found.');
export const contactUnavailable = () =>
  new AppError(
    503,
    'CUSTOMER_CONTACT_UNAVAILABLE',
    'Verified contact changes are not configured for this workspace.',
  );
export async function contactActorVersion(tx: AdministrationTransaction, operatorId: string) {
  const [actor] = await tx
    .select({
      id: PosUser.id,
      is_active: PosUser.is_active,
      username: PosUser.username,
      email: PosUser.email,
      password: PosUser.password,
      is_mfa: PosUser.is_mfa,
      mfa_hash: PosUser.mfa_hash,
      phone: PosUser.phone,
      contact_email: PosUser.contact_email,
      otp_method: PosUser.otp_method,
      role: PosUser.role,
      user_type: PosUser.user_type,
      is_staff: PosUser.is_staff,
      is_superuser: PosUser.is_superuser,
    })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(operatorId)))
    .limit(1)
    .for('share');
  if (!actor?.is_active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  return currentAuthenticationVersion(tx, actor);
}
export async function lockContactCustomer(tx: AdministrationTransaction, customerId: string) {
  const [customer] = await tx
    .select()
    .from(contactUsers)
    .where(
      and(
        eq(contactUsers.id, BigInt(customerId)),
        eq(contactUsers.userType, '2'),
        eq(contactUsers.status, 1),
        or(isNull(contactUsers.blocked), eq(contactUsers.blocked, 0)),
        or(isNull(contactUsers.disabled), eq(contactUsers.disabled, 0)),
      ),
    )
    .limit(1)
    .for('update');
  if (!customer)
    throw new AppError(
      403,
      'CUSTOMER_CONTACT_ACCOUNT_UNAVAILABLE',
      'This customer account is unavailable.',
    );
  return { ...customer, contactRevision: await ensureCustomerContactRevision(tx, customerId) };
}
export type ContactCustomer = Awaited<ReturnType<typeof lockContactCustomer>>;
export function contactFingerprint(secret: string, customer: ContactCustomer) {
  return contactDigest(
    secret,
    'customer',
    JSON.stringify([
      String(customer.id),
      customer.email,
      customer.telephone,
      customer.emailVerified,
      customer.twoFactor,
      customer.status,
      customer.userType,
      String(customer.contactRevision),
      customer.blocked,
      customer.disabled,
    ]),
  );
}
export function currentProofDestination(customer: ContactCustomer) {
  if (/^[6-9]\d{9}$/.test(customer.telephone))
    return { channel: 'sms' as const, destination: customer.telephone };
  if (hasRealCustomerEmail(customer.email) && z.email().max(96).safeParse(customer.email).success)
    return { channel: 'email' as const, destination: customer.email };
  throw new AppError(
    409,
    'CUSTOMER_CONTACT_EXISTING_PROOF_UNAVAILABLE',
    'A verified existing customer contact is required. Use account support to recover this customer first.',
  );
}
export function assertMissingContact(customer: ContactCustomer, kind: 'telephone' | 'email') {
  if (kind === 'telephone' ? Boolean(customer.telephone) : hasRealCustomerEmail(customer.email))
    throw new AppError(
      409,
      'CUSTOMER_CONTACT_ALREADY_PRESENT',
      'This customer already has that contact. Only missing contacts can be added here.',
    );
}
export async function assertEditableContactCheckout(
  tx: AdministrationTransaction,
  state: CheckoutState,
  expectedVersion?: number,
) {
  if (
    !customerProfileEditable(state) ||
    (expectedVersion !== undefined && state.version !== expectedVersion)
  )
    throw contactChanged();
  if (state.registrationId) {
    const [registration] = await tx
      .select({
        status: customerRegistrationsTable.status,
        customerId: customerRegistrationsTable.customerId,
      })
      .from(customerRegistrationsTable)
      .where(eq(customerRegistrationsTable.id, state.registrationId))
      .limit(1)
      .for('share');
    if (
      !registration ||
      registration.status !== 'registered' ||
      registration.customerId !== state.customerId
    )
      throw new AppError(
        409,
        'CUSTOMER_CONTACT_REGISTRATION_PENDING',
        'Finish or cancel the pending customer registration before changing a contact.',
      );
  }
}
/** Same mutex namespace as registration; uncertain/missing owners are never reclaimed. */
export async function assertContactRegistrationAvailable(
  tx: AdministrationTransaction,
  key: string,
  now: number,
) {
  const [claim] = await tx
    .select()
    .from(customerRegistrationClaims)
    .where(eq(customerRegistrationClaims.key, key))
    .limit(1)
    .for('update');
  if (!claim) return;
  const [owner] = await tx
    .select({
      status: customerRegistrationsTable.status,
      expiresAt: customerRegistrationsTable.expiresAt,
    })
    .from(customerRegistrationsTable)
    .where(eq(customerRegistrationsTable.id, claim.registrationId))
    .limit(1)
    .for('share');
  if (
    !owner ||
    ['dispatching', 'uncertain', 'registered'].includes(owner.status) ||
    !['pending', 'verified', 'expired', 'locked', 'cancelled'].includes(owner.status) ||
    !Number.isSafeInteger(owner.expiresAt) ||
    owner.expiresAt > now
  )
    throw new AppError(
      409,
      'CUSTOMER_CONTACT_REGISTRATION_PENDING',
      'A customer registration for this contact is pending or needs review.',
    );
  await tx.delete(customerRegistrationClaims).where(eq(customerRegistrationClaims.key, key));
}
export function contactWallTime(now: number, zone: string) {
  return Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })
    .replace('T', ' ');
}
/** Indexed absent-target locks must retain InnoDB next-key protection through commit. */
export async function assertContactWriterIsolation(tx: AdministrationTransaction) {
  const result = await tx.execute(sql`SELECT @@SESSION.transaction_isolation AS level`);
  const rows = z
    .array(z.object({ level: z.enum(['REPEATABLE-READ', 'SERIALIZABLE']) }))
    .safeParse(result[0]);
  if (!rows.success || rows.data.length !== 1)
    throw new AppError(
      503,
      'CUSTOMER_CONTACT_ISOLATION_REQUIRED',
      'Contact changes require a verified writer transaction isolation level.',
    );
}
