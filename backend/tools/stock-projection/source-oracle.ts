import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import ts from 'typescript';
import { and, eq, gt, inArray, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../src/db/pools.js';
import { bigint, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { warehouseLocations } from '../../src/db/stock-projection/domain.js';

const path = '../../backend-sync-api/new-src/api/models/inventoryModel.ts';
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

const source = readFileSync(path, 'utf8');
export const sourceHash = createHash('sha256').update(source).digest('hex');
const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const inventory = tree.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'getProductInventory',
);
if (!inventory) throw new Error('Pinned source inventory function unavailable.');
const arithmetic: string[] = [];
function inspect(node: ts.Node) {
  if (
    ts.isExpressionStatement(node) &&
    ts.isBinaryExpression(node.expression) &&
    node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    node.expression.left.getText(tree) === 'onlineStock' &&
    /\+\s*storeOnlineStock$/.test(node.expression.right.getText(tree)) &&
    ts.isBlock(node.parent)
  ) {
    const index = node.parent.statements.indexOf(node);
    arithmetic.push(
      node.parent.statements
        .slice(index, index + 3)
        .map((statement) => statement.getText(tree))
        .join('\n'),
    );
  }
  ts.forEachChild(node, inspect);
}
inspect(tree);
if (
  arithmetic.length !== 1 ||
  !arithmetic[0]!.replace(/\s/g, '').includes('Math.min(bufferStock,onlineStock)')
)
  throw new Error('Pinned source stock arithmetic changed.');

/** Runs only the selected original query/function bodies, without application imports or startup. */
export function sourceStockOracle(db: ReturnType<Databases['get']>) {
  const code = ts.transpileModule(inventory!.getText(tree).replace(/^export\s+/, ''), {
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
      arithmetic[0] +
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
