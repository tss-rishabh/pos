import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { Databases } from '../../../db/pools.js';
import {
  Order,
  OrderStore,
  MUser,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  ExpressLineItem,
  HyperlocalLocation,
  Store,
  StoreCounter,
  PosTerminalTransaction,
  PosPaytmTransaction,
  HasProduct,
} from '../../../db/legacy-schema.js';
import { searchDataInvalid } from './format.js';
import type {
  OrderSearchInput,
  SearchWindow,
  SourceSearchScope,
  SourceOrder,
  SourceStore,
  SourceTerminal,
} from './contracts.js';

type Executor = Pick<ReturnType<Databases['get']>, 'select'>;
const anyStore = alias(OrderStore, 'source_any_store'),
  matchedStore = alias(OrderStore, 'source_matched_store');
const zero = sql<string>`'0'`;
const escapeLike = (value: string) =>
  '%' + value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_') + '%';
function countHeader(db: Executor, scope: SourceSearchScope) {
  const storeMode = scope.effectiveType === 'ST',
    selected = !scope.explicitIds && storeMode;
  return db
    .select({ count: sql<string>`CAST(COUNT(*) AS CHAR)` })
    .from(Order)
    .leftJoin(MUser, eq(MUser.id, Order.user))
    .leftJoin(
      OrderStatus,
      and(eq(OrderStatus.id, Order.order_statuses), ne(Order.order_statuses, 0n)),
    )
    .leftJoin(
      PaymentMethod,
      and(eq(PaymentMethod.id, Order.payment_methods), ne(Order.payment_methods, 0n)),
    )
    .leftJoin(
      PaymentStatus,
      and(eq(PaymentStatus.id, Order.payment_statuses), ne(Order.payment_statuses, 0n)),
    )
    .leftJoin(anyStore, and(eq(anyStore.order, Order.id), sql`${storeMode}`))
    .leftJoin(
      matchedStore,
      and(
        eq(matchedStore.order, Order.id),
        sql`${selected}`,
        inArray(matchedStore.store, scope.selectedStores.map(BigInt)),
      ),
    );
}
function joinHeader(db: Executor, scope: SourceSearchScope, multiplicity = true) {
  const storeMode = multiplicity && scope.effectiveType === 'ST',
    selected = !scope.explicitIds && storeMode;
  return db
    .select({
      id: Order.id,
      reference: Order.order_ref_no,
      userId: Order.user,
      orderAmount: Order.order_amt,
      payAmount: Order.pay_amt,
      createdAt: Order.created_at,
      rawMethodId: Order.payment_methods,
      methodId: PaymentMethod.id,
      methodName: PaymentMethod.name,
      rawPaymentId: Order.payment_statuses,
      paymentId: PaymentStatus.id,
      paymentLabel: PaymentStatus.payment_status,
      rawStatusId: Order.order_statuses,
      statusId: OrderStatus.id,
      statusLabel: OrderStatus.order_status,
      customerId: MUser.id,
      customerFirst: MUser.firstname,
      customerLast: MUser.lastname,
      locationId: Order.location_id,
      locationType: Order.location_type,
      nextLocations: Order.next_location_ids,
      transfer: Order.is_transfer,
      global: Order.is_global_order,
      rowAny: storeMode ? sql<string>`CAST(${anyStore.id} AS CHAR)` : zero,
      rowMatched: selected ? sql<string>`CAST(${matchedStore.id} AS CHAR)` : zero,
      phoneWeight: sql<string>`LOWER(HEX(WEIGHT_STRING(${Order.phone_no} AS CHAR(32))))`,
      userPhoneWeight: sql<
        string | null
      >`LOWER(HEX(WEIGHT_STRING(${MUser.telephone} AS CHAR(32))))`,
      emailWeight: sql<string | null>`LOWER(HEX(WEIGHT_STRING(${MUser.email} AS CHAR(96))))`,
      userFirstKey: sql<string | null>`LOWER(HEX(WEIGHT_STRING(${MUser.firstname} AS CHAR(32))))`,
      methodKey: sql<string | null>`LOWER(HEX(WEIGHT_STRING(${PaymentMethod.name} AS CHAR(255))))`,
      paymentKey: sql<
        string | null
      >`LOWER(HEX(WEIGHT_STRING(${PaymentStatus.payment_status} AS CHAR(255))))`,
    })
    .from(Order)
    .leftJoin(MUser, eq(MUser.id, Order.user))
    .leftJoin(
      OrderStatus,
      and(eq(OrderStatus.id, Order.order_statuses), ne(Order.order_statuses, 0n)),
    )
    .leftJoin(
      PaymentMethod,
      and(eq(PaymentMethod.id, Order.payment_methods), ne(Order.payment_methods, 0n)),
    )
    .leftJoin(
      PaymentStatus,
      and(eq(PaymentStatus.id, Order.payment_statuses), ne(Order.payment_statuses, 0n)),
    )
    .leftJoin(anyStore, and(eq(anyStore.order, Order.id), sql`${storeMode}`))
    .leftJoin(
      matchedStore,
      and(
        eq(matchedStore.order, Order.id),
        sql`${selected}`,
        inArray(matchedStore.store, scope.selectedStores.map(BigInt)),
      ),
    );
}
/**
 * Stores whose orders a non-explicit search covers (legacy `orders_datatable.py:93-121`).
 * Explicit order-ID searches are not store-scoped in legacy ("Allow to see all stores order if
 * search by order id"), so they return no store list here.
 */
