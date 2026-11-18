import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { Store, PaymentMethod, PaymentStatus, OrderStatus } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import type { Principal } from '../../../domain/access.js';
import { orderRange, positiveId } from '../contracts.js';
import {
  orderSearchInput,
  sourceSearchContract,
  type OrderSearchRequest,
  type SourceSearchPage,
  type SourceOrder,
} from './contracts.js';
import { sourceSearchAuthority } from './scope.js';
import { sourceNativeRepository } from './native.js';
import { sourceQueueRepository } from './queue.js';
import { sourceHistoricalSearch, type SourceHistorySearchPort } from './warehouse.js';
import { searchContactKeys, searchContactSelection } from './contacts.js';
import { sourceIndex, sourceSelect } from './reducer.js';
import { formatSourceOrder, searchDataInvalid } from './format.js';
import { readOrderSearchOptions, type OrderSearchOptions } from './options.js';
import {
  sourceOrderDefaults,
  sourceSearchReadPlan,
  type SourceSearchReadPlan,
} from './default-ranges.js';
export function orderSearchService(
  config: Config,
  db: Databases,
  options: OrderSearchOptions = readOrderSearchOptions(),
  dependencies: { history?: SourceHistorySearchPort; clock?: () => number } = {},
) {
  const clock = dependencies.clock ?? Date.now,
    capture = sourceSearchAuthority(config, db),
    native = sourceNativeRepository(db, searchContactKeys(options)),
    contacts = searchContactSelection(db, options),
    discover = sourceQueueRepository(db, options.ORDER_SEARCH_MAX_QUEUE_ORDERS),
    history = dependencies.history ?? sourceHistoricalSearch(config, options, dependencies);
  async function recheck(
    user: Principal,
    storeId: string,
    input: ReturnType<typeof orderSearchInput.parse>,
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
    async search(
      user: Principal,
      storeId: string,
      raw: OrderSearchRequest,
    ): Promise<SourceSearchPage> {
      positiveId.parse(storeId);
      const input = orderSearchInput.parse(raw),
        scope = await capture(user, storeId, input),
        queue = input.notPacked || input.inQueue;
      const plan: SourceSearchReadPlan = queue
        ? { selected: orderRange({}, config.BUSINESS_TIMEZONE, clock()) }
        : sourceSearchReadPlan(input, config.BUSINESS_TIMEZONE, clock());
      const selected = plan.selected;
      const metadata = {
        contract: sourceSearchContract as typeof sourceSearchContract,
        draw: input.draw,
        pageSize: input.pageSize,
        fetchedAt: new Date(clock()).toISOString(),
        range: {
          from: selected.from,
          to: selected.to,
          timeZone: selected.timeZone,
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
          reader: selected.reader,
          recordsTotal: '0',
          recordsFiltered: '0',
          page: 1,
          generationId: null,
          data: [],
        };
      }
      if (!queue && selected.reader !== 'bigquery' && (!scope.explicitIds || selected.explicit)) {
        const result = await native.search(scope, input, selected);
        await recheck(user, storeId, input, scope.binding);
        return {
          ...metadata,
          reader: selected.reader,
          recordsTotal: result.count,
          recordsFiltered: result.count,
          page: result.page,
          generationId: null,
          data: result.rows.map((row) => formatSourceOrder(row.fact, scope, row.rowKey)),
        };
      }
      let live: Awaited<ReturnType<typeof discover>> | undefined,
        current: SourceOrder[] = [],
        old: Awaited<ReturnType<SourceHistorySearchPort['range']>> | undefined;
      if (queue || (scope.explicitIds && !selected.explicit)) {
        const today = orderRange({}, config.BUSINESS_TIMEZONE, clock());
        live = queue ? await discover(scope, input) : undefined;
        const ids = live ? live.orders.map((row) => row.id) : input.orderIds;
        current = await native.facts(scope, today, ids);
        const present = new Set(current.map((row) => row.id)),
          older = ids.filter((id) => !present.has(id));
        if (older.length) old = await history.ids(scope, older, today.cutoff);
        if (live && older.some((id) => !old?.indexes.some((row) => row.id === id)))
          throw new AppError(
            503,
            'ORDER_QUEUE_HISTORY_UNAVAILABLE',
            'Some queued orders need a complete historical publication before this queue can be shown.',
          );
      } else {
        if (plan.historical) old = await history.range(scope, plan.historical);
        if (plan.current)
          current = await native.currentFacts(
            scope,
            input,
            plan.current,
            options.ORDER_SEARCH_MAX_INDEX_ROWS,
          );
      }
      const currentIndexes = current.map((row) => sourceIndex(row));
      let indexes = [...currentIndexes, ...(old?.indexes ?? [])];
      if (new Set(indexes.map((row) => row.id)).size !== indexes.length) throw searchDataInvalid();
      // Queue status/owner remain current operational facts, while older header/payment/customer facts stay warehouse-only.
      if (live) {
        const state = new Map(live.orders.map((row) => [row.id, row]));
        indexes = indexes.map((row) => {
          const value = state.get(row.id);
          if (!value) throw searchDataInvalid();
          return { ...row, statusId: value.statusId };
        });
      }
      const chosen = sourceSelect(
          indexes,
          scope,
          input,
          await contacts(input),
          live ? new Set(live.orders.map((row) => row.id)) : undefined,
        ),
        wanted = [...new Set(chosen.rows.map((row) => row.index.id))];
      const facts = new Map(current.map((row) => [row.id, row]));
      for (const fact of (await old?.facts(wanted.filter((id) => !facts.has(id)))) ?? [])
        facts.set(fact.id, fact);
      if (live) {
        const fresh = await discover(scope, input);
        if (fresh.binding !== live.binding)
          throw new AppError(
            409,
            'ORDER_QUEUE_CHANGED',
            'This delivery queue changed while loading. Refresh it.',
          );
        for (const value of fresh.orders) {
          const fact = facts.get(value.id);
          if (fact)
            facts.set(value.id, {
              ...fact,
              statusId: value.statusId,
              status: value.status,
              locationId: value.locationId,
              locationType: value.locationType,
              locationStoreId: value.ownerStoreId,
              locationLabel: value.locationLabel,
              transfer: value.transfer === 1,
              nextLocations: value.nextLocations ?? '',
            });
        }
      }
      await recheck(user, storeId, input, scope.binding);
      return {
        ...metadata,
        reader: old ? (live || plan.current ? 'mixed' : 'bigquery') : 'primary',
        recordsTotal: chosen.count,
        recordsFiltered: chosen.count,
        page: chosen.page,
        generationId: old?.generationId ?? null,
        data: chosen.rows.map((row) => {
          const fact = facts.get(row.index.id);
          if (!fact) throw searchDataInvalid();
          return formatSourceOrder(fact, scope, row.rowKey);
        }),
      };
    },
    async options(user: Principal, storeId: string) {
      const defaults = sourceOrderDefaults(clock(), config.BUSINESS_TIMEZONE);
      const input = orderSearchInput.parse({ storeIds: [storeId] }),
        scope = await capture(user, storeId, input),
        primary = db.get('primary');
      const [stores, methods, paymentStatuses, orderStatuses] = await Promise.all([
        primary
          .select({
            id: sql<string>`CAST(${Store.id} AS CHAR)`,
            name: Store.store_name,
            locationCode: Store.location_code,
          })
          .from(Store)
          .where(and(eq(Store.is_active, true), inArray(Store.id, scope.allowedStores.map(BigInt))))
          .orderBy(Store.store_name, Store.id),
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
      ]);
      await recheck(user, storeId, input, scope.binding);
      return {
        stores,
        methods,
        paymentStatuses,
        orderStatuses,
        orderTypes: scope.globalReader ? ['ST', 'HL', 'HE', 'N'] : ['ST', 'HL', 'HE'],
        checkedInStoreId: scope.checkedInStoreId,
        defaults,
      };
    },
  };
}
