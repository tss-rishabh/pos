import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { invoiceDocumentScope } from './contracts.js';
import { invoiceDocumentOptions, type InvoiceDocumentOptions } from './options.js';
import { onlineInvoiceService } from './service.js';
import { scopedInvoiceService } from './scoped-service.js';
import { invoiceCapabilities } from './capabilities.js';
import { invoiceService } from '../checkout/invoices.js';
import { invoicePreviewScope, invoicePreviewHtml, invoicePreviewPolicy } from './presentation.js';

export function registerInvoiceDocuments(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: InvoiceDocumentOptions = invoiceDocumentOptions(),
  fetcher: typeof fetch = fetch,
) {
  async function assertCurrentSession(request: FastifyRequest) {
    if (!request.authSessionValid && config.DEMO_MODE) return;
    if (!request.authSessionValid || !(await request.authSessionValid()))
      throw new AppError(401, 'SESSION_EXPIRED', 'Sign in again to load this invoice.');
  }
  const read = onlineInvoiceService(db, config, options, fetcher);
  const readScoped = scopedInvoiceService(db, config, options, fetcher);
  const capabilities = invoiceCapabilities(db, options);
  const readStore = invoiceService(db, config, options, fetcher);
  app.get(
    '/api/v1/operators/:operatorId/stores/:storeId/orders/:orderId/invoices/:kind/preview',
    { config: { trace: { module: 'checkout', resource: 'invoice-preview', action: 'read' } } },
    async (request, reply) => {
      const scope = invoicePreviewScope.parse(request.params),
        user = authenticated(request);
      // Browser frame navigations cannot set custom headers. The captured actor
      // is asserted by the path and MUST match the fresh revocable cookie identity.
      if (
        scope.operatorId !== user.id ||
        (request.headers['x-operator-id'] !== undefined &&
          request.headers['x-operator-id'] !== user.id)
      )
        throw new AppError(
          409,
          'OPERATOR_CHANGED',
          'The signed-in operator changed. Refresh this workspace.',
        );
      z.object({}).strict().parse(request.query);
      reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .header('Referrer-Policy', 'no-referrer')
        .header('Content-Security-Policy', invoicePreviewPolicy);
      const document =
        scope.kind === 'store'
          ? await readStore(user, scope.storeId, scope.orderId)
          : scope.kind === 'online'
            ? await read(user, { storeId: scope.storeId, orderId: scope.orderId })
            : await readScoped(
                user,
                { storeId: scope.storeId, orderId: scope.orderId },
                scope.kind,
              );
      await assertCurrentSession(request);
      return reply
        .type('text/html; charset=utf-8')
        .send(invoicePreviewHtml(document.html, scope, document.number));
    },
  );
  for (const preview of [false, true])
    app.get(
      `/api/v1/stores/:storeId/orders/:orderId/invoices/online${preview ? '/preview' : ''}`,
      {
        config: {
          trace: {
            module: 'checkout',
            resource: 'online-tax-invoice',
            action: preview ? 'preview' : 'read',
          },
        },
      },
      async (request, reply) => {
        const user = authenticated(request);
        if (request.headers['x-operator-id'] !== user.id)
          throw new AppError(
            409,
            'OPERATOR_CHANGED',
            'The signed-in operator changed. Refresh this workspace.',
          );
        z.object({}).strict().parse(request.query);
        const document = await read(user, invoiceDocumentScope.parse(request.params));
        await assertCurrentSession(request);
        reply
          .header('Cache-Control', 'no-store')
          .header('Pragma', 'no-cache')
          .header('Referrer-Policy', 'no-referrer');
        if (!preview) return document;
        return reply
          .header(
            'Content-Security-Policy',
            "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-same-origin allow-modals",
          )
          .type('text/html; charset=utf-8')
          .send(document.html);
      },
    );
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/invoices/capabilities',
    { config: { trace: { module: 'checkout', resource: 'invoice-capabilities', action: 'read' } } },
    async (request, reply) => {
      const user = authenticated(request);
      if (request.headers['x-operator-id'] !== user.id)
        throw new AppError(
          409,
          'OPERATOR_CHANGED',
          'The signed-in operator changed. Refresh this workspace.',
        );
      z.object({}).strict().parse(request.query);
      reply.header('Cache-Control', 'no-store');
      const result = await capabilities(user, invoiceDocumentScope.parse(request.params));
      await assertCurrentSession(request);
      return result;
    },
  );
  for (const kind of ['same-day', 'express'] as const)
    app.get(
      `/api/v1/stores/:storeId/orders/:orderId/invoices/${kind}`,
      {
        config: {
          trace: {
            module: 'checkout',
            resource: kind === 'express' ? 'express-tax-invoice' : 'same-day-tax-invoice',
            action: 'read',
          },
        },
      },
      async (request, reply) => {
        const user = authenticated(request);
        if (request.headers['x-operator-id'] !== user.id)
          throw new AppError(
            409,
            'OPERATOR_CHANGED',
            'The signed-in operator changed. Refresh this workspace.',
          );
        z.object({}).strict().parse(request.query);
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        const result = await readScoped(user, invoiceDocumentScope.parse(request.params), kind);
        await assertCurrentSession(request);
        return result;
      },
    );
  return read;
}
