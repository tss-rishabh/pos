import { createHash } from 'node:crypto';
import { z } from 'zod';
import { json, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { identifier } from '../../../domain/validation.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const publicScreeningCompletionSchema = z
  .object({
    contract: z.literal('pos-node-screening-completion-v1'),
    operationId: z.uuid(),
    creationHash: hash,
    orderId: identifier,
    customerId: identifier,
    storeId: identifier,
    counterId: identifier,
    paymentReceiptId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9:_-]+$/),
    projectionHash: hash,
    lineHash: hash,
    completedAt: z.number().int().positive().safe(),
  })
  .strict();
export type PublicScreeningCompletion = z.infer<typeof publicScreeningCompletionSchema>;
export const publicScreeningCompletions = mysqlTable(
  'pos_rewrite_public_screening_completions',
  {
    operationId: varchar('operation_id', { length: 36 }).primaryKey(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    data: json('data').$type<PublicScreeningCompletion>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
  },
  (table) => [uniqueIndex('uq_public_screening_completion_order').on(table.orderId)],
);
/** Exact immutable native projection rows, ascending HP ID; no money serialization. */
export function publicScreeningLineHash(
  input: readonly { id: string; productId: string; quantity: string; inputHash: string }[],
) {
  const rows = z
    .array(
      z
        .object({
          id: identifier,
          productId: identifier,
          quantity: z.string().regex(/^[1-9]\d{0,18}$/),
          inputHash: hash,
        })
        .strict(),
    )
    .min(1)
    .max(1000)
    .parse(input);
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error('Duplicate native projection line');
  rows.sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));
  return createHash('sha256')
    .update(
      rows.map((row) => `${row.id}:${row.productId}:${row.quantity}:${row.inputHash}`).join('\n'),
    )
    .digest('hex');
}
// Deliberately no final-writer factory here. The Node owner must first verify
// the real paid receipt and complete ordinary projection in that same TX.
