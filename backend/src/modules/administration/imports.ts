import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, count, desc, eq, exists, gt, gte, inArray, lt, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  HoldStockStore,
  PosHoldStockLog,
  PosUser,
  Product,
  ProductStore,
  Store,
} from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { requireRole, type Principal } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { currentRequestTrace } from '../../observability/context.js';
import type { AdministrationTransaction } from './checkins.js';
import { assertCurrentInventoryAccess, assertCurrentOperatorRole } from './authorization.js';
import { lockAdministrationRegistry } from './locks.js';
import { utcMediaTimestamp } from './media-domain.js';
import type { InventoryOptions } from './inventory.js';
import { executeStockProcedure } from './stock-procedure.js';
import { enqueueInventorySynchronization } from './inventory-synchronization.js';
import { inventoryImports, inventoryImportRows, type StockImportCommand } from './import-schema.js';
import {
  importJobDto,
  importHistoryInput,
  importListInput,
  importRowListInput,
  parseStockImport,
  stockCsv,
  stockImportCells,
  stockImportChecksum,
  stockImportCommand,
  stockImportHeaders,
  type ParsedImportRow,
  type StockImportInput,
} from './import-domain.js';
import { inventoryImportHistory, type InventoryImportHistory } from './import-history.js';
import { historicalInventoryImport, mysqlImportCutoff } from './import-time.js';
import type {
  ImportCommand,
  ImportActor,
  InventoryImportProfile,
  QueueImportRow,
} from './import-profile.js';

type Job = typeof inventoryImports.$inferSelect;
export interface ImportDispatchResult {
  profile?: 'parent-store';
  importId: string;
  actorId: string;
  requestId: string | null;
  rowNumber: number | null;
  storeId: string | null;
  status: 'row-succeeded' | 'row-failed' | 'blocked' | 'completed';
  errorCode?: string;
}
const batches = <T>(values: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(values.length / size) }, (_value, index) =>
    values.slice(index * size, (index + 1) * size),
  );
const key = (storeId: string, productId: string) => `${storeId}:${productId}`;
const synchronizeId = (importId: string, rowNumber: number) =>
  createHash('sha256')
    .update(`inventory-import:${importId}:${rowNumber}`)
    .digest('hex')
    .slice(0, 32);
