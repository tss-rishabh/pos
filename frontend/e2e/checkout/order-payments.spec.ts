import { installInvoicePrintProbe } from './invoice-print-probe';
import {
  invoicePreviewHtml,
  invoicePreviewPolicy,
} from '../../../backend/src/modules/invoice-documents/presentation';
import { sanitizeInvoiceHtml } from '../../../backend/src/modules/checkout/invoices';
import { type Page } from '@playwright/test';
import { expect, test, sandboxedFrameTrace, type NetworkGuard } from '../support/fixtures';
import { recordedPaymentInputSchema } from '../../src/pages/checkout/payment-recovery';
import { signIn } from '../support/login';
import { createUnpaidCounterOrder } from '../../../backend/tools/e2e/fixture-orders';

test.use(sandboxedFrameTrace);

/**
 * Existing-order payment on the real stack (legacy order show/index pages, create_order.html
 * payment form). Each test adds its own new unpaid counter order to the running stack's schema
 * (backend/tools/e2e/fixture-orders.ts), so a repeated run on the same stack never meets an order
 * an earlier run already paid. Only the invoice renderer, an external adapter, is answered by the
 * test.
 */
async function invoicePreview(page: Page, orderId: string) {
  const state = { reads: 0 };
  await installInvoicePrintProbe(page);
  await page.route(
    `**/api/v1/operators/*/stores/1/orders/${orderId}/invoices/store/preview`,
    (route) => {
      state.reads++;
      const operatorId = /\/operators\/(\d+)\//.exec(new URL(route.request().url()).pathname)![1]!;
      return route.fulfill({
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': invoicePreviewPolicy, 'Cache-Control': 'no-store' },
        body: invoicePreviewHtml(
          sanitizeInvoiceHtml('<h1>Existing order tax invoice</h1>'),
          { operatorId, storeId: '1', orderId, kind: 'store' },
          'ISOLATED-EXISTING-INVOICE',
        ),
      });
    },
  );
  return state;
}
/** An unrelated local sale that an existing-order payment must neither clear nor complete. */
async function seedUnrelatedDraft(page: Page) {
  const ownerId = await page.evaluate(async () => {
    const opened = indexedDB.open('souled-pos-v1'),
      database = await new Promise<IDBDatabase>((resolve, reject) => {
        opened.onsuccess = () => resolve(opened.result);
        opened.onerror = () => reject(opened.error);
      });
    const session = await new Promise<{ user: { id: string } } | undefined>((resolve) => {
      const read = database.transaction('sessions').objectStore('sessions').get('current');
      read.onsuccess = () => resolve(read.result as { user: { id: string } } | undefined);
    });
    const ownerId = session!.user.id,
      transaction = database.transaction('drafts', 'readwrite');
    transaction.objectStore('drafts').put({
      ownerId,
      id: '22222222-2222-4222-8222-222222222222',
      storeId: '1',
      counterId: '1',
      customerId: null,
      version: 7,
      createdAt: 1000,
      updatedAt: 1000,
      lines: [
        { productId: '10', name: 'Other sale', barcode: null, unitPrice: '99.95', quantity: 8 },
      ],
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    return ownerId;
  });
  return async () =>
    page.evaluate(async (ownerId) => {
      const opened = indexedDB.open('souled-pos-v1'),
        database = await new Promise<IDBDatabase>((resolve, reject) => {
          opened.onsuccess = () => resolve(opened.result);
          opened.onerror = () => reject(opened.error);
        });
      const transaction = database.transaction(['drafts', 'completedSales'], 'readonly'),
        draft = transaction
          .objectStore('drafts')
          .get([ownerId, '22222222-2222-4222-8222-222222222222']),
        sales = transaction.objectStore('completedSales').count();
      const result = await Promise.all([
        new Promise<unknown>((resolve) => {
          draft.onsuccess = () => resolve(draft.result as unknown);
        }),
        new Promise<number>((resolve) => {
          sales.onsuccess = () => resolve(sales.result);
        }),
      ]);
      database.close();
      return result;
    }, ownerId);
}
async function openOrder(page: Page, orderId: string) {
  await page.goto('/orders?orderId=' + orderId);
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'SYN-' + orderId, exact: true })).toBeVisible();
}
async function confirmCash(page: Page) {
  const panel = page.getByRole('region', { name: 'Proceed with the payment.' });
  // The legacy form starts with the whole payable as cash (create_order.html:5820-5870).
  await expect(panel.getByRole('spinbutton', { name: 'Cash To Be Accepted:' })).toHaveValue(
    /^[1-9]\d*(?:\.\d{1,2})?$/,
  );
  await panel.getByRole('button', { name: 'Submit', exact: true }).click();
  await panel.getByRole('button', { name: 'Yes, sure!', exact: true }).click();
}

