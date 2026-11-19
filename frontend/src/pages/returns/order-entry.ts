import { z } from 'zod';
import type { ReturnLine, ReverseKind } from './client';

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
    lineId: identifier.optional(),
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

/** Navigation selects an order; the server still checks check-in and eligibility on every action. */
export function returnOrderLink(entry: ReturnOrderEntry): string {
  return `/returns?${new URLSearchParams(Object.entries(entrySchema.parse(entry)).filter((pair): pair is [string, string] => typeof pair[1] === 'string')).toString()}`;
}

export function readReturnOrderEntry(
  search: string,
  context: ReturnEntryContext,
): ParsedReturnEntry {
  if (!search || search === '?') return { status: 'absent' };
  if (search.length > 512) return { status: 'invalid' };
  const params = new URLSearchParams(search);
  const values = new Map<string, string>();
  for (const [key, value] of params) {
    if (values.has(key)) return { status: 'invalid' };
    values.set(key, value);
  }
  const parsed = entrySchema.safeParse(Object.fromEntries(values));
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

/** URL identifiers are only a selection hint; the server's order lines remain authoritative. */
export function matchingReturnEntryLine(
  entry: ReturnOrderEntry | undefined,
  selectedOrderId: string | undefined,
  mode: ReverseKind,
  lines: readonly ReturnLine[],
): ReturnLine | null {
  if (!entry?.lineId || entry.orderId !== selectedOrderId || entry.kind !== mode) return null;
  const matches = lines.filter((line) => line.id === entry.lineId);
  const line = matches.length === 1 ? matches[0] : undefined;
  return line &&
    (mode === 'exchange'
      ? ['DELIVERED', 'EXCHANGE_INITIATED'].includes(line.status || '') && line.parentId !== '0'
      : line.status === 'DELIVERED' && line.returnStatus === 0)
    ? line
    : null;
}
