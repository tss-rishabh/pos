import { sql } from 'drizzle-orm';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { AppError } from '../../../domain/errors.js';
import { membershipPublicationError } from './publication.js';

/** Drizzle0.45.4 omits the required comma when combining consistent-snapshot
 * and READ ONLY, and its failed-BEGIN path does not release the pool session.
 * Keep this source-only adapter on a dedicated connection. All data reads use
 * Drizzle; transaction control below is fixed SQL, never caller text. */
export async function readMembershipSourceSnapshot<T>(
  pool: Pick<Pool, 'getConnection'>,
  read: (snapshot: MySql2Database<Record<string, never>>) => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const active = () => {
    if (options.signal?.aborted) throw membershipPublicationError('SOURCE_UNAVAILABLE', 503);
  };
  active();
  let connection: PoolConnection;
  try {
    connection = await pool.getConnection();
  } catch {
    throw membershipPublicationError('SOURCE_UNAVAILABLE', 503);
  }
  let snapshot: MySql2Database<Record<string, never>> | undefined;
  let begun = false,
    reusable = true,
    setupAttempted = false,
    destroyed = false;
  const destroy = () => {
    if (!destroyed) {
      destroyed = true;
      connection.destroy();
    }
  };
  const abort = () => {
    reusable = false;
    destroy();
  };
  try {
    active();
    options.signal?.addEventListener('abort', abort, { once: true });
    snapshot = drizzle(connection);
    setupAttempted = true;
    await snapshot.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    active();
    try {
      await snapshot.execute(sql`START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`);
      begun = true;
    } catch {
      reusable = false;
      throw membershipPublicationError('SOURCE_UNAVAILABLE', 503);
    }
    active();
    const value = await read(snapshot);
    active();
    await snapshot.execute(sql`COMMIT`);
    begun = false;
    return value;
  } catch (error) {
    if (begun && snapshot && !destroyed) {
      try {
        await snapshot.execute(sql`ROLLBACK`);
        begun = false;
      } catch {
        reusable = false;
      }
    } else if (setupAttempted) reusable = false; // discard pending next-transaction settings/setup errors
    if (error instanceof AppError && error.code.startsWith('ORDER_IMPORT_MEMBERSHIP_')) throw error;
    throw membershipPublicationError('SOURCE_UNAVAILABLE', 503);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (reusable) connection.release();
    else destroy();
  }
}
