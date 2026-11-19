import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { invoiceAdapter, type InvoiceAdapter } from './adapter.js';
import { invoiceDocumentScope, invoiceKind } from './contracts.js';
import { invoiceDocumentOptions, type InvoiceDocumentOptions } from './options.js';
import { invoiceDocumentService } from './service.js';
import { invoicePreviewScope, invoicePreviewHtml, invoicePreviewPolicy } from './presentation.js';
import { auditCrossStoreLookup } from '../order-history/audit.js';

/** Legacy `store|online|online_sdd/<order_id>/invoice/` (`order/urls.py:13-15`). */
export function registerInvoiceDocuments(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: InvoiceDocumentOptions = invoiceDocumentOptions(),
  adapter: InvoiceAdapter = invoiceAdapter(config, options),
) {
  const service = invoiceDocumentService(config, db, options, adapter, (outcome) =>
    app.log.warn(
      {
        module: 'invoice-documents',
        resource: 'whatsapp-invoice',
        eventId: 'invoice-documents.whatsapp-invoice.not-sent',
        outcome,
      },
      'WhatsApp invoice message was not sent.',
    ),
  );
  const accessQuery = z.object({ access: z.literal('global-online').optional() }).strict();
  const selection = (request: FastifyRequest) =>
    invoiceDocumentScope.parse({
      ...z.object({ storeId: z.string(), orderId: z.string() }).strip().parse(request.params),
      ...accessQuery.parse(request.query),
    });
  function operator(request: FastifyRequest) {
    const user = authenticated(request);
    if (request.headers['x-operator-id'] !== user.id)
      throw new AppError(
        409,
        'OPERATOR_CHANGED',
        'The signed-in operator changed. Refresh this workspace.',
      );
    return user;
  }
  async function assertCurrentSession(request: FastifyRequest) {
    if (!request.authSessionValid && config.DEMO_MODE) return;
    if (!request.authSessionValid || !(await request.authSessionValid()))
      throw new AppError(401, 'SESSION_EXPIRED', 'Sign in again to load this invoice.');
  }
  app.get(
    '/api/v1/operators/:operatorId/stores/:storeId/orders/:orderId/invoices/:kind/preview',
    {
      config: {
        trace: { module: 'invoice-documents', resource: 'invoice-preview', action: 'read' },
      },
    },
    async (request, reply) => {
      const scope = invoicePreviewScope.parse({
          ...invoicePreviewScope.parse(request.params),
          ...accessQuery.parse(request.query),
        }),
        user = authenticated(request);
      // Frame navigations cannot set custom headers; the path actor must match the session.
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
      const document = await service.document(
        user,
        {
          storeId: scope.storeId,
          orderId: scope.orderId,
          ...(scope.access ? { access: scope.access } : {}),
        },
        scope.kind,
      );
      await assertCurrentSession(request);
      if (scope.access)
        auditCrossStoreLookup(request, 'invoice', {
          storeId: scope.storeId,
          orderId: scope.orderId,
        });
      return reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .header('Referrer-Policy', 'no-referrer')
        .header('Content-Security-Policy', invoicePreviewPolicy)
        .type('text/html; charset=utf-8')
        .send(invoicePreviewHtml(document.html, scope, document.number));
    },
  );
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/invoices/capabilities',
    {
      config: {
        trace: { module: 'invoice-documents', resource: 'invoice-capabilities', action: 'read' },
      },
    },
    async (request, reply) => {
      const user = operator(request);
      const result = await service.capabilities(user, selection(request));
      await assertCurrentSession(request);
      return reply.header('Cache-Control', 'no-store').send(result);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/invoices/:kind',
    { config: { trace: { module: 'invoice-documents', resource: 'tax-invoice', action: 'read' } } },
    async (request, reply) => {
      const user = operator(request);
      const kind = invoiceKind.parse((request.params as { kind?: unknown }).kind);
      const scope = selection(request),
        document = await service.document(user, scope, kind);
      await assertCurrentSession(request);
      if (scope.access)
        auditCrossStoreLookup(request, 'invoice', {
          storeId: scope.storeId,
          orderId: scope.orderId,
        });
      return reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .header('Referrer-Policy', 'no-referrer')
        .send(document);
    },
  );
  return service;
}
