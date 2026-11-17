import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerWholeOrderStatusReceiver } from '../../src/modules/legacy-order-status/receiver-routes.js';
import {
  receiptSignature,
  wholeOrderStatusContract,
} from '../../src/modules/legacy-order-status/domain.js';
import { wholeOrderStatusTransport } from '../../src/modules/legacy-order-status/transport.js';
import { options, config, command, queuedReceipt } from './fixtures.js';
export function receiverHeaders() {
  const scope = Buffer.from(
    JSON.stringify({
      contract: wholeOrderStatusContract,
      operationId: command.id,
      operatorId: command.operatorId,
      authVersion: command.authVersion,
      storeId: command.storeId,
      counterId: command.snapshot.counterId,
      scopeHash: command.scopeHash,
      requestHash: command.requestHash,
      requestId: command.requestId,
    }),
  ).toString('base64url');
  return {
    'x-api-key': options.BACKEND_SYNC_REPO_API_KEY!,
    'x-pos-status-scope': scope,
    'x-pos-status-proof': createHmac('sha256', options.WHOLE_ORDER_STATUS_RECEIPT_KEY!)
      .update('pos-whole-order-status-request-v1\0' + scope)
      .digest('base64url'),
    'idempotency-key': command.id,
  };
}
describe('private executable STORE receiver boundary', () => {
  it.each([
    {},
    { 'x-api-key': 'invalid-synthetic-key' },
    { ...receiverHeaders(), 'x-pos-status-proof': 'a'.repeat(43) },
  ])(
    'rejects absent or invalid credentials before DB work even with an authenticated cookie',
    async (headers) => {
      const app = Fastify({ logger: false }),
        accept = vi.fn(),
        read = vi.fn();
      app.setErrorHandler((error, _request, reply) =>
        reply
          .code(
            typeof error === 'object' && error !== null && 'status' in error
              ? Number(error.status)
              : 500,
          )
          .send({ code: 'SERVICE_DENIED' }),
      );
      await registerWholeOrderStatusReceiver(app, options, { accept, read, ready() {} });
      try {
        for (const method of ['GET', 'POST'] as const) {
          const response = await app.inject({
            method,
            url:
              method === 'GET'
                ? '/store-order/status/commands/' + command.id
                : '/store-order/status',
            headers: { ...headers, cookie: 'session=synthetic-valid-browser-cookie' },
            ...(method === 'POST'
              ? {
                  payload: {
                    orderId: command.orderId,
                    has_product_ids: command.snapshot.lines.map((row) => row.id),
                    platform: 'PACK',
                  },
                }
              : {}),
          });
          expect(response.statusCode).toBe(401);
        }
        expect(accept).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it('executes exact source POST and authenticated GET through the actual lossless sender and receiver', async () => {
    const app = Fastify({ logger: false }),
      accept = vi.fn(async () => queuedReceipt()),
      read = vi.fn(async () => queuedReceipt());
    await registerWholeOrderStatusReceiver(app, options, { accept, read, ready() {} });
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const response = await app.inject({
        method: init?.method === 'POST' ? 'POST' : 'GET',
        url: url.pathname.replace(/^\/api/, ''),
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(init?.body ? { payload: String(init.body) } : {}),
      });
      return new Response(response.payload, {
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
      });
    };
    try {
      const adapter = wholeOrderStatusTransport(config, options, fetcher);
      expect(await adapter.send(command)).toEqual(queuedReceipt());
      expect(accept).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: command.requestId }),
        {
          orderId: command.orderId,
          has_product_ids: command.snapshot.lines.map((row) => row.id),
          platform: 'PACK',
        },
      );
      expect(await adapter.read(command)).toEqual(queuedReceipt());
      const response = await app.inject({
        url: '/store-order/status/commands/' + command.id,
        headers: receiverHeaders(),
      });
      expect(response.headers['x-pos-status-receipt']).toBe(
        receiptSignature(options.WHOLE_ORDER_STATUS_RECEIPT_KEY!, queuedReceipt()),
      );
    } finally {
      await app.close();
    }
  });
});
