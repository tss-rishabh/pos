import { z } from 'zod';
import { captureOperatorScope } from '../../../api/client';
import { importCounterSchema, type OrderImportInput } from './client';

const identifier = z.string().regex(/^[1-9]\d{0,19}$/);
export const importIntentSchema = z
  .object({
    version: z.literal(1),
    operatorId: identifier,
    id: z.uuid(),
    kind: z.enum(['offline', 'shopify']),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    counters: z.array(importCounterSchema).min(1).max(100),
    storeId: identifier.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.kind === 'offline') !== (value.storeId === null) ||
      new Set(value.counters.map((scope) => scope.storeId)).size !== value.counters.length
    )
      context.addIssue({ code: 'custom', message: 'The saved import scope is inconsistent.' });
  });
export type OrderImportIntent = z.infer<typeof importIntentSchema>;
const key = (operatorId: string) =>
  'pos-legacy-order-import:' + JSON.stringify([identifier.parse(operatorId)]);
export async function orderImportInputHash(input: OrderImportInput) {
  // Only this complete-request digest is retained. No CSV, name, email, address,
  // message, filename or customer reference is written to browser storage.
  const body =
    input.kind === 'offline'
      ? { id: input.id, kind: input.kind, counters: input.counters, csv: input.csv }
      : {
          id: input.id,
          kind: input.kind,
          counters: input.counters,
          csv: input.csv,
          storeId: input.storeId,
        };
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(body)),
  );
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function readImportIntent(operatorId: string): OrderImportIntent | null {
  captureOperatorScope(operatorId).throwIfAborted();
  const saved = localStorage.getItem(key(operatorId));
  if (saved === null) return null;
  try {
    const value = importIntentSchema.parse(JSON.parse(saved) as unknown);
    if (value.operatorId !== operatorId) throw new Error();
    return value;
  } catch {
    throw new Error(
      'The saved import reference is unreadable. Keep this device for administrator recovery.',
    );
  }
}
export function saveImportIntent(value: OrderImportIntent) {
  captureOperatorScope(value.operatorId).throwIfAborted();
  const parsed = importIntentSchema.parse(value),
    prior = readImportIntent(value.operatorId);
  if (prior && (prior.id !== parsed.id || prior.inputHash !== parsed.inputHash))
    throw new Error('Reconcile the original import before preparing another file.');
  try {
    localStorage.setItem(key(value.operatorId), JSON.stringify(parsed));
  } catch {
    throw new Error('The recovery reference could not be saved. No file was queued.');
  }
}
export function clearImportIntent(operatorId: string, id: string) {
  const saved = readImportIntent(operatorId);
  if (saved && saved.id !== id)
    throw new Error('The original import reference changed. Refresh before continuing.');
  localStorage.removeItem(key(operatorId));
}
