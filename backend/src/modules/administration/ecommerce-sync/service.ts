import { and, asc, count, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { Product, ProductStore, Store } from '../../../db/legacy-schema.js';
import { retryTransaction } from '../../../db/retry.js';
import { configuredSystemStockProjection } from '../../../db/stock-projection/options.js';
import type { Principal } from '../../../domain/access.js';
import { requireRole, requireStore } from '../../../domain/access.js';
import { AppError, unavailable } from '../../../domain/errors.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { assertCurrentStoreAccess } from '../authorization.js';
import type { AdministrationTransaction } from '../checkins.js';
import { lockAdministrationRegistry } from '../locks.js';
import { utcMediaTimestamp } from '../media-domain.js';
import {
  ecommerceInput,
  settingVersion,
  settingsEffectSchema,
  type SettingsMutationResult,
} from '../settings-domain.js';
import { settingsEffects, settingsMutations } from '../settings-schema.js';
import type { StockProcedure } from '../stock-procedure.js';
import {
  fullSyncHash,
  fullSyncResult,
  type FullSyncAdapter,
  type FullSyncCommand,
  type FullSyncResult,
} from './domain.js';
import { createEcommerceFullSyncAdapter } from './http.js';
import {
  readEcommerceSynchronizationOptions,
  type EcommerceSynchronizationOptions,
} from './options.js';
import { ecommerceSyncCommands as commands, ecommerceSyncRows as rows } from './schema.js';
type Command = typeof commands.$inferSelect;
const blocked = () =>
  new AppError(
    503,
    'ECOMMERCE_SYNC_RECONCILIATION_REQUIRED',
    'Ecommerce synchronization requires reconciliation before continuing.',
  );
const notFound = () =>
  new AppError(404, 'ECOMMERCE_SYNC_NOT_FOUND', 'This ecommerce synchronization was not found.');
export function ecommerceInventorySynchronization(
  config: Config,
  db: Databases,
  options: EcommerceSynchronizationOptions = readEcommerceSynchronizationOptions(),
  injected: { projection?: StockProcedure; fullSync?: FullSyncAdapter } = {},
) {
  const projection = injected.projection || configuredSystemStockProjection(config),
    fullSync = injected.fullSync || createEcommerceFullSyncAdapter(options);
  const ready = !config.DEMO_MODE && !!projection && !!fullSync;
  async function effect(tx: AdministrationTransaction, id: string, storeId: string, lock = false) {
    const query = tx.select().from(settingsEffects).where(eq(settingsEffects.id, id)).limit(1),
      [found] = lock ? await query.for('update') : await query;
    const parsed = settingsEffectSchema.safeParse(found?.payload);
    if (
      !found ||
      found.kind !== 'ecommerce.inventory.sync' ||
      !parsed.success ||
      parsed.data.kind !== 'ecommerce.inventory.sync' ||
      parsed.data.storeId !== storeId
    )
      throw notFound();
    return { row: found, payload: parsed.data };
  }
  async function currentScope(tx: AdministrationTransaction, user: Principal, storeId: string) {
    requireRole(user, [1]);
    requireStore(user, storeId);
    await assertCurrentStoreAccess(tx, user.id, storeId, [1]);
  }
  async function currentJob(id: string, storeId: string) {
    return retryTransaction(() =>
      db.get('writer').transaction(async (tx) => {
        const source = await effect(tx, id, storeId),
          [existing] = await tx
            .select()
            .from(commands)
            .where(eq(commands.id, id))
            .limit(1)
            .for('update');
        if (existing) {
          if (
            String(existing.storeId) !== storeId ||
            existing.actorId !== source.payload.actorId ||
            existing.requestId !== source.payload.requestId
          )
            throw blocked();
          if (existing.state !== 'PREPARING') return existing;
          const [staged] = await tx
            .select({ value: count() })
            .from(rows)
            .where(eq(rows.syncId, id));
          if (existing.processedRows !== 0 || staged?.value !== 0) throw blocked();
        }
        const [store] = await tx
          .select()
          .from(Store)
          .where(
            and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, true), eq(Store.type, 'STORE')),
          )
          .limit(1)
          .for('update');
        if (!store)
          throw new AppError(404, 'STORE_NOT_FOUND', 'An active ecommerce store was not found.');
        if (store.ecom_threshold === null)
          throw new AppError(
            409,
            'ECOMMERCE_THRESHOLD_MISSING',
            'Configure the store ecommerce threshold before synchronization.',
          );
        const selected = and(
          eq(ProductStore.store, store.id),
          gt(ProductStore.stock, store.ecom_threshold),
        );
        const [total] = await tx
          .select({ value: sql<string>`CAST(COUNT(*) AS CHAR)` })
          .from(ProductStore)
          .where(selected);
        const totalRows = BigInt(z.string().regex(/^\d+$/).parse(total?.value)),
          wide = totalRows > BigInt(options.ECOMMERCE_SYNC_MAX_PRODUCTS),
          now = utcMediaTimestamp();
        const checkpoint: typeof commands.$inferInsert = {
          id,
          storeId: store.id,
          actorId: source.payload.actorId,
          requestId: source.payload.requestId,
          policyHash: settingVersion([store.ecom_threshold, store.ecom_delivery]),
          threshold: store.ecom_threshold,
          active: store.ecom_delivery,
          state: wide ? 'BLOCKED' : totalRows === 0n ? 'FULL_SYNC' : 'PROJECTING',
          fullState: 'READY',
          selectedRows: wide ? 0 : Number(totalRows),
          processedRows: 0,
          skippedRows: 0,
          errorCode: wide ? 'ECOMMERCE_SYNC_SCOPE_TOO_WIDE' : null,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        };
        await tx.insert(commands).values(checkpoint).onDuplicateKeyUpdate({ set: checkpoint });
        if (!wide && totalRows > 0n) {
          // Server-side bounded snapshot; do not materialize every selected SKU in JS.
          await tx.insert(rows).select(
            tx
              .select({
                syncId: sql<string>`${id}`.as('sync_id'),
                associationId: ProductStore.id,
                productId: ProductStore.product,
                selectedStock: ProductStore.stock,
                currentStock: sql<number | null>`NULL`.as('current_stock'),
                state: sql<'PENDING'>`'PENDING'`.as('state'),
                updatedAt: sql<string>`${now}`.as('updated_at'),
              })
              .from(ProductStore)
              .where(selected)
              .orderBy(asc(ProductStore.id))
              .limit(options.ECOMMERCE_SYNC_MAX_PRODUCTS + 1),
          );
          const [actual] = await tx
            .select({ value: count() })
            .from(rows)
            .where(eq(rows.syncId, id));
          if (actual?.value !== Number(totalRows))
            throw new AppError(
              503,
              'ECOMMERCE_SYNC_SNAPSHOT_CHANGED',
              'The inventory selection changed; retry the snapshot.',
            );
        }
        const [created] = await tx.select().from(commands).where(eq(commands.id, id)).limit(1);
        if (!created) throw blocked();
        return created;
      }),
    );
  }
  async function markBlocked(id: string, error: unknown) {
    const code =
      error instanceof AppError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : 'ECOMMERCE_SYNC_STORAGE_UNAVAILABLE';
    await db
      .get('writer')
      .update(commands)
      .set({ state: 'BLOCKED', errorCode: code, updatedAt: utcMediaTimestamp() })
      .where(eq(commands.id, id));
  }
  async function projectOne(id: string) {
    return retryTransaction(() =>
      db.get('writer').transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(commands)
          .where(eq(commands.id, id))
          .limit(1)
          .for('update');
        if (!job || job.state !== 'PROJECTING') return;
        const [row] = await tx
          .select()
          .from(rows)
          .where(and(eq(rows.syncId, id), eq(rows.state, 'PENDING')))
          .orderBy(asc(rows.productId), asc(rows.associationId))
          .limit(1)
          .for('update');
        if (!row)
          throw new AppError(
            503,
            'ECOMMERCE_SYNC_RECORDS_INCOMPLETE',
            'Inventory checkpoint records are incomplete.',
          );
        // Cooperating stock writers lock the Product before reading/changing its quantity.
        const [product] = await tx
          .select({ id: Product.id })
          .from(Product)
          .where(eq(Product.id, row.productId))
          .limit(1)
          .for('update');
        if (!product)
          throw new AppError(
            409,
            'ECOMMERCE_SYNC_PRODUCT_MISSING',
            'A selected product needs reconciliation.',
          );
        const [store] = await tx
          .select({ id: Store.id })
          .from(Store)
          .where(and(eq(Store.id, job.storeId), eq(Store.is_active, true), eq(Store.type, 'STORE')))
          .limit(1)
          .for('share');
        if (!store)
          throw new AppError(404, 'STORE_NOT_FOUND', 'An active ecommerce store was not found.');
        const associations = await tx
          .select({ id: ProductStore.id, stock: ProductStore.stock })
          .from(ProductStore)
          .where(and(eq(ProductStore.store, job.storeId), eq(ProductStore.product, row.productId)))
          .limit(2)
          .for('update');
        if (associations.length > 1)
          throw new AppError(
            409,
            'ECOMMERCE_SYNC_ASSOCIATION_AMBIGUOUS',
            'A selected store association needs reconciliation.',
          );
        const current = associations[0],
          now = utcMediaTimestamp();
        if (current) {
          if (!projection) return unavailable('Selected atomic system stock projection');
          await projection(tx, {
            storeId: String(job.storeId),
            productId: String(row.productId),
            stock: current.stock,
            operatorId: '0',
            comment: 'Updated by System',
          });
        }
        await tx
          .update(rows)
          .set({
            currentStock: current?.stock ?? null,
            state: current ? 'PROCESSED' : 'SKIPPED',
            updatedAt: now,
          })
          .where(and(eq(rows.syncId, id), eq(rows.associationId, row.associationId)));
        const processedRows = job.processedRows + 1;
        if (processedRows > job.selectedRows) throw blocked();
        await tx
          .update(commands)
          .set({
            processedRows,
            skippedRows: job.skippedRows + (current ? 0 : 1),
            state: processedRows === job.selectedRows ? 'FULL_SYNC' : 'PROJECTING',
            updatedAt: now,
          })
          .where(eq(commands.id, id));
        return true;
      }),
    );
  }
  const remoteCommand = (job: Command): FullSyncCommand => ({
    operationId: job.id,
    storeId: String(job.storeId),
    actorId: job.actorId,
    requestId: job.requestId,
  });
  async function recordFull(id: string, result: FullSyncResult) {
    result = fullSyncResult.parse(result);
    await db.get('writer').transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(commands)
        .where(eq(commands.id, id))
        .limit(1)
        .for('update');
      if (!job || job.state === 'COMPLETED') return;
      if (result.operationId !== job.id || result.requestHash !== fullSyncHash(remoteCommand(job)))
        throw blocked();
      await tx
        .update(commands)
        .set({
          state:
            result.status === 'succeeded'
              ? 'COMPLETED'
              : result.status === 'failed'
                ? 'BLOCKED'
                : 'FULL_SYNC',
          fullState:
            result.status === 'succeeded'
              ? 'SUCCEEDED'
              : result.status === 'uncertain'
                ? 'UNCERTAIN'
                : 'PENDING',
          fullResult: result,
          errorCode:
            result.status === 'failed'
              ? 'ECOMMERCE_FULL_SYNC_FAILED'
              : result.status === 'uncertain'
                ? 'ECOMMERCE_FULL_SYNC_UNCERTAIN'
                : null,
          updatedAt: utcMediaTimestamp(),
        })
        .where(eq(commands.id, id));
    });
  }
  async function advanceFull(job: Command, signal?: AbortSignal) {
    if (!fullSync) return unavailable('Approved full ecommerce synchronization');
    const command = remoteCommand(job);
    try {
      let result = job.fullState === 'READY' ? null : await fullSync.read(command, signal);
      if (!result) {
        await db
          .get('writer')
          .update(commands)
          .set({ fullState: 'POSTING', updatedAt: utcMediaTimestamp() })
          .where(and(eq(commands.id, job.id), eq(commands.state, 'FULL_SYNC')));
        result = await fullSync.submit(command, signal);
      }
      await recordFull(job.id, result);
    } catch {
      await db
        .get('writer')
        .update(commands)
        .set({
          fullState: 'UNCERTAIN',
          errorCode: 'ECOMMERCE_FULL_SYNC_UNAVAILABLE',
          updatedAt: utcMediaTimestamp(),
        })
        .where(and(eq(commands.id, job.id), eq(commands.state, 'FULL_SYNC')));
    }
  }
  async function synchronizeEcommerce(
    id: string,
    storeId: string,
    signal?: AbortSignal,
  ): Promise<void | 'pending'> {
    if (!ready) return unavailable('Verified ecommerce inventory synchronization');
    let job = await currentJob(id, storeId);
    if (job.state === 'BLOCKED') throw blocked();
    if (job.state === 'COMPLETED') return;
    if (job.state === 'PROJECTING')
      try {
        for (let index = 0; index < options.ECOMMERCE_SYNC_BATCH_SIZE; index++) {
          signal?.throwIfAborted();
          if (!(await projectOne(id))) break;
        }
      } catch (error) {
        if (signal?.aborted) return 'pending';
        await markBlocked(id, error);
        throw blocked();
      }
    job = await currentJob(id, storeId);
    if (job.state === 'FULL_SYNC') {
      signal?.throwIfAborted();
      await advanceFull(job, signal);
      job = await currentJob(id, storeId);
    }
    if (job.state === 'BLOCKED') throw blocked();
    return job.state === 'COMPLETED' ? undefined : 'pending';
  }
  const view = (source: Awaited<ReturnType<typeof effect>>, job?: Command) => ({
    id: source.row.id,
    storeId: source.payload.storeId,
    state: job?.state || (source.row.attempts >= 10 ? 'BLOCKED' : 'QUEUED'),
    fullState: job?.fullState || 'READY',
    selectedRows: job?.selectedRows ?? 0,
    processedRows: job?.processedRows ?? 0,
    skippedRows: job?.skippedRows ?? 0,
    errorCode:
      job?.errorCode ||
      (source.row.attempts >= 10
        ? 'ECOMMERCE_SYNC_DELIVERY_BLOCKED'
        : !job && source.row.attempts > 0
          ? 'ECOMMERCE_SYNC_INITIALIZATION_FAILED'
          : null),
    attempts: source.row.attempts,
    completed: job?.state === 'COMPLETED',
    fullProof: job?.fullResult?.status === 'succeeded' ? job.fullResult.proof : null,
  });
  return {
    ready,
    synchronizeEcommerce,
    async status(user: Principal, storeId: string, syncId: string) {
      z.uuid().parse(syncId);
      return db.get('writer').transaction(async (tx) => {
        await currentScope(tx, user, storeId);
        const source = await effect(tx, syncId, storeId),
          [job] = await tx.select().from(commands).where(eq(commands.id, syncId)).limit(1);
        const [pending] =
          job?.state === 'BLOCKED'
            ? await tx
                .select({ associationId: rows.associationId, productId: rows.productId })
                .from(rows)
                .where(and(eq(rows.syncId, syncId), eq(rows.state, 'PENDING')))
                .orderBy(asc(rows.productId), asc(rows.associationId))
                .limit(1)
            : [];
        return {
          ...view(source, job),
          blockedRecord: pending
            ? { associationId: String(pending.associationId), productId: String(pending.productId) }
            : null,
        };
      });
    },
    async operation(user: Principal, storeId: string, operationId: string) {
      z.uuid().parse(operationId);
      return db.get('writer').transaction(async (tx) => {
        await currentScope(tx, user, storeId);
        const [row] = await tx
          .select()
          .from(settingsMutations)
          .where(eq(settingsMutations.id, operationId))
          .limit(1);
        if (!row || row.actorId !== user.id || row.result.storeId !== storeId)
          throw new AppError(
            404,
            'ECOMMERCE_OPERATION_NOT_FOUND',
            'The original ecommerce settings operation was not found.',
          );
        return row.result;
      });
    },
    async cancel(
      user: Principal,
      storeId: string,
      input: { operationId: string; original: z.infer<typeof ecommerceInput> },
    ) {
      const operationId = z.uuid().parse(input.operationId),
        original = ecommerceInput.parse(input.original);
      if (operationId === original.operationId)
        throw new AppError(
          409,
          'SETTINGS_OPERATION_REUSED',
          'Choose a separate cancellation operation.',
        );
      const originalHash = settingVersion({ storeId, input: original }),
        hash = settingVersion(['ecommerce-settings-cancellation', storeId, original]);
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await lockAdministrationRegistry(tx, 'settings');
          await currentScope(tx, user, storeId);
          const [previous] = await tx
            .select()
            .from(settingsMutations)
            .where(eq(settingsMutations.id, operationId))
            .limit(1);
          if (previous) {
            if (previous.actorId !== user.id || previous.hash !== hash)
              throw new AppError(
                409,
                'SETTINGS_OPERATION_REUSED',
                'Choose a new settings operation.',
              );
            return previous.result;
          }
          const [accepted] = await tx
            .select()
            .from(settingsMutations)
            .where(eq(settingsMutations.id, original.operationId))
            .limit(1);
          if (accepted && (accepted.actorId !== user.id || accepted.hash !== originalHash))
            throw new AppError(
              409,
              'SETTINGS_OPERATION_REUSED',
              'The original operation does not match.',
            );
          // The ordinary settings writer takes this same registry lock and checks this
          // receipt before its version check. A late PUT can only replay this fence.
          const fenced: SettingsMutationResult = accepted?.result || {
            status: 'success',
            message: 'The original settings request was cancelled before acceptance.',
            effectsQueued: false,
            storeId,
            operationId: original.operationId,
            actorId: user.id,
            cancelled: true,
            requestId: currentRequestTrace()?.requestId || null,
          };
          if (!accepted)
            await tx.insert(settingsMutations).values({
              id: original.operationId,
              actorId: user.id,
              hash: originalHash,
              result: fenced,
              createdAt: utcMediaTimestamp(),
            });
          const result: SettingsMutationResult = {
            ...fenced,
            operationId,
            originalOperationId: original.operationId,
            actorId: user.id,
            storeId,
            message: fenced.cancelled
              ? 'The original settings request was cancelled before acceptance.'
              : 'The original settings request was already accepted; its synchronization continues.',
          };
          await tx.insert(settingsMutations).values({
            id: operationId,
            actorId: user.id,
            hash,
            result,
            createdAt: utcMediaTimestamp(),
          });
          return result;
        }),
      );
    },
    async records(
      user: Principal,
      storeId: string,
      syncId: string,
      after: string | undefined,
      limit: number,
    ) {
      z.uuid().parse(syncId);
      const cursor =
        after === undefined
          ? undefined
          : z
              .string()
              .regex(/^[1-9]\d{0,19}$/)
              .parse(after);
      z.number().int().min(1).max(100).parse(limit);
      return db.get('writer').transaction(async (tx) => {
        await currentScope(tx, user, storeId);
        await effect(tx, syncId, storeId);
        const selected = await tx
          .select()
          .from(rows)
          .where(
            and(
              eq(rows.syncId, syncId),
              cursor ? gt(rows.associationId, BigInt(cursor)) : undefined,
            ),
          )
          .orderBy(asc(rows.associationId))
          .limit(limit + 1);
        const data = selected.slice(0, limit).map((row) => ({
          associationId: String(row.associationId),
          productId: String(row.productId),
          selectedStock: row.selectedStock,
          currentStock: row.currentStock,
          state: row.state,
        }));
        return { data, nextCursor: selected.length > limit ? data.at(-1)!.associationId : null };
      });
    },
    async retry(user: Principal, storeId: string, syncId: string, operationId: string) {
      z.uuid().parse(syncId);
      z.uuid().parse(operationId);
      const hash = settingVersion(['ecommerce-sync-retry', storeId, syncId]);
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await lockAdministrationRegistry(tx, 'settings');
          await currentScope(tx, user, storeId);
          const [activeStore] = await tx
            .select({ id: Store.id })
            .from(Store)
            .where(
              and(
                eq(Store.id, BigInt(storeId)),
                eq(Store.is_active, true),
                eq(Store.type, 'STORE'),
              ),
            )
            .limit(1)
            .for('share');
          if (!activeStore)
            throw new AppError(404, 'STORE_NOT_FOUND', 'An active ecommerce store was not found.');
          const [previous] = await tx
            .select()
            .from(settingsMutations)
            .where(eq(settingsMutations.id, operationId))
            .limit(1);
          if (previous) {
            if (previous.actorId !== user.id || previous.hash !== hash)
              throw new AppError(
                409,
                'SETTINGS_OPERATION_REUSED',
                'Choose a new settings operation.',
              );
            return previous.result;
          }
          const source = await effect(tx, syncId, storeId, true);
          const [job] = await tx
            .select()
            .from(commands)
            .where(eq(commands.id, syncId))
            .limit(1)
            .for('update');
          const completed = !!source.row.deliveredAt || job?.state === 'COMPLETED';
          if (job && !completed) {
            await tx
              .update(commands)
              .set({
                state:
                  job.errorCode === 'ECOMMERCE_SYNC_SCOPE_TOO_WIDE'
                    ? 'PREPARING'
                    : job.processedRows < job.selectedRows
                      ? 'PROJECTING'
                      : 'FULL_SYNC',
                fullState: job.fullState === 'READY' ? 'READY' : 'UNCERTAIN',
                errorCode: null,
                updatedAt: utcMediaTimestamp(),
              })
              .where(eq(commands.id, syncId));
          }
          if (!completed)
            await tx
              .update(settingsEffects)
              .set({ attempts: 0 })
              .where(eq(settingsEffects.id, syncId));
          const result: SettingsMutationResult = {
            status: 'success',
            message: completed
              ? 'Ecommerce synchronization already completed.'
              : 'Ecommerce synchronization queued for recovery.',
            effectsQueued: !completed,
            storeId,
            ecommerceSyncId: syncId,
            requestId: currentRequestTrace()?.requestId || null,
            operationId,
            actorId: user.id,
          };
          await tx.insert(settingsMutations).values({
            id: operationId,
            actorId: user.id,
            hash,
            result,
            createdAt: utcMediaTimestamp(),
          });
          return result;
        }),
      );
    },
  };
}
