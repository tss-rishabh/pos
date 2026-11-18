import { asc, count, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PosUser } from '../../db/legacy-schema.js';
import { identifier } from '../../domain/validation.js';
import { AppError, unavailable } from '../../domain/errors.js';
import type { AdministrationTransaction } from './checkins.js';

export interface StoreDefaultOperatorOptions {
  /** Legacy server-constructor option; production configuration uses contact identities. */
  defaultStoreOperatorIds?: string[];
  /** Source STOREDEFAULTUSER identities are PosUser.contact_email, not login email. */
  defaultStoreOperatorContactEmails?: string[];
}
const identities = z.array(z.email().max(254)).max(100);
const ids = z.array(identifier).max(100);

/** Parse configuration only. Resolving mutable identities belongs to the writer transaction. */
export function readStoreDefaultOperatorOptions(
  env: NodeJS.ProcessEnv = process.env,
): StoreDefaultOperatorOptions {
  const raw = env.STOREDEFAULTUSER;
  if (raw === undefined) return {};
  if (raw.trim() === '') return { defaultStoreOperatorContactEmails: [] };
  return {
    defaultStoreOperatorContactEmails: identities.parse(raw.split(',')),
  };
}

/** Source skips missing configured contacts and retains archived recipients' assignments. */
export async function resolveDefaultStoreOperatorIds(
  transaction: AdministrationTransaction,
  options: StoreDefaultOperatorOptions,
): Promise<bigint[]> {
  const byId = options.defaultStoreOperatorIds;
  const byContact = options.defaultStoreOperatorContactEmails;
  if (byId !== undefined && byContact !== undefined)
    throw new AppError(
      503,
      'STORE_DEFAULT_OPERATORS_AMBIGUOUS',
      'Configure one source for default store operators.',
    );
  if (byId === undefined && byContact === undefined)
    return unavailable('Default store operator assignments');
  const selected = byId === undefined ? identities.parse(byContact) : ids.parse(byId);
  if (!selected.length) return [];
  const rows = await transaction
    .select({ id: PosUser.id, role: PosUser.role, userType: PosUser.user_type })
    .from(PosUser)
    .where(
      byId === undefined
        ? inArray(PosUser.contact_email, selected)
        : inArray(PosUser.id, selected.map(BigInt)),
    )
    .orderBy(asc(PosUser.id))
    .limit(101)
    .for('share');
  if (
    rows.length > 100 ||
    rows.some(
      (row) =>
        row.id <= 0n || ![1, 2, 3, 4, 5].includes(row.role) || ![1, 2].includes(row.userType),
    )
  )
    return unavailable('Reconciled default store operators');
  // Group in MySQL using the source column's collation, rather than inventing
  // JavaScript email equality. The selected identity rows remain writer-locked.
  if (byId === undefined && rows.length > 1) {
    const [ambiguous] = await transaction
      .select({ matches: count() })
      .from(PosUser)
      .where(
        inArray(
          PosUser.id,
          rows.map((row) => row.id),
        ),
      )
      .groupBy(PosUser.contact_email)
      .having(sql`count(*) > 1`)
      .limit(1);
    if (ambiguous)
      throw new AppError(
        503,
        'STORE_DEFAULT_OPERATORS_AMBIGUOUS',
        'Default store operator identities require reconciliation.',
      );
  }
  return rows.map((row) => row.id);
}
