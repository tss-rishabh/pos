import { eq } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import { MUser } from '../../db/legacy-schema.js';
import { identifier } from '../../domain/validation.js';
import { retryTransaction } from '../../db/retry.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { importFinancialError } from './financial-adapter-crypto.js';

interface Witness {
  readonly customers: Set<string>;
}
const active = new WeakMap<AdministrationTransaction, Witness>();

/** This is the only witness mint: isolation is set before BEGIN by Drizzle.
 * Selected screening work has no automatic deadlock/timeout retry. */
export function financialTransaction<T>(
  db: Databases,
  screening: boolean,
  work: (transaction: AdministrationTransaction) => Promise<T>,
): Promise<T> {
  const run = () =>
    db.get('writer').transaction(
      async (tx) => {
        if (!screening) return work(tx);
        active.set(tx, { customers: new Set() });
        try {
          return await work(tx);
        } finally {
          active.delete(tx);
        }
      },
      screening ? { isolationLevel: 'read committed' } : undefined,
    );
  return screening ? run() : retryTransaction(run);
}
export function assertScreeningTransaction(tx: AdministrationTransaction) {
  if (!active.has(tx))
    throw importFinancialError('ORDER_IMPORT_SCREENING_TRANSACTION_REQUIRED', 503);
}
/** Inspection only: this does not mint authority or change caller isolation. */
export function usesCurrentFinancialReads(tx: AdministrationTransaction): boolean {
  return active.has(tx);
}
export async function financialSavepoint<T>(
  tx: AdministrationTransaction,
  work: (savepoint: AdministrationTransaction) => Promise<T>,
): Promise<T> {
  const original = active.get(tx);
  return tx.transaction(async (savepoint) => {
    const witness = original ? { customers: new Set(original.customers) } : undefined;
    if (witness) active.set(savepoint, witness);
    try {
      const result = await work(savepoint);
      if (witness && original)
        for (const customer of witness.customers) original.customers.add(customer);
      return result;
    } finally {
      active.delete(savepoint);
    }
  });
}
/** A native row lock, not a caller-provided claim of ownership. */
export async function lockScreeningCustomer(tx: AdministrationTransaction, customer: string) {
  assertScreeningTransaction(tx);
  const id = identifier.parse(customer),
    witness = active.get(tx)!;
  if (witness.customers.has(id)) return;
  if (witness.customers.size) throw importFinancialError('ORDER_IMPORT_SCREENING_SCOPE_CHANGED');
  const [row] = await tx
    .select({ id: MUser.id })
    .from(MUser)
    .where(eq(MUser.id, BigInt(id)))
    .limit(1)
    .for('update');
  if (!row) throw importFinancialError('ORDER_IMPORT_SCREENING_SCOPE_CHANGED');
  witness.customers.add(id);
}
export function assertScreeningCustomer(tx: AdministrationTransaction, customer: string) {
  assertScreeningTransaction(tx);
  if (!active.get(tx)!.customers.has(identifier.parse(customer)))
    throw importFinancialError('ORDER_IMPORT_SCREENING_CUSTOMER_LOCK_REQUIRED', 503);
}
