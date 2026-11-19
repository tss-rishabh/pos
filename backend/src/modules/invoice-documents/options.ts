import { z } from 'zod';
import type { Config } from '../../config.js';

const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());
/**
 * Legacy settings (`POSAdmin/settings.py`):
 * - `ORDER_SHOP_RECEIPT_URL` (`:670`) = `MAIN_API_V2_URL + "pos-shop"` when `INVOICE_MIGRATION`
 *   (`:668`, int, default 0) is set, else the `ORDER_SHOP_RECEIPT_URL` env value.
 * - `ORDER_RECEIPT_TOKEN` (`:366`), `SDD_ORDER_RECEIPT_URL` (`:368`), `MAIN_API_V2_URL`, `MJML_HOST`.
 * - `ENABLE_WHATSAPP_INVOICE` (`:638`): `os.getenv(…, 'False').lower() in ['true', '1']`.
 */
export function invoiceDocumentOptions(env: NodeJS.ProcessEnv = process.env) {
  const value = z
    .object({
      MAIN_API_V2_URL: optionalUrl,
      ORDER_SHOP_RECEIPT_URL: optionalUrl,
      INVOICE_MIGRATION: z.coerce.number().int().default(0),
      ORDER_RECEIPT_TOKEN: z.string().max(4096).optional(),
      SDD_ORDER_RECEIPT_URL: optionalUrl,
      MJML_HOST: optionalUrl,
      ENABLE_WHATSAPP_INVOICE: z
        .string()
        .default('False')
        .transform((raw) => ['true', '1'].includes(raw.toLowerCase())),
    })
    .parse(env);
  return {
    storeReceiptUrl: value.INVOICE_MIGRATION
      ? value.MAIN_API_V2_URL && value.MAIN_API_V2_URL + 'pos-shop'
      : value.ORDER_SHOP_RECEIPT_URL,
    onlineInvoiceUrl: value.MAIN_API_V2_URL && value.MAIN_API_V2_URL + 'show-invoicer',
    sameDayReceiptUrl: value.SDD_ORDER_RECEIPT_URL,
    receiptToken: value.ORDER_RECEIPT_TOKEN,
    whatsappInvoice: value.ENABLE_WHATSAPP_INVOICE,
    whatsappInvoiceUrl: value.MJML_HOST && value.MJML_HOST + 'api/v2/mailr/send-invoice-whatsapp/',
  };
}
export type InvoiceDocumentOptions = ReturnType<typeof invoiceDocumentOptions>;
/**
 * Security (W5): a renderer URL is used only over HTTPS (plain HTTP only to a loopback host
 * outside production), with no credentials or fragment, so the receipt token is never sent
 * in clear text.
 */
export function rendererUrl(config: Pick<Config, 'NODE_ENV'>, raw: string | undefined) {
  if (!raw) return undefined;
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        config.NODE_ENV !== 'production' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    return undefined;
  return url;
}
