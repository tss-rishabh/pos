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
export function orderBrowserDates(search: URLSearchParams, now = Date.now()) {
  const today = currentOrderDay(now),
    has = search.has('from') || search.has('to'),
    parsed = orderDatesSchema.safeParse({ from: search.get('from'), to: search.get('to') });
  return {
    from: parsed.success ? parsed.data.from : today,
    to: parsed.success ? parsed.data.to : today,
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
export const orderBrowseDetail = orderDetailSchema.extend({
  ...metadata,
  lines: z.array(
    z.object({
      id,
      productId: numeric,
      name: z.string().nullable(),
      quantity: z.string().regex(/^-?(0|[1-9]\d{0,18})$/),
      amount: z.number().finite(),
      gst: z.number().finite(),
      status: z.string(),
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
