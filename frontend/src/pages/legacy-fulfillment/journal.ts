import { z } from 'zod';
import { ApiError, captureOperatorScope, request } from '../../api/client';

interface ScopedReceipt {
  commandId: string;
  actorId: string;
  storeId: string;
  orderId: string;
  action: string;
}
export interface CommandJournal<T extends ScopedReceipt> {
  namespace: 'legacy-fulfillment' | 'local-delivery';
  actor: string;
  store: string;
  order: string;
  action: string;
  readPath: string;
  writePath: string;
  method: 'POST' | 'PUT';
  body: Readonly<Record<string, unknown>>;
  intent: readonly unknown[];
  schema: z.ZodType<T>;
}
const marker = z.object({ commandId: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const key = (
  value: Pick<CommandJournal<ScopedReceipt>, 'namespace' | 'actor' | 'store' | 'order' | 'action'>,
) => `pos:${value.namespace}-command:${value.actor}:${value.store}:${value.order}:${value.action}`;
function saved<T extends ScopedReceipt>(journal: CommandJournal<T>) {
  const raw = localStorage.getItem(key(journal));
  if (!raw) return null;
  try {
    return marker.parse(JSON.parse(raw) as unknown);
  } catch {
    throw new Error('The saved fulfillment request needs receipt reconciliation.');
  }
}
function checked<T extends ScopedReceipt>(journal: CommandJournal<T>, value: T, commandId: string) {
  if (
    value.commandId !== commandId ||
    value.actorId !== journal.actor ||
    value.storeId !== journal.store ||
    value.orderId !== journal.order ||
    value.action !== journal.action
  )
    throw new Error('The fulfillment receipt does not match this operator and order.');
  return value;
}
function scopeFor(actor: string, signal?: AbortSignal) {
  const scope = AbortSignal.any([captureOperatorScope(actor), ...(signal ? [signal] : [])]);
  scope.throwIfAborted();
  return scope;
}
export async function recoverCommand<T extends ScopedReceipt>(
  journal: CommandJournal<T>,
  signal?: AbortSignal,
): Promise<T | null> {
  const scope = scopeFor(journal.actor, signal),
    pending = saved(journal);
  if (!pending) return null;
  try {
    const value = checked(
      journal,
      await request(
        journal.readPath + pending.commandId,
        { operatorId: journal.actor, signal: scope, cache: 'no-store' },
        journal.schema,
      ),
      pending.commandId,
    );
    scope.throwIfAborted();
    localStorage.removeItem(key(journal));
    return value;
  } catch (error) {
    scope.throwIfAborted();
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
export async function submitCommand<T extends ScopedReceipt>(
  journal: CommandJournal<T>,
  signal?: AbortSignal,
): Promise<T> {
  const scope = scopeFor(journal.actor, signal),
    old = saved(journal);
  if (old) {
    const confirmed = await recoverCommand(journal, scope);
    scope.throwIfAborted();
    if (confirmed) return confirmed;
  }
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(journal.intent)),
  );
  scope.throwIfAborted();
  const hash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  if (old && old.hash !== hash)
    throw new Error(
      'A previous request needs confirmation. Check its receipt or restore the original note.',
    );
  const operation = old || { commandId: crypto.randomUUID(), hash };
  scope.throwIfAborted();
  localStorage.setItem(key(journal), JSON.stringify(operation));
  try {
    const value = checked(
      journal,
      await request(
        journal.writePath,
        {
          operatorId: journal.actor,
          signal: scope,
          method: journal.method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...journal.body, commandId: operation.commandId }),
        },
        journal.schema,
      ),
      operation.commandId,
    );
    scope.throwIfAborted();
    localStorage.removeItem(key(journal));
    return value;
  } catch (error) {
    scope.throwIfAborted();
    if (
      !old &&
      error instanceof ApiError &&
      [400, 403, 404, 409, 422].includes(error.status) &&
      error.code !== 'IDEMPOTENCY_CONFLICT'
    )
      localStorage.removeItem(key(journal));
    else {
      try {
        const confirmed = await recoverCommand(journal, scope);
        if (confirmed) return confirmed;
      } catch {
        scope.throwIfAborted();
      }
    }
    throw error;
  }
}
