import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { positiveId, type OrderReadRange } from './contracts.js';
const value = z
  .object({
    v: z.literal(1),
    actor: positiveId,
    store: positiveId,
    from: z.string(),
    to: z.string(),
    intent: z.string(),
    reader: z.string(),
    generation: z.uuid().nullable(),
    order: positiveId,
    row: positiveId,
    expires: z.number().int().safe().positive(),
  })
  .strict();
export interface OrderCursorScope {
  actor: string;
  store: string;
  range: OrderReadRange;
}
export function orderCursors(secret: string | undefined, clock = Date.now) {
  function sign(payload: string) {
    if (!secret)
      throw new AppError(
        503,
        'ORDER_READER_CONFIGURATION_REQUIRED',
        'Order pagination needs the configured application authority.',
      );
    return createHmac('sha256', secret)
      .update('public-order-page:' + payload)
      .digest();
  }
  return {
    encode(
      scope: OrderCursorScope,
      anchor: { orderId: string; rowId: string },
      generation: string | null,
    ) {
      const payload = Buffer.from(
        JSON.stringify(
          value.parse({
            v: 1,
            actor: scope.actor,
            store: scope.store,
            from: scope.range.from,
            to: scope.range.to,
            intent: scope.range.intent,
            reader: scope.range.reader,
            generation,
            order: anchor.orderId,
            row: anchor.rowId,
            expires: clock() + 900000,
          }),
        ),
      ).toString('base64url');
      return payload + '.' + sign(payload).toString('base64url');
    },
    decode(token: string | undefined, scope: OrderCursorScope) {
      if (!token) return undefined;
      try {
        // Older current-day callers used an order-ID-only boundary. Keep that
        // bounded compatibility input; every newly emitted cursor is signed.
        if (scope.range.reader !== 'bigquery' && /^[1-9]\d{0,18}$/.test(token))
          return { orderId: positiveId.parse(token), rowId: '0', generationId: undefined };
        if (token.length > 2048) throw new Error('Invalid');
        const [payload, signature, ...extra] = token.split('.');
        if (!payload || !signature || extra.length) throw new Error('Invalid');
        const expected = sign(payload),
          received = Buffer.from(signature, 'base64url');
        if (
          received.length !== expected.length ||
          received.toString('base64url') !== signature ||
          !timingSafeEqual(received, expected)
        )
          throw new Error('Invalid');
        const decoded = value.parse(
          JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown,
        );
        if (
          decoded.actor !== scope.actor ||
          decoded.store !== scope.store ||
          decoded.from !== scope.range.from ||
          decoded.to !== scope.range.to ||
          decoded.reader !== scope.range.reader ||
          decoded.intent !== scope.range.intent ||
          decoded.expires <= clock() ||
          decoded.expires > clock() + 900000
        )
          throw new Error('Invalid');
        return {
          orderId: decoded.order,
          rowId: decoded.row,
          generationId: decoded.generation ?? undefined,
        };
      } catch {
        throw new AppError(
          400,
          'INVALID_ORDER_CURSOR',
          'Refresh this store and date selection before loading another page.',
        );
      }
    },
  };
}
