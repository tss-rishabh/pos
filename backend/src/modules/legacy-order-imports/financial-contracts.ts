import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import type { LegacyOrderImportPlan } from './plans.js';

export const importFinancialResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('completed'),
      operationId: z.uuid(),
      orderId: identifier,
      receiptId: z.uuid(),
      businessDate: z.iso.date(),
      projectionHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      status: z.literal('rejected'),
      operationId: z.uuid(),
      code: z.string().regex(/^ORDER_IMPORT_[A-Z0-9_]{1,45}$/),
    })
    .strict(),
  z
    .object({
      status: z.literal('unknown'),
      operationId: z.uuid(),
      stage: z.enum(['preparation', 'order', 'confirmation', 'settlement', 'publication']),
      orderId: identifier.nullable(),
    })
    .strict(),
]);
export type ImportFinancialResult = z.infer<typeof importFinancialResultSchema>;
export interface ImportFinancialScope {
  actorId: string;
  operationId: string;
  storeId: string;
  counterId: string;
}
/** A trusted adapter must resolve current authority and verify native financial receipts. */
export interface ImportFinancialAdapter {
  start(
    input: ImportFinancialScope & { plan: LegacyOrderImportPlan; planHash: string },
  ): Promise<ImportFinancialResult>;
  read(input: ImportFinancialScope): Promise<ImportFinancialResult | null>;
}
