import { readConfig } from '../../src/config.js';
import {
  orderRange,
  orderHistoryContract,
  type HistoryHeader,
  type HistoryStore,
  type HistoryLine,
} from '../../src/modules/order-history/contracts.js';
import { readOrderHistoryOptions } from '../../src/modules/order-history/options.js';
import {
  historyListRowHash,
  historyRowsHash,
  historyOrderHash,
  historyCopyHash,
} from '../../src/modules/order-history/hashes.js';
export const now = Date.parse('2026-11-17T06:00:00Z'),
  generation = '4918d168-c62e-4ed7-b8ae-89b0a5e70019';
export const config = readConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'synthetic-order-history-secret-'.repeat(2),
  MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
  MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_order_history_test',
  BIGQUERY_PROJECT_ID: 'tssgcp2025',
  BIGQUERY_LOCATION: 'asia-south1',
});
export const options = readOrderHistoryOptions({
  ORDER_HISTORY_CONTRACT: orderHistoryContract,
  BQ_ORDER_HISTORY_HEADERS_VIEW: 'tssgcp2025.tss_mysql_raw_layer.pos_public_order_headers_v1',
  BQ_ORDER_HISTORY_STORES_VIEW: 'tssgcp2025.tss_mysql_raw_layer.pos_public_order_stores_v1',
  BQ_ORDER_HISTORY_LINES_VIEW: 'tssgcp2025.tss_mysql_raw_layer.pos_public_order_lines_v1',
  BQ_ORDER_HISTORY_PUBLICATIONS_VIEW:
    'tssgcp2025.tss_mysql_raw_layer.pos_public_order_publications_v1',
});
export const range = orderRange(
  { from: '2026-11-15', to: '2026-11-16' },
  config.BUSINESS_TIMEZONE,
  now,
);
export const header: HistoryHeader = {
  id: '9007199254740993',
  customerId: '7',
  reference: 'SYNTHETIC',
  first: 'Synthetic',
  last: 'Customer',
  amount: '1234.5',
  status: 'Delivered',
  paymentStatus: 'Paid',
  paymentStatusId: '4',
  createdAt: '2026-11-16 12:00:00',
};
export const stores: HistoryStore[] = [
  { id: '10', orderId: header.id, storeId: '1', counterId: '1' },
  { id: '11', orderId: header.id, storeId: '1', counterId: '1' },
];
export const lines: HistoryLine[] = [
  {
    id: '9007199254741001',
    orderId: header.id,
    productId: '101',
    name: 'Synthetic item',
    quantity: '4',
    amount: '10.5',
    gst: '5',
    status: 'DELIVERED',
  },
  {
    id: '9007199254741002',
    orderId: header.id,
    productId: '101',
    name: 'Synthetic item',
    quantity: '1',
    amount: '20',
    gst: '12',
    status: 'RETURNED',
  },
  {
    id: '9007199254741003',
    orderId: header.id,
    productId: '999',
    name: null,
    quantity: '0',
    amount: '0',
    gst: '0',
    status: 'CANCELLED',
  },
];
export function manifest(
  kind: 'store-day' | 'order',
  day: string | null,
  counts: { rows: string; orders: string; stores: string; lines: string },
  digest: string,
) {
  return {
    generation_id: generation,
    contract_version: orderHistoryContract,
    kind,
    scope_id: kind === 'order' ? header.id : '1',
    business_date: day,
    source_complete: true,
    source_snapshot_id: 'synthetic-native-snapshot-0001',
    source_snapshot_at: new Date(now - 60000).toISOString(),
    source_cdc_watermark: new Date(now - 50000).toISOString(),
    published_at: new Date(now - 40000).toISOString(),
    source_rows: counts.rows,
    warehouse_rows: counts.rows,
    source_orders: counts.orders,
    warehouse_orders: counts.orders,
    source_stores: counts.stores,
    warehouse_stores: counts.stores,
    source_lines: counts.lines,
    warehouse_lines: counts.lines,
    source_hash: digest,
    warehouse_hash: digest,
    source_copy_hash: kind === 'order' ? historyCopyHash([header], stores, lines) : null,
    warehouse_copy_hash: kind === 'order' ? historyCopyHash([header], stores, lines) : null,
  };
}
export function listEnvelope() {
  const page = [...stores]
      .reverse()
      .map((store) => ({ header: structuredClone(header), store: structuredClone(store) })),
    digest = historyRowsHash(page.map((row) => historyListRowHash(row.header, row.store)));
  return {
    publications: [
      manifest(
        'store-day',
        '2026-11-15',
        { rows: '0', orders: '0', stores: '0', lines: '0' },
        historyRowsHash([]),
      ),
      manifest(
        'store-day',
        '2026-11-16',
        { rows: '2', orders: '1', stores: '2', lines: '0' },
        digest,
      ),
    ],
    actual: [
      {
        business_date: '2026-11-16',
        rows: '2',
        orders: '1',
        unique_stores: '2',
        actual_hash: digest,
      },
    ],
    page,
  };
}
export function orderEnvelope() {
  return {
    publications: [
      manifest(
        'order',
        '2026-11-16',
        { rows: '6', orders: '1', stores: '2', lines: '3' },
        historyOrderHash([header], stores, lines),
      ),
    ],
    actual: { headers: '1', stores: '2', lines: '3', unique_stores: '2', unique_lines: '3' },
    headers: [structuredClone(header)],
    stores: structuredClone(stores),
    lines: structuredClone(lines),
  };
}
export function copyEnvelope() {
  const value = orderEnvelope();
  return {
    ...value,
    headers: value.headers.map(({ id, customerId, createdAt }) => ({ id, customerId, createdAt })),
    lines: value.lines.map(({ id, orderId, productId }) => ({ id, orderId, productId })),
  };
}
