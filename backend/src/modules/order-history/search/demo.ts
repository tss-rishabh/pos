import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../../config.js';
import { requireStore } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import type { CatalogService } from '../../catalog.js';
import type { OrdersService } from '../../orders.js';
import { orderRange } from '../contracts.js';
import type { OrderSearchService } from './index.js';
import { orderSearchInput, sourceSearchContract, type SourceOrderRow } from './contracts.js';

/** Explicit synthetic adapter. It has no database, warehouse or provider port. */
export function demoOrderSearch(
  config: Config,
  catalog: CatalogService,
  orders: OrdersService,
): OrderSearchService {
  if (!config.DEMO_MODE || config.NODE_ENV === 'production')
    throw new AppError(503, 'DEMO_UNAVAILABLE', 'The synthetic workspace is unavailable.');
  return {
    async options(user, storeId) {
      requireStore(user, storeId);
      return {
        stores: (await catalog.stores(user)).map((store) => ({
          id: store.id,
          name: store.name,
          locationCode: store.locationCode,
        })),
        methods: [{ id: '14', name: 'Cash on counter' }],
        paymentStatuses: [{ id: '4', name: 'Paid' }],
        orderStatuses: [
          { id: '1', name: 'Processing' },
          { id: '3', name: 'Delivered' },
        ],
        orderTypes: ['ST'],
        checkedInStoreId: storeId,
      };
    },
    async search(user, storeId, raw) {
      requireStore(user, storeId);
      const input = orderSearchInput.parse(raw);
      for (const selectedStore of input.storeIds) requireStore(user, selectedStore);
      if (input.orderType !== 'ST')
        throw new AppError(
          400,
          'DEMO_ORDER_SELECTION_UNAVAILABLE',
          'Choose store orders in the synthetic workspace.',
        );
      const range = orderRange(
        {
          from: input.from ?? input.placedFrom?.slice(0, 10),
          to: input.to ?? input.placedTo?.slice(0, 10),
          intent: input.intent,
        },
        config.BUSINESS_TIMEZONE,
      );
      const sample: SourceOrderRow[] = [];
      for (const selectedStore of input.storeIds) {
        const page = await orders.list(user, selectedStore);
        const stores = await catalog.stores(user),
          store = stores.find((value) => value.id === selectedStore);
        for (const order of page.data)
          sample.push({
            rowKey: selectedStore + ':' + order.id,
            id: order.id,
            user_id: '0',
            user__firstname: order.customer,
            payment_statuses__payment_status: order.paymentStatus,
            payment_methods__name: 'Cash on counter',
            payment_methods__id: '14',
            order_amt: Number(order.amount),
            order_statuses: order.status,
            created_at: Temporal.Instant.from(order.createdAt)
              .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
              .toPlainDateTime()
              .toString({ smallestUnit: 'second' })
              .replace('T', ' '),
            store_name: store?.name ?? null,
            counter_id: selectedStore === '1' ? '1' : '2',
            location_code: store?.locationCode ?? null,
            is_manually_paid: false,
            is_offline_order: false,
            is_shopify_order: false,
            is_uploaded: 0,
            transaction_id: '',
            plutus_id: '',
            paytm_mid: '',
            pay_amount: Number(order.amount),
            is_revert: false,
            DT_RowId: order.id,
            is_global_order: 0,
            actionStoreId: selectedStore,
          });
      }
      const rows = sample.filter((row) => {
        const day = row.created_at.slice(0, 10),
          status = row.order_statuses === 'Processing' ? '1' : '3';
        return (
          (!input.orderIds.length || input.orderIds.includes(row.id)) &&
          !input.mobile &&
          !input.email &&
          (input.inQueue || input.notPacked || (day >= range.from && day <= range.to)) &&
          (!input.placedFrom || row.created_at >= input.placedFrom) &&
          (!input.placedTo || row.created_at <= input.placedTo) &&
          (!input.paymentMethodIds.length || input.paymentMethodIds.includes('14')) &&
          (!input.paymentStatusIds.length || input.paymentStatusIds.includes('4')) &&
          (!input.orderStatusIds.length || input.orderStatusIds.includes(status)) &&
          ((!input.inQueue && !input.notPacked) || status === '1') &&
          Object.values(row).join(' ').toLowerCase().includes(input.search.toLowerCase())
        );
      });
      rows.sort((a, b) => {
        const field = input.sort.field,
          left = a[field],
          right = b[field];
        const comparison =
          field === 'id' || field === 'user_id'
            ? BigInt(String(left)) < BigInt(String(right))
              ? -1
              : BigInt(String(left)) > BigInt(String(right))
                ? 1
                : 0
            : typeof left === 'number' && typeof right === 'number'
              ? left - right
              : String(left ?? '').localeCompare(String(right ?? ''));
        return comparison * (input.sort.direction === 'desc' ? -1 : 1);
      });
      const page = Math.min(input.page, Math.max(1, Math.ceil(rows.length / input.pageSize)));
      return {
        contract: sourceSearchContract,
        draw: input.draw,
        recordsTotal: String(rows.length),
        recordsFiltered: String(rows.length),
        page,
        pageSize: input.pageSize,
        reader: range.reader,
        data: rows.slice((page - 1) * input.pageSize, page * input.pageSize),
        fetchedAt: new Date().toISOString(),
        generationId: null,
        range: {
          from: range.from,
          to: range.to,
          timeZone: range.timeZone,
          ignoredForQueue: input.inQueue || input.notPacked,
        },
        ...(!input.storeIds.length ? { emptySelection: true as const } : {}),
      };
    },
  };
}
