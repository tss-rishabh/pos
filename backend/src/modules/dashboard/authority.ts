import { createHash } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { PosUser, Store, UserStore } from '../../db/legacy-schema.js';
import { currentAuthenticationVersion } from '../../auth/revocation.js';
import type { DashboardStore } from './domain.js';

export interface DashboardAuthority {
  fingerprint: string;
  orderStoreIds: string[];
  graphStores: DashboardStore[];
}
export async function dashboardAuthority(
  db: Databases,
  user: Principal,
): Promise<DashboardAuthority> {
  return db.get('writer').transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(user.id)))
      .limit(1)
      .for('share');
    if (!account?.is_active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    if (account.user_type !== 1 || ![1, 2, 3, 4, 5].includes(account.role))
      throw new AppError(
        403,
        'DASHBOARD_ACCESS_DENIED',
        'This dashboard is available to internal operators.',
      );
    const assignments = await tx
      .select({ storeId: UserStore.store_id })
      .from(UserStore)
      .where(eq(UserStore.django_user_id, account.id))
      .for('share');
    const assigned = [
      ...new Set(
        assignments.flatMap((row) =>
          row.storeId !== null && row.storeId > 0n ? [String(row.storeId)] : [],
        ),
      ),
    ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    if (assigned.length > 500)
      throw new AppError(
        422,
        'DASHBOARD_SCOPE_TOO_WIDE',
        'Dashboard access supports at most 500 assigned stores.',
      );
    const stores =
      account.role !== 1 && !assigned.length
        ? []
        : await tx
            .select({ id: Store.id, name: Store.store_name })
            .from(Store)
            .where(
              and(
                eq(Store.is_active, true),
                account.role === 1 ? undefined : inArray(Store.id, assigned.map(BigInt)),
              ),
            )
            .orderBy(asc(Store.id))
            .limit(501)
            .for('share');
    if (stores.length > 500)
      throw new AppError(
        422,
        'DASHBOARD_SCOPE_TOO_WIDE',
        'Dashboard access supports at most 500 active stores.',
      );
    const graphStores = stores.map((row) => ({ id: String(row.id), name: row.name })),
      orderStoreIds = account.role === 1 ? graphStores.map((row) => row.id) : assigned;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          version: await currentAuthenticationVersion(tx, account),
          orderStoreIds,
          graphStores: graphStores.map((row) => row.id),
        }),
      )
      .digest('hex');
    return { fingerprint, orderStoreIds, graphStores };
  });
}
export async function recheckDashboardAuthority(
  db: Databases,
  user: Principal,
  original: DashboardAuthority,
) {
  const current = await dashboardAuthority(db, user);
  if (current.fingerprint !== original.fingerprint)
    throw new AppError(
      409,
      'DASHBOARD_SCOPE_CHANGED',
      'Dashboard access changed. Refresh to load the current store scope.',
    );
}
