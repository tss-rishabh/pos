import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import { Product, ProductBarcode, ProductStore } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { withCatalogLock } from './locks.js';
import {
  inventoryPullSelection,
  temporarySourceBarcode,
  type InventoryPullInput,
} from './maintenance-domain.js';
import type { MaintenanceTransports } from './maintenance-transports.js';
import type { EventId, EventLogger } from '../../observability/event-registry.js';

export type MaintenanceLogger = EventLogger;
/** `AjaxTroubleshootProductView` always answers with this (core/views.py:3027-3030). */
export const troubleshootMessage =
  'Troubleshooting started for the Product, Just wait for a few seconds';

/**
 * `AjaxTroubleshootProductView` local repair (core/views.py:2996-3020), in one writer transaction:
 * the parent's product_store rows become available/listed, empty `images_new` is initialised, and
 * other products sharing this product's first barcode get `<gtin>0123`.
 */
export async function repairTroubleshootProduct(tx: AdministrationTransaction, productId: string) {
  const [product] = await tx
    .select({ type: Product.prod_type, parentId: Product.parent_prod_id })
    .from(Product)
    .where(eq(Product.id, BigInt(productId)))
    .limit(1);
  if (!product || product.type !== 1n) return;
  if (product.parentId > 0n)
    await tx
      .update(ProductStore)
      .set({ is_avail: true, is_del: false })
      .where(eq(ProductStore.product, product.parentId));
  const imageId = product.parentId > 0n ? product.parentId : BigInt(productId);
  const [image] = await tx
    .select({ images: Product.images_new })
    .from(Product)
    .where(eq(Product.id, imageId))
    .limit(1);
  if (image && !image.images)
    await tx
      .update(Product)
      .set({ images_new: '{"unisex":[],"male":[],"female":[]}' })
      .where(eq(Product.id, imageId));
  const [first] = await tx
    .select({ gtin: ProductBarcode.gtin })
    .from(ProductBarcode)
    .where(eq(ProductBarcode.product, BigInt(productId)))
    .orderBy(asc(ProductBarcode.id))
    .limit(1);
  if (!first) return;
  const others = await tx
    .select({ id: ProductBarcode.id })
    .from(ProductBarcode)
    .where(and(eq(ProductBarcode.gtin, first.gtin), ne(ProductBarcode.product, BigInt(productId))));
  if (!others.length) return;
  await tx
    .update(ProductBarcode)
    .set({ gtin: BigInt(temporarySourceBarcode(String(first.gtin))) })
    .where(
      inArray(
        ProductBarcode.id,
        others.map((row) => row.id),
      ),
    );
}

/**
 * Inventory pull and product troubleshooting run synchronously in the request, as legacy does:
 * local repair commits first, then the upstream call. No command ledger, worker or reconciliation.
 */
export function catalogMaintenanceService(
  db: Databases,
  transports: MaintenanceTransports,
  ephemeral: EphemeralStore,
  log: MaintenanceLogger = () => {},
) {
  const event = (
    user: Principal,
    requestId: string,
    resource: 'inventory-pull' | 'product-troubleshoot',
    eventId: EventId,
  ) => ({
    module: 'catalog-details',
    resource,
    eventId,
    eventInstanceId: randomUUID(),
    requestId,
    userId: user.id,
  });
  return {
    capabilities() {
      return {
        inventoryPullEnabled: Boolean(transports.inventory),
        troubleshootingEnabled: Boolean(transports.products),
      };
    },
    /** `InventorySyncView.post` (core/views.py:1564-1620); any signed-in operator. */
    async inventoryPull(user: Principal, input: InventoryPullInput, requestId: string) {
      const send = transports.inventory;
      if (!send)
        throw new AppError(
          503,
          'INVENTORY_PULL_UNAVAILABLE',
          'Inventory pull is not configured on this server.',
        );
      const selection = inventoryPullSelection(input);
      const ids = (
        await db
          .get('primary')
          .select({ id: Product.id })
          .from(Product)
          .where(
            and(
              inArray(
                Product.id,
                selection.ids.map((id) => BigInt(id)),
              ),
              eq(Product.prod_type, 1n),
            ),
          )
          .orderBy(asc(Product.id))
      ).map((row) => String(row.id));
      if (!ids.length && selection.mode === 'manual')
        throw new AppError(422, 'INVENTORY_SKUS_NOT_FOUND', 'No Sku(s) found for inventory pull.');
      if (ids.length) {
        let status: number;
        try {
          status = await send(ids, selection.mode);
        } catch {
          log(
            'error',
            event(user, requestId, 'inventory-pull', 'catalog-details.inventory-pull.failed'),
            'Inventory pull failed',
          );
          throw new AppError(
            503,
            'INVENTORY_PULL_UNAVAILABLE',
            'The inventory service could not be reached. Try again.',
          );
        }
        if (status < 200 || status >= 300)
          log(
            'warn',
            {
              ...event(
                user,
                requestId,
                'inventory-pull',
                'catalog-details.inventory-pull.not-acknowledged',
              ),
              status,
            },
            'Inventory pull was not acknowledged',
          );
      }
      return {
        status: 'success' as const,
        message:
          selection.mode === 'manual'
            ? 'Sku(s) registered successfully. Please check inventory after sometime.'
            : 'All SKUs processed successfully.Data may take some time to reflect.',
        productIds: ids,
      };
    },
    /**
     * `AjaxTroubleshootProductView.post` (core/views.py:2987-3030); any signed-in operator. Errors
     * are logged and swallowed; the response is always the legacy constant message.
     */
    async troubleshoot(user: Principal, productId: string, requestId: string) {
      try {
        await withCatalogLock(ephemeral, 'barcode-mutations', () =>
          db.get('writer').transaction((tx) => repairTroubleshootProduct(tx, productId)),
        );
        if (!transports.products) throw new Error('Product sync is not configured.');
        await transports.products([productId], {
          userId: user.id,
          requestId,
          troubleshoot: true,
        });
        log(
          'info',
          event(
            user,
            requestId,
            'product-troubleshoot',
            'catalog-details.product-troubleshoot.completed',
          ),
          'Troubleshoot ran',
        );
      } catch {
        log(
          'error',
          event(
            user,
            requestId,
            'product-troubleshoot',
            'catalog-details.product-troubleshoot.failed',
          ),
          'Error while troubleshooting the product',
        );
      }
      return { status: 200 as const, message: troubleshootMessage };
    },
  };
}
