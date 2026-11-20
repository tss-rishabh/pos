import { Script } from 'node:vm';
import ts from 'typescript';
import { and, eq, gt, inArray, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../src/db/pools.js';
import { bigint, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { warehouseLocations } from '../../src/db/stock-projection/domain.js';
import { loadSourceExcerpts } from '../../tests/golden/source-excerpts.js';

// Keep source property names/Number decoders; this oracle accepts only bounded exact IDs.
const products = mysqlTable('products', {
  id: bigint('id', { mode: 'number', unsigned: true }),
  parentProdId: bigint('parent_prod_id', { mode: 'number' }),
  isAvail: int('is_avail'),
  isDel: int('is_del'),
  prodType: bigint('prod_type', { mode: 'number' }),
});
const productStore = mysqlTable('product_store', {
  productId: bigint('product_id', { mode: 'number' }),
  storeId: bigint('store_id', { mode: 'number' }),
  stock: int('stock'),
});
const stores = mysqlTable('stores', {
  id: int('id'),
  locationCode: varchar('location_code', { length: 10 }),
  ecomDelivery: int('ecom_delivery'),
  ecomThreshold: int('ecom_threshold'),
});
const productStocks = mysqlTable('product_stocks', {
  prodId: bigint('prod_id', { mode: 'number', unsigned: true }),
  stock: bigint('stock', { mode: 'number' }),
  stocked: int('stocked'),
});

// backend-sync-api 70b8015 new-src/api/models/inventoryModel.ts, captured verbatim
// (tests/golden/stock-projection/inventory-model-source.json) instead of reading the sibling
// checkout: the getProductInventory declaration and the online-stock arithmetic statements.
const captured = loadSourceExcerpts('stock-projection', 'inventory-model-source');
export const sourceHash = captured.fileSha256;
function excerpt(key: string, valid: (text: string) => boolean, message: string): string {
  const text = captured.excerpts[key]?.text;
  if (!text || !valid(text)) throw new Error(message);
  return text;
}
const inventory = excerpt(
  'getProductInventory',
  (text) => /^export\s+(?:async\s+)?function\s+getProductInventory\b/.test(text),
  'Pinned source inventory function unavailable.',
);
const arithmetic = excerpt(
  'onlineStockArithmetic',
  (text) => text.replace(/\s/g, '').includes('Math.min(bufferStock,onlineStock)'),
  'Pinned source stock arithmetic changed.',
);

/** Runs only the selected original query/function bodies, without application imports or startup. */
export function sourceStockOracle(db: ReturnType<Databases['get']>) {
  const code = ts.transpileModule(inventory.replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
  }).outputText;
  const original: unknown = new Script(code + '\ngetProductInventory').runInNewContext({
    db,
    and,
    eq,
    gt,
    inArray,
    sql,
    sum,
    WAREHOUSE_LOCATIONS: [...warehouseLocations],
    PRODUCT_TYPES: { SIMPLE: 1, MEMBERSHIP: 5, FREEBIE: 4, GIFT_VOUCHER: 8 },
    products,
    productStore,
    stores,
    productStocks,
  });
  const calculate: unknown = new Script(
    '(function(stock, storeOnlineStock, bufferStock) { let onlineStock;\n' +
      arithmetic +
      '\nreturn {stock:onlineStock,storeStock:storeOnlineStock,grossStock:onlineStock+bufferStock,effectiveBuffer:bufferStock}; })',
  ).runInNewContext({});
  if (typeof original !== 'function' || typeof calculate !== 'function')
    throw new Error('Source oracle unavailable.');
  const read = original as (id: number) => Promise<unknown>;
  const project = calculate as (
    stock: Record<string, unknown>,
    stores: number,
    buffer: number,
  ) => unknown;
  return async (id: number) => {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error('Legacy oracle requires an exact positive Number ID.');
    const facts = z
      .object({ storeOnline: z.number(), buffer: z.number() })
      .passthrough()
      .parse(await read(id));
    return z
      .object({
        stock: z.number().int(),
        storeStock: z.number().int(),
        grossStock: z.number().int(),
        effectiveBuffer: z.number().int(),
      })
      .parse(project(facts, facts.storeOnline, facts.buffer));
  };
}
