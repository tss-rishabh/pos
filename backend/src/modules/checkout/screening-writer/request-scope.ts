import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../../../domain/access.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { AppError } from '../../../domain/errors.js';

const scopes = new AsyncLocalStorage<{
  user: Principal;
  valid: ((transaction?: AdministrationTransaction) => Promise<boolean>) | undefined;
  managed: boolean;
}>();
/** Installing a scope does no I/O and changes no ordinary route behavior. */
export function publicScreeningRequest<T>(
  request: FastifyRequest,
  user: Principal,
  work: () => Promise<T>,
): Promise<T> {
  const scope = { user, valid: request.authSessionValid ?? undefined, managed: false };
  return scopes.run(scope, async () => {
    const value = await work();
    if (scope.managed && (!scope.valid || !(await scope.valid())))
      throw new AppError(
        401,
        'SESSION_EXPIRED',
        'Sign in again to access this screening sale. Its original outcome is retained.',
      );
    return value;
  });
}
export function markPublicScreeningRequest(user: Pick<Principal, 'id'>): void {
  const scope = scopes.getStore();
  if (scope?.user.id === user.id) scope.managed = true;
}
export async function validPublicScreeningSession(
  user: Pick<Principal, 'id'>,
  transaction?: AdministrationTransaction,
): Promise<boolean> {
  const scope = scopes.getStore();
  return (
    scope?.user.id === user.id && scope.valid !== undefined && (await scope.valid(transaction))
  );
}
export function currentPublicScreeningActor(): Principal | null {
  return scopes.getStore()?.user ?? null;
}
export async function assertPublicScreeningSession(user: Pick<Principal, 'id'>): Promise<void> {
  if (!(await validPublicScreeningSession(user)))
    throw new AppError(
      401,
      'SESSION_EXPIRED',
      'Sign in again to access this screening sale. Its original outcome is retained.',
    );
}
