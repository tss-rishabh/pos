import { expect, test, sandboxedFrameTrace } from '../support/fixtures';
import {
  invoicePreviewHtml,
  invoicePreviewPolicy,
} from '../../../backend/src/modules/invoice-documents/presentation';
import { sanitizeInvoiceHtml } from '../../../backend/src/modules/checkout/invoices';
import { installInvoicePrintProbe } from './invoice-print-probe';
import { signIn } from '../support/login';

test.use(sandboxedFrameTrace);

/**
 * A web checkout creates a real order on the real stack: real backend, seeded MySQL, the
 * stateful API-v2 cart/order stand-in (backend/tools/e2e/order-api.ts) writing the order rows,
 * and the legacy payment form (create_order.html:6177-7239) recording cash.
 */
test('web checkout creates a real order and records its cash payment', async ({ page }) => {
  const submissions: number[] = [],
    attempts: number[] = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (response.request().method() !== 'POST') return;
    if (path.endsWith('/order-submissions')) submissions.push(response.status());
    if (/\/orders\/\d+\/payment-attempts$/.test(path)) attempts.push(response.status());
  });
  // The invoice renderer is an external adapter the stack does not configure.
  await installInvoicePrintProbe(page);
  await page.route('**/api/v1/operators/*/stores/1/orders/*/invoices/store/preview', (route) => {
    const [, operatorId, orderId] = /\/operators\/(\d+)\/stores\/1\/orders\/(\d+)\//.exec(
      new URL(route.request().url()).pathname,
    )!;
    return route.fulfill({
      contentType: 'text/html',
      headers: { 'Content-Security-Policy': invoicePreviewPolicy, 'Cache-Control': 'no-store' },
      body: invoicePreviewHtml(
        sanitizeInvoiceHtml('<h1>Real order tax invoice</h1>'),
        { operatorId: operatorId!, storeId: '1', orderId: orderId!, kind: 'store' },
        'REAL-ORDER-INVOICE',
      ),
    });
  });
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Classic: Oversized T-shirt to sale' }).click();
  await page.getByRole('button', { name: 'Review sale', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm the sale' });
  await dialog.getByRole('button', { name: 'Confirm prices online' }).click();
  // Legacy requires a salesperson on every order ("Please Select The Salesperson."). W27: the
  // assignments are an always-open section of the review dialog.
  await expect(dialog.getByRole('heading', { name: 'Salesperson assignments' })).toBeVisible();
  await dialog
    .getByRole('combobox', { name: 'Sale salesperson', exact: true })
    .selectOption('810001');
  await dialog.getByRole('button', { name: 'Get final quote' }).click();
  await dialog.getByRole('button', { name: 'Proceed For Payment', exact: true }).click();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await dialog.getByRole('button', { name: 'Yes, sure!', exact: true }).click();
  await expect(page.getByText('Payment confirmed. Your sale is complete.')).toBeVisible();
  await expect(
    page.frameLocator('iframe[title^="Tax invoice for order"]').getByRole('heading', {
      name: 'Real order tax invoice',
    }),
  ).toBeVisible();
  // One real order submission: API-v2 pos/order wrote the order rows and the confirmed payment
  // form travelled with it (legacy C-21), so no separate payment request is sent.
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toBeLessThan(300);
  expect(attempts).toEqual([]);
});
