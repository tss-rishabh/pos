import type { OrderDefaultRanges } from './search-client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { params, request } from '../../api/client';
import { orderSchema, orderDetailSchema } from '../../api/schemas';
const id = z.string().regex(/^[1-9]\d{0,18}$/),
  numeric = z.string().regex(/^(0|[1-9]\d{0,18})$/);
export const orderDatesSchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .strict()
  .refine((value) => value.from <= value.to, 'End date must follow start date.');
export function currentOrderDay(now = Date.now(), timeZone = 'Asia/Kolkata') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (kind: string) => parts.find((part) => part.type === kind)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function orderBrowserDates(
  search: URLSearchParams,
  now = Date.now(),
  defaults?: OrderDefaultRanges,
) {
  const today = currentOrderDay(now),
    has = search.has('from') || search.has('to'),
    parsed = orderDatesSchema.safeParse({ from: search.get('from'), to: search.get('to') });
  return {
    from: parsed.success ? parsed.data.from : (defaults?.store.placedFrom.slice(0, 10) ?? today),
    to: parsed.success ? parsed.data.to : (defaults?.store.placedTo.slice(0, 10) ?? today),
    explicit: has,
    valid: !has || parsed.success,
  };
}
const range = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    timeZone: z.string().min(1),
    reader: z.enum(['primary', 'data', 'bigquery']),
  })
  .passthrough();
const metadata = {
  reader: z.enum(['primary', 'data', 'bigquery']).optional(),
  range: range.optional(),
  fetchedAt: z.iso.datetime({ offset: true }).optional(),
};
export const orderBrowsePage = z.object({
  data: z.array(orderSchema.extend({ rowId: id.optional() })),
  nextCursor: z
    .string()
    .max(2048)
    .regex(/^(?:[1-9]\d*|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43})$/)
    .nullable(),
  ...metadata,
});
const status = z.object({ id: numeric, label: z.string() }).strict();
/** Legacy `ShowOrderDetailsView` context (`order/views.py:351-501`). */
export const storeOrderLegacy = z
  .object({
    crossAccess: z.boolean(),
    customer: z
      .object({
        id: numeric,
        firstName: z.string(),
        lastName: z.string(),
        email: z.string(),
        telephone: z.string(),
        tssMoney: z.string(),
        tssPoints: z.string(),
      })
      .strict()
      .nullable(),
    exclusive: z
      .object({ member: z.boolean(), expiry: z.string().nullable(), message: z.string() })
      .strict(),
    paymentStatus: status.nullable(),
    paymentMethod: z.object({ id: numeric, name: z.string().nullable() }).strict().nullable(),
    orderStatus: status.nullable(),
    storeName: z.string(),
    isOfflineOrder: z.boolean(),
    isShopifyOrder: z.boolean(),
    orderMessage: z.string(),
    isManuallyPaid: z.boolean(),
    counterId: numeric,
    transactionId: z.string(),
    isUploaded: z.boolean(),
    plutusId: z.string(),
    paytmMid: z.string(),
    showMarkPaymentPopUp: z.boolean(),
    totalItems: z.number().int(),
    giftVouchers: z.array(z.object({ id, giftCardSrno: numeric }).strict()),
    vincStatus: z.record(
      z.enum(['CREATE', 'PACK', 'SHIP', 'DELIVER']),
      z.object({ status: z.string(), date: z.string() }).strict(),
    ),
    isFranchiseeOrder: z.boolean(),
    isSuperAdmin: z.boolean(),
    isAtStore: z.boolean(),
    checkedInStoreId: id.nullable(),
    exchangeFeatureEnabled: z.boolean(),
    reasons: z.array(z.object({ id, reason: z.string() }).strict()),
    transactionLog: z.array(
      z
        .object({
          storeId: numeric,
          orderStatus: z.string(),
          paymentStatus: z.string(),
          comment: z.string(),
          createdAt: z.string(),
          payments: z.array(
            z.object({ method: z.string(), value: z.string().nullable() }).strict(),
          ),
        })
        .strict(),
    ),
    cashback: z.null(),
  })
  .strict();
export type StoreOrderLegacy = z.infer<typeof storeOrderLegacy>;
export const orderBrowseDetail = orderDetailSchema.extend({
  ...metadata,
  orderAmount: z.number().finite().optional(),
  legacy: storeOrderLegacy.optional(),
  lines: z.array(
    z.object({
      id,
      productId: numeric,
      name: z.string().nullable(),
      quantity: z.string().regex(/^-?(0|[1-9]\d{0,18})$/),
      amount: z.number().finite(),
      gst: z.number().finite(),
      status: z.string().nullable(),
      erpProduct: z.string().optional(),
      productType: numeric.optional(),
      parentProductId: numeric.optional(),
      giftVoucherId: numeric.optional(),
      returnStatus: z.number().int().optional(),
    }),
  ),
});
export function orderDateQuery(selection: { from: string; to: string } | undefined) {
  return selection ? params(selection) : '';
}
export function useOrderBrowse(
  ownerId: string,
  storeId: string,
  selection: { from: string; to: string },
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: [ownerId, 'orders', storeId, selection.from, selection.to],
    initialPageParam: null as string | null,
    enabled: enabled && Boolean(storeId),
    retry: false,
    staleTime: 0,
    queryFn: async ({ pageParam, signal }) => {
      const result = await request(
        `/api/v1/stores/${storeId}/orders?` +
          params({ ...selection, before: pageParam ?? undefined, limit: '30' }),
        { operatorId: ownerId, signal, cache: 'no-store' },
        orderBrowsePage,
      );
      if (result.nextCursor && (result.nextCursor === pageParam || !result.data.length))
        throw new Error('Refresh the order dates before continuing this page.');
      return result;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
