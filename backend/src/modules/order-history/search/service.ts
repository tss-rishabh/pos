import { and, eq, inArray, sql } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import {
  Store,
  PaymentMethod,
  PaymentStatus,
  OrderStatus,
  ExpressLineItem,
} from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import type { Principal } from '../../../domain/access.js';
import { positiveId } from '../contracts.js';
import {
  orderSearchInput,
  sourceSearchContract,
  type OrderSearchInput,
  type OrderSearchRequest,
  type SearchWindow,
  type SourceSearchPage,
} from './contracts.js';
import { sourceSearchAuthority } from './scope.js';
import { sourceNativeRepository } from './native.js';
import { sourceQueueRepository } from './queue.js';
import { formatSourceOrder } from './format.js';
import { sourceOrderDefaults } from './default-ranges.js';

/** The submitted window: placement timestamps (legacy `__lte` form), calendar dates, or none. */
export function searchWindow(input: OrderSearchInput): SearchWindow | null {
  if (input.placedFrom && input.placedTo)
    return { start: input.placedFrom, end: input.placedTo, inclusive: true };
  if (input.from && input.to)
    return {
      start: input.from + ' 00:00:00',
      end: Temporal.PlainDate.from(input.to).add({ days: 1 }).toString() + ' 00:00:00',
      inclusive: false,
    };
  return null;
}
export interface HyperlocalTabCounts {
  inQueue: number;
  notPacked: number;
  packed: number;
  shipped: number;
}
/**
 * Legacy `_hl_get_tab_counts` (`order/views.py:4696-4746`): distinct orders per Express line
 * status for the checked-in store, scoped to today's expiry dates, read from READ_DB_ALIAS.
 */
