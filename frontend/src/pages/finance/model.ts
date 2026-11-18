import { z } from 'zod';
export const amount = z
  .string()
  .regex(
    /^\d{1,12}(?:\.\d{1,2})?$/,
    'Enter a non-negative amount with at most two decimal places.',
  );
export const reasons = [
  '',
  'MANUAL_BILL_MADE',
  'MANUAL_BILL_PUNCHED',
  'CHANGE_SHORT',
  'CHANGE_EXCESS',
  'JUMBLING',
] as const;
export const entriesSchema = z
  .object({
    cash_actual: amount,
    cash_manual_punched: amount,
    cash_manual_created: amount,
    card_actual: amount,
    card_manual_punched: amount,
    card_manual_created: amount,
    banking_amount: amount,
    cash_reason: z.enum(reasons),
    card_reason: z.enum(reasons),
    cash_comment: z.string().trim().max(255),
    card_comment: z.string().trim().max(255),
  })
  .strict();
export type Entries = z.infer<typeof entriesSchema>;
const split = z.object({
  system: z.string(),
  actual: z.string(),
  manual_punched: z.string(),
  manual_created: z.string(),
  difference: z.string(),
  reason: z.enum(reasons),
  comment: z.string(),
});
export const closeSchema = z.object({
  version: z.number().int(),
  status: z.string(),
  closed_at: z.string(),
  closed_by_id: z.string(),
  stale_reason: z.string().nullable(),
  stale_trigger_ref: z.string().nullish(),
  cash: split.extend({ refund: z.string() }),
  card: split,
  banking_amount: z.string(),
});
export const stateSchema = z.object({
  store_id: z.string(),
  close_date: z.string(),
  window: z.object({
    state: z.enum(['PENDING', 'OPEN', 'EXPIRED']),
    allowed: z.boolean(),
    override: z.enum(['REVISION', 'WINDOW']).nullable(),
    message: z.string(),
    opens_at: z.string(),
    closes_at: z.string(),
  }),
  system: z.object({
    order_count: z.number(),
    cash: z.string(),
    cash_refund: z.string(),
    card_upi: z.string(),
    district: z.string(),
    online_other: z.string(),
    total_online: z.string(),
    total_collection: z.string(),
  }),
  close: closeSchema.nullable(),
  tolerance: z.string(),
});
export type CloseState = z.infer<typeof stateSchema>;
export function cents(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) return 0n;
  const negative = value.startsWith('-'),
    [whole, fraction = ''] = value.replace('-', '').split('.');
  const result = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -result : result;
}
export function decimal(value: bigint): string {
  const n = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
}
export function differences(state: CloseState, entries: Entries) {
  return {
    cash:
      cents(state.system.cash) -
      cents(state.system.cash_refund) -
      cents(entries.cash_manual_punched) +
      cents(entries.cash_manual_created) -
      cents(entries.cash_actual),
    card:
      cents(state.system.total_online) -
      cents(entries.card_manual_punched) +
      cents(entries.card_manual_created) -
      cents(entries.card_actual),
  };
}
export function initialEntries(state: CloseState): Entries {
  return {
    cash_actual: state.close?.cash.actual || '',
    cash_manual_punched: state.close?.cash.manual_punched ?? '',
    cash_manual_created: state.close?.cash.manual_created ?? '',
    card_actual: state.close?.card.actual || '',
    card_manual_punched: state.close?.card.manual_punched ?? '',
    card_manual_created: state.close?.card.manual_created ?? '',
    banking_amount: state.close?.banking_amount || '',
    cash_reason: state.close?.cash.reason || '',
    card_reason: state.close?.card.reason || '',
    cash_comment: state.close?.cash.comment || '',
    card_comment: state.close?.card.comment || '',
  };
}