const rowFailureMessages: Readonly<Record<string, string>> = {
  STORE_ACCESS_DENIED: 'Not a valid store for requested user.',
  STORE_NOT_FOUND: 'Not a valid store.',
  PRODUCT_NOT_FOUND: 'Not a valid product.',
  CONFIGURABLE_PARENT_STOCK: 'Parent configurable product cannot be saved.',
  INSUFFICIENT_SALEABLE_STOCK: 'Stock is not available to hold.',
  INSUFFICIENT_HELD_STOCK: 'Stock not available to unhold.',
  INVENTORY_STOCK_RANGE: 'Stock would exceed its supported range.',
};
const blockedCodes = new Set([
  'DEPENDENCY_UNAVAILABLE',
  'HOLD_STOCK_RECONCILIATION_REQUIRED',
  'INVENTORY_FAMILY_RECONCILIATION_REQUIRED',
  'AUTH_REQUIRED',
  'ROLE_ACCESS_DENIED',
  'INVENTORY_ADMINISTRATION_DENIED',
]);
function authorizeStockImport(user: Principal) {
  requireRole(user, [1, 2, 3]);
  if (user.userType !== 1)
    throw new AppError(
      403,
      'INVENTORY_ADMINISTRATION_DENIED',
      'Stock administration is restricted for this user type.',
    );
}
async function currentStockActor(transaction: AdministrationTransaction, actorId: string) {
  const role = await assertCurrentOperatorRole(transaction, actorId, [1, 2, 3]);
  const [identity] = await transaction
    .select({ userType: PosUser.user_type })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(actorId)))
    .limit(1);
  if (identity?.userType !== 1)
    throw new AppError(
      403,
      'INVENTORY_ADMINISTRATION_DENIED',
      'Stock administration is restricted for this user type.',
    );
  return role;
}
const project = importJobDto;
export interface InventoryImportOptions extends InventoryOptions {
  importHistory?: InventoryImportHistory;
  importProfile?: InventoryImportProfile;
}
export function inventoryImportService(
  config: Config,
  db: Databases,
  options: InventoryImportOptions = {},
) {
  const profile = options.importProfile,
    kind = profile?.kind || 'stock';
  const authorize = profile?.authorize || authorizeStockImport;
  const currentActor =
    profile?.currentActor ||
    (async (transaction: AdministrationTransaction, actorId: string): Promise<ImportActor> => {
      const role = await currentStockActor(transaction, actorId);
      return { role, allActors: role === 1 };
    });
  const parseRows = profile?.parse || parseStockImport,
    commandSchema = profile?.command || stockImportCommand,
    cellsSchema = profile?.cells || stockImportCells,
    headers = profile?.headers || stockImportHeaders;
  const needsStock = (command: ImportCommand) =>
    profile ? profile.needsStock(command) : stockImportCommand.parse(command).movement !== 'none';
  const stockReady = !!options.procedureVerified && (!profile || !!options.stockProcedure);
  const failures = { ...rowFailureMessages, ...profile?.failureMessages };
  const historicalReader =
    profile?.history || options.importHistory || inventoryImportHistory(config);
  const historical = (row: Job) =>
    historicalInventoryImport(row, Temporal.Now.instant().subtract({ hours: 24 }));
  const timestamp = () =>
    Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  function dependencies(rows: QueueImportRow[]) {
    if (rows.some((row) => row.command) && !options.syncProducts)
      return unavailable('Product synchronization adapter');
    if (rows.some((row) => row.command && needsStock(row.command)) && !stockReady)
      return unavailable('Verified inventory stock procedure');
  }
  async function job(user: Principal, importId: string) {
    authorize(user);
    return db.get('writer').transaction(async (transaction) => {
      const actor = await currentActor(transaction, user.id);
      const [row] = await transaction
        .select()
        .from(inventoryImports)
        .where(
          and(
            eq(inventoryImports.id, importId),
            eq(inventoryImports.profile, kind),
            actor.allActors ? undefined : eq(inventoryImports.actorId, user.id),
          ),
        )
        .limit(1)
        .for('share');
      if (!row) throw new AppError(404, 'INVENTORY_IMPORT_NOT_FOUND', 'This import was not found.');
      return row;
    });
  }
  async function inspect(user: Principal, rows: ParsedImportRow[]) {
    const commands = rows.flatMap((row) => (row.command ? [row.command] : []));
    const permitted = commands.filter(
      (command) => user.role === 1 || user.storeIds.includes(command.storeId),
    );
    const stores = new Map<string, boolean>(),
      products = new Map<string, bigint>(),
      stocks = new Map<string, number>(),
      held = new Map<string, number>();
    for (const ids of batches([...new Set(permitted.map((command) => command.storeId))], 500)) {
      const values = await db
        .get('primary')
        .select({ id: Store.id, active: Store.is_active })
        .from(Store)
        .where(inArray(Store.id, ids.map(BigInt)))
        .limit(ids.length);
      for (const value of values) stores.set(String(value.id), value.active);
    }
    for (const ids of batches([...new Set(permitted.map((command) => command.productId))], 500)) {
      const values = await db
        .get('primary')
        .select({ id: Product.id, type: Product.prod_type })
        .from(Product)
        .where(inArray(Product.id, ids.map(BigInt)))
        .limit(ids.length);
      for (const value of values) products.set(String(value.id), value.type);
    }
    const pairs = [
      ...new Map(
        permitted.map((command) => [key(command.storeId, command.productId), command]),
      ).values(),
    ];
    for (const chunk of batches(pairs, 100)) {
      const stockValues = await db
        .get('primary')
        .select({
          store: ProductStore.store,
          product: ProductStore.product,
          stock: ProductStore.stock,
        })
        .from(ProductStore)
        .where(
          or(
            ...chunk.map((command) =>
              and(
                eq(ProductStore.store, BigInt(command.storeId)),
                eq(ProductStore.product, BigInt(command.productId)),
              ),
            ),
          ),
        )
        .limit(chunk.length);
      const heldValues = await db
        .get('primary')
        .select({
          store: HoldStockStore.store,
          product: HoldStockStore.product,
          stock: HoldStockStore.stock,
        })
        .from(HoldStockStore)
        .where(
          or(
            ...chunk.map((command) =>
              and(
                eq(HoldStockStore.store, BigInt(command.storeId)),
                eq(HoldStockStore.product, BigInt(command.productId)),
              ),
            ),
          ),
        )
        .limit(chunk.length * 2 + 1);
      for (const value of stockValues)
        stocks.set(key(String(value.store), String(value.product)), value.stock);
      for (const value of heldValues)
        held.set(
          key(String(value.store), String(value.product)),
          (held.get(key(String(value.store), String(value.product))) || 0) + value.stock,
        );
    }
    return rows.map((row) => {
      const command = row.command;
      if (!command) return { ...row, saleableStock: null, heldStock: null };
      let errorCode: string | null = null,
        message: string | null = null;
      if (user.role !== 1 && !user.storeIds.includes(command.storeId)) {
        errorCode = 'STORE_ACCESS_DENIED';
        message = 'Not a valid store for requested user.';
      } else if (!stores.get(command.storeId)) {
        errorCode = 'STORE_NOT_FOUND';
        message = 'Not a valid store.';
      } else if (!products.has(command.productId)) {
        errorCode = 'PRODUCT_NOT_FOUND';
        message = 'Not a valid product.';
      } else if (command.movement !== 'none' && products.get(command.productId) === 3n) {
        errorCode = 'CONFIGURABLE_PARENT_STOCK';
        message = 'Parent configurable product cannot be saved.';
      }
      const saleableStock = stocks.get(key(command.storeId, command.productId)) ?? null,
        heldStock = held.get(key(command.storeId, command.productId)) || 0;
      if (
        !errorCode &&
        saleableStock !== null &&
        command.movement === 'hold' &&
        command.quantity > saleableStock
      ) {
        errorCode = 'INSUFFICIENT_SALEABLE_STOCK';
        message = 'Stock is not available to hold.';
      }
      if (
        !errorCode &&
        saleableStock !== null &&
        command.movement === 'unhold' &&
        command.quantity > heldStock
      ) {
        errorCode = 'INSUFFICIENT_HELD_STOCK';
        message = 'Stock not available to unhold.';
      }
      return {
        ...row,
        errorCode,
        message:
          message ||
          (saleableStock === null
            ? 'Product is not assigned to this store; no stock or visibility will change.'
            : null),
        saleableStock,
        heldStock,
      };
    });
  }
  async function apply(
    transaction: AdministrationTransaction,
    actorId: string,
    requestId: string | null,
    importId: string,
    rowNumber: number,
    command: StockImportCommand,
  ) {
    await assertCurrentInventoryAccess(transaction, actorId, command.storeId);
    const [store] = await transaction
      .select({ id: Store.id })
      .from(Store)
      .where(and(eq(Store.id, BigInt(command.storeId)), eq(Store.is_active, true)))
      .limit(1)
      .for('update');
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Not a valid store.');
    const [product] = await transaction
      .select({ id: Product.id, parentId: Product.parent_prod_id, type: Product.prod_type })
      .from(Product)
      .where(eq(Product.id, BigInt(command.productId)))
      .limit(1)
      .for('update');
    if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Not a valid product.');
    if (command.movement !== 'none' && product.type === 3n)
      throw new AppError(
        409,
        'CONFIGURABLE_PARENT_STOCK',
        'Parent configurable product cannot be saved.',
      );
    const [current] = await transaction
      .select()
      .from(ProductStore)
      .where(and(eq(ProductStore.store, store.id), eq(ProductStore.product, product.id)))
      .limit(1)
      .for('update');
    const family = new Set([command.productId]);
    if (current) {
      if (command.movement !== 'none') {
        if (!options.procedureVerified) return unavailable('Verified inventory stock procedure');
        const held = await transaction
          .select()
          .from(HoldStockStore)
          .where(and(eq(HoldStockStore.store, store.id), eq(HoldStockStore.product, product.id)))
          .limit(2)
          .for('update');
        if (held.length > 1)
          throw new AppError(
            503,
            'HOLD_STOCK_RECONCILIATION_REQUIRED',
            'Held stock requires reconciliation before importing.',
          );
        const before = held[0]?.stock || 0,
          hold = command.movement === 'hold';
        if (hold && command.quantity > current.stock)
          throw new AppError(409, 'INSUFFICIENT_SALEABLE_STOCK', 'Stock is not available to hold.');
        if (!hold && command.quantity > before)
          throw new AppError(409, 'INSUFFICIENT_HELD_STOCK', 'Stock not available to unhold.');
        const after = before + (hold ? command.quantity : -command.quantity),
          stock = current.stock + (hold ? -command.quantity : command.quantity);
        if (after < 0 || after > 2_147_483_647 || stock < 0 || stock > 2_147_483_647)
          throw new AppError(
            409,
            'INVENTORY_STOCK_RANGE',
            'Stock would exceed its supported range.',
          );
        if (!hold && product.parentId > 0n) {
          const otherStock = alias(ProductStore, 'live_variant_stock');
          const variants = await transaction
            .select({ id: Product.id })
            .from(Product)
            .where(
              and(
                eq(Product.parent_prod_id, product.parentId),
                or(
                  eq(Product.is_del, 0),
                  exists(
                    transaction
                      .select({ id: otherStock.id })
                      .from(otherStock)
                      .where(
                        and(
                          eq(otherStock.product, Product.id),
                          eq(otherStock.is_del, false),
                          gt(otherStock.stock, 0),
                        ),
                      ),
                  ),
                ),
              ),
            )
            .orderBy(asc(Product.id))
            .limit(1001);
          if (variants.length > 1000)
            throw new AppError(
              503,
              'INVENTORY_FAMILY_RECONCILIATION_REQUIRED',
              'Product variants require reconciliation before importing.',
            );
          variants.forEach((value) => family.add(String(value.id)));
          family.add(String(product.parentId));
          if (family.size > 1000)
            throw new AppError(
              503,
              'INVENTORY_FAMILY_RECONCILIATION_REQUIRED',
              'Product variants require reconciliation before importing.',
            );
          for (const id of [...family].sort((one, two) => (BigInt(one) < BigInt(two) ? -1 : 1)))
            await transaction
              .insert(ProductStore)
              .values({
                product: BigInt(id),
                store: store.id,
                stock: 0,
                is_avail: true,
                is_del: false,
              })
              .onDuplicateKeyUpdate({ set: { is_avail: true, is_del: false } });
        }
        if (held[0])
          await transaction
            .update(HoldStockStore)
            .set({ stock: after })
            .where(eq(HoldStockStore.id, held[0].id));
        else
          await transaction
            .insert(HoldStockStore)
            .values({ product: product.id, store: store.id, stock: after });
        await (options.stockProcedure || executeStockProcedure)(transaction, {
          storeId: command.storeId,
          productId: command.productId,
          stock,
          operatorId: actorId,
          comment: hold
            ? 'Product inventory added into hold stock.'
            : 'Product inventory added from admin panel from Hold Stock',
        });
        await transaction
          .update(ProductStore)
          .set({ stock })
          .where(eq(ProductStore.id, current.id));
        const now = timestamp();
        await transaction.insert(PosHoldStockLog).values({
          store_id: store.id,
          product_id: product.id,
          stock_before: String(before),
          stock_after: String(after),
          pos_user_id: BigInt(actorId),
          comment: hold
            ? 'Hold Stock inventory added into Hold Stock from admin panel .'
            : 'Hold Stock inventory reduced to add into Product inventory.',
          created_at: now,
          updated_at: now,
        });
      }
      const visibility = {
        is_avail: command.available ?? current.is_avail,
        is_del: command.archived ?? current.is_del,
      };
      await transaction
        .update(ProductStore)
        .set(visibility)
        .where(
          and(
            eq(ProductStore.store, store.id),
            inArray(
              ProductStore.product,
              product.parentId > 0n ? [product.id, product.parentId] : [product.id],
            ),
          ),
        );
      if (product.parentId > 0n) family.add(String(product.parentId));
    }
    await enqueueInventorySynchronization(transaction, {
      id: synchronizeId(importId, rowNumber),
      storeId: command.storeId,
      productIds: [...family],
      operatorId: actorId,
      reason: 'inventory-import',
      ...(requestId ? { requestId } : {}),
    });
  }
  return {
    capabilities(user: Principal) {
      authorize(user);
      return {
        maximumBytes: 256 * 1024,
        maximumRows: 5000,
        visibilityEnabled: !!options.syncProducts,
        stockEnabled: !!options.syncProducts && stockReady,
        historyEnabled: historicalReader.enabled,
      };
    },
    async preview(user: Principal, input: StockImportInput) {
      authorize(user);
      const rows = profile
          ? await profile.inspect(user, profile.parse(input.csv))
          : await inspect(user, parseStockImport(input.csv)),
        invalidRows = rows.filter((row) => row.errorCode).length;
      return {
        totalRows: rows.length,
        validRows: rows.length - invalidRows,
        invalidRows,
        rows: rows.slice(0, 100),
        remainingRows: Math.max(0, rows.length - 100),
        requiresStockProcedure: rows.some((row) => row.command && needsStock(row.command)),
        canSubmit:
          (!rows.some((row) => row.command) || !!options.syncProducts) &&
          (!rows.some((row) => row.command && needsStock(row.command)) || stockReady),
      };
    },
    async create(user: Principal, input: StockImportInput) {
      authorize(user);
      const rows = parseRows(input.csv),
        checksum = stockImportChecksum(input.csv);
      dependencies(rows);
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await lockAdministrationRegistry(transaction, 'inventory-imports');
          await currentActor(transaction, user.id);
          const [previous] = await transaction
            .select()
            .from(inventoryImports)
            .where(eq(inventoryImports.id, input.id))
            .limit(1);
          if (previous) {
            if (
              previous.actorId !== user.id ||
              previous.profile !== kind ||
              previous.checksum !== checksum ||
              previous.name !== input.name
            )
              throw new AppError(
                409,
                'INVENTORY_IMPORT_ID_REUSED',
                'Choose a new inventory import.',
              );
            return project(previous);
          }
          const [pending] = await transaction
            .select({ count: count() })
            .from(inventoryImports)
            .where(
              and(
                eq(inventoryImports.actorId, user.id),
                inArray(inventoryImports.state, ['QUEUED', 'RUNNING', 'BLOCKED']),
              ),
            );
          if ((pending?.count || 0) >= 5)
            throw new AppError(
              409,
              'INVENTORY_IMPORT_LIMIT',
              'Complete or cancel an existing import before adding another.',
            );
          const failed = rows.filter((row) => !row.command).length,
            now = utcMediaTimestamp();
          const value: typeof inventoryImports.$inferInsert = {
            id: input.id,
            profile: kind,
            actorId: user.id,
            requestId: currentRequestTrace()?.requestId || null,
            checksum,
            name: input.name,
            state: failed === rows.length ? 'COMPLETED' : 'QUEUED',
            errorCode: null,
            totalRows: rows.length,
            processedRows: failed,
            successfulRows: 0,
            failedRows: failed,
            createdAt: now,
            updatedAt: now,
          };
          await transaction.insert(inventoryImports).values(value);
          for (const chunk of batches(rows, 200))
            await transaction.insert(inventoryImportRows).values(
              chunk.map((row) => ({
                importId: input.id,
                rowNumber: row.rowNumber,
                cells: row.cells,
                command: row.command,
                state: row.command ? ('PENDING' as const) : ('FAILED' as const),
                errorCode: row.errorCode,
                message: row.message,
              })),
            );
          const [created] = await transaction
            .select()
            .from(inventoryImports)
            .where(eq(inventoryImports.id, input.id))
            .limit(1);
          if (!created)
            throw new AppError(
              500,
              'INVENTORY_IMPORT_CREATE_FAILED',
              'This import could not be queued.',
            );
          return project(created);
        }),
      );
    },
    async list(user: Principal, input: z.infer<typeof importListInput>) {
      authorize(user);
      const actor = await db
        .get('writer')
        .transaction((transaction) => currentActor(transaction, user.id));
      const rows = await db
        .get('primary')
        .select()
        .from(inventoryImports)
        .where(
          and(
            eq(inventoryImports.profile, kind),
            actor.allActors ? undefined : eq(inventoryImports.actorId, user.id),
            or(
              inArray(inventoryImports.state, ['QUEUED', 'RUNNING', 'BLOCKED']),
              gte(
                inventoryImports.createdAt,
                mysqlImportCutoff(Temporal.Now.instant().subtract({ hours: 24 })),
              ),
            ),
            input.after === '0' ? undefined : lt(inventoryImports.sequence, BigInt(input.after)),
          ),
        )
        .orderBy(desc(inventoryImports.sequence))
        .limit(input.limit + 1);
      return {
        data: rows.slice(0, input.limit).map(project),
        nextCursor: rows.length > input.limit ? String(rows[input.limit - 1]!.sequence) : null,
      };
    },
    async history(user: Principal, input: z.infer<typeof importHistoryInput>) {
      authorize(user);
      const actor = await db
        .get('writer')
        .transaction((transaction) => currentActor(transaction, user.id));
      return historicalReader.list({ actorId: user.id, allActors: actor.allActors }, input);
    },
    async detail(user: Principal, importId: string) {
      const anchor = await job(user, importId);
      return historical(anchor) ? historicalReader.detail(anchor) : project(anchor);
    },
    async rows(user: Principal, importId: string, input: z.infer<typeof importRowListInput>) {
      const anchor = await job(user, importId);
      if (historical(anchor)) return historicalReader.rows(anchor, input);
      const rows = await db
        .get('primary')
        .select()
        .from(inventoryImportRows)
        .where(
          and(
            eq(inventoryImportRows.importId, importId),
            gt(inventoryImportRows.rowNumber, input.after),
            input.state === 'all' ? undefined : eq(inventoryImportRows.state, input.state),
          ),
        )
        .orderBy(asc(inventoryImportRows.rowNumber))
        .limit(input.limit + 1);
      return {
        data: rows.slice(0, input.limit),
        nextCursor: rows.length > input.limit ? String(rows[input.limit - 1]!.rowNumber) : null,
      };
    },
    async failedCsv(user: Principal, importId: string): Promise<AsyncGenerator<string>> {
      const anchor = await job(user, importId);
      if (historical(anchor)) return historicalReader.failedCsv(anchor);
      return (async function* () {
        yield stockCsv([[...headers, 'Message']], true);
        let after = 0;
        for (;;) {
          const rows = await db
            .get('primary')
            .select({
              rowNumber: inventoryImportRows.rowNumber,
              cells: inventoryImportRows.cells,
              message: inventoryImportRows.message,
            })
            .from(inventoryImportRows)
            .where(
              and(
                eq(inventoryImportRows.importId, importId),
                eq(inventoryImportRows.state, 'FAILED'),
                gt(inventoryImportRows.rowNumber, after),
              ),
            )
            .orderBy(asc(inventoryImportRows.rowNumber))
            .limit(100);
          if (!rows.length) break;
          yield stockCsv(
            rows.map((row) => [
              ...cellsSchema.parse(row.cells),
              row.message || 'Error while traversing csv data.',
            ]),
            true,
          );
          after = rows.at(-1)!.rowNumber;
        }
      })();
    },
    async control(user: Principal, importId: string, action: 'resume' | 'cancel') {
      authorize(user);
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          const actor = await currentActor(transaction, user.id);
          const [row] = await transaction
            .select()
            .from(inventoryImports)
            .where(
              and(
                eq(inventoryImports.id, importId),
                eq(inventoryImports.profile, kind),
                actor.allActors ? undefined : eq(inventoryImports.actorId, user.id),
              ),
            )
            .limit(1)
            .for('update');
          if (!row)
            throw new AppError(404, 'INVENTORY_IMPORT_NOT_FOUND', 'This import was not found.');
          if (['COMPLETED', 'CANCELLED'].includes(row.state))
            throw new AppError(
              409,
              'INVENTORY_IMPORT_FINISHED',
              'This import has already finished.',
            );
          if (action === 'resume') {
            await currentActor(transaction, row.actorId);
            if (!options.syncProducts) return unavailable('Product synchronization adapter');
            const pending = await transaction
              .select({ command: inventoryImportRows.command })
              .from(inventoryImportRows)
              .where(
                and(
                  eq(inventoryImportRows.importId, importId),
                  eq(inventoryImportRows.state, 'PENDING'),
                ),
              )
              .limit(5000);
            if (
              pending.some(
                (value) => value.command !== null && needsStock(commandSchema.parse(value.command)),
              ) &&
              !stockReady
            )
              return unavailable('Verified inventory stock procedure');
          } else
            await transaction
              .update(inventoryImportRows)
              .set({
                state: 'CANCELLED',
                message: 'Import cancelled before this row was processed.',
              })
              .where(
                and(
                  eq(inventoryImportRows.importId, importId),
                  eq(inventoryImportRows.state, 'PENDING'),
                ),
              );
          if (action === 'cancel')
            await profile?.finalize?.(transaction, {
              importId: row.id,
              actorId: row.actorId,
              requestId: row.requestId,
              processedRows: row.processedRows,
            });
          await transaction
            .update(inventoryImports)
            .set({
              state: action === 'resume' ? 'QUEUED' : 'CANCELLED',
              errorCode: null,
              updatedAt: utcMediaTimestamp(),
            })
            .where(eq(inventoryImports.id, importId));
          return {
            status: 'success',
            message: action === 'resume' ? 'Import queued.' : 'Pending import rows cancelled.',
          };
        }),
      );
    },
    async dispatchNext(): Promise<ImportDispatchResult | null> {
      if (!options.syncProducts) return null;
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          const [current] = await transaction
            .select()
            .from(inventoryImports)
            .where(
              and(
                eq(inventoryImports.profile, kind),
                inArray(inventoryImports.state, ['QUEUED', 'RUNNING']),
              ),
            )
            .orderBy(asc(inventoryImports.sequence))
            .limit(1)
            .for('update', { skipLocked: true });
          if (!current) return null;
          const [row] = await transaction
            .select()
            .from(inventoryImportRows)
            .where(
              and(
                eq(inventoryImportRows.importId, current.id),
                eq(inventoryImportRows.state, 'PENDING'),
              ),
            )
            .orderBy(asc(inventoryImportRows.rowNumber))
            .limit(1)
            .for('update');
          const parsed = commandSchema.safeParse(row?.command);
          const result = {
            ...(profile ? { profile: profile.kind } : {}),
            importId: current.id,
            actorId: current.actorId,
            requestId: current.requestId,
            rowNumber: row?.rowNumber || null,
            storeId: parsed.success ? parsed.data.storeId : null,
          };
          if (!row) {
            await profile?.finalize?.(transaction, {
              importId: current.id,
              actorId: current.actorId,
              requestId: current.requestId,
              processedRows: current.processedRows,
            });
            await transaction
              .update(inventoryImports)
              .set({ state: 'COMPLETED', updatedAt: utcMediaTimestamp() })
              .where(eq(inventoryImports.id, current.id));
            return { ...result, status: 'completed' };
          }
          let failed: AppError | undefined;
          try {
            await transaction.transaction(async (savepoint) => {
              if (profile) {
                await profile.apply(
                  savepoint,
                  {
                    actorId: current.actorId,
                    requestId: current.requestId,
                    importId: current.id,
                    rowNumber: row.rowNumber,
                  },
                  commandSchema.parse(row.command),
                );
                return;
              }
              const command = stockImportCommand.parse(row.command);
              await apply(
                savepoint,
                current.actorId,
                current.requestId,
                current.id,
                row.rowNumber,
                command,
              );
            });
          } catch (error) {
            const message = error instanceof AppError ? failures[error.code] : undefined;
            if (!(error instanceof AppError) || error.status >= 500 || !message) {
              const errorCode =
                error instanceof AppError &&
                (blockedCodes.has(error.code) || profile?.isBlockedCode(error.code))
                  ? error.code
                  : 'INVENTORY_IMPORT_STORAGE_UNAVAILABLE';
              await transaction
                .update(inventoryImports)
                .set({ state: 'BLOCKED', errorCode, updatedAt: utcMediaTimestamp() })
                .where(eq(inventoryImports.id, current.id));
              await profile?.finalize?.(transaction, {
                importId: current.id,
                actorId: current.actorId,
                requestId: current.requestId,
                processedRows: current.processedRows,
              });
              return { ...result, status: 'blocked', errorCode };
            }
            failed = new AppError(error.status, error.code, message);
          }
          await transaction
            .update(inventoryImportRows)
            .set({
              state: failed ? 'FAILED' : 'SUCCEEDED',
              errorCode: failed?.code || null,
              message: failed?.message || profile?.successMessage || 'Product stock row processed.',
            })
            .where(
              and(
                eq(inventoryImportRows.importId, current.id),
                eq(inventoryImportRows.rowNumber, row.rowNumber),
              ),
            );
          const processedRows = current.processedRows + 1;
          if (processedRows === current.totalRows)
            await profile?.finalize?.(transaction, {
              importId: current.id,
              actorId: current.actorId,
              requestId: current.requestId,
              processedRows,
            });
          await transaction
            .update(inventoryImports)
            .set({
              state: processedRows === current.totalRows ? 'COMPLETED' : 'RUNNING',
              processedRows,
              successfulRows: current.successfulRows + (failed ? 0 : 1),
              failedRows: current.failedRows + (failed ? 1 : 0),
              errorCode: null,
              updatedAt: utcMediaTimestamp(),
            })
            .where(eq(inventoryImports.id, current.id));
          return {
            ...result,
            status: failed ? 'row-failed' : 'row-succeeded',
            ...(failed ? { errorCode: failed.code } : {}),
          };
        }),
      );
    },
  };
}
