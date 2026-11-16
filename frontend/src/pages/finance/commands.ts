import { z } from 'zod';
import { ApiError, request } from '../../api/client';
import { closeSchema, type Entries } from './model';
const pendingSchema = z
  .object({
    commandId: z.uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
type Pending = z.infer<typeof pendingSchema>;
type CommandStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (ownerId: string, storeId: string, date: string) =>
  `pos-day-close-command:${ownerId}:${storeId}:${date}`;
export function pendingClose(
  ownerId: string,
  storeId: string,
  date: string,
  storage: CommandStorage = localStorage,
): Pending | null {
  const raw = storage.getItem(key(ownerId, storeId, date));
  return raw ? pendingSchema.parse(JSON.parse(raw) as unknown) : null;
}
/** Persist only the idempotency key and a SHA-256 digest; comments/amounts stay out of local storage. */
export async function submitClose(
  ownerId: string,
  storeId: string,
  date: string,
  expectedVersion: number,
  entries: Entries,
  storage: CommandStorage = localStorage,
  send?: (command: Pending) => Promise<z.infer<typeof closeSchema>>,
) {
  const canonical = JSON.stringify([
    storeId,
    date,
    expectedVersion,
    entries.cash_actual,
    entries.cash_manual_punched,
    entries.cash_manual_created,
    entries.card_actual,
    entries.card_manual_punched,
    entries.card_manual_created,
    entries.banking_amount,
    entries.cash_reason,
    entries.card_reason,
    entries.cash_comment,
    entries.card_comment,
  ]);
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const prior = pendingClose(ownerId, storeId, date, storage);
  if (prior && prior.hash !== hash)
    throw new Error(
      'A previous submission is awaiting confirmation. Check its result before changing these figures.',
    );
  const command = prior || { commandId: crypto.randomUUID(), hash, expectedVersion };
  storage.setItem(key(ownerId, storeId, date), JSON.stringify(command));
  try {
    const result = send
      ? await send(command)
      : (
          await request(
            `/api/v1/stores/${storeId}/day-closes/${date}/versions`,
            {
              method: 'POST',
              operatorId: ownerId,
              body: JSON.stringify({
                commandId: command.commandId,
                expectedVersion: command.expectedVersion,
                entries,
              }),
            },
            z.object({ data: closeSchema }),
          )
        ).data;
    storage.removeItem(key(ownerId, storeId, date));
    return result;
  } catch (error) {
    if (error instanceof ApiError && [400, 401, 403, 404, 409].includes(error.status))
      storage.removeItem(key(ownerId, storeId, date));
    throw error;
  }
}
export async function confirmClose(
  ownerId: string,
  storeId: string,
  date: string,
  storage: CommandStorage = localStorage,
) {
  const saved = pendingClose(ownerId, storeId, date, storage);
  if (!saved) return null;
  const result = await request(
    `/api/v1/finance/day-close-commands/${saved.commandId}`,
    { operatorId: ownerId },
    z.object({ data: closeSchema }),
  );
  storage.removeItem(key(ownerId, storeId, date));
  return result.data;
}
