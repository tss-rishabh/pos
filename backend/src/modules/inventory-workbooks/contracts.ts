import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
export const inventoryWorkbookHeaders = [
  'StoreName',
  'ParentID',
  'ChildID',
  'Product',
  'Erp Product',
  'Variant',
  'Category',
  'Inventory',
  'GTIN',
] as const;
const integer = z.union([z.bigint(), z.string().regex(/^-?\d+$/), z.number().int().safe()]);
const id = z
  .union([z.bigint(), z.string(), z.number().int().safe()])
  .transform(String)
  .pipe(identifier);
export const inventoryWorkbookRowSchema = z
  .object({
    id,
    store_name: z.string().max(255),
    parent_id: id,
    child_id: id,
    product: z.string().max(255),
    erp_product: z.string().max(225).nullable(),
    variant: z.string().max(65535).nullable(),
    category: z.string().max(50).nullable(),
    inventory: integer.transform(Number).pipe(z.number().int().min(-2147483648).max(2147483647)),
    gtin: integer.transform(String).nullable(),
  })
  .strict();
export type InventoryWorkbookRow = z.infer<typeof inventoryWorkbookRowSchema>;
export interface InventoryWorkbookPage {
  candidateIds: string[];
  rows: InventoryWorkbookRow[];
}
export interface InventoryWorkbookStore {
  storeId: string;
  pages: AsyncIterable<InventoryWorkbookPage>;
}
