import { z } from 'zod';
import { ApiError, captureOperatorScope, request } from '../../api/client';
import { maintenanceReceipt, type MaintenanceKind } from './maintenance-contracts';
export type InventoryPullInput =
  { mode: 'manual'; skus: string } | { mode: 'csv'; filename: string; csv: string };
export type MaintenanceAction =
  | { kind: 'inventory-pull'; input: InventoryPullInput }
  | { kind: 'product-troubleshoot'; productId: string; expectedPlanHash: string };
type CommandStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const marker = z.object({ id: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const key = (ownerId: string, kind: MaintenanceKind) =>
  `pos:catalog-maintenance-command:${ownerId}:${kind}`;
export function pendingMaintenanceCommand(
  ownerId: string,
  kind: MaintenanceKind,
  storage: CommandStorage = localStorage,
) {
  const saved = storage.getItem(key(ownerId, kind));
  if (!saved) return null;
  let value: unknown;
  try {
    value = JSON.parse(saved) as unknown;
  } catch {
    throw new Error(
      'The saved maintenance request cannot be read. Review the active commands before continuing.',
    );
  }
  const parsed = marker.safeParse(value);
  if (!parsed.success)
    throw new Error(
      'The saved maintenance request cannot be read. Review the active commands before continuing.',
    );
  return parsed.data;
}
export function completeMaintenanceMarker(
  ownerId: string,
  receipt: z.infer<typeof maintenanceReceipt>,
  storage: CommandStorage = localStorage,
) {
  try {
    const saved = pendingMaintenanceCommand(ownerId, receipt.kind, storage);
    if (saved?.id === receipt.id && ['SUCCEEDED', 'FAILED'].includes(receipt.state))
      storage.removeItem(key(ownerId, receipt.kind));
  } catch {
    /* An unreadable marker must be reviewed, never overwritten by a background effect. */
  }
}
/** Store only a UUID and hash; raw CSV, search text and repair data never enter local storage. */
export async function submitMaintenanceCommand(
  ownerId: string,
  action: MaintenanceAction,
  storage: CommandStorage = localStorage,
  send?: (
    commandId: string,
    action: MaintenanceAction,
    signal: AbortSignal,
  ) => Promise<z.infer<typeof maintenanceReceipt>>,
) {
  const signal = captureOperatorScope(ownerId),
    bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(action)));
  signal.throwIfAborted();
  const hash = Array.from(new Uint8Array(bytes), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join(''),
    old = pendingMaintenanceCommand(ownerId, action.kind, storage);
  if (old && old.hash !== hash)
    throw new Error('Check the previous maintenance request before changing its inputs.');
  const saved = old || { id: crypto.randomUUID(), hash };
  signal.throwIfAborted();
  storage.setItem(key(ownerId, action.kind), JSON.stringify(saved));
  try {
    const result = send
      ? await send(saved.id, action, signal)
      : await request(
          action.kind === 'inventory-pull'
            ? '/api/v1/catalog/inventory-pulls'
            : `/api/v1/catalog/products/${action.productId}/troubleshooting`,
          {
            method: 'POST',
            operatorId: ownerId,
            signal,
            body: JSON.stringify(
              action.kind === 'inventory-pull'
                ? { commandId: saved.id, input: action.input }
                : { commandId: saved.id, expectedPlanHash: action.expectedPlanHash },
            ),
          },
          maintenanceReceipt,
        );
    signal.throwIfAborted();
    completeMaintenanceMarker(ownerId, result, storage);
    return result;
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.code !== 'CATALOG_COMMAND_CONFLICT' &&
      [400, 401, 403, 404, 409, 413, 422, 429].includes(error.status)
    )
      storage.removeItem(key(ownerId, action.kind));
    throw error;
  }
}
