import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identifier } from '../domain/validation.js';
import type { Databases } from '../db/pools.js';
import { credentialVersion } from './crypto.js';

/**
 * Compatibility surface for modules that bound short-lived grants to an
 * "authentication version". The rewrite-only per-operator auth epochs
 * (`pos_rewrite_operator_auth_epochs`) are gone (D1/D6, S5): legacy revokes sessions only
 * on a password change or deactivation, which `sessions.ts` enforces on every request.
 * The version is now derived from the account row alone, with no table read.
 */
type Database = ReturnType<Databases['get']>;
export type AuthenticationTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Reader = Pick<Database, 'select'>;
type Account = Parameters<typeof credentialVersion>[0] & { id: bigint };
export function authenticationVersion(account: Account, epoch: bigint = 0n): string {
  return createHash('sha256')
    .update(credentialVersion(account))
    .update(':')
    .update(String(epoch))
    .digest('hex');
}
/** Same value as before for an operator who never had an epoch; `_reader` is unused. */
export async function currentAuthenticationVersion(
  _reader: Reader,
  account: Account,
): Promise<string> {
  return authenticationVersion(account);
}
/**
 * No-op kept for callers. Deactivation and password changes already end sessions on the
 * next request (per-request `is_active` and password-hash checks), as legacy Django does.
 */
export async function invalidateOperatorAuthentication(
  _tx: AuthenticationTransaction,
  userId: string,
): Promise<void> {
  identifier.parse(userId);
}
export async function invalidateOperatorAuthenticationBatch(
  _tx: AuthenticationTransaction,
  userIds: readonly string[],
): Promise<void> {
  z.array(identifier).max(500).parse(userIds);
}
