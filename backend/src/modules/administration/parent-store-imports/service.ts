import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { Product, ProductStore, Store } from '../../../db/legacy-schema.js';
import type { Principal } from '../../../domain/access.js';
import { AppError, unavailable } from '../../../domain/errors.js';
import type { InventoryImportOptions } from '../imports.js';
import { inventoryImportService } from '../imports.js';
import type { ImportPreviewRow, QueueImportRow } from '../import-profile.js';
import { inventoryImportRows } from '../import-schema.js';
import { assertCurrentStoreAccess } from '../authorization.js';
import { enqueueCatalogSynchronization } from '../inventory-synchronization.js';
import { utcMediaTimestamp } from '../media-domain.js';
import { inventoryImportHistory, readImportHistoryOptions } from '../import-history.js';
import { warehouseView } from '../../operational-reports/report-inputs.js';
import {
  parentStoreCells,
  parentStoreCommand,
  parentStoreHeaders,
  parseParentStoreImport,
} from './domain.js';
import { authorizeParentImport, currentParentImportActor } from './authority.js';
import { liveParentVariantPredicate, parentStorePlan } from './plan.js';
import { parentStoreImportAudits } from './schema.js';

export function readParentStoreImportOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      BQ_PARENT_STORE_IMPORTS_VIEW: z.preprocess(
        (value) => (value === '' ? undefined : value),
        warehouseView,
      ),
      BQ_PARENT_STORE_IMPORT_ROWS_VIEW: z.preprocess(
        (value) => (value === '' ? undefined : value),
        warehouseView,
      ),
    })
    .parse(env);
}
export type ParentStoreImportOptions = InventoryImportOptions & {
  historyOptions?: ReturnType<typeof readParentStoreImportOptions>;
};
const batches = <T>(values: readonly T[], size: number) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
const failures = {
  STORE_NOT_FOUND: 'Not a valid store.',
  PARENT_STORE_PARENT_REQUIRED: 'Not a parent product.',
  STORE_ACCESS_DENIED: 'Not a valid store for requested user.',
};
export function parentStoreImportService(
  config: Config,
  db: Databases,
  options: ParentStoreImportOptions = {},
) {
  const historyOptions = options.historyOptions || readParentStoreImportOptions(),
    history =
      options.importHistory ||
      inventoryImportHistory(
        config,
        readImportHistoryOptions({
          BQ_INVENTORY_IMPORTS_VIEW: historyOptions.BQ_PARENT_STORE_IMPORTS_VIEW,
          BQ_INVENTORY_IMPORT_ROWS_VIEW: historyOptions.BQ_PARENT_STORE_IMPORT_ROWS_VIEW,
        }),
        undefined,
        undefined,
        {
          kind: 'parent-store',
          cells: parentStoreCells,
          command: parentStoreCommand,
          headers: parentStoreHeaders,
        },
      );
  const scope = (user: Principal) =>
    db.get('writer').transaction((tx) => currentParentImportActor(tx, user.id));
  async function inspect(user: Principal, rows: QueueImportRow[]): Promise<ImportPreviewRow[]> {
    const actor = await scope(user),
      commands = rows.flatMap((row) =>
        row.command ? [parentStoreCommand.parse(row.command)] : [],
      ),
      stores = new Map<string, { active: boolean; category: string | null }>(),
      parents = new Map<string, { parentId: bigint; type: bigint }>(),
      variants = new Map<string, number>();
    for (const ids of batches([...new Set(commands.map((row) => row.storeId))], 500)) {
      const found = await db
        .get('primary')
        .select({ id: Store.id, active: Store.is_active, category: Store.category })
        .from(Store)
        .where(inArray(Store.id, ids.map(BigInt)))
        .limit(ids.length);
      for (const row of found) stores.set(String(row.id), row);
    }
    for (const ids of batches([...new Set(commands.map((row) => row.productId))], 500)) {
      const reader = db.get('primary'),
        found = await reader
          .select({ id: Product.id, parentId: Product.parent_prod_id, type: Product.prod_type })
          .from(Product)
          .where(inArray(Product.id, ids.map(BigInt)))
          .limit(ids.length);
      for (const row of found) parents.set(String(row.id), row);
      const counts = await reader
        .select({ id: Product.parent_prod_id, count: sql<string>`CAST(COUNT(*) AS CHAR)` })
        .from(Product)
        .where(
          and(inArray(Product.parent_prod_id, ids.map(BigInt)), liveParentVariantPredicate(reader)),
        )
        .groupBy(Product.parent_prod_id)
        .limit(ids.length);
      for (const row of counts)
        variants.set(
          String(row.id),
          Number(
            z
              .string()
              .regex(/^\d{1,10}$/)
              .parse(row.count),
          ),
        );
    }
    return rows.map((row) => {
      let errorCode = row.errorCode,
        message = row.message,
        familySize: number | null = null;
      if (row.command) {
        const command = parentStoreCommand.parse(row.command),
          store = stores.get(command.storeId),
          parent = parents.get(command.productId);
        if (!store?.active) {
          errorCode = 'STORE_NOT_FOUND';
          message = failures.STORE_NOT_FOUND;
        } else if (!parent || parent.parentId !== 0n) {
          errorCode = 'PARENT_STORE_PARENT_REQUIRED';
          message = failures.PARENT_STORE_PARENT_REQUIRED;
        } else if (
          !actor.allActors &&
          (!actor.storeIds.includes(command.storeId) ||
            (actor.userType === 2 && store.category !== 'FRANCHISE'))
        ) {
          errorCode = 'STORE_ACCESS_DENIED';
          message = failures.STORE_ACCESS_DENIED;
        } else {
          familySize = (parent.type === 3n ? variants.get(command.productId) || 0 : 0) + 1;
          if (familySize > 1000) {
            errorCode = 'PARENT_STORE_FAMILY_TOO_WIDE';
            message = 'Reconcile this product family before importing.';
          }
        }
      }
      return { ...row, errorCode, message, saleableStock: null, heldStock: null, familySize };
    });
  }
  const queue = inventoryImportService(config, db, {
    ...options,
    importProfile: {
      kind: 'parent-store',
      authorize: authorizeParentImport,
      currentActor: currentParentImportActor,
      parse: parseParentStoreImport,
      inspect,
      command: parentStoreCommand,
      cells: parentStoreCells,
      headers: parentStoreHeaders,
      needsStock: () => true,
      history,
      failureMessages: failures,
      isBlockedCode: (code) => code.startsWith('PARENT_STORE_') || code.startsWith('STOCK_'),
      successMessage: 'Product Store Data Updated Successfully.',
      async apply(tx, context, value) {
        const command = parentStoreCommand.parse(value);
        let denied = false;
        try {
          await assertCurrentStoreAccess(tx, context.actorId, command.storeId);
        } catch (error) {
          if (error instanceof AppError && error.code === 'STORE_ACCESS_DENIED') denied = true;
          else throw error;
        }
        const [store] = await tx
          .select({ id: Store.id })
          .from(Store)
          .where(and(eq(Store.id, BigInt(command.storeId)), eq(Store.is_active, true)))
          .limit(1)
          .for('update');
        if (!store) throw new AppError(404, 'STORE_NOT_FOUND', failures.STORE_NOT_FOUND);
        if (denied) {
          const [parent] = await tx
            .select({ parentId: Product.parent_prod_id })
            .from(Product)
            .where(eq(Product.id, BigInt(command.productId)))
            .limit(1);
          if (!parent || parent.parentId !== 0n)
            throw new AppError(
              404,
              'PARENT_STORE_PARENT_REQUIRED',
              failures.PARENT_STORE_PARENT_REQUIRED,
            );
          throw new AppError(403, 'STORE_ACCESS_DENIED', failures.STORE_ACCESS_DENIED);
        }
        const plan = await parentStorePlan(tx, command);
        if (!options.procedureVerified || !options.stockProcedure)
          return unavailable('Verified atomic stock projection');
        const reset = new Set(plan.resetIds);
        for (const row of plan.existing)
          if (reset.has(String(row.productId)))
            await options.stockProcedure(tx, {
              storeId: command.storeId,
              productId: String(row.productId),
              stock: 0,
              operatorId: context.actorId,
              comment: 'Product removed from store using bulk CSV upload.',
            });
        await tx
          .delete(ProductStore)
          .where(
            and(
              eq(ProductStore.store, store.id),
              inArray(ProductStore.product, plan.familyIds.map(BigInt)),
            ),
          );
        if (command.active)
          for (const group of batches(plan.familyIds, 200))
            await tx.insert(ProductStore).values(
              group.map((id) => ({
                store: store.id,
                product: BigInt(id),
                stock: 0,
                is_avail: true,
                is_del: false,
              })),
            );
        await tx.insert(parentStoreImportAudits).values({
          importId: context.importId,
          rowNumber: context.rowNumber,
          actorId: context.actorId,
          requestId: context.requestId,
          storeId: command.storeId,
          parentId: command.productId,
          before: plan.existing.map((row) => ({
            ...row,
            id: String(row.id),
            productId: String(row.productId),
          })),
          afterIds: command.active ? plan.familyIds : [],
          resetIds: plan.existing
            .filter((row) => reset.has(String(row.productId)))
            .map((row) => String(row.productId)),
          createdAt: utcMediaTimestamp(),
        });
      },
      async finalize(tx, context) {
        const rows = await tx
          .select({ command: inventoryImportRows.command })
          .from(inventoryImportRows)
          .where(
            and(
              eq(inventoryImportRows.importId, context.importId),
              eq(inventoryImportRows.state, 'SUCCEEDED'),
            ),
          )
          .orderBy(asc(inventoryImportRows.rowNumber))
          .limit(5001);
        if (rows.length > 5000)
          throw new AppError(
            503,
            'PARENT_STORE_SYNC_RECONCILIATION',
            'Import synchronization requires reconciliation.',
          );
        const ids = rows.map((row) => parentStoreCommand.parse(row.command).productId);
        for (const [index, products] of batches(ids, 1000).entries())
          await enqueueCatalogSynchronization(tx, {
            id: createHash('sha256')
              .update(`parent-store-import:${context.importId}:${context.processedRows}:${index}`)
              .digest('hex')
              .slice(0, 32),
            importId: context.importId,
            revision: context.processedRows,
            productIds: products,
            operatorId: context.actorId,
            ...(context.requestId ? { requestId: context.requestId } : {}),
          });
      },
    },
  });
  return {
    ...queue,
    async capabilities(user: Principal) {
      authorizeParentImport(user);
      const actor = await scope(user),
        stores =
          actor.allActors || actor.storeIds.length
            ? await db
                .get('primary')
                .select({ id: Store.id, name: Store.store_name })
                .from(Store)
                .where(
                  and(
                    eq(Store.is_active, true),
                    actor.allActors ? undefined : inArray(Store.id, actor.storeIds.map(BigInt)),
                    actor.userType === 2 ? eq(Store.category, 'FRANCHISE') : undefined,
                  ),
                )
                .orderBy(asc(Store.id))
                .limit(1001)
            : [];
      if (stores.length > 1000)
        throw new AppError(
          422,
          'PARENT_STORE_SCOPE_TOO_WIDE',
          'Use a bounded store scope for this import.',
        );
      return {
        ...queue.capabilities(user),
        stores: stores.map((row) => ({ id: String(row.id), name: row.name })),
      };
    },
  };
}
