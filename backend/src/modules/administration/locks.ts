import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '../../domain/errors.js';
import { withEphemeralLock, type EphemeralStore } from '../../jobs/ephemeral.js';

export type AdministrationLockResource =
  | 'stores'
  | 'operators'
  | 'salespeople'
  | 'documentation'
  | 'settings'
  | 'inventory-imports'
  | 'access-control'
  | 'gift-card-batches';

/** Ledger `administration/locks`: `pos:lock:admin:{resource}`, SET NX PX, token-checked release. */
export const administrationLockKey = (resource: AdministrationLockResource) =>
  `pos:lock:admin:${resource}`;

/**
 * Serialises low-frequency administration writers across instances (replaces the
 * `pos_rewrite_administration_registries` FOR UPDATE rows). Acquire before the writer
 * transaction and keep it until after commit: call the transaction inside `run`.
 * Legacy Django has no lock here; this only narrows check-then-write races.
 */
export async function withAdministrationLock<T>(
  ephemeral: EphemeralStore,
  resource: AdministrationLockResource,
  run: () => Promise<T>,
  options: { leaseMs?: number; waitMs?: number } = {},
): Promise<T> {
  const leaseMs = options.leaseMs ?? 30_000,
    deadline = Date.now() + (options.waitMs ?? 5_000);
  for (;;) {
    const result = await withEphemeralLock(
      ephemeral,
      administrationLockKey(resource),
      leaseMs,
      run,
    );
    if (result) return result.value;
    if (Date.now() >= deadline)
      throw new AppError(
        409,
        'ADMINISTRATION_BUSY',
        'Another administration change is in progress. Try again.',
      );
    await sleep(50);
  }
}

/**
 * @deprecated The registry table is removed under the schema freeze. Kept only so callers
 * outside W8 (auth/profile.ts until the W3 merge) compile; it no longer locks anything.
 * Use `withAdministrationLock` around the transaction instead.
 */
export async function lockAdministrationRegistry(
  _transaction: unknown,
  _resource: AdministrationLockResource,
): Promise<void> {}
