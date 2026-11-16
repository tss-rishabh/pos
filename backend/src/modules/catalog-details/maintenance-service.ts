import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../db/pools.js';
import { Product } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import type { Principal } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import {
  assertCurrentMaintenanceOperator,
  assertMaintenancePrincipal,
} from './maintenance-authority.js';
import {
  commandMetadata,
  inventoryPullSelection,
  maintenanceHash,
  maintenancePayload,
  type InventoryPullInput,
  type MaintenanceKind,
  type MaintenancePayload,
  type CommandMetadata,
} from './maintenance-domain.js';
import { applyCatalogRepair, catalogRepairPlan } from './maintenance-repair.js';
import { lockBarcodeMutation } from '../administration/barcodes/locks.js';
import type { CatalogMaintenanceOptions } from './maintenance-options.js';
import { MaintenanceDeliveryError, type MaintenanceTransports } from './maintenance-transports.js';
import {
  catalogMaintenanceCommands as commands,
  catalogMaintenanceDeliveries as deliveries,
  catalogMaintenanceLocks as locks,
  catalogMaintenanceReconciliations as reconciliations,
} from './maintenance-schema.js';
type Command = typeof commands.$inferSelect;
const traceId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const hashValue = z.string().regex(/^[a-f0-9]{64}$/);
export interface CatalogMaintenanceResult {
  commandId: string;
  kind: MaintenanceKind;
  state: Command['state'];
  requestId: string;
  userId: string;
  errorCode: string | null;
}
export function catalogMaintenanceService(
  db: Databases,
  options: CatalogMaintenanceOptions,
  transports: MaintenanceTransports,
  clock = () => Temporal.Now.instant(),
) {
  const timestamp = (instant = clock()) =>
    instant
      .toZonedDateTimeISO('UTC')
      .toPlainDateTime()
      .toString({ smallestUnit: 'millisecond' })
      .replace('T', ' ');
  async function lock(transaction: AdministrationTransaction, id: string) {
    await transaction.insert(locks).values({ id }).onDuplicateKeyUpdate({ set: { id } });
    await transaction.select().from(locks).where(eq(locks.id, id)).for('update');
  }
  function transport(kind: MaintenancePayload['kind']) {
    return kind === 'inventory-pull' ? transports.inventory : transports.products;
  }
  function requireTransport(kind: MaintenancePayload['kind']) {
    const target = transport(kind);
    if (!target)
      return unavailable(
        kind === 'inventory-pull' ? 'Inventory pull service' : 'Product synchronization service',
      );
    if (!hashValue.safeParse(target.identity).success)
      throw new AppError(
        503,
        'CATALOG_DELIVERY_CONFIGURATION_INVALID',
        'Catalog maintenance delivery configuration is invalid.',
      );
    return target;
  }
  async function receipt(transaction: AdministrationTransaction, id: string) {
    const [command] = await transaction.select().from(commands).where(eq(commands.id, id)).limit(1);
    if (!command)
      throw new AppError(
        404,
        'CATALOG_COMMAND_NOT_FOUND',
        'Catalog maintenance command was not found.',
      );
    const parts = await transaction
      .select({
        id: deliveries.id,
        ordinal: deliveries.ordinal,
        state: deliveries.state,
        errorCode: deliveries.errorCode,
        updatedAt: deliveries.updatedAt,
        payload: deliveries.payload,
      })
      .from(deliveries)
      .where(eq(deliveries.commandId, id))
      .orderBy(asc(deliveries.ordinal));
    return {
      id: command.id,
      kind: command.kind,
      state: command.state,
      metadata: commandMetadata.parse(command.metadata),
      localApplied: command.localApplied,
      createdAt: command.createdAt,
      updatedAt: command.updatedAt,
      errorCode: command.errorCode,
      deliveries: parts.map(({ payload, ...part }) => ({
        ...part,
        productIds: maintenancePayload.parse(payload).productIds,
      })),
    };
  }
  async function prior(
    transaction: AdministrationTransaction,
    user: Principal,
    id: string,
    kind: MaintenanceKind,
    inputHash: string,
  ) {
    const [saved] = await transaction
      .select()
      .from(commands)
      .where(eq(commands.id, id))
      .limit(1)
      .for('update');
    if (
      saved &&
      (saved.ownerId !== user.id || saved.kind !== kind || saved.inputHash !== inputHash)
    )
      throw new AppError(
        409,
        'CATALOG_COMMAND_CONFLICT',
        'This command ID belongs to a different maintenance operation.',
      );
    return saved ? receipt(transaction, id) : null;
  }
  async function quota(transaction: AdministrationTransaction, userId: string) {
    const [count] = await transaction
      .select({ value: sql<string>`count(*)` })
      .from(commands)
      .where(
        and(
          eq(commands.ownerId, userId),
          inArray(commands.state, ['PENDING', 'RUNNING', 'UNCERTAIN']),
        ),
      );
    if (Number(count?.value || 0) >= options.CATALOG_MAINTENANCE_MAX_PENDING)
      throw new AppError(
        429,
        'CATALOG_MAINTENANCE_QUEUE_FULL',
        'Resolve pending maintenance commands before adding more.',
      );
  }
  async function insertCommand(
    transaction: AdministrationTransaction,
    user: Principal,
    id: string,
    kind: MaintenanceKind,
    inputHash: string,
    requestId: string,
    metadata: CommandMetadata,
    localApplied: boolean,
    payloads: MaintenancePayload[],
  ) {
    const now = timestamp();
    await transaction
      .insert(commands)
      .values({
        id,
        kind,
        ownerId: user.id,
        requestId,
        inputHash,
        state: 'PENDING',
        metadata,
        localApplied,
        createdAt: now,
        updatedAt: now,
        errorCode: null,
      });
    await transaction
      .insert(deliveries)
      .values(
        payloads.map((payload, ordinal) => ({
          id: randomUUID(),
          commandId: id,
          ordinal,
          targetIdentity: requireTransport(payload.kind).identity,
          payload,
          state: 'PENDING' as const,
          leaseUntil: null,
          leaseToken: null,
          updatedAt: now,
          errorCode: null,
          reconciliationId: null,
          reconciliationOutcome: null,
          reconciledBy: null,
        })),
      );
    return receipt(transaction, id);
  }
  async function refreshState(transaction: AdministrationTransaction, id: string) {
    const parts = await transaction
      .select({ state: deliveries.state, errorCode: deliveries.errorCode })
      .from(deliveries)
      .where(eq(deliveries.commandId, id))
      .orderBy(asc(deliveries.ordinal));
    const state: Command['state'] = !parts.length
      ? 'FAILED'
      : parts.some((part) => part.state === 'UNCERTAIN')
        ? 'UNCERTAIN'
        : parts.some((part) => part.state === 'FAILED')
          ? 'FAILED'
          : parts.every((part) => part.state === 'DELIVERED')
            ? 'SUCCEEDED'
            : parts.some((part) => part.state === 'SENDING' || part.state === 'DELIVERED')
              ? 'RUNNING'
              : 'PENDING';
    const errorCode =
      state === 'FAILED' && !parts.length
        ? 'CATALOG_DELIVERY_MISSING'
        : parts.find((part) => part.state === 'UNCERTAIN' || part.state === 'FAILED')?.errorCode ||
          null;
    await transaction
      .update(commands)
      .set({ state, errorCode, updatedAt: timestamp() })
      .where(eq(commands.id, id));
    return { state, errorCode };
  }
  function result(
    command: Command,
    state: Command['state'],
    errorCode: string | null,
  ): CatalogMaintenanceResult {
    return {
      commandId: command.id,
      kind: command.kind,
      state,
      errorCode,
      requestId: command.requestId,
      userId: command.ownerId,
    };
  }
  return {
    capabilities(user: Principal) {
      assertMaintenancePrincipal(user);
      return {
        inventoryPullEnabled: !!transports.inventory,
        troubleshootingEnabled: !!transports.products,
      };
    },
    async active(user: Principal) {
      assertMaintenancePrincipal(user);
      await db
        .get('writer')
        .transaction((transaction) => assertCurrentMaintenanceOperator(transaction, user.id));
      const rows = await db
        .get('primary')
        .select({
          id: commands.id,
          kind: commands.kind,
          state: commands.state,
          ownerId: commands.ownerId,
          metadata: commands.metadata,
          localApplied: commands.localApplied,
          createdAt: commands.createdAt,
          updatedAt: commands.updatedAt,
          errorCode: commands.errorCode,
        })
        .from(commands)
        .where(inArray(commands.state, ['PENDING', 'RUNNING', 'UNCERTAIN']))
        .orderBy(asc(commands.createdAt), asc(commands.id))
        .limit(100);
      return {
        reader: 'primary' as const,
        data: rows.map((row) => ({ ...row, metadata: commandMetadata.parse(row.metadata) })),
      };
    },
    async preview(user: Principal, productId: string) {
      assertMaintenancePrincipal(user);
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await assertCurrentMaintenanceOperator(transaction, user.id);
          return catalogRepairPlan(transaction, productId, 'share');
        }),
      );
    },
    async enqueuePull(
      user: Principal,
      commandId: string,
      value: InventoryPullInput,
      requestId: string,
    ) {
      assertMaintenancePrincipal(user);
      z.uuid().parse(commandId);
      traceId.parse(requestId);
      const selection = inventoryPullSelection(value),
        inputHash = maintenanceHash(selection);
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await assertCurrentMaintenanceOperator(transaction, user.id);
          await lock(transaction, 'operator:' + user.id);
          const saved = await prior(transaction, user, commandId, 'inventory-pull', inputHash);
          if (saved) return saved;
          requireTransport('inventory-pull');
          await quota(transaction, user.id);
          const selected = await transaction
            .select({ id: Product.id })
            .from(Product)
            .where(and(inArray(Product.id, selection.ids.map(BigInt)), eq(Product.prod_type, 1n)))
            .orderBy(asc(Product.id))
            .for('share');
          if (!selected.length)
            throw new AppError(
              422,
              'INVENTORY_PULL_NO_SKUS',
              'No simple-product SKUs were found for this inventory pull.',
            );
          return insertCommand(
            transaction,
            user,
            commandId,
            'inventory-pull',
            inputHash,
            requestId,
            commandMetadata.parse({
              requestedCount: selection.requestedCount,
              uniqueRequestedCount: selection.uniqueRequestedCount,
              matchedCount: selected.length,
              mode: selection.mode,
            }),
            false,
            [
              {
                kind: 'inventory-pull',
                mode: selection.mode,
                productIds: selected.map((row) => String(row.id)),
              },
            ],
          );
        }),
      );
    },
    async troubleshoot(
      user: Principal,
      commandId: string,
      productId: string,
      expectedPlanHash: string,
      requestId: string,
    ) {
      assertMaintenancePrincipal(user);
      z.uuid().parse(commandId);
      hashValue.parse(expectedPlanHash);
      traceId.parse(requestId);
      const inputHash = maintenanceHash({ productId, expectedPlanHash });
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await assertCurrentMaintenanceOperator(transaction, user.id);
          await lock(transaction, 'operator:' + user.id);
          const saved = await prior(
            transaction,
            user,
            commandId,
            'product-troubleshoot',
            inputHash,
          );
          if (saved) return saved;
          requireTransport('product-sync');
          await quota(transaction, user.id);
          await lockBarcodeMutation(transaction);
          const plan = await catalogRepairPlan(transaction, productId, 'update');
          if (plan.planHash !== expectedPlanHash)
            throw new AppError(
              409,
              'CATALOG_REPAIR_PLAN_CHANGED',
              'The product changed after inspection. Inspect it again before applying repairs.',
            );
          await applyCatalogRepair(transaction, plan);
          const payloads: MaintenancePayload[] = [
              { kind: 'product-sync', productIds: [productId], troubleshoot: true },
            ],
            otherIds = plan.syncProductIds.filter((id) => id !== productId);
          for (let index = 0; index < otherIds.length; index += 1000)
            payloads.push({
              kind: 'product-sync',
              productIds: otherIds.slice(index, index + 1000),
              troubleshoot: false,
            });
          return insertCommand(
            transaction,
            user,
            commandId,
            'product-troubleshoot',
            inputHash,
            requestId,
            commandMetadata.parse({
              requestedCount: 1,
              uniqueRequestedCount: 1,
              matchedCount: 1,
              productId,
              parentRowsChanged: plan.parentVisibility.length,
              imageReset: plan.imageReset,
              barcodeRowsChanged: plan.barcodeChanges.length,
            }),
            true,
            payloads,
          );
        }),
      );
    },
    async get(user: Principal, id: string) {
      assertMaintenancePrincipal(user);
      z.uuid().parse(id);
      return db.get('writer').transaction(async (transaction) => {
        await assertCurrentMaintenanceOperator(transaction, user.id);
        return receipt(transaction, id);
      });
    },
    async reconcile(
      user: Principal,
      id: string,
      deliveryId: string,
      reconciliationId: string,
      outcome: 'delivered' | 'not-delivered',
      requestId: string,
    ) {
      assertMaintenancePrincipal(user);
      [id, deliveryId, reconciliationId].forEach((value) => z.uuid().parse(value));
      z.enum(['delivered', 'not-delivered']).parse(outcome);
      traceId.parse(requestId);
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await assertCurrentMaintenanceOperator(transaction, user.id);
          await lock(transaction, 'workers');
          const [old] = await transaction
            .select()
            .from(reconciliations)
            .where(eq(reconciliations.id, reconciliationId))
            .limit(1)
            .for('update');
          if (old) {
            if (
              old.commandId !== id ||
              old.deliveryId !== deliveryId ||
              old.actorId !== user.id ||
              old.outcome !== outcome
            )
              throw new AppError(
                409,
                'CATALOG_RECONCILIATION_CONFLICT',
                'This reconciliation ID belongs to another decision.',
              );
            return receipt(transaction, id);
          }
          const [command] = await transaction
            .select()
            .from(commands)
            .where(eq(commands.id, id))
            .limit(1)
            .for('update');
          const [delivery] = await transaction
            .select()
            .from(deliveries)
            .where(and(eq(deliveries.id, deliveryId), eq(deliveries.commandId, id)))
            .limit(1)
            .for('update');
          if (!command || !delivery)
            throw new AppError(
              404,
              'CATALOG_COMMAND_NOT_FOUND',
              'Catalog maintenance command was not found.',
            );
          if (delivery.state !== 'UNCERTAIN')
            throw new AppError(
              409,
              'CATALOG_RECONCILIATION_NOT_REQUIRED',
              'This delivery does not have an uncertain outcome.',
            );
          const now = timestamp();
          await transaction
            .insert(reconciliations)
            .values({
              id: reconciliationId,
              commandId: id,
              deliveryId,
              outcome,
              actorId: user.id,
              requestId,
              createdAt: now,
            });
          await transaction
            .update(deliveries)
            .set({
              state: outcome === 'delivered' ? 'DELIVERED' : 'PENDING',
              leaseUntil: null,
              leaseToken: null,
              updatedAt: now,
              errorCode: null,
              reconciliationId,
              reconciliationOutcome: outcome,
              reconciledBy: user.id,
            })
            .where(eq(deliveries.id, deliveryId));
          await refreshState(transaction, id);
          return receipt(transaction, id);
        }),
      );
    },
    async runOne(): Promise<CatalogMaintenanceResult | null> {
      const claim = await retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await lock(transaction, 'workers');
          const now = timestamp();
          const [expired] = await transaction
            .select()
            .from(deliveries)
            .where(and(eq(deliveries.state, 'SENDING'), lte(deliveries.leaseUntil, now)))
            .orderBy(asc(deliveries.leaseUntil))
            .limit(1)
            .for('update', { skipLocked: true });
          if (expired) {
            const [command] = await transaction
              .select()
              .from(commands)
              .where(eq(commands.id, expired.commandId))
              .limit(1)
              .for('update');
            await transaction
              .update(deliveries)
              .set({
                state: 'UNCERTAIN',
                leaseUntil: null,
                leaseToken: null,
                errorCode: 'CATALOG_DELIVERY_OUTCOME_UNKNOWN',
                updatedAt: now,
              })
              .where(eq(deliveries.id, expired.id));
            if (!command) return null;
            const state = await refreshState(transaction, command.id);
            return {
              type: 'processed' as const,
              processed: result(command, state.state, state.errorCode),
            };
          }
          const available: MaintenanceKind[] = [
            ...(transports.inventory ? ['inventory-pull' as const] : []),
            ...(transports.products ? ['product-troubleshoot' as const] : []),
          ];
          if (!available.length) return null;
          const [active] = await transaction
            .select({ value: sql<string>`count(*)` })
            .from(deliveries)
            .where(eq(deliveries.state, 'SENDING'));
          if (Number(active?.value || 0) >= 2) return null;
          const [command] = await transaction
            .select()
            .from(commands)
            .where(
              and(
                inArray(commands.state, ['PENDING', 'RUNNING']),
                inArray(commands.kind, available),
                sql`not exists(select 1 from ${deliveries} sending where sending.command_id=${commands.id} and sending.state in ('SENDING','UNCERTAIN'))`,
              ),
            )
            .orderBy(asc(commands.createdAt), asc(commands.id))
            .limit(1)
            .for('update', { skipLocked: true });
          if (!command) return null;
          const [delivery] = await transaction
            .select()
            .from(deliveries)
            .where(and(eq(deliveries.commandId, command.id), eq(deliveries.state, 'PENDING')))
            .orderBy(asc(deliveries.ordinal))
            .limit(1)
            .for('update');
          if (!delivery) {
            const state = await refreshState(transaction, command.id);
            return {
              type: 'processed' as const,
              processed: result(command, state.state, state.errorCode),
            };
          }
          const parsedPayload = maintenancePayload.safeParse(delivery.payload);
          if (!parsedPayload.success) {
            await transaction
              .update(deliveries)
              .set({ state: 'FAILED', updatedAt: now, errorCode: 'CATALOG_DELIVERY_INVALID' })
              .where(eq(deliveries.id, delivery.id));
            const updated = await refreshState(transaction, command.id);
            return {
              type: 'processed' as const,
              processed: result(command, updated.state, updated.errorCode),
            };
          }
          const payload = parsedPayload.data,
            target = transport(payload.kind);
          let failure: string | null = null;
          if (
            (command.kind === 'inventory-pull' && payload.kind !== 'inventory-pull') ||
            (command.kind === 'product-troubleshoot' && payload.kind !== 'product-sync')
          )
            failure = 'CATALOG_DELIVERY_KIND_INVALID';
          if (!target || target.identity !== delivery.targetIdentity)
            failure = 'CATALOG_DELIVERY_TARGET_CHANGED';
          if (command.kind === 'product-troubleshoot' && !command.localApplied)
            failure = 'CATALOG_REPAIR_PROOF_MISSING';
          if (command.kind === 'inventory-pull') {
            try {
              await assertCurrentMaintenanceOperator(transaction, command.ownerId);
            } catch (error) {
              if (error instanceof AppError && error.status === 403)
                failure = 'CATALOG_OPERATOR_REVOKED';
              else throw error;
            }
            if (!failure) {
              const selected = await transaction
                .select({ id: Product.id })
                .from(Product)
                .where(
                  and(
                    inArray(Product.id, payload.productIds.map(BigInt)),
                    eq(Product.prod_type, 1n),
                  ),
                )
                .for('share');
              if (selected.length !== payload.productIds.length)
                failure = 'INVENTORY_PULL_SELECTION_CHANGED';
            }
          }
          const [earlier] = await transaction
            .select({ value: sql<string>`count(*)` })
            .from(deliveries)
            .where(
              and(
                eq(deliveries.commandId, command.id),
                sql`${deliveries.ordinal}<${delivery.ordinal}`,
                ne(deliveries.state, 'DELIVERED'),
              ),
            );
          if (Number(earlier?.value || 0) > 0) failure = 'CATALOG_DELIVERY_SEQUENCE_INVALID';
          if (failure) {
            await transaction
              .update(deliveries)
              .set({ state: 'FAILED', updatedAt: now, errorCode: failure })
              .where(eq(deliveries.id, delivery.id));
            const state = await refreshState(transaction, command.id);
            return {
              type: 'processed' as const,
              processed: result(command, state.state, state.errorCode),
            };
          }
          const leaseToken = randomUUID();
          await transaction
            .update(deliveries)
            .set({
              state: 'SENDING',
              leaseToken,
              leaseUntil: timestamp(clock().add({ seconds: 120 })),
              updatedAt: now,
              errorCode: null,
            })
            .where(eq(deliveries.id, delivery.id));
          await transaction
            .update(commands)
            .set({ state: 'RUNNING', updatedAt: now })
            .where(eq(commands.id, command.id));
          return { type: 'send' as const, command, delivery, payload, target: target!, leaseToken };
        }),
      );
      if (!claim) return null;
      if (claim.type === 'processed') return claim.processed;
      let state: 'DELIVERED' | 'FAILED' | 'UNCERTAIN' = 'DELIVERED',
        errorCode: string | null = null;
      try {
        await claim.target.send(claim.payload, {
          deliveryId: claim.delivery.id,
          requestId: claim.command.requestId,
          userId: claim.command.ownerId,
        });
      } catch (error) {
        state =
          error instanceof MaintenanceDeliveryError && error.outcome === 'failed'
            ? 'FAILED'
            : 'UNCERTAIN';
        errorCode =
          error instanceof MaintenanceDeliveryError
            ? error.code
            : 'CATALOG_DELIVERY_OUTCOME_UNKNOWN';
      }
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await lock(transaction, 'workers');
          const [current] = await transaction
            .select()
            .from(deliveries)
            .where(eq(deliveries.id, claim.delivery.id))
            .limit(1)
            .for('update');
          if (!current || current.state !== 'SENDING' || current.leaseToken !== claim.leaseToken) {
            const [saved] = await transaction
              .select()
              .from(commands)
              .where(eq(commands.id, claim.command.id))
              .limit(1);
            return result(
              saved || claim.command,
              saved?.state || 'UNCERTAIN',
              saved?.errorCode || null,
            );
          }
          await transaction
            .update(deliveries)
            .set({ state, leaseToken: null, leaseUntil: null, updatedAt: timestamp(), errorCode })
            .where(eq(deliveries.id, current.id));
          const updated = await refreshState(transaction, claim.command.id);
          return result(claim.command, updated.state, updated.errorCode);
        }),
      );
    },
  };
}
