import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { AppError } from '../../../domain/errors.js';
import { shippingLabelSchema, type ShippingLabel } from './contracts.js';
import { shippingCode128Svg } from './code128.js';

const css = `@page{size:100mm 150mm;margin:3mm}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000;font-family:Arial,sans-serif;font-size:10pt}main{width:94mm;max-width:100%;margin:auto}table{width:100%;border-collapse:collapse;table-layout:fixed}td,th{border:1px solid #000;padding:4px;vertical-align:top;overflow-wrap:anywhere}h2{font-size:11pt;margin:3px 0}p{margin:3px 0;line-height:1.25}.center{text-align:center}.quantity{text-align:right;width:20%}.barcode svg{max-width:100%;height:auto;display:block;margin:auto}.small{font-size:8pt}.parcel{white-space:nowrap}@media print{html,body{min-width:0!important}td,th,p{font-size:8pt;line-height:1.2}h2{font-size:9pt}td,th{padding:1px 5px}}`;
const styleHash = createHash('sha256').update(css).digest('base64');
export const shippingLabelCsp = `default-src 'none'; script-src 'none'; style-src 'sha256-${styleHash}'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-same-origin allow-modals`;
const metaCsp = shippingLabelCsp
  .split(';')
  .map((value) => value.trim())
  .filter((value) => !value.startsWith('frame-ancestors ') && !value.startsWith('sandbox '))
  .join('; ');
export const escapeShippingText = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const months = [
  'Jan.',
  'Feb.',
  'March',
  'April',
  'May',
  'June',
  'July',
  'Aug.',
  'Sept.',
  'Oct.',
  'Nov.',
  'Dec.',
] as const;
export function sourceShippingDate(value: string | null) {
  if (value === null) return '';
  try {
    const date = Temporal.PlainDate.from(value.slice(0, 10));
    return `${months[date.month - 1]} ${date.day}, ${date.year}`;
  } catch {
    throw new AppError(
      409,
      'SHIPPING_DATE_RECONCILIATION_REQUIRED',
      'The shipping date requires reconciliation before printing.',
    );
  }
}
/** A standalone, inert document. Address data is text and cannot create markup. */
export function shippingLabelDocument(supplied: ShippingLabel) {
  const label = shippingLabelSchema.parse(supplied),
    text = escapeShippingText,
    address = label.shippingAddress;
  const destination = address
    ? `<p>${text(address.name)}</p>${address.addressLine ? `<p>${text(address.addressLine)}</p>` : ''}${address.cityLine ? `<p>${text(address.cityLine)}</p>` : ''}${address.phone ? `<p>Ph: ${text(address.phone)}</p>` : ''}`
    : '<p>Address not available</p>';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="pos-shipping-label" content="${label.storeId}:${label.orderId}"><meta http-equiv="Content-Security-Policy" content="${escapeShippingText(metaCsp)}"><title>Shipping label ${label.orderId}</title><style>${css}</style></head><body><main aria-label="Order shipping label"><table><tbody><tr><td><h2>Payment Mode : ${label.paymentMode}</h2></td><td class="center"><h2>NIL</h2></td></tr><tr><td><h2>SHIP TO :-</h2></td><td class="center"><h2>FROM/RETURN :-</h2></td></tr><tr><td>${destination}</td><td><p><strong>If undelivered, please return to:</strong> ${text(label.storeAddress)}</p></td></tr><tr><td><p>Order Date : ${text(sourceShippingDate(label.orderDate))}</p><p>Invoice # : ${text(label.orderReference)}</p></td><td><p>Order No: ${label.orderId}</p><div class="barcode">${shippingCode128Svg(label.orderId, false)}</div></td></tr><tr><td><p>Dimensions: (CM)</p><p>Weight:(Kg)</p></td><td class="parcel"><p>${label.dimensionsCm.join(' *')}</p><p>${label.weightKg}</p></td></tr><tr><td colspan="2"><table><tbody><tr><td>Matter</td><td class="quantity">QTY</td></tr><tr><td>${label.product}</td><td class="quantity">${label.totalQuantity}</td></tr></tbody></table></td></tr><tr><td colspan="2" class="barcode center">${shippingCode128Svg(label.awb)}</td></tr><tr><td colspan="2"><p class="small">Prices are inclusive of all applicable taxes</p></td></tr></tbody></table></main></body></html>`;
  return { filename: `shipping-label-${label.orderId}-${label.storeId}.html`, html };
}