export async function hyperlocalTabCounts(
  db: Databases,
  storeId: string | null,
  today: string,
): Promise<HyperlocalTabCounts> {
  if (!storeId) return { inQueue: 0, notPacked: 0, packed: 0, shipped: 0 };
  const count = async (
    statuses: ('PENDING' | 'ACCEPTED' | 'PACKED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'RTO')[],
    expiry: 'pending' | 'accepted',
  ) => {
    const column =
      expiry === 'pending'
        ? ExpressLineItem.pending_expires_at
        : ExpressLineItem.accepted_expires_at;
    const [row] = await db
      .get('data')
      .select({ count: sql<string>`CAST(COUNT(DISTINCT ${ExpressLineItem.order}) AS CHAR)` })
      .from(ExpressLineItem)
      .where(
        and(
          eq(ExpressLineItem.store_id, Number(storeId)),
          inArray(ExpressLineItem.status, statuses),
          sql`DATE(${column}) = ${today}`,
        ),
      );
    return Number(row?.count ?? '0');
  };
  const [inQueue, notPacked, packed, shipped] = await Promise.all([
    count(['PENDING'], 'pending'),
    count(['ACCEPTED'], 'accepted'),
    count(['PACKED'], 'accepted'),
    count(['OUT_FOR_DELIVERY', 'DELIVERED', 'RTO'], 'accepted'),
  ]);
  return { inQueue, notPacked, packed, shipped };
}

export function orderSearchService(
  config: Config,
  db: Databases,
  dependencies: { clock?: () => number } = {},
) {
  const clock = dependencies.clock ?? Date.now,
    capture = sourceSearchAuthority(config, db),
    native = sourceNativeRepository(db),
    discover = sourceQueueRepository(db);
  async function recheck(
    user: Principal,
    storeId: string,
    input: OrderSearchInput,
    binding: string,
  ) {
    if ((await capture(user, storeId, input)).binding !== binding)
      throw new AppError(
        403,
        'ORDER_SEARCH_SCOPE_CHANGED',
        'Your order-viewing permissions changed. Refresh this selection.',
      );
  }
  return {
    /** Legacy `AjaxOrderListView.datatables` (`order/datatables/orders_datatable.py:22-196`). */
    async search(
      user: Principal,
      storeId: string,
      raw: OrderSearchRequest,
    ): Promise<SourceSearchPage> {
      positiveId.parse(storeId);
      const input = orderSearchInput.parse(raw),
        scope = await capture(user, storeId, input),
        queue = input.notPacked || input.inQueue,
        window = queue ? null : searchWindow(input);
      const metadata = {
        contract: sourceSearchContract as typeof sourceSearchContract,
        draw: input.draw,
        pageSize: input.pageSize,
        fetchedAt: new Date(clock()).toISOString(),
        reader: 'primary' as const,
        range: {
          placedFrom: window?.start ?? null,
          placedTo: window?.end ?? null,
          timeZone: config.BUSINESS_TIMEZONE,
          ignoredForQueue: queue,
        },
      };
      if (
        !queue &&
        scope.effectiveType === 'ST' &&
        !scope.explicitIds &&
        !scope.selectedStores.length
      ) {
        await recheck(user, storeId, input, scope.binding);
        return {
          ...metadata,
          emptySelection: true,
          recordsTotal: '0',
          recordsFiltered: '0',
          page: 1,
          data: [],
        };
      }
      const queued = queue ? (await discover(scope, input)).orders.map((row) => row.id) : undefined;
      // Queue tabs ignore order IDs, as legacy clears `order_id_list` for them.
      const result = await native.search(
        scope,
        queue ? { ...input, orderIds: [] } : input,
        window,
        queued,
      );
      await recheck(user, storeId, input, scope.binding);
      return {
        ...metadata,
        recordsTotal: result.count,
        recordsFiltered: result.count,
        page: result.page,
        data: result.rows.map((row) => formatSourceOrder(row.fact, scope, row.rowKey)),
      };
    },
    /** Legacy `OrdersView.get` / `OnlineOrdersView.get` page context (`order/views.py:67-260`). */
    async options(user: Principal, storeId: string) {
      const now = clock(),
        defaults = sourceOrderDefaults(now, config.BUSINESS_TIMEZONE);
      const input = orderSearchInput.parse({ storeIds: [storeId] }),
        scope = await capture(user, storeId, input),
        primary = db.get('primary');
      const today = Temporal.Instant.fromEpochMilliseconds(now)
        .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
        .toPlainDate()
        .toString();
      const [stores, methods, paymentStatuses, orderStatuses, hyperlocalTabs] = await Promise.all([
        primary
          .select({
            id: sql<string>`CAST(${Store.id} AS CHAR)`,
            name: Store.store_name,
            locationCode: Store.location_code,
          })
          .from(Store)
          .where(and(eq(Store.is_active, true), inArray(Store.id, scope.allowedStores.map(BigInt))))
          .orderBy(Store.id),
        primary
          .select({ id: sql<string>`CAST(${PaymentMethod.id} AS CHAR)`, name: PaymentMethod.name })
          .from(PaymentMethod)
          .orderBy(PaymentMethod.id),
        primary
          .select({
            id: sql<string>`CAST(${PaymentStatus.id} AS CHAR)`,
            name: PaymentStatus.payment_status,
          })
          .from(PaymentStatus)
          .orderBy(PaymentStatus.id),
        primary
          .select({
            id: sql<string>`CAST(${OrderStatus.id} AS CHAR)`,
            name: OrderStatus.order_status,
          })
          .from(OrderStatus)
          .orderBy(OrderStatus.id),
        hyperlocalTabCounts(db, scope.checkedInStoreId, today),
      ]);
      await recheck(user, storeId, input, scope.binding);
      return {
        stores,
        methods,
        paymentStatuses,
        orderStatuses,
        // Legacy shows the Store, Online and HyperLocal radios to everyone; the HL list is
        // the Online page (`orders/online/`).
        orderTypes: ['ST', 'HL', 'HE', 'N'] as ('ST' | 'HL' | 'HE' | 'N')[],
        checkedInStoreId: scope.checkedInStoreId,
        // Store page: 5 days back to now + 1 minute. Online page: no default range.
        defaults,
        hyperlocalTabs,
      };
    },
  };
}
