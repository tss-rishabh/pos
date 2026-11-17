import { z } from 'zod';
const identifier = z.string().regex(/^[1-9]\d{0,18}$/),
  uuid = z.uuid();
const pending = z
  .object({
    ownerId: identifier,
    operationId: uuid,
    createdAt: z.number().int().safe().nonnegative(),
  })
  .strict();
const prefix = (ownerId: string) => 'pos-model-account-v1:' + identifier.parse(ownerId) + ':';
const invalid = () =>
  new Error(
    'Saved account operations are unavailable. Restore browser storage before creating an account.',
  );
/** Metadata only: never persist username, password, confirmation, contact or password hash. */
export function pendingAccounts(ownerId: string, storage: Storage = localStorage) {
  try {
    if (storage.length > 10000) throw invalid();
    const start = prefix(ownerId),
      rows: z.infer<typeof pending>[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(start)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const row = pending.parse(JSON.parse(raw) as unknown);
      if (row.ownerId !== ownerId || key !== start + row.operationId) throw invalid();
      rows.push(row);
    }
    if (rows.length > 20) throw invalid();
    return rows.sort(
      (a, b) => a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId),
    );
  } catch {
    throw invalid();
  }
}
export function savePendingAccount(
  ownerId: string,
  operationId: string,
  storage: Storage = localStorage,
) {
  try {
    const rows = pendingAccounts(ownerId, storage),
      prior = rows.find((row) => row.operationId === operationId);
    if (prior) return prior;
    if (rows.length >= 20) throw invalid();
    const row = pending.parse({ ownerId, operationId, createdAt: Date.now() });
    storage.setItem(prefix(ownerId) + row.operationId, JSON.stringify(row));
    return row;
  } catch {
    throw invalid();
  }
}
/** Only after an exact actor/original-operation receipt; a404 does not erase the operation. */
export function removePendingAccount(
  ownerId: string,
  operationId: string,
  storage: Storage = localStorage,
) {
  try {
    pendingAccounts(ownerId, storage);
    storage.removeItem(prefix(ownerId) + uuid.parse(operationId));
  } catch {
    throw invalid();
  }
}