/**
 * A confirmed payment refreshes the order list (a new legacy `draw`); the app cancels a list
 * search that the refresh supersedes while it is still in flight. Timing decides whether one is.
 */
function allowSupersededListSearch(network: NetworkGuard) {
  network.expectFailure({
    method: 'POST',
    path: '/api/v1/stores/1/orders/searches',
    outcome: 'net::ERR_ABORTED',
    upTo: 2,
  });
}

test('existing order cash payment confirms on the real stack without completing a local cart', async ({
  page,
  network,
}) => {
  allowSupersededListSearch(network);
  const orderId = await createUnpaidCounterOrder(process.env.E2E_MYSQL_URL);
  const invoice = await invoicePreview(page, orderId);
  const attempts: unknown[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith(`/orders/${orderId}/payment-attempts`)
    )
      attempts.push(request.postDataJSON());
  });
  await openOrder(page, orderId);
  const snapshot = await seedUnrelatedDraft(page);
  await confirmCash(page);
  await expect(
    page.getByText(`Payment has been Completed for order ID : ${orderId}`, { exact: false }),
  ).toBeVisible();
  expect(attempts).toHaveLength(1);
  const sent = recordedPaymentInputSchema.parse(attempts[0]);
  expect(sent).toMatchObject({ channel: 'cash', onlineAmount: '0.00' });
  expect(sent.cashReceived).toBe(sent.cashAmount);
  expect(Number(sent.cashAmount)).toBeGreaterThan(0);
  await expect(
    page
      .frameLocator(`iframe[title="Tax invoice for order ${orderId}"]`)
      .getByRole('heading', { name: 'Existing order tax invoice' }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-invoice-print-count', '1');
  expect(invoice.reads).toBe(1);
  await page.getByRole('button', { name: 'Close invoice' }).click();
  await page.reload();
  await expect(
    page.getByText(`Payment has been Completed for order ID : ${orderId}`, { exact: false }),
  ).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(invoice.reads).toBe(1);
  expect(attempts).toHaveLength(1);
  const [draft, completed] = await snapshot();
  expect(draft).toMatchObject({ version: 7, lines: [{ quantity: 8 }] });
  expect(completed).toBe(0);
});

test('a lost payment response is read back by status check and never sent again', async ({
  page,
  network,
}) => {
  allowSupersededListSearch(network);
  const orderId = await createUnpaidCounterOrder(process.env.E2E_MYSQL_URL);
  network.expectFailure({
    method: 'POST',
    path: `/api/v1/stores/1/orders/${orderId}/payment-attempts`,
    outcome: 'net::ERR_CONNECTION_RESET',
  });
  const invoice = await invoicePreview(page, orderId);
  let posts = 0;
  // The server records the payment, but its response never reaches the browser.
  await page.route(`**/api/v1/stores/1/orders/${orderId}/payment-attempts`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    return route.abort('connectionreset');
  });
  await openOrder(page, orderId);
  const snapshot = await seedUnrelatedDraft(page);
  await confirmCash(page);
  await expect(
    page.getByText('The last payment request did not get a reply.', { exact: false }),
  ).toBeVisible();
  expect(posts).toBe(1);
  await page.getByRole('button', { name: 'Check payment status', exact: true }).click();
  await expect(
    page.getByText(`Payment has been Completed for order ID : ${orderId}`, { exact: false }),
  ).toBeVisible();
  await expect(
    page
      .frameLocator(`iframe[title="Tax invoice for order ${orderId}"]`)
      .getByRole('heading', { name: 'Existing order tax invoice' }),
  ).toBeVisible();
  expect(invoice.reads).toBe(1);
  await page.getByRole('button', { name: 'Close invoice' }).click();
  await page.reload();
  await expect(
    page.getByText(`Payment has been Completed for order ID : ${orderId}`, { exact: false }),
  ).toBeVisible();
  expect(posts).toBe(1);
  const [draft, completed] = await snapshot();
  expect(draft).toMatchObject({ version: 7, lines: [{ quantity: 8 }] });
  expect(completed).toBe(0);
});
