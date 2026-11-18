import { z } from 'zod';

const identifier = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
const entrySchema = z
  .object({
    operatorId: identifier,
    storeId: identifier,
    counterId: identifier,
    orderId: identifier,
    kind: z.enum(['return', 'exchange']),
  })
  .strict();

export type ReturnOrderEntry = z.infer<typeof entrySchema>;
export type ReturnEntryContext = Pick<ReturnOrderEntry, 'operatorId' | 'storeId' | 'counterId'>;
export type ParsedReturnEntry =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'mismatch' }
  | { status: 'ready'; entry: ReturnOrderEntry };

/** Navigation selects an order; the server still verifies every action and customer proof. */
export function returnOrderLink(entry: ReturnOrderEntry): string {
  return `/returns?${new URLSearchParams(entrySchema.parse(entry)).toString()}`;
}

export function readReturnOrderEntry(
  search: string,
  context: ReturnEntryContext,
): ParsedReturnEntry {
  if (!search || search === '?') return { status: 'absent' };
  if (search.length > 512) return { status: 'invalid' };
  const params = new URLSearchParams(search);
  const values: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(values, key)) return { status: 'invalid' };
    values[key] = value;
  }
  const parsed = entrySchema.safeParse(values);
  if (!parsed.success) return { status: 'invalid' };
  const entry = parsed.data;
  if (
    entry.operatorId !== context.operatorId ||
    entry.storeId !== context.storeId ||
    entry.counterId !== context.counterId
  )
    return { status: 'mismatch' };
  return { status: 'ready', entry };
}
