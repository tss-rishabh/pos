import { readFile } from 'node:fs/promises';
import { test, expect, sandboxedFrameTrace } from '../support/fixtures';
import { sanitizeInvoiceHtml } from '../../../backend/src/modules/checkout/invoices.js';
import { installInvoicePrintProbe } from './invoice-print-probe';
import {
  invoicePreviewHtml,
  invoicePreviewPolicy,
} from '../../../backend/src/modules/invoice-documents/presentation';
import { signIn } from '../support/login';

test.use(sandboxedFrameTrace);

test('production invoice frame uses its own restrictive policy and supports in-app print/download', async ({
  page,
  network,
}) => {
  // The last print runs after access is revoked and must be refused.
  network.expectFailure({
    method: 'GET',
    path: /^\/api\/v1\/operators\/\d+\/stores\/1\/orders\/6008\/invoices\/store\/preview$/,
    outcome: 403,
  });
  const html = sanitizeInvoiceHtml(
    '<h1>Fixture tax invoice FST12627INV00123</h1><table><tr><th>Taxable value</th><td>100.00</td></tr><tr><th>GST</th><td>18.00</td></tr></table><script>window.invoiceExecuted=true</script><img src="https://attacker.example.test/track">',
  );
  await installInvoicePrintProbe(page);
  let documentReads = 0,
    denied = false;
  let popups = 0;
  page.on('popup', () => {
    popups++;
  });
  // Downloads read the store invoice document (`/invoices/{kind}`, 2aa2f33d).
  await page.route('**/api/v1/stores/*/orders/6008/invoices/store', (route) => {
    documentReads++;
    expect(route.request().headers()['x-operator-id']).toBeTruthy();
    if (denied)
      return route.fulfill({
        status: 403,
        json: { error: { code: 'STORE_ACCESS_DENIED', message: 'Invoice access was revoked.' } },
      });
    return route.fulfill({
      json: {
        orderId: '6008',
        number: 'FST12627INV00123',
        filename: 'tax-invoice-6008.html',
        html,
      },
    });
  });
  await page.route('**/api/v1/operators/*/stores/*/orders/6008/invoices/store/preview', (route) => {
    documentReads++;
    if (denied)
      return route.fulfill({
        status: 403,
        json: { error: { code: 'STORE_ACCESS_DENIED', message: 'Invoice access was revoked.' } },
        headers: { 'Cache-Control': 'no-store', 'Content-Security-Policy': invoicePreviewPolicy },
      });
    const match = /\/operators\/(\d+)\/stores\/(\d+)\//.exec(
      new URL(route.request().url()).pathname,
    )!;
    return route.fulfill({
      contentType: 'text/html',
      headers: {
        'Content-Security-Policy': invoicePreviewPolicy,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
      body: invoicePreviewHtml(
        html,
        { operatorId: match[1]!, storeId: match[2]!, orderId: '6008', kind: 'store' },
        'FST12627INV00123',
      ),
    });
  });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('link', { name: 'Orders', exact: true }).click();
  await page.getByRole('button', { name: 'View order 6008', exact: true }).click();
  await page.getByRole('button', { name: 'Tax invoice', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Tax invoice for order 6008"]');
  await expect(
    frame.getByRole('heading', { name: 'Fixture tax invoice FST12627INV00123' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print invoice' })).toBeEnabled();
  expect(await frame.locator('body').evaluate((body) => getComputedStyle(body).fontSize)).toBe(
    '12px',
  );
  expect(await frame.locator('script').count()).toBe(0);
  expect(await frame.locator('img[src^="https:"]').count()).toBe(0);
  expect(documentReads).toBe(1);
  await page.getByRole('button', { name: 'Print invoice' }).click();
  await expect(frame.locator('html')).toHaveAttribute('data-print-requested', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-invoice-print-count', '1');
  expect(documentReads).toBe(2);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download invoice' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('tax-invoice-6008.html');
  const path = await saved.path();
  expect(path).toBeTruthy();
  const document = await readFile(path!, 'utf8');
  expect(document).toContain('Fixture tax invoice');
  expect(document).not.toContain('invoiceExecuted');
  expect(document).not.toContain('attacker.example.test');
  expect(documentReads).toBe(3);
  denied = true;
  await page.getByRole('button', { name: 'Print invoice' }).click();
  await expect(page.getByRole('dialog', { name: /^Tax invoice/ }).getByRole('alert')).toContainText(
    'Invoice access was revoked.',
  );
  await expect(page.locator('iframe[title="Tax invoice for order 6008"]')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-invoice-print-count', '1');
  expect(popups).toBe(0);
});
