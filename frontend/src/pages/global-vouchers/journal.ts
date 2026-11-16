import { z } from 'zod';
const id = z.string().regex(/^[1-9]\d{0,19}$/);
export const voucherIntentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('issuance'),
      operatorId: id,
      operationId: z.uuid(),
      selectionId: z.uuid(),
      amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('conversion'),
      operatorId: id,
      operationId: z.uuid(),
      storeId: id,
      checkoutId: z.uuid(),
      customerId: id,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
]);
export type VoucherIntent = z.infer<typeof voucherIntentSchema>;
/** Only opaque scope/command IDs and issuance amount. Never code, PIN, email, name or receipt. */
export function voucherJournal(key: string) {
  return {
    read(): VoucherIntent | null {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      const result = voucherIntentSchema.safeParse(JSON.parse(raw) as unknown);
      if (!result.success) throw new Error('The saved voucher reference requires review.');
      return result.data;
    },
    save(input: VoucherIntent) {
      localStorage.setItem(key, JSON.stringify(voucherIntentSchema.parse(input)));
    },
    clear() {
      localStorage.removeItem(key);
    },
  };
}
