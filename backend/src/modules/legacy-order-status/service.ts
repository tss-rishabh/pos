import { and, eq, inArray } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  HasProduct,
  Order,
  OrderStatus,
  OrderStore,
  Store,
  UserStore,
} from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import {
  queuedMessage,
  sourceStatusPresentation,
  unprocessedLabels,
  type StatusPlatform,
} from './domain.js';
import {
  readWholeOrderStatusOptions,
  syncRepoBaseUrl,
  type WholeOrderStatusOptions,
} from './options.js';
import { wholeOrderStatusLogs } from './schema.js';
import { syncRepoStatusApi, type CallStatusApi, type SyncRepoOutcome } from './transport.js';
import { tracedFetch } from '../../observability/context.js';

const notFound = () =>
  new AppError(404, 'ORDER_NOT_FOUND', 'This order was not found for this store.');

/** Sync-repo status adapter shared by the push route and the C12 job. */
export function statusApiFromOptions(
  config: Pick<Config, 'NODE_ENV'>,
  options: WholeOrderStatusOptions,
  log: (outcome: SyncRepoOutcome, hyperlocal: boolean) => void = () => {},
  fetcher: typeof fetch = tracedFetch,
): CallStatusApi {
  return syncRepoStatusApi(
    {
      BACKEND_SYNC_API_BASE_URL: syncRepoBaseUrl(config, options),
      BACKEND_SYNC_REPO_API_KEY: options.BACKEND_SYNC_REPO_API_KEY,
    },
    fetcher,
    log,
  );
}

/** Line ids for the whole order: `HasProduct.objects.filter(order_id=…).values_list('id')`. */
export async function orderLineIds(db: Databases, orderId: string): Promise<string[]> {
  const rows = await db
    .get('writer')
    .select({ id: HasProduct.id })
    .from(HasProduct)
    .where(eq(HasProduct.order, BigInt(orderId)));
  return rows.map((row) => String(row.id));
}

export function wholeOrderStatusService(
  config: Config,
  db: Databases,
  options: WholeOrderStatusOptions = readWholeOrderStatusOptions(),
  dependencies: { callStatusApi?: CallStatusApi } = {},
) {
  const callStatusApi = dependencies.callStatusApi ?? statusApiFromOptions(config, options);
  /**
   * Legacy `ShowOrderDetailsView` store scope (`order/views.py:355-369`): the order needs an
   * `order_stores` row in the user's stores (`user_stores`, or every active store for role 1).
   * The `cr=1` cross-store bypass is not offered here (security decision, see report).
   */
  async function authorize(user: Principal, storeId: string, orderId: string) {
    const reader = db.get('primary');
    const allowed =
      user.role === 1
        ? reader
            .select({ id: Store.id })
            .from(Store)
            .where(and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, true)))
        : reader
            .select({ id: UserStore.store_id })
            .from(UserStore)
            .where(
              and(
                eq(UserStore.django_user_id, BigInt(user.id)),
                eq(UserStore.store_id, BigInt(storeId)),
              ),
            );
    const [row] = await reader
      .select({ id: OrderStore.id })
      .from(OrderStore)
      .where(
        and(
          eq(OrderStore.order, BigInt(orderId)),
          eq(OrderStore.store, BigInt(storeId)),
          inArray(OrderStore.store, allowed),
        ),
      )
      .limit(1);
    if (!row) throw notFound();
  }
  return {
    /** "Vinculum Status" tab data (`order/views.py:451-464`, `show.html:303-340`). */
    async status(user: Principal, storeId: string, orderId: string) {
      await authorize(user, storeId, orderId);
      const reader = db.get('primary');
      const [order] = await reader
        .select({ label: OrderStatus.order_status })
        .from(Order)
        .leftJoin(OrderStatus, eq(OrderStatus.id, Order.order_statuses))
        .where(eq(Order.id, BigInt(orderId)))
        .limit(1);
      if (!order) throw notFound();
      const logs = await reader
        .select({
          id: wholeOrderStatusLogs.id,
          platform: wholeOrderStatusLogs.platform,
          status: wholeOrderStatusLogs.status,
          updatedAt: wholeOrderStatusLogs.updatedAt,
        })
        .from(wholeOrderStatusLogs)
        .where(eq(wholeOrderStatusLogs.orderId, BigInt(orderId)))
        .orderBy(wholeOrderStatusLogs.id);
      return {
        orderId,
        storeId,
        processed: !unprocessedLabels.includes(order.label ?? ''),
        stages: sourceStatusPresentation(logs.map((row) => ({ ...row, id: String(row.id) }))),
      };
    },
    /**
     * Legacy `AjaxUpdateStatusVincView.post` (`order/views.py:4427-4445`): POST every line of
     * the order to the sync-repo `/store-order/status` once, synchronously, and answer
     * "Request has been queued for processing" whatever the outcome (legacy only logs).
     */
    async push(user: Principal, storeId: string, orderId: string, stage: StatusPlatform) {
      await authorize(user, storeId, orderId);
      const ids = await orderLineIds(db, orderId);
      const outcome = await callStatusApi(orderId, ids, stage, false);
      return { message: queuedMessage, outcome };
    },
  };
}
export type WholeOrderStatusService = ReturnType<typeof wholeOrderStatusService>;
