import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { positiveId, nonnegativeId, sourceDate, date } from '../contracts.js';
export const sourceSearchContract = 'pos-source-order-search-v1';
export const comparableSourceTime = (value: string) =>
  value.slice(0, 19) + '.' + value.slice(20).padEnd(6, '0');
const identifiers = z
  .array(positiveId)
  .max(1000)
  .default([])
  .transform((values) => [...new Set(values)]);
const filterIdentifiers = z
  .array(nonnegativeId)
  .max(1000)
  .default([])
  .transform((values) => [...new Set(values)]);
const timestamp = sourceDate.refine((value) => {
  try {
    Temporal.PlainDateTime.from(value.replace(' ', 'T'));
    return true;
  } catch {
    return false;
  }
});
export const orderSearchInput = z
  .object({
    orderType: z.enum(['ST', 'HL', 'HE', 'N']).default('ST'),
    storeIds: identifiers,
    orderIds: identifiers,
    from: date.optional(),
    to: date.optional(),
    placedFrom: timestamp.optional(),
    placedTo: timestamp.optional(),
    intent: z.enum(['interactive', 'report']).default('interactive'),
    mobile: z
      .string()
      .max(32)
      .regex(/^[+0-9 ()-]*$/)
      .default(''),
    email: z
      .string()
      .max(96)
      .regex(/^[^\u0000-\u001f\u007f]*$/)
      .default(''),
    paymentMethodIds: filterIdentifiers,
    paymentStatusIds: filterIdentifiers,
    orderStatusIds: filterIdentifiers,
    notPacked: z.boolean().default(false),
    inQueue: z.boolean().default(false),
    search: z.string().max(100).default(''),
    sort: z
      .object({
        field: z.enum([
          'id',
          'user_id',
          'user__firstname',
          'payment_statuses__payment_status',
          'payment_methods__name',
          'order_amt',
          'order_statuses',
          'created_at',
        ]),
        direction: z.enum(['asc', 'desc']).default('desc'),
      })
      .strict()
      .default({ field: 'id', direction: 'desc' }),
    page: z.number().int().min(1).max(2147483647).default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
    draw: z.number().int().min(0).max(2147483647).default(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.from) !== Boolean(value.to))
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'Supply both calendar dates.' });
    if (Boolean(value.placedFrom) !== Boolean(value.placedTo))
      ctx.addIssue({
        code: 'custom',
        path: ['placedFrom'],
        message: 'Supply both placement timestamps.',
      });
    if (
      value.placedFrom &&
      value.placedTo &&
      comparableSourceTime(value.placedFrom) > comparableSourceTime(value.placedTo)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['placedTo'],
        message: 'The end timestamp precedes the start.',
      });
  });
export type OrderSearchInput = z.infer<typeof orderSearchInput>;
export type OrderSearchRequest = z.input<typeof orderSearchInput>;
export interface SourceStore {
  id: string;
  orderId: string;
  storeId: string;
  counterId: string;
  storeName: string | null;
  counterName: string | null;
  locationCode: string | null;
  storeExists: boolean;
  counterExists: boolean;
  cash: string;
  onlineOther: string;
  manuallyPaid: boolean;
  offline: boolean;
  shopify: boolean;
}
export interface SourceTerminal {
  inactiveCreated: number;
  activeCreated: { reference: string } | null;
  completedMode: number | null;
}
export interface SourceOrder {
  id: string;
  reference: string;
  userId: string;
  customer: { id: string; first: string; last: string } | null;
  orderAmount: number;
  payAmount: number;
  createdAt: string;
  method: { id: string; name: string | null } | null;
  methodId: string | null;
  paymentStatus: { id: string; label: string } | null;
  paymentStatusId: string | null;
  status: { id: string; label: string } | null;
  statusId: string | null;
  locationId: string | null;
  locationType: string;
  locationStoreId: string | null;
  locationLabel: string | null;
  transfer: boolean;
  nextLocations: string;
  global: number;
  stores: SourceStore[];
  expressStoreIds: string[];
  terminal: SourceTerminal;
  paytm: SourceTerminal;
  isRevert: boolean;
  phoneKey: string;
  userPhoneKey: string | null;
  emailKey: string | null;
  userFirstKey: string | null;
  methodKey: string | null;
  paymentKey: string | null;
}
export interface SourceOrderRow {
  rowKey: string;
  id: string;
  user_id: string;
  user__firstname: string;
  payment_statuses__payment_status: string;
  payment_methods__name: string | null;
  payment_methods__id: string;
  order_amt: number;
  order_statuses: string;
  created_at: string;
  store_name: string | null;
  counter_id: string;
  location_code: string | null;
  is_manually_paid: boolean;
  is_offline_order: boolean;
  is_shopify_order: boolean;
  is_uploaded: 0 | 1;
  transaction_id: string;
  plutus_id: string;
  paytm_mid: string;
  pay_amount: number;
  is_revert: boolean;
  DT_RowId: string;
  is_global_order: number;
  actionStoreId: string | null;
}
export interface SourceSearchScope {
  contextStoreId: string;
  checkedInStoreId: string | null;
  allowedStores: string[];
  internal: boolean;
  globalReader: boolean;
  binding: string;
  effectiveType: 'ST' | 'HL' | 'HE' | 'N';
  selectedStores: string[];
  explicitIds: boolean;
  heLocationLabel: string | null;
}
export interface SourceSearchPage {
  emptySelection?: true;
  contract: typeof sourceSearchContract;
  draw: number;
  recordsTotal: string;
  recordsFiltered: string;
  page: number;
  pageSize: number;
  reader: 'primary' | 'data' | 'bigquery' | 'mixed';
  data: SourceOrderRow[];
  fetchedAt: string;
  range: { from: string; to: string; timeZone: string; ignoredForQueue: boolean };
  generationId: string | null;
}
export const sourceRowSchema = z
  .object({
    rowKey: z.string().min(1).max(128),
    id: positiveId,
    user_id: nonnegativeId,
    user__firstname: z.string(),
    payment_statuses__payment_status: z.string(),
    payment_methods__name: z.string().nullable(),
    payment_methods__id: nonnegativeId,
    order_amt: z.number().finite(),
    order_statuses: z.string(),
    created_at: sourceDate,
    store_name: z.string().nullable(),
    counter_id: nonnegativeId,
    location_code: z.string().nullable(),
    is_manually_paid: z.boolean(),
    is_offline_order: z.boolean(),
    is_shopify_order: z.boolean(),
    is_uploaded: z.union([z.literal(0), z.literal(1)]),
    transaction_id: z.string(),
    plutus_id: z.string(),
    paytm_mid: z.string(),
    pay_amount: z.number().finite(),
    is_revert: z.boolean(),
    DT_RowId: positiveId,
    is_global_order: z.number().int(),
    actionStoreId: positiveId.nullable(),
  })
  .strict();
