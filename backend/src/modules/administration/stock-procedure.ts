import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import type { AdministrationTransaction } from './checkins.js';

const stockProcedureInput = z
  .object({
    storeId: identifier,
    productId: identifier,
    stock: z.number().int().min(0).max(2_147_483_647),
    operatorId: identifier,
    comment: z.string().max(255),
  })
  .strict();
export type StockProcedureInput = z.infer<typeof stockProcedureInput>;
export type StockProcedure = (
  transaction: AdministrationTransaction,
  input: StockProcedureInput,
) => Promise<void>;

/** Caller must establish verified writer-body parity and transaction safety before calling. */
export const executeStockProcedure: StockProcedure = async (transaction, input) => {
  const value = stockProcedureInput.parse(input);
  await transaction.execute(
    sql`call pos_stock_syncer(${BigInt(value.storeId)},${BigInt(value.productId)},${value.stock},${0},${BigInt(value.operatorId)},${value.comment})`,
  );
};
