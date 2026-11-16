import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { Product, ProductBarcode, ProductStore } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { maintenanceHash, temporarySourceBarcode } from './maintenance-domain.js';

export interface CatalogRepairPlan {
  productId: string;
  name: string;
  type: string;
  planHash: string;
  parentVisibility: Array<{
    id: string;
    storeId: string;
    availableBefore: boolean;
    listedBefore: boolean;
  }>;
  imageReset: boolean;
  imageProductId: string | null;
  barcodeChanges: Array<{ id: string; productId: string; from: string; to: string }>;
  syncProductIds: string[];
}
const missingParent = () =>
  new AppError(
    422,
    'CATALOG_PARENT_RECONCILIATION_REQUIRED',
    'Reconcile the missing product parent before troubleshooting.',
  );
/** Preview/apply both read the same bounded footprint; apply callers hold update locks. */
export async function catalogRepairPlan(
  transaction: AdministrationTransaction,
  productId: string,
  lock: 'share' | 'update',
): Promise<CatalogRepairPlan> {
  const [product] = await transaction
    .select({
      id: Product.id,
      name: Product.product,
      type: Product.prod_type,
      parentId: Product.parent_prod_id,
      images: Product.images_new,
    })
    .from(Product)
    .where(eq(Product.id, BigInt(productId)))
    .limit(1)
    .for(lock);
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
  const parentVisibility: CatalogRepairPlan['parentVisibility'] = [],
    barcodeChanges: CatalogRepairPlan['barcodeChanges'] = [];
  let imageReset = false,
    imageProductId: string | null = null;
  const footprint: unknown[] = [
    { id: String(product.id), type: String(product.type), parentId: String(product.parentId) },
  ];
  if (product.type === 1n) {
    let imageTarget = { id: product.id, images: product.images };
    if (product.parentId > 0n) {
      const [parent] = await transaction
        .select({ id: Product.id, images: Product.images_new })
        .from(Product)
        .where(eq(Product.id, product.parentId))
        .limit(1)
        .for(lock);
      if (!parent) throw missingParent();
      imageTarget = parent;
      const parentRows = await transaction
        .select({
          id: ProductStore.id,
          storeId: ProductStore.store,
          available: ProductStore.is_avail,
          deleted: ProductStore.is_del,
        })
        .from(ProductStore)
        .where(eq(ProductStore.product, product.parentId))
        .orderBy(asc(ProductStore.id))
        .limit(5001)
        .for(lock);
      if (parentRows.length > 5000)
        throw new AppError(
          422,
          'CATALOG_REPAIR_TOO_LARGE',
          'Reconcile this unusually large product-store family before troubleshooting.',
        );
      footprint.push(
        parentRows.map((row) => ({
          id: String(row.id),
          storeId: String(row.storeId),
          available: row.available,
          deleted: row.deleted,
        })),
      );
      parentVisibility.push(
        ...parentRows
          .filter((row) => !row.available || row.deleted)
          .map((row) => ({
            id: String(row.id),
            storeId: String(row.storeId),
            availableBefore: row.available,
            listedBefore: !row.deleted,
          })),
      );
    }
    imageReset = !imageTarget.images;
    imageProductId = String(imageTarget.id);
    footprint.push({ imageProductId, images: imageTarget.images });
    const [first] = await transaction
      .select({ id: ProductBarcode.id, gtin: ProductBarcode.gtin })
      .from(ProductBarcode)
      .where(eq(ProductBarcode.product, product.id))
      .orderBy(asc(ProductBarcode.id))
      .limit(1)
      .for(lock);
    footprint.push(first ? { id: String(first.id), gtin: String(first.gtin) } : null);
    if (first) {
      const duplicates = await transaction
        .select({
          id: ProductBarcode.id,
          productId: ProductBarcode.product,
          gtin: ProductBarcode.gtin,
        })
        .from(ProductBarcode)
        .where(and(eq(ProductBarcode.gtin, first.gtin), ne(ProductBarcode.product, product.id)))
        .orderBy(asc(ProductBarcode.id))
        .limit(5001)
        .for(lock);
      if (duplicates.length > 5000)
        throw new AppError(
          422,
          'CATALOG_REPAIR_TOO_LARGE',
          'Reconcile this unusually large barcode duplicate group before troubleshooting.',
        );
      footprint.push(
        duplicates.map((row) => ({
          id: String(row.id),
          productId: String(row.productId),
          gtin: String(row.gtin),
        })),
      );
      if (duplicates.length) {
        const candidate = temporarySourceBarcode(String(first.gtin));
        const [collision] = await transaction
          .select({ id: ProductBarcode.id })
          .from(ProductBarcode)
          .where(eq(ProductBarcode.gtin, BigInt(candidate)))
          .limit(1)
          .for(lock);
        if (collision)
          throw new AppError(
            422,
            'CATALOG_BARCODE_RECONCILIATION_REQUIRED',
            'The source temporary barcode is already in use. Reconcile these duplicates manually.',
          );
        barcodeChanges.push(
          ...duplicates.map((row) => ({
            id: String(row.id),
            productId: String(row.productId),
            from: String(row.gtin),
            to: candidate,
          })),
        );
        const ids = [...new Set(duplicates.map((row) => row.productId))],
          existing = await transaction
            .select({ id: Product.id })
            .from(Product)
            .where(inArray(Product.id, ids))
            .orderBy(asc(Product.id))
            .for('share');
        if (existing.length !== ids.length)
          throw new AppError(
            422,
            'CATALOG_BARCODE_RECONCILIATION_REQUIRED',
            'A duplicate barcode belongs to a missing product. Reconcile it before troubleshooting.',
          );
      }
    }
  }
  const syncProductIds = [
    ...new Set([productId, ...barcodeChanges.map((row) => row.productId)]),
  ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  return {
    productId,
    name: product.name,
    type: String(product.type),
    planHash: maintenanceHash(footprint),
    parentVisibility,
    imageReset,
    imageProductId,
    barcodeChanges,
    syncProductIds,
  };
}
export async function applyCatalogRepair(
  transaction: AdministrationTransaction,
  plan: CatalogRepairPlan,
) {
  if (plan.parentVisibility.length)
    await transaction
      .update(ProductStore)
      .set({ is_avail: true, is_del: false })
      .where(
        inArray(
          ProductStore.id,
          plan.parentVisibility.map((row) => BigInt(row.id)),
        ),
      );
  if (plan.imageReset && plan.imageProductId)
    await transaction
      .update(Product)
      .set({ images_new: '{"unisex":[],"male":[],"female":[]}' })
      .where(eq(Product.id, BigInt(plan.imageProductId)));
  if (plan.barcodeChanges.length)
    await transaction
      .update(ProductBarcode)
      .set({ gtin: BigInt(plan.barcodeChanges[0]!.to) })
      .where(
        inArray(
          ProductBarcode.id,
          plan.barcodeChanges.map((row) => BigInt(row.id)),
        ),
      );
}
