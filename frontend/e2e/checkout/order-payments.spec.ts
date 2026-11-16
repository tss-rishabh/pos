import { installInvoicePrintProbe } from './invoice-print-probe';
import {
  invoicePreviewHtml,
  invoicePreviewPolicy,
} from '../../../backend/src/modules/invoice-documents/presentation';
import { sanitizeInvoiceHtml } from '../../../backend/src/modules/checkout/invoices';
import { expect, test } from '@playwright/test';
import {
  recordedLegacyInputSchema,
  recordedPaymentInputSchema,
} from '../../src/pages/checkout/payment-recovery';
const id = '9007199254740993',
  base = `/api/v1/stores/1/orders/${id}`;
for (const mode of ['cash', 'legacy'] as const) {
  test(`existing order ${mode} payment confirms without completing a local cart`, async ({
    page,
  }) => {
    let attempt: {
        id: string;
        orderId: string;
        transactionId: string;
        channel: string;
        cashAmount: string;
        onlineAmount: string;
        status: string;
        errorCode: null;
      } | null = null,
      paid = false,
      starts = 0,
      adopts = 0,
      enquiries = 0,
      invoiceReads = 0;
    let ownerId = '';
    await installInvoicePrintProbe(page);
    await page.route(
      '**/api/v1/operators/*/stores/1/orders/' + id + '/invoices/store/preview',
      (route) => {
        expect(new URL(route.request().url()).pathname).toBe(
          `/api/v1/operators/${ownerId}/stores/1/orders/${id}/invoices/store/preview`,
        );
        invoiceReads++;
        return route.fulfill({
          contentType: 'text/html',
          headers: { 'Content-Security-Policy': invoicePreviewPolicy, 'Cache-Control': 'no-store' },
          body: invoicePreviewHtml(
            sanitizeInvoiceHtml('<h1>Existing order tax invoice</h1>'),
            { operatorId: ownerId, storeId: '1', orderId: id, kind: 'store' },
            'ISOLATED-EXISTING-INVOICE',
          ),
        });
      },
    );
    await page.route('**/api/v1/stores/*/orders/**', async (route) => {
      const path = new URL(route.request().url()).pathname,
        method = route.request().method();
      const actor = route.request().headers()['x-operator-id'];
      expect(actor).toMatch(/^[1-9]\d*$/);
      if (ownerId) expect(actor).toBe(ownerId);
      else ownerId = actor!;
      if (method === 'GET' && path === base + '/invoices/capabilities')
        return route.fulfill({ json: { storeId: '1', orderId: id, actions: [] } });
      if (method === 'GET' && path === base)
        return route.fulfill({
          json: {
            reference: 'EXISTING-PAYMENT-ORDER',
            amount: 99.95,
            isPaid: paid,
            status: paid ? 'Delivered' : 'Order Placed',
            createdAt: '2026-11-17T12:00:00',
            lines: [],
          },
        });
      if (method === 'GET' && path === base + '/payment-context')
        return route.fulfill({
          json: {
            orderId: id,
            storeId: '1',
            counterId: '1',
            payable: '99.95',
            canRecordPayment: mode === 'cash' && !attempt,
            activeAttemptId: attempt?.id ?? null,
            legacyPayment:
              mode === 'legacy' && !attempt
                ? { provider: 'pine', legacyId: '9007199254740994' }
                : null,
            blocker: null,
          },
        });
      if (method === 'GET' && path === base + '/cancellations')
        return route.fulfill({
          json: {
            orderId: id,
            storeId: '1',
            counterId: '1',
            eligible: false,
            snapshotHash: null,
            blocker: 'ORDER_NOT_CANCELLABLE',
            receipt: null,
          },
        });
      if (method === 'GET' && path === base + '/payment-options')
        return route.fulfill({
          json: {
            payable: '99.95',
            options: [{ channel: 'cash', label: 'Cash', machineId: null }],
          },
        });
      if (method === 'GET' && path === base + '/payment-attempts')
        return route.fulfill({ json: { data: attempt ? [attempt] : [] } });
      if (method === 'GET' && path.startsWith(base + '/payment-attempts/') && attempt)
        return route.fulfill({ json: attempt });
      if (method === 'POST' && path === base + '/payment-attempts') {
        const body = recordedPaymentInputSchema.parse(route.request().postDataJSON() as unknown);
        starts++;
        attempt = {
          id: body.operationId,
          orderId: id,
          transactionId: 'ORIGINAL-CASH',
          channel: body.channel,
          cashAmount: body.cashAmount,
          onlineAmount: body.onlineAmount,
          status: 'paid',
          errorCode: null,
        };
        paid = true;
        return route.fulfill({ json: attempt });
      }
      if (method === 'POST' && path === base + '/legacy-payment-recoveries') {
        const body = recordedLegacyInputSchema.parse(route.request().postDataJSON() as unknown);
        adopts++;
        attempt = {
          id: body.operationId,
          orderId: id,
          transactionId: 'ORIGINAL-TERMINAL',
          channel: 'pine-card',
          cashAmount: '0.00',
          onlineAmount: '99.95',
          status: 'uncertain',
          errorCode: null,
        };
        return route.abort();
      }
      if (method === 'POST' && path.endsWith('/reconciliations') && attempt) {
        enquiries++;
        attempt.status = 'paid';
        paid = true;
        return route.fulfill({ json: attempt });
      }
      throw new Error('Unexpected order payment fixture request: ' + method + ' ' + path);
    });
    await page.goto('/orders?orderId=' + id);
    await page.getByRole('button', { name: 'Explore demo workspace' }).click();
    await expect(
      page.getByRole('heading', { name: 'EXISTING-PAYMENT-ORDER', exact: true }),
    ).toBeVisible();
    await page.evaluate(async (ownerId) => {
      const opened = indexedDB.open('souled-pos-v1'),
        database = await new Promise<IDBDatabase>((resolve, reject) => {
          opened.onsuccess = () => resolve(opened.result);
          opened.onerror = () => reject(opened.error);
        });
      const transaction = database.transaction('drafts', 'readwrite');
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
    }, ownerId);
    if (mode === 'cash')
      await page.getByRole('button', { name: 'Record received payment' }).click();
    else {
      await page.getByRole('button', { name: 'Recover original terminal payment' }).click();
      await expect(page.getByRole('button', { name: 'Check payment status' })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('button', { name: 'Check payment status' })).toBeVisible();
      expect(adopts).toBe(1);
      expect(enquiries).toBe(0);
      await page.getByRole('button', { name: 'Check payment status' }).click();
    }
    await expect(page.getByText('Payment confirmed · ORIGINAL-', { exact: false })).toBeVisible();
    await expect(
      page
        .frameLocator(`iframe[title="Tax invoice for order ${id}"]`)
        .getByRole('heading', { name: 'Existing order tax invoice' }),
    ).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-invoice-print-count', '1');
    expect(invoiceReads).toBe(1);
    await page.getByRole('button', { name: 'Close invoice' }).click();
    await page.reload();
    await expect(page.getByText('Payment confirmed · ORIGINAL-', { exact: false })).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(invoiceReads).toBe(1);
    expect(starts).toBe(mode === 'cash' ? 1 : 0);
    expect(adopts).toBe(mode === 'legacy' ? 1 : 0);
    expect(enquiries).toBe(mode === 'legacy' ? 1 : 0);
    const snapshot = await page.evaluate(async (ownerId) => {
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
    expect(snapshot[0]).toMatchObject({ version: 7, lines: [{ quantity: 8 }] });
    expect(snapshot[1]).toBe(0);
  });
}
