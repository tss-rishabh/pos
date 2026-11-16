import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { customerProfileScope, type CustomerProfileScope } from '../customer-insights/contracts.js';
import { historyCapture, type HistoryCaptureFn } from './capture.js';
import {
  customerHistoryResponse,
  customerHistoryLinesResponse,
  historySummary,
  historyRecentOrder,
  historyReturnedOrder,
  historyQuery,
  historyLineQuery,
  type HistoryCapture,
} from './contracts.js';
import { customerHistoryGateway, type HistoryGateway } from './gateway.js';
const positive = identifier.refine((value) => BigInt(value) <= 9223372036854775807n),
  resultSchema = z
    .object({
      summary: historySummary,
      recentOrders: z.array(historyRecentOrder).max(5),
      returnedRows: z.array(historyReturnedOrder).max(101),
    })
    .strict(),
  linesSchema = z
    .object({
      orderFound: z.boolean(),
      items: z
        .array(z.object({ id: positive, productId: positive, name: z.string().max(300) }).strict())
        .max(101),
    })
    .strict();
const invalid = () =>
  new AppError(
    503,
    'CUSTOMER_HISTORY_DATA_INVALID',
    'Historical customer data does not match its projection contract.',
  );
export function customerHistoryService(
  config: Config,
  db: Databases,
  dependencies: { capture?: HistoryCaptureFn; gateway?: HistoryGateway; clock?: () => Date } = {},
) {
  const capture = dependencies.capture || historyCapture(config, db),
    gateway = dependencies.gateway || customerHistoryGateway(config),
    clock = dependencies.clock || (() => new Date());
  function cursor(kind: string, context: HistoryCapture, anchor: string) {
    const payload = Buffer.from(
      JSON.stringify([1, kind, context.binding, positive.parse(anchor)]),
    ).toString('base64url');
    return (
      payload +
      '.' +
      createHmac('sha256', config.SESSION_SECRET).update(payload).digest('base64url')
    );
  }
  function before(value: string | undefined, kind: string, context: HistoryCapture) {
    if (!value) return '';
    try {
      const [payload, signature, ...extra] = value.split('.');
      if (!payload || !signature || extra.length) throw new Error('INVALID');
      const expected = createHmac('sha256', config.SESSION_SECRET).update(payload).digest(),
        received = Buffer.from(signature, 'base64url');
      if (
        received.toString('base64url') !== signature ||
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      )
        throw new Error('INVALID');
      const parsed = z
        .tuple([z.literal(1), z.literal(kind), z.literal(context.binding), positive])
        .parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown);
      return parsed[3];
    } catch {
      throw new AppError(
        400,
        'INVALID_CUSTOMER_HISTORY_CURSOR',
        'Reopen customer history before continuing this page.',
      );
    }
  }
  async function recheck(user: Principal, scope: CustomerProfileScope, initial: HistoryCapture) {
    const current = await capture(user, scope);
    if (
      current.customerId !== initial.customerId ||
      current.checkoutVersion !== initial.checkoutVersion ||
      current.binding !== initial.binding
    )
      throw new AppError(
        409,
        'CUSTOMER_HISTORY_CONTEXT_CHANGED',
        'This sale changed. Reopen customer history.',
      );
    return current;
  }
  return {
    async read(user: Principal, scope: CustomerProfileScope, value: unknown = {}) {
      customerProfileScope.parse(scope);
      const input = historyQuery.parse(value),
        initial = await capture(user, scope),
        anchor = before(input.returnBefore, 'orders', initial),
        raw = await gateway.read(initial.customerId, initial.sourceNow, anchor, input.limit),
        current = await recheck(user, scope, initial),
        parsed = resultSchema.safeParse(raw);
      if (!parsed.success) throw invalid();
      const rows = parsed.data.returnedRows;
      if (
        rows.some(
          (row, index) =>
            (anchor && BigInt(row.id) >= BigInt(anchor)) ||
            (index > 0 && BigInt(row.id) >= BigInt(rows[index - 1]!.id)),
        )
      )
        throw invalid();
      const items = rows.slice(0, input.limit);
      return customerHistoryResponse.parse({
        customerId: current.customerId,
        checkoutVersion: current.checkoutVersion,
        reader: 'bigquery',
        fetchedAt: clock().toISOString(),
        summary: parsed.data.summary,
        recentOrders: parsed.data.recentOrders,
        returnedOrders: {
          items,
          nextCursor:
            rows.length > input.limit ? cursor('orders', current, items.at(-1)!.id) : null,
        },
      });
    },
    async lines(
      user: Principal,
      scope: CustomerProfileScope,
      orderId: string,
      value: unknown = {},
    ) {
      customerProfileScope.parse(scope);
      positive.parse(orderId);
      const input = historyLineQuery.parse(value),
        initial = await capture(user, scope),
        kind = 'lines:' + orderId,
        anchor = before(input.before, kind, initial),
        raw = await gateway.lines(initial.customerId, orderId, anchor, input.limit),
        current = await recheck(user, scope, initial),
        parsed = linesSchema.safeParse(raw);
      if (!parsed.success) throw invalid();
      if (!parsed.data.orderFound)
        throw new AppError(
          404,
          'CUSTOMER_HISTORY_ORDER_NOT_FOUND',
          'Order not found for this customer.',
        );
      const rows = parsed.data.items;
      if (
        rows.some(
          (row, index) =>
            (anchor && BigInt(row.id) >= BigInt(anchor)) ||
            (index > 0 && BigInt(row.id) >= BigInt(rows[index - 1]!.id)),
        )
      )
        throw invalid();
      const items = rows.slice(0, input.limit);
      return customerHistoryLinesResponse.parse({
        customerId: current.customerId,
        checkoutVersion: current.checkoutVersion,
        orderId,
        items,
        nextCursor: rows.length > input.limit ? cursor(kind, current, items.at(-1)!.id) : null,
      });
    },
  };
}
