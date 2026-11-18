import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { boundedText } from '../../domain/http-json.js';
import { rendererUrl, type InvoiceDocumentOptions } from './options.js';

export type WhatsappInvoiceOutcome = 'sent' | 'skipped-unconfigured' | 'failed';
/** Sandboxable outbound calls of the legacy invoice views. Tests replace `fetcher`. */
export interface InvoiceAdapter {
  storeReceipt(orderId: string, hasProductIds: readonly string[] | null): Promise<string>;
  onlineInvoice(orderId: string): Promise<string>;
  sameDayReceipt(orderId: string): Promise<string>;
  /** `Helpers.delivered_order` (`helpers/helpers.py:2062-2072`); never throws. */
  sendWhatsappInvoice(orderId: string): Promise<WhatsappInvoiceOutcome>;
}
const unavailable = () =>
  new AppError(503, 'INVOICE_UNAVAILABLE', 'Invoice delivery is not configured.');
/** Legacy redirects with "Something went wrong !" on a non-200 renderer response. */
const failed = () =>
  new AppError(
    502,
    'INVOICE_UNAVAILABLE',
    'Something went wrong! The invoice could not be loaded.',
  );

export function invoiceAdapter(
  config: Pick<Config, 'NODE_ENV'>,
  options: InvoiceDocumentOptions,
  fetcher: typeof fetch = fetch,
): InvoiceAdapter {
  async function html(url: URL, headers: Record<string, string> = {}) {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'GET',
        headers: { Accept: 'text/html', ...headers },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw failed();
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw failed();
    }
    try {
      return await boundedText(response, 3_000_000);
    } catch {
      throw failed();
    }
  }
  return {
    /** `ShowOrderInvoiceView`: `{ORDER_SHOP_RECEIPT_URL}?order_id&pos_token[&has_product_ids]`. */
    async storeReceipt(orderId, hasProductIds) {
      const url = rendererUrl(config, options.storeReceiptUrl);
      if (!url || options.receiptToken === undefined) throw unavailable();
      url.searchParams.set('order_id', orderId);
      url.searchParams.set('pos_token', options.receiptToken);
      if (hasProductIds?.length) url.searchParams.set('has_product_ids', hasProductIds.join(','));
      return html(url);
    },
    /** `ShowOnlineOrderInvoiceView`: `{MAIN_API_V2_URL}show-invoicer?order_id`, `X-POS-Secret`. */
    async onlineInvoice(orderId) {
      const url = rendererUrl(config, options.onlineInvoiceUrl);
      if (!url || options.receiptToken === undefined) throw unavailable();
      url.searchParams.set('order_id', orderId);
      return html(url, { 'X-POS-Secret': options.receiptToken });
    },
    /** `ShowOnlineSDDOrderInvoiceView`: `?order_id&is_sdd_shipment=0&pos_token`. */
    async sameDayReceipt(orderId) {
      const url = rendererUrl(config, options.sameDayReceiptUrl);
      if (!url || options.receiptToken === undefined) throw unavailable();
      url.searchParams.set('order_id', orderId);
      url.searchParams.set('is_sdd_shipment', '0');
      url.searchParams.set('pos_token', options.receiptToken);
      return html(url);
    },
    async sendWhatsappInvoice(orderId) {
      const url = rendererUrl(config, options.whatsappInvoiceUrl);
      if (!url) return 'skipped-unconfigured';
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Legacy posts the integer path parameter: {"order_id": <int>}.
          body: `{"order_id": ${BigInt(orderId).toString()}}`,
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
        await response.body?.cancel();
        return response.status === 200 ? 'sent' : 'failed';
      } catch {
        return 'failed';
      }
    },
  };
}
