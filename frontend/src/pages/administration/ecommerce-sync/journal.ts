import { z } from 'zod';
import { administrationIdentifier } from '../api';
import { ecommerceInput } from './api';
export const ecommerceAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('change'), input: ecommerceInput }).strict(),
  z.object({ kind: z.literal('cancel'), operationId: z.uuid(), original: ecommerceInput }).strict(),
  z.object({ kind: z.literal('retry'), operationId: z.uuid(), syncId: z.uuid() }).strict(),
]);
export type EcommerceAction = z.infer<typeof ecommerceAction>;
const journalSchema = z
  .object({
    ownerId: administrationIdentifier,
    storeId: administrationIdentifier,
    action: ecommerceAction.nullable(),
    syncId: z.uuid().nullable(),
  })
  .strict();
export type EcommerceJournal = z.infer<typeof journalSchema>;
const key = (ownerId: string, storeId: string) =>
  'pos-ecommerce-sync-v1:' +
  administrationIdentifier.parse(ownerId) +
  ':' +
  administrationIdentifier.parse(storeId);
const unavailable = () =>
  new Error(
    'Saved settings requests are unavailable. Restore browser storage before changing delivery settings.',
  );
export function readEcommerceJournal(
  ownerId: string,
  storeId: string,
  storage: Storage = localStorage,
): EcommerceJournal {
  try {
    const raw = storage.getItem(key(ownerId, storeId));
    if (raw && raw.length > 16384) throw unavailable();
    const row = raw
      ? journalSchema.parse(JSON.parse(raw) as unknown)
      : { ownerId, storeId, action: null, syncId: null };
    if (row.ownerId !== ownerId || row.storeId !== storeId) throw unavailable();
    return row;
  } catch {
    throw unavailable();
  }
}
/** No contact, credential, cart or financial state; original operation/body survives reload. */
export function saveEcommerceJournal(row: EcommerceJournal, storage: Storage = localStorage) {
  try {
    const checked = journalSchema.parse(row);
    storage.setItem(key(checked.ownerId, checked.storeId), JSON.stringify(checked));
    return checked;
  } catch {
    throw unavailable();
  }
}
export const actionId = (action: EcommerceAction) =>
  action.kind === 'change' ? action.input.operationId : action.operationId;
