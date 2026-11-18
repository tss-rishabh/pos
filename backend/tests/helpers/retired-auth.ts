/**
 * Identifiers of the rewrite-only auth tables and helpers removed when authentication moved
 * to Redis (W3: pos_rewrite_sessions, pos_rewrite_login_challenges, pos_rewrite_login_security,
 * pos_rewrite_operator_auth_epochs, pos_rewrite_profile_uploads/_media_jobs). Integration
 * cases that still use them encode retired behaviour (auth epochs, table-backed sessions)
 * and fail loudly here until their owners rewrite them against Redis sessions.
 */
function retired(name: string): never {
  throw new Error(`${name} was removed with the Redis auth re-home (W3); rewrite this case.`);
}
const table = (name: string) =>
  new Proxy(
    {},
    {
      get: () => retired(name),
    },
  );
export const operatorAuthEpochs = table('pos_rewrite_operator_auth_epochs');
export const loginChallenges = table('pos_rewrite_login_challenges');
export const loginSecurity = table('pos_rewrite_login_security');
export const profileUploads = table('pos_rewrite_profile_uploads');
export function mysqlSessions(..._args: unknown[]): never {
  return retired('mysqlSessions (pos_rewrite_sessions)');
}
export function profileMediaCleanup(..._args: unknown[]): never {
  return retired('profileMediaCleanup (pos_rewrite_profile_media_jobs)');
}
