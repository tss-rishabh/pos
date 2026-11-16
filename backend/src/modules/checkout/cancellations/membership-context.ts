import { AppError } from '../../../domain/errors.js';
export const membershipContextContract = 'pos-membership-fresh-reader-v1';
/** Fresh private POS responses must bind their source membership cache bypass. */
export function verifiedMembershipContext(headers: Headers): boolean {
  const revision = headers.get('X-POS-Membership-Revision');
  return (
    headers.get('X-POS-Membership-Context') === membershipContextContract &&
    revision !== null &&
    /^(?:0|[1-9]\d{0,19})$/.test(revision) &&
    BigInt(revision) <= 18446744073709551615n
  );
}
export function assertMembershipContextContract(contract: string | undefined): void {
  if (contract !== membershipContextContract)
    throw new AppError(
      503,
      'MEMBERSHIP_CONTEXT_CONTRACT_UNVERIFIED',
      'Fresh membership context must be verified before restoring this entitlement.',
    );
}
