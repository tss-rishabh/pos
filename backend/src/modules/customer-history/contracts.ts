import { z } from 'zod';
import { identifier } from '../../domain/validation.js';

export const historyCount = z.string().regex(/^\d{1,30}$/),
  historyCursor = z.string().regex(/^[A-Za-z0-9_-]{1,700}\.[A-Za-z0-9_-]{43}$/);
export const historyQuery = z
  .object({
    returnBefore: historyCursor.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export const historyLineQuery = z
  .object({
    before: historyCursor.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const historySummary = z
  .object({
    exclusiveSavings: z.number().finite(),
    totalOrders: historyCount,
    totalStoreOrders: historyCount,
    totalOnlineOrders: historyCount,
    last30DaysOrders: historyCount,
    cancelledOrders: historyCount,
    returnedOrders: historyCount,
    npsScore: z.number().finite().nullable(),
  })
  .strict();
export const historyRecentOrder = z
  .object({
    id: identifier,
    orderAmount: z.number().finite(),
    createdDate: z.iso.date().nullable(),
    status: z.number().int().safe().nonnegative(),
    isStoreOrder: z.boolean(),
  })
  .strict();
export const historyReturnedOrder = z
  .object({
    id: identifier,
    orderAmount: z.number().finite(),
    itemNames: z.array(z.string().max(300)).max(2000),
    itemCount: historyCount,
    hasMoreItems: z.boolean(),
    isStoreOrder: z.boolean(),
  })
  .strict();
export const customerHistoryResponse = z
  .object({
    customerId: identifier,
    checkoutVersion: z.number().int().safe().nonnegative(),
    reader: z.literal('bigquery'),
    fetchedAt: z.iso.datetime(),
    summary: historySummary,
    recentOrders: z.array(historyRecentOrder).max(5),
    returnedOrders: z
      .object({
        items: z.array(historyReturnedOrder).max(100),
        nextCursor: historyCursor.nullable(),
      })
      .strict(),
  })
  .strict();
export const customerHistoryLinesResponse = z
  .object({
    customerId: identifier,
    checkoutVersion: z.number().int().safe().nonnegative(),
    orderId: identifier,
    items: z
      .array(
        z.object({ id: identifier, productId: identifier, name: z.string().max(300) }).strict(),
      )
      .max(100),
    nextCursor: historyCursor.nullable(),
  })
  .strict();
export type CustomerHistoryResponse = z.infer<typeof customerHistoryResponse>;
export type CustomerHistoryLinesResponse = z.infer<typeof customerHistoryLinesResponse>;
export type HistoryQuery = z.infer<typeof historyQuery>;
export type HistoryLineQuery = z.infer<typeof historyLineQuery>;
export interface HistoryCapture {
  customerId: string;
  checkoutVersion: number;
  sourceNow: string;
  binding: string;
}
