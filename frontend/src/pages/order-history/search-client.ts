import { z } from 'zod';
import { request } from '../../api/client';
const id = z.string().regex(/^[1-9]\d{0,18}$/),
  zero = z.string().regex(/^(?:0|[1-9]\d{0,18})$/);
export const sourceOrderRow = z
  .object({
    rowKey: z.string().min(1).max(128),
    id,
    user_id: zero,
    user__firstname: z.string().max(511),
    payment_statuses__payment_status: z.string().max(255),
    payment_methods__name: z.string().max(1024).nullable(),
    payment_methods__id: zero,
    order_amt: z.number().finite(),
    order_statuses: z.string().max(255),
    created_at: z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?$/),
    store_name: z.string().max(1024).nullable(),
    counter_id: zero,
    location_code: z.string().max(1024).nullable(),
    is_manually_paid: z.boolean(),
    is_offline_order: z.boolean(),
    is_shopify_order: z.boolean(),
    is_uploaded: z.union([z.literal(0), z.literal(1)]),
    transaction_id: z.string().max(1024),
    plutus_id: z.string().max(255),
    paytm_mid: z.string().max(255),
    pay_amount: z.number().finite(),
    is_revert: z.boolean(),
    DT_RowId: id,
    is_global_order: z.number().int(),
    actionStoreId: id.nullable(),
  })
  .strict();
export type SourceOrderRow = z.infer<typeof sourceOrderRow>;
export const orderSearchPage = z
  .object({
    emptySelection:z.literal(true).optional(),
    contract: z.literal('pos-source-order-search-v1'),
    draw: z.number().int(),
    recordsTotal: zero,
    recordsFiltered: zero,
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
    reader: z.enum(['primary', 'data', 'bigquery', 'mixed']),
    data: z.array(sourceOrderRow).max(100),
    fetchedAt: z.iso.datetime({ offset: true }),
    range: z
      .object({
        from: z.iso.date(),
        to: z.iso.date(),
        timeZone: z.string(),
        ignoredForQueue: z.boolean(),
      })
      .strict(),
    generationId: z.uuid().nullable(),
  })
  .strict();
const option = z.object({ id: zero, name: z.string().nullable() }).strict();
export const orderSearchOptions = z
  .object({
    stores: z.array(
      z.object({ id, name: z.string().nullable(), locationCode: z.string().nullable() }).strict(),
    ),
    methods: z.array(option),
    paymentStatuses: z.array(option),
    orderStatuses: z.array(option),
    orderTypes: z.array(z.enum(['ST', 'HL', 'HE', 'N'])),
    checkedInStoreId: id.nullable(),
  })
  .strict();
export type SearchSort =
  | 'id'
  | 'user_id'
  | 'user__firstname'
  | 'payment_statuses__payment_status'
  | 'payment_methods__name'
  | 'order_amt'
  | 'order_statuses'
  | 'created_at';
export interface OrderSearchBody {
  orderType: 'ST' | 'HL' | 'HE' | 'N';
  storeIds: string[];
  orderIds: string[];
  from?: string;
  to?: string;
  placedFrom?: string;
  placedTo?: string;
  mobile: string;
  email: string;
  paymentMethodIds: string[];
  paymentStatusIds: string[];
  orderStatusIds: string[];
  notPacked: boolean;
  inQueue: boolean;
  search: string;
  sort: { field: SearchSort; direction: 'asc' | 'desc' };
  page: number;
  pageSize: number;
  draw: number;
}
export function searchOrders(
  ownerId: string,
  storeId: string,
  body: OrderSearchBody,
  signal: AbortSignal,
) {
  return request(
    `/api/v1/stores/${storeId}/orders/searches`,
    {
      operatorId: ownerId,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal,
    },
    orderSearchPage,
  );
}
export function sourcePageCsv(
  rows: readonly SourceOrderRow[],
  columns: readonly (keyof SourceOrderRow)[],
) {
  const cell = (value: unknown) => {
    const text = String(value ?? '');
    return (
      '"' +
      (typeof value !== 'number' && /^[\s]*[=+\-@\t\r]/.test(text) ? "'" + text : text).replaceAll(
        '"',
        '""',
      ) +
      '"'
    );
  };
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((key) => cell(row[key])).join(',')),
  ].join('\r\n');
}
