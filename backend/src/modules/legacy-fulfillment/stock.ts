import { and, asc, eq, gt, inArray, or } from 'drizzle-orm';
import {
  HasProduct,
  HoldStockStore,
  Order,
  PosHoldStockLog,
  Product,
  ProductStore,
  Store,
} from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { parseLocationIds, locationStoreIds } from './python-text.js';
import type { LifecycleRuntime } from './runtime.js';

/** Result shape of the legacy `HoldStockHelperClass` methods. */
export interface StockResult {
  status: 'success' | 'fail';
  message: string;
}
const inventoryUnavailable = () =>
  new AppError(
    503,
    'LOCAL_DELIVERY_INVENTORY_UNAVAILABLE',
    'Store inventory synchronization is not configured.',
  );

/**
 * Legacy `HoldStockHelperClass` (`helpers/inventory_helper.py:30-235`) and
 * `inward_product_to_store` (`order/libs/calculations.py:286-320`). Each call is its own
 * writer transaction (legacy runs each statement in autocommit and a failing call only
 * logs). `sync_pos_inventory` is the configured stock procedure; `sync_pos_product` runs
 * after commit.
 */
export function lifecycleStock(runtime: LifecycleRuntime) {
  const { deps } = runtime;
  const procedure = (userId: string) =>
    userId === '0' ? deps.systemStockProcedure : deps.stockProcedure;
  async function syncProducts(productIds: readonly string[], storeId: string, userId: string) {
    if (!productIds.length) return;
    if (!deps.syncProducts) {
      runtime.log({
        eventId: 'legacy-fulfillment.product-sync.skipped',
        storeId,
        outcome: 'unconfigured',
      });
      return;
    }
    try {
      await deps.syncProducts(crypto.randomUUID(), [...new Set(productIds)], {
        operatorId: userId,
        storeId,
      });
    } catch {
      runtime.log({
        eventId: 'legacy-fulfillment.product-sync.failed',
        storeId,
        outcome: 'not-synced',
      });
    }
  }
  async function storeRow(tx: AdministrationTransaction, storeId: string) {
    const [store] = await tx
      .select({
        name: Store.store_name,
        type: Store.type,
        active: Store.is_active,
        location: Store.location_code,
      })
      .from(Store)
      .where(eq(Store.id, BigInt(storeId)))
      .limit(1);
    return store;
  }
  async function holdLog(
    tx: AdministrationTransaction,
    productId: string,
    storeId: string,
    before: number,
    after: number,
    userId: string,
    comment: string,
  ) {
    const at = runtime.timestamp();
    await tx.insert(PosHoldStockLog).values({
      product_id: BigInt(productId),
      store_id: BigInt(storeId),
      stock_before: String(before),
      stock_after: String(after),
      pos_user_id: BigInt(userId),
      comment: [...comment].slice(0, 255).join(''),
      created_at: at,
      updated_at: at,
    });
  }
  async function addHold(
    tx: AdministrationTransaction,
    productId: string,
    storeId: string,
    quantity: number,
  ) {
    const [held] = await tx
      .select({ id: HoldStockStore.id, stock: HoldStockStore.stock })
      .from(HoldStockStore)
      .where(
        and(
          eq(HoldStockStore.product, BigInt(productId)),
          eq(HoldStockStore.store, BigInt(storeId)),
        ),
      )
      .orderBy(asc(HoldStockStore.id))
      .limit(1)
      .for('update');
    if (held) {
      await tx
        .update(HoldStockStore)
        .set({ stock: held.stock + quantity })
        .where(
          and(
            eq(HoldStockStore.product, BigInt(productId)),
            eq(HoldStockStore.store, BigInt(storeId)),
          ),
        );
      return { before: held.stock, after: held.stock + quantity };
    }
    await tx
      .insert(HoldStockStore)
      .values({ product: BigInt(productId), store: BigInt(storeId), stock: quantity });
    return { before: 0, after: quantity };
  }

  /** `HoldStockHelperClass.hold_stock`. A CORE_WAREHOUSE location is not supported (see report). */
  async function hold(
    productId: string,
    storeId: string,
    quantity: number,
    userId: string,
    extraMessage = '',
  ): Promise<StockResult> {
    let synced = false;
    try {
      const result = await runtime.writer().transaction(async (tx) => {
        const store = await storeRow(tx, storeId);
        // Helpers.get_store_type filters is_active=1; an inactive store takes the STORE branch.
        if (store?.active && store.type === 'CORE_WAREHOUSE')
          return { status: 'fail' as const, message: 'Warehouse hold is not supported' };
        const [row] = await tx
          .select({ id: ProductStore.id, stock: ProductStore.stock })
          .from(ProductStore)
          .where(
            and(
              eq(ProductStore.product, BigInt(productId)),
              eq(ProductStore.store, BigInt(storeId)),
            ),
          )
          .orderBy(asc(ProductStore.id))
          .limit(1)
          .for('update');
        if (!row) return { status: 'fail' as const, message: 'Invalid Prodoct' };
        if (quantity > row.stock)
          return {
            status: 'fail' as const,
            message: `Only ${row.stock} quantity of ${productId} available in ${store?.name ?? 'None'}`,
          };
        const stockProcedure = procedure(userId);
        if (!stockProcedure) throw inventoryUnavailable();
        const { before, after } = await addHold(tx, productId, storeId, quantity);
        const message = extraMessage || 'Product inventory reduced to add into hold stock';
        await stockProcedure(tx, {
          storeId,
          productId,
          stock: row.stock - quantity,
          operatorId: userId,
          comment: message,
        });
        await holdLog(
          tx,
          productId,
          storeId,
          before,
          after,
          userId,
          extraMessage
            ? 'Hold Stock inventory added into Hold Stock ' + extraMessage
            : 'Hold Stock inventory added into Hold Stock from admin panel.',
        );
        synced = true;
        return {
          status: 'success' as const,
          message: `${quantity} Quantity of ${productId} hold in ${store?.name ?? 'None'}`,
        };
      });
      if (synced) await syncProducts([productId], storeId, userId);
      return result;
    } catch {
      runtime.log({ eventId: 'legacy-fulfillment.hold-stock.failed', storeId, outcome: 'fail' });
      return { status: 'fail', message: '' };
    }
  }

  /** `Helpers.live_variant_ids(parent)` (`helpers/helpers.py:107`). */
  async function liveVariantIds(tx: AdministrationTransaction, parentId: bigint) {
    const live = tx
      .select({ id: ProductStore.product })
      .from(ProductStore)
      .innerJoin(Product, eq(Product.id, ProductStore.product))
      .where(
        and(
          eq(Product.parent_prod_id, parentId),
          eq(ProductStore.is_del, false),
          gt(ProductStore.stock, 0),
        ),
      );
    const rows = await tx
      .select({ id: Product.id })
      .from(Product)
      .where(
        and(
          eq(Product.parent_prod_id, parentId),
          or(eq(Product.is_del, 0), inArray(Product.id, live)),
        ),
      )
      .orderBy(asc(Product.id));
    return rows.map((row) => String(row.id));
  }
  /** `inward_product_to_store` (`order/libs/calculations.py:286-320`); returns the ids to sync. */
  async function inwardToStore(
    tx: AdministrationTransaction,
    productId: string,
    storeId: string,
    quantity: number,
    userId: string,
    message: string,
  ) {
    const stockProcedure = procedure(userId);
    if (!stockProcedure) throw inventoryUnavailable();
    const [row] = await tx
      .select({ stock: ProductStore.stock })
      .from(ProductStore)
      .where(
        and(eq(ProductStore.product, BigInt(productId)), eq(ProductStore.store, BigInt(storeId))),
      )
      .orderBy(asc(ProductStore.id))
      .limit(1)
      .for('update');
    const updated = (row?.stock ?? 0) + quantity;
    const [product] = await tx
      .select({ parent: Product.parent_prod_id })
      .from(Product)
      .where(eq(Product.id, BigInt(productId)))
      .limit(1);
    let ids = [productId];
    if (product && product.parent > 0n) {
      ids = await liveVariantIds(tx, product.parent);
      if (!ids.includes(productId)) ids.push(productId);
      ids.push(String(product.parent));
    }
    for (const id of ids) {
      const [existing] = await tx
        .select({ id: ProductStore.id })
        .from(ProductStore)
        .where(and(eq(ProductStore.product, BigInt(id)), eq(ProductStore.store, BigInt(storeId))))
        .limit(1);
      if (existing)
        await tx
          .update(ProductStore)
          .set({ is_del: false, is_avail: true })
          .where(
            and(eq(ProductStore.product, BigInt(id)), eq(ProductStore.store, BigInt(storeId))),
          );
      else
        await tx.insert(ProductStore).values({
          product: BigInt(id),
          store: BigInt(storeId),
          stock: 0,
          is_del: false,
          is_avail: true,
        });
    }
    await stockProcedure(tx, {
      storeId,
      productId,
      stock: updated,
      operatorId: userId,
      comment: message,
    });
    await tx
      .update(ProductStore)
      .set({ stock: updated })
      .where(
        and(eq(ProductStore.product, BigInt(productId)), eq(ProductStore.store, BigInt(storeId))),
      );
    return ids;
  }

  /** `HoldStockHelperClass.unhold_stock` (without `order_push`). */
  async function unhold(
    productId: string,
    storeId: string,
    quantity: number,
    userId: string,
    extraMessage = '',
  ): Promise<StockResult> {
    let synced: string[] = [];
    try {
      const result = await runtime.writer().transaction(async (tx) => {
        const [held] = await tx
          .select({ stock: HoldStockStore.stock })
          .from(HoldStockStore)
          .where(
            and(
              eq(HoldStockStore.product, BigInt(productId)),
              eq(HoldStockStore.store, BigInt(storeId)),
            ),
          )
          .orderBy(asc(HoldStockStore.id))
          .limit(1)
          .for('update');
        if (!held) return { status: 'fail' as const, message: 'holded stock not available' };
        const store = await storeRow(tx, storeId);
        if (quantity > held.stock)
          return {
            status: 'fail' as const,
            message: `Only ${held.stock} quantity of ${productId} on hold in ${store?.name ?? 'None'}`,
          };
        if (store?.active && store.type === 'CORE_WAREHOUSE')
          return { status: 'fail' as const, message: 'Warehouse unhold is not supported' };
        const after = held.stock - quantity;
        await tx
          .update(HoldStockStore)
          .set({ stock: after })
          .where(
            and(
              eq(HoldStockStore.product, BigInt(productId)),
              eq(HoldStockStore.store, BigInt(storeId)),
            ),
          );
        await holdLog(
          tx,
          productId,
          storeId,
          held.stock,
          after,
          userId,
          extraMessage
            ? 'Hold Stock inventory reduced ' + extraMessage
            : 'Hold Stock inventory reduced to add into Product inventory.',
        );
        synced = await inwardToStore(
          tx,
          productId,
          storeId,
          quantity,
          userId,
          extraMessage || 'Product inventory added from admin panel from Hold Stock',
        );
        return {
          status: 'success' as const,
          message: `${quantity} Quantity of ${productId} unhold in ${store?.name ?? 'None'}`,
        };
      });
      await syncProducts(synced, storeId, userId);
      return result;
    } catch {
      runtime.log({ eventId: 'legacy-fulfillment.unhold-stock.failed', storeId, outcome: 'fail' });
      return { status: 'fail', message: '' };
    }
  }

  /** Hyperlocal line items of an order (all items, or platform 4 for split orders). */
  async function hyperlocalLines(orderId: string, split: boolean) {
    return runtime
      .writer()
      .select({ id: HasProduct.id, productId: HasProduct.product, quantity: HasProduct.qty })
      .from(HasProduct)
      .where(
        and(
          eq(HasProduct.order, BigInt(orderId)),
          split ? eq(HasProduct.order_platform, 4n) : undefined,
        ),
      )
      .orderBy(asc(HasProduct.id));
  }

  /** `HoldStockHelperClass.unhold_for_convert` (`helpers/inventory_helper.py:219-235`). */
  async function unholdForConvert(orderId: string, storeId: string) {
    const [order] = await runtime
      .writer()
      .select({
        split: Order.is_split_order,
        next: Order.next_location_ids,
        transfer: Order.is_transfer,
      })
      .from(Order)
      .where(eq(Order.id, BigInt(orderId)))
      .limit(1);
    if (!order) return;
    const stores = [storeId];
    if (order.transfer) stores.push(...locationStoreIds(parseLocationIds(order.next)));
    const message = `Hyperlocal order converted/canceled, inventory unhold for order ${orderId}`;
    for (const line of await hyperlocalLines(orderId, order.split === 1))
      for (const target of new Set(stores))
        await unhold(String(line.productId), target, Number(line.quantity), '0', message);
  }

  /**
   * Store restock of `AjaxRtoRecievedView.inventory_inward` (`order/views.py:4093-4120`) and the
   * webhook branch of `AjaxHlOrderView.cancel` (`:3638-3652`): stock + qty through
   * `sync_pos_inventory`, then `sync_pos_product`. Only existing `product_store` rows move.
   */
  async function restock(
    tx: AdministrationTransaction,
    storeId: string,
    lines: readonly { productId: string; quantity: number }[],
    userId: string,
    message: string,
  ) {
    const stockProcedure = procedure(userId);
    if (!stockProcedure) throw inventoryUnavailable();
    const synced: string[] = [];
    for (const line of lines) {
      const [row] = await tx
        .select({ stock: ProductStore.stock })
        .from(ProductStore)
        .where(
          and(
            eq(ProductStore.store, BigInt(storeId)),
            eq(ProductStore.product, BigInt(line.productId)),
          ),
        )
        .orderBy(asc(ProductStore.id))
        .limit(1)
        .for('update');
      if (!row) continue;
      const stock = row.stock + line.quantity;
      await stockProcedure(tx, {
        storeId,
        productId: line.productId,
        stock,
        operatorId: userId,
        comment: message,
      });
      await tx
        .update(ProductStore)
        .set({ stock })
        .where(
          and(
            eq(ProductStore.store, BigInt(storeId)),
            eq(ProductStore.product, BigInt(line.productId)),
          ),
        );
      synced.push(line.productId);
    }
    return synced;
  }
  return {
    hold,
    unhold,
    unholdForConvert,
    hyperlocalLines,
    restock,
    syncProducts,
    ready: (userId: string) => !!procedure(userId),
  };
}
export type LifecycleStock = ReturnType<typeof lifecycleStock>;
