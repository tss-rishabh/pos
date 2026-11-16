import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import {
  businessTimestamp,
  scalarId,
  warehouseView,
} from '../operational-reports/report-inputs.js';

export const productSort = z.enum([
  'id',
  'product',
  'erp_product',
  'prod_type',
  'categories',
  'price',
  'exclusive_price',
  'spl_price',
  'store_names',
]);
const page = {
  search: z.string().max(150).default(''),
  start: z.number().int().min(0).max(1000000).default(0),
  length: z.number().int().min(1).max(500).default(25),
  draw: z.number().int().min(0).max(2147483647).default(0),
  direction: z.enum(['asc', 'desc']).default('asc'),
};
export const productSearchInput = z
  .object({
    ...page,
    storeIds: z.array(identifier).max(5000).default([]),
    sort: productSort.default('id'),
  })
  .strict();
export type ProductSearchInput = z.infer<typeof productSearchInput>;
export const auditKind = z.enum(['product', 'held', 'storage']);
export type AuditKind = z.infer<typeof auditKind>;
export const auditSearchInput = z
  .object({
    ...page,
    storeIds: z.array(identifier).max(5000).default([]),
    from: businessTimestamp,
    to: businessTimestamp,
    sort: z
      .enum([
        'id',
        'store_name',
        'storage_name',
        'product_id',
        'product',
        'erp_product',
        'created_at',
      ])
      .default('id'),
  })
  .strict();
export type AuditSearchInput = z.infer<typeof auditSearchInput>;
export const catalogDetailOptions = (env: NodeJS.ProcessEnv = process.env) =>
  z
    .object({
      BQ_PRODUCT_INVENTORY_AUDIT_VIEW: warehouseView,
      BQ_HELD_INVENTORY_AUDIT_VIEW: warehouseView,
      BQ_STORAGE_INVENTORY_AUDIT_VIEW: warehouseView,
      BQ_INVENTORY_AUDIT_LIKE_UDF: warehouseView,
    })
    .parse(env);
export type CatalogDetailOptions = ReturnType<typeof catalogDetailOptions>;
export const countValue = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const productRow = z.object({
  id: scalarId,
  product: z.string(),
  erp_product: z.string().nullable(),
  price: z.string(),
  spl_price: z.string(),
  exclusive_price: z.coerce.number().finite().nullable(),
  prod_type: z.string().nullable(),
  categories: z.string().nullable(),
  store_names: z.string().nullable(),
});
export type ProductRow = z.infer<typeof productRow>;
export const auditRow = z.object({
  id: scalarId,
  store_id: scalarId,
  store_name: z.string().nullable(),
  storage_name: z.string().nullable(),
  product_id: scalarId,
  product: z.string(),
  erp_product: z.string().nullable(),
  stock_before: z.string(),
  stock_after: z.string(),
  user: z.string().nullable(),
  comment: z.string().nullable(),
  created_at: z
    .string()
    .nullable()
    .transform((value) => value?.replace('T', ' ').slice(0, 19) || ''),
});
export type AuditRawRow = z.infer<typeof auditRow>;
