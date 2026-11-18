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
  globalOnlineInvoiceContract,
  issueGlobalOnlineInvoiceProof,
  assertGlobalOnlineInvoiceResponse,
  sameInvoiceAuthority,
} from './global-proof.js';
import { invoiceDocumentAuthority } from './authority.js';
import {
  invoiceDocumentScope,
  onlineInvoiceDocument,
  type InvoiceDocumentScope,
} from './contracts.js';
import type { InvoiceDocumentOptions } from './options.js';
import { invoiceHistoryReader, type InvoiceHistoryReader } from './history.js';
import {
  issueInvoiceHistoryProof,
  assertInvoiceHistoryResponse,
  invoiceHistoryContract,
} from './history-proof.js';

export function onlineInvoiceService(
  db: Databases,
  config: Config,
  options: InvoiceDocumentOptions,
  fetcher: typeof fetch = fetch,
  readHistory: InvoiceHistoryReader = invoiceHistoryReader(config, options),
) {
  const authority = invoiceDocumentAuthority(db);
  return async (user: Principal, raw: InvoiceDocumentScope) => {
    const scope = invoiceDocumentScope.parse(raw),
      original = await authority(user, scope);
    if (
      (original.globalOnline && options.globalOnlineContract !== globalOnlineInvoiceContract) ||
      !options.onlineUrl ||
      !options.serviceKey ||
      !/^[!-~]{32,4096}$/.test(options.serviceKey) ||
      options.securityContract !== invoiceSecurityContract ||
      options.feedbackContract !== feedbackProofContract ||
      options.historyContract !== invoiceHistoryContract
    )
      throw new AppError(
        503,
        'INVOICE_SECURITY_UNCONFIRMED',
        'The private online invoice contract is not configured.',
      );
    const url = new URL(options.onlineUrl);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/internal/pos/invoices/online' ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          config.NODE_ENV !== 'production' &&
          ['localhost', '127.0.0.1'].includes(url.hostname)
        ))
    )
      throw new AppError(503, 'INVOICE_UNAVAILABLE', 'Online invoice delivery is not configured.');
    url.searchParams.set('order_id', scope.orderId);
    const history = await readHistory(scope, original),
      beforeRender = await authority(user, scope);
    if (!sameInvoiceAuthority(beforeRender, original))
      throw new AppError(
        409,
        'INVOICE_SCOPE_CHANGED',
        'The invoice changed while it was loading. Refresh its current details.',
      );
    const proofScope: InvoiceProofScope = {
      kind: 'online',
      orderId: scope.orderId,
      operatorId: user.id,
      requestId: currentRequestTrace()?.requestId ?? randomUUID(),
      nonce: randomBytes(24).toString('base64url'),
    };
    const historyProof = issueInvoiceHistoryProof(
      proofScope,
      scope.storeId,
      original,
      history,
      options.serviceKey,
    );
    const globalProof = original.globalOnline
      ? issueGlobalOnlineInvoiceProof(
          'online',
          proofScope,
          scope.storeId,
          original,
          historyProof,
          options.serviceKey,
        )
      : null;
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: {
          ...(globalProof
            ? {
                'X-POS-Global-Invoice': globalProof,
                'X-POS-Global-Invoice-Contract': globalOnlineInvoiceContract,
              }
            : {}),
          Accept: 'text/html',
          'X-POS-Invoice-Key': options.serviceKey,
          'X-POS-Invoice-Contract': invoiceSecurityContract,
          'X-POS-Feedback-Contract': feedbackProofContract,
          'X-POS-Invoice-Nonce': proofScope.nonce,
          'X-POS-Operator-ID': proofScope.operatorId,
          'X-Request-ID': proofScope.requestId,
          'X-POS-Invoice-History': historyProof,
        },
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new AppError(502, 'INVOICE_UNAVAILABLE', 'The online invoice service did not respond.');
    }
    if (!response.ok)
      throw new AppError(
        502,
        'INVOICE_UNAVAILABLE',
        'The online invoice service did not return this invoice.',
      );
    const source = await boundedText(response);
    assertInvoiceResponseProof(response, proofScope, source, options.serviceKey);
    assertInvoiceHistoryResponse(response, historyProof, source, options.serviceKey);
    if (globalProof)
      assertGlobalOnlineInvoiceResponse(response, globalProof, source, options.serviceKey);
    if (!/<(?:html|body|table|div|p)\b/i.test(source))
      throw new AppError(
        502,
        'INVOICE_RESPONSE_INVALID',
        'The online invoice service returned an unsupported document.',
      );
    const current = await authority(user, scope);
    if (!sameInvoiceAuthority(current, original))
      throw new AppError(
        409,
        'INVOICE_SCOPE_CHANGED',
        'The invoice changed while it was loading. Refresh its current details.',
      );
    return onlineInvoiceDocument.parse({
      kind: 'online',
      storeId: scope.storeId,
      orderId: scope.orderId,
      ...(scope.access ? { access: scope.access } : {}),
      number: current.number,
      filename: `online-tax-invoice-${scope.orderId}.html`,
      html: sanitizeInvoiceHtml(source),
    });
  };
}
