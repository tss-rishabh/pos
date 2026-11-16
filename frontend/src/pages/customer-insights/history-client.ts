import { z } from 'zod';
import { captureOperatorScope } from '../../api/client';
import { recordCustomerHistoryPerformance } from '../../offline/performance/storage';
import { customerWorkspaceBase, customerWorkspaceRequest, type ProfileScope } from './client';

const id = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine((value) => /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n);
const count = z.string().regex(/^(?:0|[1-9]\d{0,19})$/);
const continuation = z.string().regex(/^[A-Za-z0-9_-]{1,700}\.[A-Za-z0-9_-]{43}$/);
export interface HistoryCursor {
  token: string;
  anchorId: string;
}
const amount = z.number().finite();
const recentOrder = z
  .object({
    id,
    orderAmount: amount,
    createdDate: z.iso.date().nullable(),
    status: z.number().int(),
    isStoreOrder: z.boolean(),
  })
  .strict();
export const customerHistoryResponse = z
  .object({
    customerId: id,
    checkoutVersion: z.number().int().nonnegative(),
    reader: z.literal('bigquery'),
    fetchedAt: z.iso.datetime(),
    summary: z
      .object({
        exclusiveSavings: amount,
        totalOrders: count,
        totalStoreOrders: count,
        totalOnlineOrders: count,
        last30DaysOrders: count,
        cancelledOrders: count,
        returnedOrders: count,
        npsScore: amount.nullable(),
      })
      .strict(),
    recentOrders: z.array(recentOrder).max(5),
    returnedOrders: z
      .object({
        items: z
          .array(
            z
              .object({
                id,
                orderAmount: amount,
                itemNames: z.array(z.string().max(300)).max(2000),
                itemCount: count,
                hasMoreItems: z.boolean(),
                isStoreOrder: z.boolean(),
              })
              .strict(),
          )
          .max(100),
        nextCursor: continuation.nullable(),
      })
      .strict(),
  })
  .strict();
export const customerOrderLinesResponse = z
  .object({
    customerId: id,
    checkoutVersion: z.number().int().nonnegative(),
    orderId: id,
    items: z.array(z.object({ id, productId: id, name: z.string().max(300) }).strict()).max(100),
    nextCursor: continuation.nullable(),
  })
  .strict();
export type CustomerHistory = z.infer<typeof customerHistoryResponse>;

function assertScope(
  scope: ProfileScope,
  version: number,
  response: { customerId: string; checkoutVersion: number },
) {
  if (response.customerId !== scope.customerId || response.checkoutVersion !== version)
    throw new Error('This sale changed. Reopen customer history.');
}
function assertPage(
  items: readonly { id: string }[],
  nextCursor: string | null,
  before: HistoryCursor | undefined,
) {
  if (
    (nextCursor !== null && (!items.length || nextCursor === before?.token)) ||
    items.some(
      (row, index) =>
        (before !== undefined && BigInt(row.id) >= BigInt(id.parse(before.anchorId))) ||
        (index > 0 && BigInt(row.id) >= BigInt(items[index - 1]!.id)),
    )
  )
    throw new Error('The historical page could not be verified. Refresh customer history.');
}
export async function readCustomerHistory(
  scope: ProfileScope,
  version: number,
  before: HistoryCursor | undefined,
  signal: AbortSignal,
) {
  const actor = captureOperatorScope(scope.operatorId),
    started = performance.now();
  const query = new URLSearchParams({
    limit: '25',
    ...(before ? { returnBefore: continuation.parse(before.token) } : {}),
  });
  const result = await customerWorkspaceRequest(
    scope,
    customerWorkspaceBase(scope) + '/customer-history?' + query,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) },
    customerHistoryResponse,
  );
  assertScope(scope, version, result);
  assertPage(result.returnedOrders.items, result.returnedOrders.nextCursor, before);
  try {
    await recordCustomerHistoryPerformance(
      scope.operatorId,
      scope.storeId,
      scope.checkoutId,
      version,
      performance.now() - started,
      { signal: AbortSignal.any([signal, actor]) },
    );
  } catch {
    /* Keep valid history available when optional local timing is unavailable. */
  }
  signal.throwIfAborted();
  actor.throwIfAborted();
  return result;
}
export async function readCustomerOrderLines(
  scope: ProfileScope,
  version: number,
  orderId: string,
  before: HistoryCursor | undefined,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({
    limit: '50',
    ...(before ? { before: continuation.parse(before.token) } : {}),
  });
  const result = await customerWorkspaceRequest(
    scope,
    customerWorkspaceBase(scope) +
      '/customer-orders/' +
      encodeURIComponent(id.parse(orderId)) +
      '/lines?' +
      query,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) },
    customerOrderLinesResponse,
  );
  assertScope(scope, version, result);
  if (result.orderId !== orderId)
    throw new Error('The order items could not be verified for this customer.');
  assertPage(result.items, result.nextCursor, before);
  return result;
}
