import { z } from 'zod';
import { AppError } from '../../domain/errors.js';

/** The newer pinned sync service's arithmetic includes these ten warehouse keys. */
export const warehouseLocations = [
  'DWH',
  'BWH',
  'WWH',
  'BW1',
  'BW2',
  'DW1',
  'HWH',
  'MW1',
  'MW2',
  'MW3',
] as const;
export const projectionContract = 'pos-stock-projection-70b801-v1';
const int32 = z.number().int().min(-2_147_483_648).max(2_147_483_647);
export const stockFact = z.object({
  storeId: z.string().regex(/^[1-9]\d*$/),
  location: z.string(),
  stock: int32,
  threshold: int32,
  ecommerce: z.boolean(),
});
export type StockFact = z.infer<typeof stockFact>;

/** Inputs are already available POS quantities. Held units must not be subtracted twice. */
export function projectAvailableStock(facts: readonly StockFact[], buffer: number) {
  int32.parse(buffer);
  let stores = 0n,
    warehouses = 0n;
  const locations = new Map<string, number>();
  for (const candidate of facts) {
    const fact = stockFact.parse(candidate);
    if (fact.ecommerce && fact.stock > 0 && fact.stock > fact.threshold)
      stores += BigInt(fact.stock) - BigInt(fact.threshold);
    const location = fact.location.toUpperCase();
    if ((warehouseLocations as readonly string[]).includes(location)) {
      const prior = locations.get(location);
      if (prior !== undefined && prior !== fact.stock)
        throw new AppError(
          409,
          'STOCK_LOCATION_AMBIGUOUS',
          'Warehouse inventory requires reconciliation.',
        );
      locations.set(location, fact.stock);
    }
  }
  for (const stock of locations.values()) warehouses += BigInt(stock);
  const gross = stores + warehouses,
    requestedBuffer = BigInt(buffer),
    effectiveBuffer = requestedBuffer < gross ? requestedBuffer : gross;
  // These two physical audit columns are INT even though product_stocks.stock is BIGINT.
  for (const amount of [stores, gross])
    if (amount < -2_147_483_648n || amount > 2_147_483_647n)
      throw new AppError(
        409,
        'STOCK_PROJECTION_OVERFLOW',
        'The inventory total requires reconciliation.',
      );
  return {
    storeStock: Number(stores),
    grossStock: Number(gross),
    stock: gross - effectiveBuffer,
    effectiveBuffer,
  };
}
