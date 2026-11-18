import { describe, expect, it, vi } from 'vitest';
import { invoiceAdapter } from '../../src/modules/invoice-documents/adapter.js';
import { invoiceDocumentOptions } from '../../src/modules/invoice-documents/options.js';

const config = { NODE_ENV: 'production' as const };
const env = {
  MAIN_API_V2_URL: 'https://api.synthetic.invalid/api/v2/',
  ORDER_SHOP_RECEIPT_URL: 'https://shop.synthetic.invalid/pos-shop',
  ORDER_RECEIPT_TOKEN: 'synthetic-receipt-token',
  SDD_ORDER_RECEIPT_URL: 'https://sdd.synthetic.invalid/receipt',
  MJML_HOST: 'https://mailr.synthetic.invalid/',
};
function capture(status = 200) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    return new Response('<div>invoice</div>', { status });
  });
  return { calls, fetcher };
}
describe('legacy invoice renderer calls', () => {
  it('parses ENABLE_WHATSAPP_INVOICE like legacy and resolves INVOICE_MIGRATION', () => {
    for (const [raw, expected] of [
      [undefined, false],
      ['False', false],
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['yes', false],
    ] as const)
      expect(invoiceDocumentOptions({ ENABLE_WHATSAPP_INVOICE: raw }).whatsappInvoice).toBe(
        expected,
      );
    expect(invoiceDocumentOptions({ ...env, INVOICE_MIGRATION: '1' }).storeReceiptUrl).toBe(
      'https://api.synthetic.invalid/api/v2/pos-shop',
    );
    expect(invoiceDocumentOptions(env).storeReceiptUrl).toBe(env.ORDER_SHOP_RECEIPT_URL);
  });
  it('builds the store, express, online and SDD requests exactly as the legacy views', async () => {
    const { calls, fetcher } = capture();
    const adapter = invoiceAdapter(config, invoiceDocumentOptions(env), fetcher);
    await adapter.storeReceipt('42', null);
    await adapter.storeReceipt('42', ['7', '9']);
    await adapter.onlineInvoice('42');
    await adapter.sameDayReceipt('42');
    expect(calls.map(({ url }) => url.origin + url.pathname)).toEqual([
      'https://shop.synthetic.invalid/pos-shop',
      'https://shop.synthetic.invalid/pos-shop',
      'https://api.synthetic.invalid/api/v2/show-invoicer',
      'https://sdd.synthetic.invalid/receipt',
    ]);
    expect(calls.map(({ url }) => Object.fromEntries(url.searchParams))).toEqual([
      { order_id: '42', pos_token: env.ORDER_RECEIPT_TOKEN },
      { order_id: '42', pos_token: env.ORDER_RECEIPT_TOKEN, has_product_ids: '7,9' },
      { order_id: '42' },
      { order_id: '42', is_sdd_shipment: '0', pos_token: env.ORDER_RECEIPT_TOKEN },
    ]);
    expect(new Headers(calls[2]!.init.headers).get('X-POS-Secret')).toBe(env.ORDER_RECEIPT_TOKEN);
  });
  it('fails the invoice on a non-200 renderer response', async () => {
    const { fetcher } = capture(500);
    await expect(
      invoiceAdapter(config, invoiceDocumentOptions(env), fetcher).storeReceipt('42', null),
    ).rejects.toMatchObject({ status: 502 });
  });
  it('posts the WhatsApp invoice request and only reports failures', async () => {
    const { calls, fetcher } = capture();
    const adapter = invoiceAdapter(config, invoiceDocumentOptions(env), fetcher);
    expect(await adapter.sendWhatsappInvoice('9007199254740993')).toBe('sent');
    expect(calls[0]!.url.href).toBe(
      'https://mailr.synthetic.invalid/api/v2/mailr/send-invoice-whatsapp/',
    );
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBe('{"order_id": 9007199254740993}');
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBe('application/json');
    const failing = invoiceAdapter(config, invoiceDocumentOptions(env), capture(500).fetcher);
    expect(await failing.sendWhatsappInvoice('1')).toBe('failed');
    const throwing = invoiceAdapter(config, invoiceDocumentOptions(env), async () => {
      throw new TypeError('down');
    });
    expect(await throwing.sendWhatsappInvoice('1')).toBe('failed');
    expect(
      await invoiceAdapter(config, invoiceDocumentOptions({}), fetcher).sendWhatsappInvoice('1'),
    ).toBe('skipped-unconfigured');
  });
  it('never sends the receipt token to a plain-HTTP remote renderer', async () => {
    const { fetcher } = capture();
    const adapter = invoiceAdapter(
      config,
      invoiceDocumentOptions({ ...env, ORDER_SHOP_RECEIPT_URL: 'http://shop.synthetic.invalid/x' }),
      fetcher,
    );
    await expect(adapter.storeReceipt('1', null)).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