export function sourceStoreSelection(scope: SourceSearchScope): string[] {
  if (scope.explicitIds) return [];
  if (scope.effectiveType === 'ST') return scope.selectedStores;
  if (scope.effectiveType === 'HE')
    return scope.selectedStores.length
      ? [scope.selectedStores[0]!]
      : scope.checkedInStoreId
        ? [scope.checkedInStoreId]
        : [];
  return scope.checkedInStoreId ? [scope.checkedInStoreId] : [];
}
function nativeScope(
  db: Executor,
  scope: SourceSearchScope,
  authorizedQueueIds?: readonly string[],
): SQL | undefined {
  if (authorizedQueueIds)
    return inArray(Order.id, authorizedQueueIds.map(BigInt));
  const ids = sourceStoreSelection(scope),
    noStore = notExists(
      db.select({ id: OrderStore.id }).from(OrderStore).where(eq(OrderStore.order, Order.id)),
    );
  if (scope.effectiveType === 'ST')
    // `order_store__isnull=False` then, without IDs, `order_store__store_id__in=selected`.
    return and(isNotNull(anyStore.id), scope.explicitIds ? undefined : isNotNull(matchedStore.id));
  if (scope.effectiveType === 'N')
    // `order_type == "N" and (user_type != 2 or order_id_list)`, else `Order.objects.none()`.
    return scope.franchiseViewer && !scope.explicitIds
      ? sql`FALSE`
      : and(noStore, isNull(Order.location_id));
  if (scope.effectiveType === 'HE')
    return scope.explicitIds
      ? undefined
      : exists(
          db
            .select({ id: ExpressLineItem.id })
            .from(ExpressLineItem)
            .where(
              and(
                eq(ExpressLineItem.order, Order.id),
                inArray(sql<string>`CAST(${ExpressLineItem.store_id} AS CHAR)`, ids),
              ),
            ),
        );
  // HL: `order_store__isnull=True, location_id__isnull=False`, plus the check-in location
  // without IDs. A warehouse location (NW) only matches when it belongs to the checked-in
  // store: a numerically equal warehouse id is not that store (security decision).
  const owning = or(
    and(
      eq(Order.location_type, 'SW'),
      inArray(sql<string>`CAST(${Order.location_id} AS CHAR)`, ids),
    ),
    and(
      eq(Order.location_type, 'NW'),
      exists(
        db
          .select({ id: HyperlocalLocation.id })
          .from(HyperlocalLocation)
          .where(
            and(
              eq(HyperlocalLocation.id, sql`CAST(${Order.location_id} AS SIGNED)`),
              inArray(sql<string>`CAST(${HyperlocalLocation.store_id} AS CHAR)`, ids),
            ),
          ),
      ),
    ),
  );
  return and(
    noStore,
    isNotNull(Order.location_id),
    scope.explicitIds ? undefined : owning,
    scope.explicitIds
      ? undefined
      : eq(sql<string>`CAST(${Order.location_id} AS CHAR)`, scope.checkedInStoreId ?? '0'),
  );
}
function filters(
  db: Executor,
  scope: SourceSearchScope,
  input: Pick<
    OrderSearchInput,
    | 'orderIds'
    | 'placedFrom'
    | 'placedTo'
    | 'paymentMethodIds'
    | 'paymentStatusIds'
    | 'orderStatusIds'
  >,
  window: SearchWindow | null,
  queueIds?: readonly string[],
) {
  return and(
    or(isNull(Order.order_statuses), ne(Order.order_statuses, 0n)),
    nativeScope(db, scope, queueIds),
    input.orderIds.length ? inArray(Order.id, input.orderIds.map(BigInt)) : undefined,
    // Legacy `created_at__gte` / `created_at__lte` on the submitted range; no range, no filter.
    window ? gte(Order.created_at, window.start) : undefined,
    window
      ? window.inclusive
        ? lte(Order.created_at, window.end)
        : lt(Order.created_at, window.end)
      : undefined,
    input.paymentMethodIds.length
      ? inArray(Order.payment_methods, input.paymentMethodIds.map(BigInt))
      : undefined,
    input.paymentStatusIds.length
      ? inArray(Order.payment_statuses, input.paymentStatusIds.map(BigInt))
      : undefined,
    input.orderStatusIds.length
      ? inArray(Order.order_statuses, input.orderStatusIds.map(BigInt))
      : undefined,
  );
}
const sorting = {
  id: Order.id,
  user_id: Order.user,
  user__firstname: MUser.firstname,
  payment_statuses__payment_status: PaymentStatus.payment_status,
  payment_methods__name: PaymentMethod.name,
  order_amt: Order.order_amt,
  order_statuses: Order.order_statuses,
  created_at: Order.created_at,
};
function requiredRelation(raw: bigint | null, related: bigint | null) {
  if (raw !== null && raw !== 0n && related === null) throw searchDataInvalid();
}
const flag = (value: string) => {
  if (value !== '0' && value !== '1') throw searchDataInvalid();
  return value === '1';
};
export function sourceNativeRepository(
  db: Databases,
  contactKey: (purpose: 'order-phone' | 'user-phone' | 'email', weight: string) => string = () =>
    '',
) {
  async function enrich(
    tx: Executor,
    rows: Awaited<ReturnType<ReturnType<typeof joinHeader>['execute']>>,
  ) {
    if (!rows.length) return [];
    const ids = [...new Set(rows.map((row) => row.id))];
    const [storeRows, terminalRows, paytmRows, revertRows, expressRows] = await Promise.all([
      tx
        .select({
          id: OrderStore.id,
          orderId: OrderStore.order,
          storeId: OrderStore.store,
          counterId: OrderStore.counter,
          storeName: Store.store_name,
          counterName: StoreCounter.counter_name,
          locationCode: Store.location_code,
          storeExists: Store.id,
          counterExists: StoreCounter.id,
          cash: OrderStore.offline_payment,
          other: OrderStore.online_other_payment,
          manual: sql<string>`CAST(${OrderStore.is_manually_paid} AS CHAR)`,
          offline: sql<string>`CAST(${OrderStore.is_offline_order} AS CHAR)`,
          shopify: sql<string>`CAST(${OrderStore.is_shopify_order} AS CHAR)`,
        })
        .from(OrderStore)
        .leftJoin(Store, eq(Store.id, OrderStore.store))
        .leftJoin(StoreCounter, eq(StoreCounter.id, OrderStore.counter))
        .where(inArray(OrderStore.order, ids))
        .orderBy(OrderStore.id),
      tx
        .select({
          id: PosTerminalTransaction.id,
          orderId: PosTerminalTransaction.order_id,
          reference: PosTerminalTransaction.plutus_id,
          mode: PosTerminalTransaction.payment_mode,
          created: sql<string>`CAST(CASE WHEN ${PosTerminalTransaction.platform}='txn_created' THEN 1 ELSE 0 END AS CHAR)`,
          completed: sql<string>`CAST(CASE WHEN ${PosTerminalTransaction.platform}='txn_completed' THEN 1 ELSE 0 END AS CHAR)`,
          active: sql<string>`CAST(${PosTerminalTransaction.is_active} AS CHAR)`,
        })
        .from(PosTerminalTransaction)
        .where(inArray(PosTerminalTransaction.order_id, ids))
        .orderBy(PosTerminalTransaction.id),
      tx
        .select({
          id: PosPaytmTransaction.id,
          orderId: PosPaytmTransaction.order_id,
          reference: PosPaytmTransaction.paytm_mid,
          mode: PosPaytmTransaction.payment_mode,
          created: sql<string>`CAST(CASE WHEN ${PosPaytmTransaction.platform}='txn_created' THEN 1 ELSE 0 END AS CHAR)`,
          completed: sql<string>`CAST(CASE WHEN ${PosPaytmTransaction.platform}='txn_completed' THEN 1 ELSE 0 END AS CHAR)`,
          active: sql<string>`CAST(${PosPaytmTransaction.is_active} AS CHAR)`,
        })
        .from(PosPaytmTransaction)
        .where(inArray(PosPaytmTransaction.order_id, ids))
        .orderBy(PosPaytmTransaction.id),
      tx
        .select({
          orderId: HasProduct.order,
          invalid: sql<string>`CAST(SUM(CASE WHEN CAST(${HasProduct.status} AS BINARY) IN (_binary'DELIVERED',_binary'PLACED') THEN 0 ELSE 1 END) AS CHAR)`,
        })
        .from(HasProduct)
        .where(inArray(HasProduct.order, ids))
        .groupBy(HasProduct.order),
      tx
        .select({ orderId: ExpressLineItem.order, storeId: ExpressLineItem.store_id })
        .from(ExpressLineItem)
        .where(inArray(ExpressLineItem.order, ids)),
    ]);
    const locations = [
      ...new Set(
        rows
          .filter((row) => row.locationId !== null && row.locationId > 0)
          .map((row) => String(row.locationId)),
      ),
    ];
    const [storeLocations, warehouseLocations] = locations.length
      ? await Promise.all([
          tx
            .select({ id: Store.id, name: Store.store_name, code: Store.location_code })
            .from(Store)
            .where(inArray(Store.id, locations.map(BigInt))),
          tx
            .select({
              id: HyperlocalLocation.id,
              storeId: HyperlocalLocation.store_id,
              code: HyperlocalLocation.location_code,
            })
            .from(HyperlocalLocation)
            .where(inArray(HyperlocalLocation.id, locations.map(BigInt))),
        ])
      : [[], []];
    const allStores = new Map<string, SourceStore[]>();
    for (const value of storeRows) {
      const key = String(value.orderId),
        list = allStores.get(key) ?? [];
      list.push({
        id: String(value.id),
        orderId: key,
        storeId: String(value.storeId),
        counterId: String(value.counterId),
        storeName: value.storeName,
        counterName: value.counterName,
        locationCode: value.locationCode,
        storeExists: value.storeExists !== null,
        counterExists: value.counterExists !== null,
        cash: value.cash,
        onlineOther: value.other,
        manuallyPaid: flag(value.manual),
        offline: flag(value.offline),
        shopify: flag(value.shopify),
      });
      allStores.set(key, list);
    }
    const terminal = (values: typeof terminalRows): Map<string, SourceTerminal> => {
      const result = new Map<string, SourceTerminal>();
      for (const value of values) {
        const key = String(value.orderId),
          item = result.get(key) ?? {
            inactiveCreated: 0,
            activeCreated: null,
            completedMode: null,
          };
        if (value.created === '1' && value.active === '0') item.inactiveCreated++;
        if (value.created === '1' && value.active === '1' && !item.activeCreated)
          item.activeCreated = { reference: value.reference };
        if (value.completed === '1' && value.active === '1' && item.completedMode === null)
          item.completedMode = value.mode;
        result.set(key, item);
      }
      return result;
    };
    const terminals = terminal(terminalRows),
      paytms = terminal(paytmRows),
      invalid = new Map(revertRows.map((row) => [String(row.orderId), row.invalid]));
    return rows.map((row) => {
      requiredRelation(row.rawMethodId, row.methodId);
      requiredRelation(row.rawPaymentId, row.paymentId);
      requiredRelation(row.rawStatusId, row.statusId);
      let locationLabel: string | null = null,
        locationStoreId: string | null = null;
      if (row.locationId && row.locationType === 'SW') {
        const item = storeLocations.find((item) => String(item.id) === String(row.locationId));
        if (!item) throw searchDataInvalid();
        locationLabel = `${item.code === null ? 'None' : item.code} (${item.name === null ? 'None' : item.name})`;
        locationStoreId = String(item.id);
      } else if (row.locationId && row.locationType === 'NW') {
        const item = warehouseLocations.find((item) => String(item.id) === String(row.locationId));
        if (!item) throw searchDataInvalid();
        locationLabel = item.code;
        locationStoreId = String(item.storeId);
      }
      const id = String(row.id),
        empty: SourceTerminal = { inactiveCreated: 0, activeCreated: null, completedMode: null };
      const fact: SourceOrder = {
        id,
        reference: row.reference,
        userId: String(row.userId),
        customer:
          row.customerId === null
            ? null
            : { id: String(row.customerId), first: row.customerFirst!, last: row.customerLast! },
        orderAmount: row.orderAmount,
        payAmount: row.payAmount,
        createdAt: row.createdAt,
        methodId: row.rawMethodId === null ? null : String(row.rawMethodId),
        method: row.methodId === null ? null : { id: String(row.methodId), name: row.methodName },
        paymentStatusId: row.rawPaymentId === null ? null : String(row.rawPaymentId),
        paymentStatus:
          row.paymentId === null ? null : { id: String(row.paymentId), label: row.paymentLabel! },
        statusId: row.rawStatusId === null ? null : String(row.rawStatusId),
        status:
          row.statusId === null ? null : { id: String(row.statusId), label: row.statusLabel! },
        locationId: row.locationId === null ? null : String(row.locationId),
        locationType: row.locationType,
        locationStoreId,
        locationLabel,
        nextLocations: row.nextLocations ?? '',
        transfer: row.transfer === 1,
        global: row.global,
        stores: allStores.get(id) ?? [],
        expressStoreIds: [
          ...new Set(
            expressRows
              .filter((item) => String(item.orderId) === id && item.storeId !== null)
              .map((item) => String(item.storeId)),
          ),
        ],
        terminal: terminals.get(id) ?? empty,
        paytm: paytms.get(id) ?? empty,
        isRevert: (invalid.get(id) ?? '0') === '0',
        phoneKey: contactKey('order-phone', row.phoneWeight),
        userPhoneKey:
          row.userPhoneWeight === null ? null : contactKey('user-phone', row.userPhoneWeight),
        emailKey: row.emailWeight === null ? null : contactKey('email', row.emailWeight),
        userFirstKey: row.userFirstKey,
        methodKey: row.methodKey,
        paymentKey: row.paymentKey,
      };
      return { rowKey: `${id}:${row.rowAny}:${row.rowMatched}`, fact };
    });
  }
  return {
    async search(
      scope: SourceSearchScope,
      input: OrderSearchInput,
      window: SearchWindow | null,
      queueIds?: readonly string[],
    ) {
      // Legacy AjaxOrderListView reads the default database (primary reader).
      return db.get('primary').transaction(
        async (tx) => {
          const base = filters(tx, scope, input, window, queueIds);
          let direct = false;
          if (input.mobile) {
            const probe = joinHeader(tx, scope)
              .where(and(base, eq(Order.phone_no, input.mobile)))
              .limit(1);
            direct = (await probe).length > 0;
          }
          const full = and(
            base,
            input.mobile
              ? direct
                ? eq(Order.phone_no, input.mobile)
                : eq(MUser.telephone, input.mobile)
              : undefined,
            input.email ? eq(MUser.email, input.email) : undefined,
            input.search
              ? or(
                  sql`CAST(${Order.id} AS CHAR) LIKE ${escapeLike(input.search)} ESCAPE '!'`,
                  sql`CAST(${Order.user} AS CHAR) LIKE ${escapeLike(input.search)} ESCAPE '!'`,
                )
              : undefined,
          );
          const [total] = await countHeader(tx, scope).where(full);
          if (!total) throw searchDataInvalid();
          const offset = BigInt(input.page - 1) * BigInt(input.pageSize),
            page = offset >= BigInt(total.count) ? 1 : input.page,
            effective = (page - 1) * input.pageSize;
          const primary =
            input.sort.direction === 'asc'
              ? asc(sorting[input.sort.field])
              : desc(sorting[input.sort.field]);
          const rows = await joinHeader(tx, scope)
            .where(
              and(full, input.sort.field === 'user__firstname' ? isNotNull(MUser.id) : undefined),
            )
            .orderBy(primary, asc(Order.id), asc(anyStore.id), asc(matchedStore.id))
            .limit(input.pageSize)
            .offset(effective);
          return { count: total.count, page, rows: await enrich(tx, rows) };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },
  };
}
