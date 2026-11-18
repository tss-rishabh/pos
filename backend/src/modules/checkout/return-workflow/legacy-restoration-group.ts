import { z } from 'zod';
import { operationHash } from '../crypto.js';

const id = z.string().regex(/^[1-9]\d{0,19}$/);
export const legacyRestorationGroupSchema = z
  .object({
    contract: z.literal('pos-legacy-exchange-restoration-group-v1'),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    lineIds: z.array(id).min(1).max(1000),
    creditIds: z.array(id).min(1).max(1000),
    saleableStockIds: z.array(id).max(1000),
    heldStockIds: z.array(id).max(1000),
    saleableQuantity: z.string().regex(/^\d{1,24}$/),
    heldQuantity: z.string().regex(/^\d{1,24}$/),
  })
  .strict();
export type LegacyRestorationGroup = z.infer<typeof legacyRestorationGroupSchema>;
export interface RestorationGroupFacts {
  orderId: string;
  productId: string;
  storeId: string;
  targetLineId: string;
  lines: readonly { id: string; quantity: string; status: string | null; returnStatus: number }[];
  exchanges: readonly {
    id: string;
    lineId: string;
    productId: string;
    status: string;
    saleable: boolean;
    createdAt: string;
    sourceHash: string;
  }[];
  credits: readonly {
    id: string;
    lineId: string;
    productId: string;
    quantity: string;
    createdAt: string;
    creditNote: string;
  }[];
  saleable: readonly { id: string; before: string | null; after: string | null; at: string }[];
  held: readonly { id: string; before: string | null; after: string | null; at: string }[];
}
const positive = (value: string) => /^[1-9]\d{0,19}$/.test(value);
const ordered = <T extends { id: string }>(items: readonly T[]) =>
  [...items].sort((a, b) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
  );
/** A complete same-SKU/store group proves fungible restoration without inventing per-line events. */
export function proveRestorationGroup(
  facts: RestorationGroupFacts,
  secret: string,
  activeLogId?: string,
): LegacyRestorationGroup | null {
  const collections = [facts.lines, facts.exchanges, facts.credits, facts.saleable, facts.held];
  if (
    collections.some(
      (rows) =>
        rows.length > 1000 ||
        rows.some((row) => !positive(row.id)) ||
        new Set(rows.map((row) => row.id)).size !== rows.length,
    )
  )
    return null;
  if (!facts.credits.length || !facts.lines.length) return null;
  const lines = new Map(facts.lines.map((line) => [line.id, line]));
  if (!lines.has(facts.targetLineId) || facts.lines.some((line) => !positive(line.quantity)))
    return null;
  const logs = new Map<string, RestorationGroupFacts['exchanges'][number]>();
  for (const log of facts.exchanges) {
    if (
      log.productId !== facts.productId ||
      !lines.has(log.lineId) ||
      logs.has(log.lineId) ||
      !/^[a-f0-9]{64}$/.test(log.sourceHash)
    )
      return null;
    if (
      !['FAILED_NEEDS_MANUAL_FIX', 'SUCCESS'].includes(log.status) &&
      !(log.id === activeLogId && log.status === 'PENDING')
    )
      return null;
    logs.set(log.lineId, log);
  }
  const credited = new Set<string>();
  let expectedSaleable = 0n,
    expectedHeld = 0n;
  for (const credit of facts.credits) {
    const line = lines.get(credit.lineId),
      log = logs.get(credit.lineId);
    if (
      !line ||
      !log ||
      credited.has(credit.lineId) ||
      credit.productId !== facts.productId ||
      !positive(credit.quantity) ||
      BigInt(credit.quantity) !== BigInt(line.quantity) ||
      !credit.creditNote.trim() ||
      credit.createdAt < log.createdAt ||
      !['DELIVERED', 'EXCHANGE_INITIATED', 'EXCHANGE_COMPLETED'].includes(line.status || '')
    )
      return null;
    credited.add(credit.lineId);
    if (log.saleable) expectedSaleable += BigInt(credit.quantity);
    else expectedHeld += BigInt(credit.quantity);
  }
  if (
    !credited.has(facts.targetLineId) ||
    facts.exchanges.some((log) => log.status === 'SUCCESS' && !credited.has(log.lineId))
  )
    return null;
  // Uncredited lines cannot have independently claimed completed return effects.
  if (
    facts.lines.some(
      (line) =>
        !credited.has(line.id) &&
        (line.returnStatus !== 0 || /(?:RETURN|EXCHANGE|REFUND)/.test(line.status || '')),
    )
  )
    return null;
  const firstCredit = facts.credits.reduce(
    (date, credit) => (credit.createdAt < date ? credit.createdAt : date),
    facts.credits[0]!.createdAt,
  );
  const sum = (events: RestorationGroupFacts['saleable']): bigint | null => {
    let total = 0n;
    for (const event of events) {
      if (
        event.before === null ||
        event.after === null ||
        !/^-?\d{1,20}$/.test(event.before) ||
        !/^-?\d{1,20}$/.test(event.after) ||
        event.at < firstCredit
      )
        return null;
      const delta = BigInt(event.after) - BigInt(event.before);
      if (delta <= 0n) return null;
      total += delta;
    }
    return total;
  };
  if (sum(facts.saleable) !== expectedSaleable || sum(facts.held) !== expectedHeld) return null;
  const stable = {
    ...facts,
    lines: ordered(facts.lines).map(({ id, quantity }) => ({ id, quantity })),
    exchanges: ordered(facts.exchanges).map(({ status: _status, ...log }) => log),
    credits: ordered(facts.credits),
    saleable: ordered(facts.saleable),
    held: ordered(facts.held),
  };
  return legacyRestorationGroupSchema.parse({
    contract: 'pos-legacy-exchange-restoration-group-v1',
    digest: operationHash('exchange.restoration-group', stable, secret),
    lineIds: ordered(facts.lines).map((line) => line.id),
    creditIds: ordered(facts.credits).map((credit) => credit.id),
    saleableStockIds: ordered(facts.saleable).map((event) => event.id),
    heldStockIds: ordered(facts.held).map((event) => event.id),
    saleableQuantity: String(expectedSaleable),
    heldQuantity: String(expectedHeld),
  });
}
