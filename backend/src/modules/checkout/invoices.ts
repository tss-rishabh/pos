import sanitizeHtml from 'sanitize-html';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { Order, OrderStore } from '../../db/legacy-schema.js';
import { authenticated } from '../../auth/routes.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import { boundedText } from '../../domain/http-json.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { currentRequestTrace } from '../../observability/context.js';
import { assertCurrentStoreAccess } from '../administration/authorization.js';
import {
  assertInvoiceResponseProof,
  feedbackProofContract,
  invoiceSecurityContract,
  type InvoiceProofScope,
} from './invoice-security.js';

export interface InvoiceEnvironment {
  storeUrl?: string;
  serviceKey?: string;
  securityContract?: string;
  feedbackContract?: string;
}
export function invoiceEnvironment(env: NodeJS.ProcessEnv = process.env): InvoiceEnvironment {
  const value = z
    .object({
      TSS_STORE_INVOICE_URL: z.url().optional(),
      TSS_POS_INVOICE_KEY: z
        .string()
        .regex(/^[!-~]{32,4096}$/)
        .optional(),
      UPSTREAM_POS_INVOICE_CONTRACT: z.string().optional(),
      UPSTREAM_POS_FEEDBACK_PROOF_CONTRACT: z.string().optional(),
    })
    .parse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')));
  return {
    storeUrl: value.TSS_STORE_INVOICE_URL,
    serviceKey: value.TSS_POS_INVOICE_KEY,
    securityContract: value.UPSTREAM_POS_INVOICE_CONTRACT,
    feedbackContract: value.UPSTREAM_POS_FEEDBACK_PROOF_CONTRACT,
  };
}
export function sanitizeInvoiceHtml(source: string): string {
  const clean = sanitizeHtml(source, {
    allowedTags: [
      'div',
      'section',
      'article',
      'header',
      'footer',
      'main',
      'p',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'span',
      'strong',
      'b',
      'em',
      'i',
      'small',
      'br',
      'hr',
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'td',
      'th',
      'caption',
      'colgroup',
      'col',
      'ul',
      'ol',
      'li',
      'dl',
      'dt',
      'dd',
      'sup',
      'sub',
      'img',
      'pre',
    ],
    allowedAttributes: {
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan', 'scope'],
      img: ['src', 'alt', 'width', 'height'],
    },
    allowedSchemes: ['data'],
    allowProtocolRelative: false,
    transformTags: {
      img: (_tag, attributes) => {
        const attribs: Record<string, string> = {};
        if (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(attributes.src || ''))
          attribs.src = attributes.src!;
        if (attributes.alt) attribs.alt = attributes.alt;
        for (const name of ['width', 'height'])
          if (/^\d{1,4}$/.test(attributes[name] || '')) attribs[name] = attributes[name]!;
        return { tagName: 'img', attribs };
      },
    },
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="pos-invoice" content="sanitized"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; script-src 'none'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tax invoice</title><style>body{font:12px/1.5 system-ui,sans-serif;color:#161616;margin:24px}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}h1,h2,h3,p{margin:8px 0}img{max-width:100%;height:auto}pre{white-space:pre-wrap}@media print{body{margin:0}thead{display:table-header-group}tr,img{break-inside:avoid}}</style></head><body>${clean}</body></html>`;
}
export function invoiceService(
  db: Databases,
  config: Config,
  environment: InvoiceEnvironment,
  fetcher: typeof fetch = fetch,
) {
  return async function invoice(user: Principal, storeId: string, orderId: string) {
    requireStore(user, storeId);
    const currentOrder = () =>
      db.get('writer').transaction(async (transaction) => {
        await assertCurrentStoreAccess(transaction, user.id, storeId);
        const [order] = await transaction
          .select({ number: OrderStore.order_invoice, paymentStatus: Order.payment_statuses })
          .from(OrderStore)
          .innerJoin(Order, eq(Order.id, OrderStore.order))
          .where(and(eq(OrderStore.store, BigInt(storeId)), eq(OrderStore.order, BigInt(orderId))))
          .limit(1);
        if (!order)
          throw new AppError(404, 'ORDER_NOT_FOUND', 'Order was not found in this store.');
        if (order.paymentStatus !== 4n)
          throw new AppError(
            409,
            'INVOICE_PAYMENT_PENDING',
            'The tax invoice is available after payment is confirmed.',
          );
        return order;
      });
    await currentOrder();
    if (
      !environment.storeUrl ||
      !environment.serviceKey ||
      !/^[!-~]{32,4096}$/.test(environment.serviceKey) ||
      environment.securityContract !== invoiceSecurityContract ||
      environment.feedbackContract !== feedbackProofContract
    )
      throw new AppError(
        503,
        'INVOICE_SECURITY_UNCONFIRMED',
        'The private invoice and feedback contracts are not configured.',
      );
    const url = new URL(environment.storeUrl);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/internal/pos/invoices/store' ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(config.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    )
      throw new AppError(503, 'INVOICE_UNAVAILABLE', 'Invoice delivery is not configured.');
    url.searchParams.set('order_id', orderId);
    const scope: InvoiceProofScope = {
      kind: 'store',
      orderId,
      operatorId: user.id,
      requestId: currentRequestTrace()?.requestId ?? randomUUID(),
      nonce: randomBytes(24).toString('base64url'),
    };
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: {
          Accept: 'text/html',
          'X-POS-Invoice-Key': environment.serviceKey,
          'X-POS-Invoice-Contract': invoiceSecurityContract,
          'X-POS-Feedback-Contract': feedbackProofContract,
          'X-POS-Invoice-Nonce': scope.nonce,
          'X-POS-Operator-ID': scope.operatorId,
          'X-Request-ID': scope.requestId,
        },
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new AppError(502, 'INVOICE_UNAVAILABLE', 'The invoice service did not respond.');
    }
    if (!response.ok)
      throw new AppError(
        502,
        'INVOICE_UNAVAILABLE',
        'The invoice service did not return this invoice.',
      );
    const source = await boundedText(response);
    assertInvoiceResponseProof(response, scope, source, environment.serviceKey);
    if (!/<(?:html|body|table|div|p)\b/i.test(source))
      throw new AppError(
        502,
        'INVOICE_RESPONSE_INVALID',
        'The invoice service returned an unsupported document.',
      );
    // Do not keep a database lock open across the remote render. Recheck before
    // releasing customer invoice data if the operator/scope changed meanwhile.
    const order = await currentOrder();
    return {
      orderId,
      number: order.number || null,
      filename: `tax-invoice-${orderId}.html`,
      html: sanitizeInvoiceHtml(source),
    };
  };
}
export function registerInvoices(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  environment = invoiceEnvironment(),
  fetcher: typeof fetch = fetch,
) {
  const invoice = invoiceService(db, config, environment, fetcher);
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/invoice',
    { config: { trace: { module: 'checkout', resource: 'tax-invoice', action: 'read' } } },
    async (request, reply) => {
      const p = z.object({ storeId: identifier, orderId: identifier }).parse(request.params);
      reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
      return invoice(authenticated(request), p.storeId, p.orderId);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/invoice/preview',
    { config: { trace: { module: 'checkout', resource: 'tax-invoice', action: 'preview' } } },
    async (request, reply) => {
      const p = z.object({ storeId: identifier, orderId: identifier }).parse(request.params),
        document = await invoice(authenticated(request), p.storeId, p.orderId);
      return reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .header(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-same-origin allow-modals",
        )
        .header('Referrer-Policy', 'no-referrer')
        .type('text/html; charset=utf-8')
        .send(document.html);
    },
  );
  return invoice;
}
