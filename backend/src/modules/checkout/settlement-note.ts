import { z } from 'zod';
import type { CheckoutState } from './contracts.js';
import { operationHash } from './crypto.js';

// Verified order_stores.message is VARCHAR(255), latin1_swedish_ci. Reject
// unsupported code points before taking money; never ask MySQL to replace them.
const ledgerText =
  /^[\t\n\r\u0020-\u007E\u00A0-\u00FF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018-\u201A\u201C-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC]+$/u;
/** MySQL latin1/CP1252 printable text; callers choose their own blank/length policy. */
export const isLegacyLatinText = (value: string): boolean => value === '' || ledgerText.test(value);
export const settlementMessageSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isLegacyLatinText, 'Use text supported by the store payment ledger.')
  .refine((value) => value.trim().length > 0, 'Enter a meaningful payment note.');
const money = z.string().regex(/^\d{1,8}\.\d{2}$/);
export const settlementNoteSchema = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    message: settlementMessageSchema,
    payable: money,
    cashReceived: money,
  })
  .strict();
export type SettlementNote = z.infer<typeof settlementNoteSchema>;
export function createSettlementNote(
  state: Pick<CheckoutState, 'id' | 'operatorId' | 'storeId' | 'counterId'>,
  message: string,
  payable: string,
  cashReceived: string,
  secret: string,
): SettlementNote {
  const text = settlementMessageSchema.parse(message);
  return settlementNoteSchema.parse({
    hash: operationHash(
      'checkout.settlement-note',
      {
        checkoutId: state.id,
        operatorId: state.operatorId,
        storeId: state.storeId,
        counterId: state.counterId,
        message: text,
        payable,
        cashReceived,
      },
      secret,
    ),
    message: text,
    payable,
    cashReceived,
  });
}
export function publicSettlementNote(note: SettlementNote | null | undefined) {
  return note ? { hash: note.hash, payable: note.payable, cashReceived: note.cashReceived } : null;
}
