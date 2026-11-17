import type { AdministrationTransaction } from '../../administration/checkins.js';
import { contactActorVersion } from '../../customer-contacts/authority.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import type { CheckoutState } from '../contracts.js';
import { readCustomerContactBinding, sameCustomerContact } from '../customer-contact-authority.js';
import {
  checkoutCustomerOtpScope,
  type CustomerVerificationClient,
} from '../customer-verification.js';
import { copyCustomerAuthoritySchema, type CopyCustomerAuthority } from './contracts.js';

export interface CopySourceAccess {
  state: CheckoutState;
  kind: 'new' | 'review' | 'command';
  authority?: CopyCustomerAuthority;
}
const required = () =>
  new AppError(
    403,
    'CUSTOMER_VERIFICATION_REQUIRED',
    'Verify the connected customer before copying their purchases.',
  );
const changed = () =>
  new AppError(
    409,
    'ORDER_COPY_CUSTOMER_AUTHORITY_CHANGED',
    'Customer verification or operator access changed. Keep the original copy reference for review.',
  );

/** Caller holds the checkout/current actor/customer locks in the same writer TX.
 * Command recovery validates the immutable capture, never renews or invents OTP.
 * Fresh review/start always invokes the actual injected native OTP verifier. */
export async function authorizeCustomerCopy(
  tx: AdministrationTransaction,
  user: Principal,
  access: CopySourceAccess,
  otp: CustomerVerificationClient | undefined,
  clock: () => number,
): Promise<CopyCustomerAuthority> {
  const state = access.state;
  if (!state.customerId || state.operatorId !== user.id) throw required();
  const current = await readCustomerContactBinding(tx, state.customerId),
    actorVersion = await contactActorVersion(tx, user.id);
  if (!state.verifiedCustomerContact && access.kind === 'new') throw required();
  if (!sameCustomerContact(state.verifiedCustomerContact, current)) throw changed();
  if (access.kind !== 'new') {
    const original = copyCustomerAuthoritySchema.safeParse(access.authority);
    if (!original.success)
      throw new AppError(
        409,
        'ORDER_COPY_CUSTOMER_AUTHORIZATION_UNPROVED',
        'This original customer copy has no verified authorization. Reconcile it without recreating its proof.',
      );
    if (
      !sameCustomerContact(original.data.contact, current) ||
      original.data.actorVersion !== actorVersion
    )
      throw changed();
    if (access.kind === 'command') return original.data;
  }
  if (
    !otp?.assertVerified ||
    !state.verificationChallenge?.id ||
    !state.verifiedCustomerUntil ||
    state.verifiedCustomerUntil <= clock()
  )
    throw required();
  if (!sameCustomerContact(state.verificationChallenge.contact, current)) throw changed();
  await otp.assertVerified(
    tx,
    user,
    checkoutCustomerOtpScope(state),
    state.verificationChallenge.id,
    current,
    state.verifiedCustomerUntil,
  );
  const captured = copyCustomerAuthoritySchema.parse({
    contact: current,
    actorVersion,
    challengeId: state.verificationChallenge.id,
    verifiedUntil: state.verifiedCustomerUntil,
    capturedAt: clock(),
  });
  if (
    access.authority &&
    (access.authority.challengeId !== captured.challengeId ||
      access.authority.verifiedUntil !== captured.verifiedUntil)
  )
    throw changed();
  return access.authority ?? captured;
}
