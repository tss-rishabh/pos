import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { operationHash } from '../../checkout/crypto.js';
import { equalImportHash, importFinancialError } from '../financial-adapter-crypto.js';

export const csvMembershipHistoryContract = 'pos-csv-membership-history-v1';
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  timestamp = z
    .string()
    .regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
    .refine((value) => {
      try {
        Temporal.PlainDateTime.from(value.replace(' ', 'T'));
        return true;
      } catch {
        return false;
      }
    });
export const csvMembershipHistoryRequestSchema = z
  .object({
    contract: z.literal(csvMembershipHistoryContract),
    operationId: z.uuid(),
    requestHash: hash,
    planHash: hash,
    customerId: identifier,
    asOf: timestamp,
    cutoff: timestamp,
  })
  .strict()
  .refine(
    (value) =>
      Temporal.PlainDateTime.from(value.asOf.replace(' ', 'T'))
        .subtract({ days: 45 })
        .toString({ smallestUnit: 'second' })
        .replace('T', ' ') === value.cutoff,
  );
const order = z
  .object({
    id: identifier,
    paymentMethod: z.number().int().min(0).max(32767),
    createdAt: timestamp,
    lines: z
      .array(
        z
          .object({
            lineId: identifier,
            productId: identifier,
            isExclusiveOrder: z.union([z.literal(0), z.literal(1)]),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export const qualifiedCsvMembershipHistorySchema = z
  .object({
    scope: csvMembershipHistoryRequestSchema,
    reader: z.literal('bigquery'),
    generationId: hash,
    complete: z.literal(true),
    fetchedAt: z.number().int().safe().positive(),
    lastDeliveredOrder: order.nullable(),
    recentDeliveredOrders: z.array(order).max(5000),
    signature: hash,
  })
  .strict();
export type CsvMembershipHistoryRequest = z.infer<typeof csvMembershipHistoryRequestSchema>;
export type QualifiedCsvMembershipHistory = z.infer<typeof qualifiedCsvMembershipHistorySchema>;
/** Provider must prove current customer scope, a complete immutable historical
 * generation and absence as well as presence. No raw/MySQL history fallback.
 */
export interface CsvMembershipHistoryPort {
  read(input: CsvMembershipHistoryRequest): Promise<QualifiedCsvMembershipHistory>;
}
export function csvMembershipHistoryHash(
  value: Omit<QualifiedCsvMembershipHistory, 'signature'>,
  key: string,
) {
  return operationHash('legacy-order-imports.membership-history.v1', value, key);
}
export function assertQualifiedCsvMembershipHistory(
  value: unknown,
  scope: CsvMembershipHistoryRequest,
  key: string,
  memberIds: readonly string[],
  now = Date.now(),
) {
  // Bound nested row work before the strict deep parse. The provider transport
  // also owns its byte budget; no oversized publication reaches a SQL fallback.
  const shallow = z
    .object({
      lastDeliveredOrder: z.unknown(),
      recentDeliveredOrders: z.array(z.unknown()).max(5000),
    })
    .safeParse(value);
  let rows = 0;
  if (!shallow.success) throw importFinancialError('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID');
  for (const entry of [shallow.data.lastDeliveredOrder, ...shallow.data.recentDeliveredOrders]) {
    if (entry === null) continue;
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('lines' in entry) ||
      !Array.isArray(entry.lines)
    )
      throw importFinancialError('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID');
    rows += entry.lines.length;
    if (rows > 20000) throw importFinancialError('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID');
  }
  const parsed = qualifiedCsvMembershipHistorySchema.safeParse(value);
  const refusal = () => importFinancialError('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID');
  if (!parsed.success || Buffer.byteLength(key) < 32 || Buffer.byteLength(key) > 4096)
    throw refusal();
  const facts = parsed.data,
    { signature, ...body } = facts;
  if (
    JSON.stringify(facts.scope) !==
      JSON.stringify(csvMembershipHistoryRequestSchema.parse(scope)) ||
    !equalImportHash(signature, csvMembershipHistoryHash(body, key)) ||
    facts.fetchedAt > now ||
    now - facts.fetchedAt > 60000
  )
    throw refusal();
  const members = new Set(memberIds),
    recent = facts.recentDeliveredOrders,
    last = facts.lastDeliveredOrder;
  const all = [...(last ? [last] : []), ...recent];
  let count = 0;
  for (const entry of all) {
    const rows = entry.lines;
    if (
      new Set(rows.map((row) => row.lineId)).size !== rows.length ||
      new Set(rows.filter((row) => !members.has(row.productId)).map((row) => row.isExclusiveOrder))
        .size > 1
    )
      throw refusal();
    count += rows.length;
  }
  if (
    count > 20000 ||
    Buffer.byteLength(JSON.stringify(body)) > 1000000 ||
    new Set(recent.map((row) => row.id)).size !== recent.length ||
    recent.some((row) => row.createdAt <= scope.cutoff) ||
    recent.some((row, index) => index > 0 && recent[index - 1]!.createdAt <= row.createdAt) ||
    (recent.length > 0 && JSON.stringify(last) !== JSON.stringify(recent[0])) ||
    (last && last.createdAt > scope.cutoff && recent.length === 0)
  )
    throw refusal();
  return facts;
}
