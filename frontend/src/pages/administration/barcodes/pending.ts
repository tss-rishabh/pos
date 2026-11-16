import { z } from 'zod';
import { assignmentInput, type AssignmentInput } from './api';
const owner = z.string().regex(/^[1-9]\d{0,18}$/);
const saved = z
  .object({
    ownerId: owner,
    input: assignmentInput,
    createdAt: z.number().int().safe().nonnegative(),
  })
  .strict();
export type PendingAssignment = z.infer<typeof saved>;
const prefix = (ownerId: string) => 'pos-barcode-assignment-v1:' + owner.parse(ownerId) + ':';
const invalid = () =>
  new Error(
    'Saved barcode actions are unavailable. Restore browser storage before assigning another barcode.',
  );
export function pendingAssignments(
  ownerId: string,
  storage: Storage = localStorage,
): PendingAssignment[] {
  try {
    if (storage.length > 10000) throw invalid();
    const start = prefix(ownerId),
      keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
        (key): key is string => key !== null && key.startsWith(start),
      ),
      rows: PendingAssignment[] = [];
    for (const key of keys) {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const row = saved.parse(JSON.parse(raw) as unknown);
      if (row.ownerId !== ownerId || key !== start + row.input.operationId) throw invalid();
      rows.push(row);
    }
    if (rows.length > 20) throw invalid();
    return rows.sort(
      (a, b) => a.createdAt - b.createdAt || a.input.operationId.localeCompare(b.input.operationId),
    );
  } catch {
    throw invalid();
  }
}
export function savePendingAssignment(
  ownerId: string,
  input: AssignmentInput,
  storage: Storage = localStorage,
): PendingAssignment {
  try {
    const rows = pendingAssignments(ownerId, storage),
      prior = rows.find((row) => row.input.operationId === input.operationId);
    if (prior) {
      if (prior.input.productId !== input.productId || prior.input.barcode !== input.barcode)
        throw invalid();
      return prior;
    }
    if (rows.length >= 20) throw invalid();
    const row = saved.parse({ ownerId, input, createdAt: Date.now() });
    storage.setItem(prefix(ownerId) + input.operationId, JSON.stringify(row));
    return row;
  } catch {
    throw invalid();
  }
}
/** Only invoke after an exact actor/input-bound committed receipt has been read. */
export function removePendingAssignment(
  ownerId: string,
  input: AssignmentInput,
  storage: Storage = localStorage,
) {
  try {
    const row = pendingAssignments(ownerId, storage).find(
      (value) => value.input.operationId === input.operationId,
    );
    if (row && (row.input.productId !== input.productId || row.input.barcode !== input.barcode))
      throw invalid();
    storage.removeItem(prefix(ownerId) + input.operationId);
  } catch {
    throw invalid();
  }
}
