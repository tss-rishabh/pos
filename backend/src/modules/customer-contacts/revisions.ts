import { identifier } from '../../domain/validation.js';
import type { AdministrationTransaction } from '../administration/checkins.js';

/**
 * The rewrite-only `pos_rewrite_customer_contact_revisions` counter is deleted (schema
 * freeze; table-disposition.md customer-contacts). Contact proofs bind to the native
 * `users` digest only, so the revision is always 0. Lost: an A→B→A contact flip inside a
 * proof window is no longer detected (ledger row, risk medium).
 */
export async function readCurrentContactRevision(
  _tx: AdministrationTransaction,
  customerId: string,
): Promise<bigint> {
  identifier.parse(customerId);
  return 0n;
}
/** @deprecated No revision is stored; kept so existing callers compile. */
export async function ensureCustomerContactRevision(
  tx: AdministrationTransaction,
  customerId: string,
): Promise<bigint> {
  return readCurrentContactRevision(tx, customerId);
}
/** @deprecated No revision is stored; kept so existing callers compile. */
export async function bumpCurrentContactRevision(
  tx: AdministrationTransaction,
  customerId: string,
): Promise<bigint> {
  return readCurrentContactRevision(tx, customerId);
}
