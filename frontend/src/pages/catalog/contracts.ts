import { z } from 'zod';
export const catalogStore = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().nullable(),
});
export const catalogMetadata = z.object({
  data: z.array(catalogStore),
  selectedStoreIds: z.array(z.string()),
  stockManagementPath: z.string(),
});
export const catalogRow = z.object({
  id: z.string(),
  product: z.string(),
  erp_product: z.string().nullable(),
  price: z.string(),
  spl_price: z.string(),
  exclusive_price: z.number().nullable(),
  prod_type: z.string().nullable(),
  categories: z.string().nullable(),
  store_names: z.string().nullable(),
  DT_RowId: z.string(),
});
export type CatalogRow = z.infer<typeof catalogRow>;
export const auditRow = z.object({
  id: z.string(),
  DT_RowId: z.string(),
  store_id: z.string(),
  store_name: z.string().nullable(),
  storage_name: z.string().nullable(),
  product_id: z.string(),
  product: z.string(),
  erp_product: z.string().nullable(),
  stock_before: z.string(),
  stock_after: z.string(),
  added_reduced: z.union([z.number(), z.string(), z.null()]),
  user: z.string().nullable(),
  comment: z.string().nullable(),
  created_at: z.string(),
});
export type AuditRow = z.infer<typeof auditRow>;
export const tableResult = <T>(row: z.ZodType<T>) =>
  z.object({
    reader: z.enum(['primary', 'data', 'bigquery']),
    draw: z.number(),
    recordsTotal: z.number(),
    recordsFiltered: z.number(),
    unfilteredCount: z.number(),
    start: z.number(),
    data: z.array(row),
  });
export const catalogDetail = z.object({
  reader: z.literal('primary'),
  product: z.object({
    id: z.string(),
    name: z.string(),
    erpName: z.string().nullable(),
    shortDescription: z.string().nullable(),
    price: z.string(),
    specialPrice: z.string(),
    parentId: z.string(),
    type: z.string(),
    exclusivePrice: z.number().nullable(),
    male: z.array(z.string()),
    female: z.array(z.string()),
    description: z.object({
      name: z.string().nullable(),
      description: z.string().nullable(),
      material: z.string().nullable(),
    }),
  }),
  variants: z.array(z.object({ id: z.string(), name: z.string(), barcode: z.string().nullable() })),
  stores: z.array(catalogStore),
  stock: z.array(
    z.object({
      productId: z.string(),
      storeId: z.string(),
      stock: z.number(),
      available: z.boolean(),
      listed: z.boolean(),
    }),
  ),
  checkInRequired: z.boolean(),
  stockManagementPath: z.string(),
});
export type CatalogDetail = z.infer<typeof catalogDetail>;
export const snapshotRow = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string().nullable(),
  z.string().nullable(),
  z.number(),
  z.number(),
]);
export type SnapshotRow = z.infer<typeof snapshotRow>;
export const catalogSnapshot = z.object({
  reader: z.literal('primary'),
  store: z.object({ id: z.string(), name: z.string() }),
  syncedAt: z.string(),
  data: z.array(snapshotRow),
});
