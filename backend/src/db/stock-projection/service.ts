import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, like, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  Product,
  ProductStore,
  Store,
  ProductInventoryLog,
  Attributes,
  HasOptions,
} from '../legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import type { StockProcedure } from '../../modules/administration/stock-procedure.js';
import { aggregateStock, physicalStockLog, storeStockLog, aggregateStockLog } from './schema.js';
import { projectAvailableStock } from './domain.js';

const inputSchema = z
  .object({
    storeId: identifier,
    productId: identifier,
    operatorId: identifier,
    stock: z.number().int().min(0).max(2_147_483_647),
    comment: z.string().max(255),
  })
  .strict();
function auditText(value: string, limit: number) {
  if (value.length > limit || [...value].some((character) => character.codePointAt(0)! > 255))
    throw new AppError(
      422,
      'STOCK_AUDIT_TEXT_INVALID',
      'The stock audit text cannot be stored safely.',
    );
  return value;
}

/**
 * Candidate for the verified current physical schema, selected only by an explicit contract.
 * Caller owns authorization, transaction, idempotency and postcommit synchronization.
 * No CALL, transaction/session SQL, external work, or implicit commit occurs here.
 */
export function availableStockProjection(
  zone: string,
  clock = () => Temporal.Now.instant(),
): StockProcedure {
  return stockProjection(zone, clock, false);
}

/**
 * Trusted internal jobs only. This separate capability records the source's
 * system actor0; ordinary HTTP callers retain the positive-operator contract.
 * The caller must verify service/job authority, current scope and idempotency.
 */
export function availableSystemStockProjection(
  zone: string,
  clock = () => Temporal.Now.instant(),
): StockProcedure {
  return stockProjection(zone, clock, true);
}

function stockProjection(
  zone: string,
  clock: () => Temporal.Instant,
  system: boolean,
): StockProcedure {
  const schema = system ? inputSchema.extend({ operatorId: z.literal('0') }).strict() : inputSchema;
  return async (transaction, supplied) => {
    const input = schema.parse(supplied),
      productId = BigInt(input.productId),
      storeId = BigInt(input.storeId);
    const [product] = await transaction
      .select({ id: Product.id, parent: Product.parent_prod_id, type: Product.prod_type })
      .from(Product)
      .where(eq(Product.id, productId))
      .limit(1)
      .for('update');
    if (!product || ![1n, 4n, 5n, 8n].includes(product.type))
      throw new AppError(
        409,
        'STOCK_PRODUCT_UNSUPPORTED',
        'This product needs a verified inventory policy.',
      );
    const [aggregate] = await transaction
      .select()
      .from(aggregateStock)
      .where(eq(aggregateStock.productId, productId))
      .limit(1)
      .for('update');
    if (!aggregate || (aggregate.parentProductId ?? 0n) !== product.parent)
      throw new AppError(
        409,
        'STOCK_AGGREGATE_MISSING',
        'The product inventory projection requires reconciliation.',
      );
    const [store] = await transaction
      .select({ id: Store.id, location: Store.location_code })
      .from(Store)
      .where(eq(Store.id, storeId))
      .limit(1)
      .for('share');
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store was not found.');
    if (!store.location)
      throw new AppError(
        409,
        'STOCK_LOCATION_MISSING',
        'Configure the store inventory location before changing stock.',
      );
    const [current] = await transaction
      .select()
      .from(ProductStore)
      .where(and(eq(ProductStore.product, productId), eq(ProductStore.store, storeId)))
      .limit(1)
      .for('update');
    if (!current)
      throw new AppError(
        409,
        'STOCK_ASSOCIATION_MISSING',
        'Create the store inventory association before changing stock.',
      );
    const comment = auditText(input.comment, 255),
      location = auditText(store.location || '', 55),
      timestamp = clock()
        .toZonedDateTimeISO(zone)
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' })
        .replace('T', ' ');
    let size = '';
    if (product.parent > 0n) {
      const sizes = await transaction
        .select({ value: HasOptions.attr_val })
        .from(HasOptions)
        .innerJoin(Attributes, eq(Attributes.id, HasOptions.attr))
        .where(
          and(
            eq(HasOptions.prod_id, productId),
            ne(HasOptions.attr_val, ''),
            like(Attributes.attr, '%size%'),
          ),
        )
        .orderBy(asc(HasOptions.id))
        .limit(100);
      if (sizes.length === 100 || new Set(sizes.map((row) => row.value)).size > 1)
        throw new AppError(
          409,
          'STOCK_SIZE_AMBIGUOUS',
          'The product size requires reconciliation.',
        );
      size = sizes[0]?.value || '';
    }
    const before = auditText(
        product.parent > 0n ? JSON.stringify({ [size]: current.stock }) : String(current.stock),
        255,
      ),
      after = auditText(
        product.parent > 0n ? JSON.stringify({ [size]: input.stock }) : String(input.stock),
        255,
      );
    await transaction.insert(physicalStockLog).values({
      productId,
      before: current.stock,
      after: input.stock,
      location,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (current.stock !== input.stock) {
      await transaction
        .update(ProductStore)
        .set({ stock: input.stock })
        .where(eq(ProductStore.id, current.id));
      await transaction.insert(storeStockLog).values({
        storeId,
        productId,
        before: current.stock,
        after: input.stock,
        syncedAt: timestamp,
      });
      await transaction.insert(ProductInventoryLog).values({
        store_id: storeId,
        product_id: product.parent > 0n ? product.parent : productId,
        stock_before: before,
        stock_after: after,
        type: product.parent > 0n ? 3 : 1,
        user_id: 0n,
        pos_user_id: BigInt(input.operatorId),
        comment,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }
    // One writer transaction and product lock serialize aggregate recomputation across stores.
    const facts = await transaction
      .select({
        storeId: ProductStore.store,
        location: Store.location_code,
        stock: ProductStore.stock,
        threshold: Store.ecom_threshold,
        ecommerce: Store.ecom_delivery,
      })
      .from(ProductStore)
      .innerJoin(Store, eq(Store.id, ProductStore.store))
      .where(eq(ProductStore.product, productId))
      .for('share');
    const projection = projectAvailableStock(
      facts.map((row) => ({
        ...row,
        storeId: String(row.storeId),
        location: row.location || '',
        threshold: row.threshold ?? 0,
        ecommerce: row.ecommerce === 1,
      })),
      aggregate.buffer,
    );
    if (aggregate.stock !== projection.stock) {
      await transaction
        .update(aggregateStock)
        .set({ stock: projection.stock })
        .where(eq(aggregateStock.productId, productId));
      await transaction.insert(aggregateStockLog).values({
        productId: product.parent > 0n ? product.parent : productId,
        before,
        after,
        location,
        storeStock: projection.storeStock,
        finalStock: projection.grossStock,
        type: product.parent > 0n ? 3 : 1,
        userId: 1606835n,
        comment,
        createdAt: timestamp,
        updatedAt: timestamp,
        heldStock: 0,
      });
    }
  };
}
