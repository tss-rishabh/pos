import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  HoldStockStore,
  PosHoldStockLog,
  Product,
  ProductStore,
  Store,
} from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import type { StockProcedure, StockProcedureInput } from '../../administration/stock-procedure.js';
import {
  enqueueInventorySynchronization,
  enqueueSystemInventorySynchronization,
} from '../../administration/inventory-synchronization.js';
import type { RtoStep } from '../domain.js';
import type { LifecycleActor, LifecycleOrderState, Reservation } from './contracts.js';
import { eventId, reconciliation } from './domain.js';

export interface HeldLine {
  hasProductId: string;
  productId: string;
  quantity: number;
}
export type SystemStockProcedure = (
  tx: AdministrationTransaction,
  input: Omit<StockProcedureInput, 'operatorId'> & { operatorId: '0' },
) => Promise<void>;
export interface LifecycleInventoryOptions {
  stockProcedure?: StockProcedure;
  systemStockProcedure?: SystemStockProcedure;
  synchronizationAvailable?: boolean;
}
const sorted = (values: readonly string[]) =>
  [...new Set(values)].sort((one, two) => (BigInt(one) < BigInt(two) ? -1 : 1));
export function lifecycleInventory(options: LifecycleInventoryOptions) {
  return {
    ready(actor: LifecycleActor) {
      return (
        options.synchronizationAvailable === true &&
        !!(actor.kind === 'service' ? options.systemStockProcedure : options.stockProcedure)
      );
    },
    async apply(
      tx: AdministrationTransaction,
      input: {
        commandId: string;
        orderId: string;
        actor: LifecycleActor;
        requestId: string;
        timestamp: string;
        state: LifecycleOrderState;
        operations: {
          kind: 'hold' | 'release' | 'consume';
          storeId: string;
          lines: HeldLine[];
          comment: string;
        }[];
      },
    ) {
      if (!this.ready(input.actor))
        throw new AppError(
          503,
          'UPSTREAM_NOT_SENT',
          'The local delivery inventory integration is unavailable.',
        );
      if (input.operations.reduce((count, operation) => count + operation.lines.length, 0) > 1000)
        throw reconciliation();
      const storeIds = sorted(input.operations.map((operation) => operation.storeId)),
        ids = sorted(
          input.operations.flatMap((operation) => operation.lines.map((line) => line.productId)),
        );
      if (!ids.length)
        return {
          state: input.state,
          steps: [] as RtoStep[],
          movements: [] as { storeId: string; step: RtoStep }[],
        };
      const stores = await tx
        .select({ id: Store.id, active: Store.is_active, type: Store.type })
        .from(Store)
        .where(inArray(Store.id, storeIds.map(BigInt)))
        .orderBy(asc(Store.id))
        .for('update');
      if (stores.length !== storeIds.length || stores.some((store) => !store.active))
        throw reconciliation();
      if (stores.some((store) => store.type === 'CORE_WAREHOUSE'))
        throw new AppError(
          409,
          'WAREHOUSE_HOLD_RECONCILIATION_REQUIRED',
          'This warehouse needs a verified location inventory projection.',
        );
      await tx
        .select({ id: Product.id })
        .from(Product)
        .where(inArray(Product.id, ids.map(BigInt)))
        .orderBy(asc(Product.id))
        .for('update');
      const available = await tx
          .select({
            id: ProductStore.id,
            storeId: ProductStore.store,
            productId: ProductStore.product,
            stock: ProductStore.stock,
          })
          .from(ProductStore)
          .where(
            and(
              inArray(ProductStore.store, storeIds.map(BigInt)),
              inArray(ProductStore.product, ids.map(BigInt)),
            ),
          )
          .orderBy(asc(ProductStore.store), asc(ProductStore.product))
          .limit(1001)
          .for('update'),
        held = await tx
          .select()
          .from(HoldStockStore)
          .where(
            and(
              inArray(HoldStockStore.store, storeIds.map(BigInt)),
              inArray(HoldStockStore.product, ids.map(BigInt)),
            ),
          )
          .orderBy(asc(HoldStockStore.store), asc(HoldStockStore.product))
          .limit(1001)
          .for('update');
      if (available.length > 1000 || held.length > 1000) throw reconciliation();
      const stock = new Map<string, number>(),
        hold = new Map<string, { id: bigint | null; stock: number }>(),
        key = (storeId: string, productId: string) => storeId + ':' + productId;
      for (const row of available) {
        const id = key(String(row.storeId), String(row.productId));
        if (stock.has(id)) throw reconciliation();
        stock.set(id, row.stock);
      }
      for (const row of held) {
        const id = key(String(row.store), String(row.product));
        if (hold.has(id)) throw reconciliation();
        hold.set(id, { id: row.id, stock: row.stock });
      }
      const reservations = input.state.reservations.map((row) => ({ ...row })),
        steps: RtoStep[] = [],
        movements: { storeId: string; step: RtoStep }[] = [],
        synchronize = new Map<string, Set<string>>();
      for (const operation of input.operations)
        for (const line of operation.lines) {
          const id = key(operation.storeId, line.productId),
            before = stock.get(id),
            current = hold.get(id) || { id: null, stock: 0 };
          if (
            before === undefined ||
            !Number.isSafeInteger(before) ||
            !Number.isSafeInteger(current.stock) ||
            current.stock < 0 ||
            !Number.isInteger(line.quantity) ||
            line.quantity <= 0
          )
            throw reconciliation();
          const owned = reservations.filter(
            (row) =>
              row.storeId === operation.storeId &&
              row.hasProductId === line.hasProductId &&
              row.productId === line.productId &&
              row.state === 'held',
          );
          if (
            operation.kind === 'hold' &&
            reservations.some(
              (row) => row.storeId === operation.storeId && row.hasProductId === line.hasProductId,
            )
          )
            throw reconciliation();
          if (
            operation.kind !== 'hold' &&
            (owned.length !== 1 || owned[0]!.quantity !== line.quantity)
          )
            throw reconciliation();
          const holdAfter =
              current.stock + (operation.kind === 'hold' ? line.quantity : -line.quantity),
            after =
              before +
              (operation.kind === 'hold'
                ? -line.quantity
                : operation.kind === 'release'
                  ? line.quantity
                  : 0);
          if (holdAfter < 0 || holdAfter > 2147483647 || after < 0 || after > 2147483647)
            throw new AppError(
              409,
              'LOCAL_DELIVERY_STOCK_UNAVAILABLE',
              'The required held or available stock is not available.',
            );
          if (current.id !== null)
            await tx
              .update(HoldStockStore)
              .set({ stock: holdAfter })
              .where(eq(HoldStockStore.id, current.id));
          else {
            await tx.insert(HoldStockStore).values({
              product: BigInt(line.productId),
              store: BigInt(operation.storeId),
              stock: holdAfter,
            });
            const [inserted] = await tx
              .select({ id: HoldStockStore.id })
              .from(HoldStockStore)
              .where(
                and(
                  eq(HoldStockStore.store, BigInt(operation.storeId)),
                  eq(HoldStockStore.product, BigInt(line.productId)),
                ),
              )
              .limit(2)
              .for('update');
            if (!inserted) throw reconciliation();
            current.id = inserted.id;
          }
          hold.set(id, { id: current.id, stock: holdAfter });
          const holdComment =
            operation.kind === 'hold'
              ? 'Hold Stock inventory added into Hold Stock ' + operation.comment
              : 'Hold Stock inventory reduced ' + operation.comment;
          if (holdComment.length > 255) throw reconciliation();
          await tx.insert(PosHoldStockLog).values({
            product_id: BigInt(line.productId),
            store_id: BigInt(operation.storeId),
            stock_before: String(current.stock),
            stock_after: String(holdAfter),
            pos_user_id: input.actor.kind === 'service' ? 0n : BigInt(input.actor.id),
            comment: holdComment,
            created_at: input.timestamp,
            updated_at: input.timestamp,
          });
          if (operation.kind !== 'consume') {
            const projection = {
              storeId: operation.storeId,
              productId: line.productId,
              stock: after,
              comment: operation.comment,
            };
            if (input.actor.kind === 'service')
              await options.systemStockProcedure!(tx, { ...projection, operatorId: '0' });
            else await options.stockProcedure!(tx, { ...projection, operatorId: input.actor.id });
            stock.set(id, after);
            if (operation.kind === 'release') {
              const step = {
                hasProductId: line.hasProductId,
                productId: line.productId,
                quantity: String(line.quantity),
                before,
                after,
              };
              steps.push(step);
              movements.push({ storeId: operation.storeId, step });
            }
          }
          if (operation.kind === 'hold')
            reservations.push({
              storeId: operation.storeId,
              hasProductId: line.hasProductId,
              productId: line.productId,
              quantity: line.quantity,
              state: 'held',
              commandId: input.commandId,
            });
          else owned[0]!.state = operation.kind === 'consume' ? 'consumed' : 'released';
          const products = synchronize.get(operation.storeId) || new Set<string>();
          products.add(line.productId);
          synchronize.set(operation.storeId, products);
        }
      for (const [storeId, productIds] of synchronize) {
        const event = {
          id: eventId('legacy-delivery-sync', input.commandId, storeId),
          storeId,
          productIds: [...productIds],
          reason: 'legacy-delivery' as const,
          requestId: input.requestId,
        };
        if (input.actor.kind === 'service') await enqueueSystemInventorySynchronization(tx, event);
        else await enqueueInventorySynchronization(tx, { ...event, operatorId: input.actor.id });
      }
      return { state: { ...input.state, reservations }, steps, movements };
    },
  };
}
export function heldLines(reservations: readonly Reservation[], storeId: string) {
  return reservations
    .filter((row) => row.storeId === storeId && row.state === 'held')
    .map(({ hasProductId, productId, quantity }) => ({ hasProductId, productId, quantity }));
}
