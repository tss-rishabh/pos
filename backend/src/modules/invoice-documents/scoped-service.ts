import { randomBytes, randomUUID } from 'node:crypto';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { boundedText } from '../../domain/http-json.js';
import { currentRequestTrace } from '../../observability/context.js';
import { sanitizeInvoiceHtml } from '../checkout/invoices.js';
import {
  assertInvoiceResponseProof,
  feedbackProofContract,
  invoiceSecurityContract,
  type InvoiceProofScope,
} from '../checkout/invoice-security.js';
import {
  hasSourceSameDayInvoice,
  invoiceScopeSnapshot,
  invoiceScopeUnavailable,
  selectedExpressIds,
} from './authority.js';
import {
  fullInvoiceOwnership,
  invoiceDocumentScope,
  scopedInvoiceDocument,
  type InvoiceDocumentScope,
} from './contracts.js';
import type { InvoiceDocumentOptions } from './options.js';
import {
  assertScopedInvoiceResponse,
  issueScopedInvoiceProof,
  scopedInvoiceContract,
} from './scope-proof.js';

export function scopedInvoiceService(
  db: Databases,
  config: Config,
  options: InvoiceDocumentOptions,
  fetcher: typeof fetch = fetch,
) {
  const capture = invoiceScopeSnapshot(db);
  return async (user: Principal, raw: InvoiceDocumentScope, kind: 'same-day' | 'express') => {
    const scope = invoiceDocumentScope.parse(raw),
      original = await capture(user, scope),
      selected = kind === 'express' ? selectedExpressIds(original.ownership) : [];
    if (
      selected === null ||
      (kind === 'same-day' &&
        (!fullInvoiceOwnership(original.ownership) || !hasSourceSameDayInvoice(original.ownership)))
    )
      throw invoiceScopeUnavailable();
    const endpoint = kind === 'express' ? options.expressUrl : options.sameDayUrl;
    if (
      !endpoint ||
      !options.serviceKey ||
      !/^[!-~]{32,4096}$/.test(options.serviceKey) ||
      options.securityContract !== invoiceSecurityContract ||
      options.feedbackContract !== feedbackProofContract ||
      options.scopedContract !== scopedInvoiceContract
    )
      throw new AppError(
        503,
        'INVOICE_SECURITY_UNCONFIRMED',
        'The protected invoice service is not configured.',
      );
    const url = new URL(endpoint);
    if (
      url.username ||
      url.password ||
      url.pathname !== `/internal/pos/invoices/${kind}` ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          config.NODE_ENV !== 'production' &&
          ['localhost', '127.0.0.1'].includes(url.hostname)
        ))
    )
      throw new AppError(
        503,
        'INVOICE_UNAVAILABLE',
        'The protected invoice service is not configured.',
      );
    url.searchParams.set('order_id', scope.orderId);
    // The source SDD endpoint always requests the zero shipment flag. Its
    // renderer is external; this transport must not reinterpret that flag.
    if (kind === 'same-day') url.searchParams.set('is_sdd_shipment', '0');
    const proofScope: InvoiceProofScope = {
      kind: kind === 'express' ? 'store' : 'same-day',
      orderId: scope.orderId,
      operatorId: user.id,
      requestId: currentRequestTrace()?.requestId ?? randomUUID(),
      nonce: randomBytes(24).toString('base64url'),
    };
    const capability = issueScopedInvoiceProof(
      kind,
      proofScope,
      scope.storeId,
      original,
      selected,
      options.serviceKey,
    );
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: {
          Accept: 'text/html',
          'X-POS-Invoice-Key': options.serviceKey,
          'X-POS-Invoice-Contract': invoiceSecurityContract,
          'X-POS-Feedback-Contract': feedbackProofContract,
          'X-POS-Invoice-Nonce': proofScope.nonce,
          'X-POS-Operator-ID': user.id,
          'X-Request-ID': proofScope.requestId,
          'X-POS-Invoice-Scope': capability,
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
    const html = await boundedText(response);
    assertInvoiceResponseProof(response, proofScope, html, options.serviceKey);
    assertScopedInvoiceResponse(response, capability, html, options.serviceKey);
    if (!/<(?:html|body|table|div|p)\b/i.test(html))
      throw new AppError(
        502,
        'INVOICE_RESPONSE_INVALID',
        'The invoice service returned an unsupported document.',
      );
    const current = await capture(user, scope);
    if (current.binding !== original.binding)
      throw new AppError(
        409,
        'INVOICE_SCOPE_CHANGED',
        'The invoice changed while it was loading. Refresh its current details.',
      );
    return scopedInvoiceDocument.parse({
      kind,
      ...scope,
      number:
        kind === 'express'
          ? current.ownership.mappings.find((row) => row.storeId === scope.storeId)?.number || null
          : current.number,
      filename: `${kind}-tax-invoice-${scope.orderId}.html`,
      html: sanitizeInvoiceHtml(html),
    });
  };
}
