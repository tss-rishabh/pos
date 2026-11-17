import { installInvoicePrintProbe } from '../../e2e/checkout/invoice-print-probe';
import { sanitizeInvoiceHtml } from '../../../backend/src/modules/checkout/invoices.js';
import {
  invoicePreviewHtml,
  invoicePreviewPolicy,
} from '../../../backend/src/modules/invoice-documents/presentation.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { paymentSchema } from '../../src/pages/checkout/PaymentPanel';
import {
  recordedPaymentInputSchema,
  recordedLegacyInputSchema,
} from '../../src/pages/checkout/payment-recovery';
import { z } from 'zod';
import {
  cancellationIntentSchema,
  cancellationReceiptSchema,
} from '../../src/pages/checkout/cancellations/client';
describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'existing-order payment recovery in actual OrdersPage',
  { timeout: 20000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        configFile: false,
        cacheDir: 'node_modules/.vite-order-payment-tests',
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__order-payment-test__')) return next();
        response.setHeader('Content-Type', 'text/html');
        response.end(
          await server.transformIndexHtml(
            '/__order-payment-test__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/order-payments/harness.tsx"></script></body></html>',
          ),
        );
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Payment fixture failed to bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    });
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });
    async function fixture(page: Page, legacy = false, cancellable = false) {
      page.setDefaultTimeout(6500);
      await installInvoicePrintProbe(page);
      const state = {
        attempt: null as z.infer<typeof paymentSchema> | null,
        starts: [] as unknown[],
        adopts: [] as unknown[],
        checks: 0,
        paid: false,
        invoiceReads: 0,
        invoiceDenied: false,
        benefits: false,
        loseStart: false,
        loseAdopt: false,
        cancellation: null as z.infer<typeof cancellationReceiptSchema> | null,
        cancels: [] as unknown[],
        loseCancel: null as 'absent' | 'committed' | null,
        unexpected: [] as string[],
      };
      const orderId = '9007199254740993',
        base = `/api/v1/stores/1/orders/${orderId}`;
      await page.route('**/api/v1/**', async (route) => {
        const path = new URL(route.request().url()).pathname,
          method = route.request().method();
        if (path.includes('/operators/')) {
          if (
            method !== 'GET' ||
            path !== `/api/v1/operators/44/stores/1/orders/${orderId}/invoices/store/preview`
          )
            throw new Error('Unexpected invoice actor route');
          state.invoiceReads++;
          if (state.invoiceDenied)
            return route.fulfill({
              status: 503,
              json: {
                error: { code: 'INVOICE_UNAVAILABLE', message: 'Invoice temporarily unavailable.' },
              },
            });
          return route.fulfill({
            contentType: 'text/html',
            headers: {
              'Content-Security-Policy': invoicePreviewPolicy,
              'Cache-Control': 'no-store',
            },
            body: invoicePreviewHtml(
              sanitizeInvoiceHtml('<h1>Existing order tax invoice</h1>'),
              { operatorId: '44', storeId: '1', orderId, kind: 'store' },
              'ISOLATED-INVOICE',
            ),
          });
        }
        expect(route.request().headers()['x-operator-id']).toBe('44');
        if (method === 'GET' && path === '/api/v1/stores/1/order-search-options')
          return route.fulfill({
            json: {
              stores: [{ id: '1', name: 'Fixture store', locationCode: 'FIXTURE' }],
              methods: [],
              paymentStatuses: [],
              orderStatuses: [],
              orderTypes: ['ST'],
              checkedInStoreId: '1',
            },
          });
        if (method === 'POST' && path === '/api/v1/stores/1/orders/searches') {
          const input = z
            .object({
              draw: z.number().int(),
              pageSize: z.number().int(),
              from: z.string(),
              to: z.string(),
            })
            .parse(route.request().postDataJSON() as unknown);
          return route.fulfill({
            json: {
              contract: 'pos-source-order-search-v1',
              draw: input.draw,
              recordsTotal: '0',
              recordsFiltered: '0',
              page: 1,
              pageSize: input.pageSize,
              reader: 'primary',
              data: [],
              fetchedAt: new Date().toISOString(),
              generationId: null,
              range: {
                from: input.from,
                to: input.to,
                timeZone: 'Asia/Kolkata',
                ignoredForQueue: false,
              },
            },
          });
        }
        if (method === 'GET' && path === base + '/invoices/capabilities')
          return route.fulfill({ json: { storeId: '1', orderId, actions: [] } });
        if (method === 'GET' && path === '/api/v1/stores/1/orders')
          return route.fulfill({ json: { data: [], nextCursor: null } });
        if (method === 'GET' && path === base)
          return route.fulfill({
            json: {
              reference: 'EXISTING-ORDER',
              amount: 99.95,
              isPaid: state.paid,
              status: state.paid ? 'Delivered' : 'Order Placed',
              createdAt: '2026-11-17T12:00:00',
              lines: [],
            },
          });
        if (method === 'GET' && path === base + '/payment-context')
          return route.fulfill({
            json: {
              orderId,
              storeId: '1',
              counterId: '3',
              payable: '99.95',
              canRecordPayment: !legacy && !state.attempt && !state.cancellation,
              activeAttemptId: state.attempt?.id ?? null,
              legacyPayment:
                legacy && !state.attempt
                  ? { provider: 'pine', legacyId: '9007199254740994' }
                  : null,
              blocker: state.cancellation
                ? 'ORDER_CANCELLATION_RECORDED'
                : state.paid
                  ? 'ORDER_NOT_PAYABLE'
                  : null,
            },
          });
        if (method === 'GET' && path === base + '/cancellations')
          return route.fulfill({
            json: {
              orderId,
              storeId: '1',
              counterId: '3',
              eligible: cancellable && !state.cancellation,
              snapshotHash: cancellable ? 'a'.repeat(64) : null,
              blocker: cancellable ? null : 'ORDER_NOT_CANCELLABLE',
              receipt: state.cancellation,
              ...(state.benefits
                ? {
                    benefits: {
                      policy: 'pos-cancellation-original-expiry-v1',
                      moneyCredited: '15',
                      moneyExpired: '10',
                      pointsCredited: '30',
                      pointsExpired: '0',
                      voucherCredited: '20',
                      voucherAvailable: false,
                      membership: 'prior-entitlement-restored',
                    },
                  }
                : {}),
            },
          });
        if (method === 'GET' && path.startsWith(base + '/cancellations/'))
          return state.cancellation
            ? route.fulfill({ json: state.cancellation })
            : route.fulfill({
                status: 404,
                json: {
                  error: {
                    code: 'CANCELLATION_NOT_FOUND',
                    message: 'Original cancellation absent.',
                  },
                },
              });
        if (method === 'POST' && path === base + '/cancellations') {
          const input = cancellationIntentSchema.parse(route.request().postDataJSON() as unknown);
          state.cancels.push(input);
          if (state.loseCancel === 'absent') {
            state.loseCancel = null;
            return route.abort();
          }
          state.cancellation = cancellationReceiptSchema.parse({
            id: input.operationId,
            orderId,
            storeId: '1',
            counterId: '3',
            operatorId: '44',
            status: 'cancelled',
            cashRefunded: '0.00',
            cancelledAt: '2026-11-17 12:00:00',
            snapshotHash: input.snapshotHash,
            restoredProducts: [{ productId: '10', quantity: 2, before: 10, after: 12 }],
            lineIds: ['9007199254740995'],
            closeImpact: null,
            ...(state.benefits
              ? {
                  benefits: {
                    policy: 'pos-cancellation-original-expiry-v1',
                    moneyCredited: '15',
                    moneyExpired: '10',
                    pointsCredited: '30',
                    pointsExpired: '0',
                    voucherCredited: '20',
                    voucherAvailable: false,
                    membership: 'prior-entitlement-restored',
                  },
                }
              : {}),
          });
          if (state.loseCancel === 'committed') {
            state.loseCancel = null;
            return route.abort();
          }
          return route.fulfill({ json: state.cancellation });
        }
        if (method === 'GET' && path === base + '/payment-options')
          return route.fulfill({
            json: {
              payable: '99.95',
              options: [{ channel: 'cash', label: 'Cash', machineId: null }],
            },
          });
        if (method === 'GET' && path === base + '/payment-attempts')
          return route.fulfill({ json: { data: state.attempt ? [state.attempt] : [] } });
        if (method === 'GET' && path.startsWith(base + '/payment-attempts/'))
          return state.attempt
            ? route.fulfill({ json: state.attempt })
            : route.fulfill({
                status: 404,
                json: {
                  error: {
                    code: 'PAYMENT_ATTEMPT_NOT_FOUND',
                    message: 'Original request not found.',
                  },
                },
              });
        if (method === 'POST' && path === base + '/payment-attempts') {
          const input = recordedPaymentInputSchema.parse(route.request().postDataJSON() as unknown);
          state.starts.push(input);
          if (state.loseStart) {
            state.loseStart = false;
            return route.abort();
          }
          state.attempt = paymentSchema.parse({
            id: input.operationId,
            orderId,
            transactionId: 'ORIGINAL-CASH',
            channel: input.channel,
            cashAmount: input.cashAmount,
            onlineAmount: input.onlineAmount,
            status: 'paid',
            errorCode: null,
          });
          state.paid = true;
          return route.fulfill({ json: state.attempt });
        }
        if (method === 'POST' && path === base + '/legacy-payment-recoveries') {
          const input = recordedLegacyInputSchema.parse(route.request().postDataJSON() as unknown);
          state.adopts.push(input);
          state.attempt = paymentSchema.parse({
            id: input.operationId,
            orderId,
            transactionId: 'ORIGINAL-TERMINAL',
            channel: 'pine-card',
            cashAmount: '0.00',
            onlineAmount: '99.95',
            status: 'uncertain',
            errorCode: null,
          });
          if (state.loseAdopt) {
            state.loseAdopt = false;
            return route.abort();
          }
          return route.fulfill({ json: state.attempt });
        }
        if (method === 'POST' && path.endsWith('/reconciliations') && state.attempt) {
          state.checks++;
          state.attempt.status = 'paid';
          state.paid = true;
          return route.fulfill({ json: state.attempt });
        }
        state.unexpected.push(method + ' ' + path);
        return route.fulfill({
          status: 400,
          json: { error: { code: 'UNEXPECTED', message: 'Unexpected fixture request.' } },
        });
      });
      return state;
    }
    async function assertCartRetained(page: Page) {
      const rows = await page.evaluate(async () => {
        const opened = indexedDB.open('souled-pos-v1');
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          opened.onsuccess = () => resolve(opened.result);
          opened.onerror = () => reject(opened.error);
        });
        const read = database.transaction(['drafts', 'completedSales'], 'readonly');
        const get = read.objectStore('drafts').getAll(),
          sales = read.objectStore('completedSales').getAll();
        const result = await Promise.all([
          new Promise<unknown>((resolve) => {
            get.onsuccess = () => resolve(get.result as unknown);
          }),
          new Promise<unknown>((resolve) => {
            sales.onsuccess = () => resolve(sales.result as unknown);
          }),
        ]);
        database.close();
        return result;
      });
      expect(rows[0]).toMatchObject([
        { id: '22222222-2222-4222-8222-222222222222', version: 7, lines: [{ quantity: 8 }] },
      ]);
      expect(rows[1]).toEqual([]);
    }
    it('records existing-order cash and refreshes its detail without clearing or completing a local sale', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.goto(origin + '/__order-payment-test__');
        await page.getByRole('button', { name: 'Record received payment' }).click();
        await browserExpect(
          page.getByText('Payment confirmed · ORIGINAL-CASH.', { exact: false }),
        ).toBeVisible();
        await browserExpect(
          page
            .frameLocator(`iframe[title=\"Tax invoice for order 9007199254740993\"]`)
            .getByRole('heading', { name: 'Existing order tax invoice' }),
        ).toBeVisible();
        await browserExpect(page.locator('html')).toHaveAttribute('data-invoice-print-count', '1');
        expect(state.invoiceReads).toBe(1);
        await page.getByRole('button', { name: 'Close invoice' }).click();
        await page.reload();
        await browserExpect(
          page.getByText('Payment confirmed · ORIGINAL-CASH.', { exact: false }),
        ).toBeVisible();
        expect(state.invoiceReads).toBe(1);
        await browserExpect(page.locator('iframe')).toHaveCount(0);
        expect(state.starts).toHaveLength(1);
        expect(state.adopts).toHaveLength(0);
        expect(state.unexpected).toEqual([]);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });
    it('reloads an absent original cash request GET-only and explicitly retries the exact saved body', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.loseStart = true;
        await page.goto(origin + '/__order-payment-test__');
        await page.getByRole('button', { name: 'Record received payment' }).click();
        await browserExpect(page.getByRole('alert')).toBeVisible();
        await page.reload();
        await browserExpect(
          page.getByRole('button', { name: 'Retry original payment request' }),
        ).toBeVisible();
        expect(state.starts).toHaveLength(1);
        await page.getByRole('button', { name: 'Retry original payment request' }).click();
        await browserExpect(
          page.getByText('Payment confirmed · ORIGINAL-CASH.', { exact: false }),
        ).toBeVisible();
        expect(state.starts).toHaveLength(2);
        expect(state.starts[1]).toEqual(state.starts[0]);
        expect(state.unexpected).toEqual([]);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });
    it('recovers a lost committed legacy adoption without charge or another adoption and enquires explicitly', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page, true);
        state.loseAdopt = true;
        await page.goto(origin + '/__order-payment-test__');
        await page.getByRole('button', { name: 'Recover original terminal payment' }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Check payment status' }),
        ).toBeVisible();
        await page.reload();
        await browserExpect(
          page.getByRole('button', { name: 'Check payment status' }),
        ).toBeVisible();
        expect(state.adopts).toHaveLength(1);
        expect(state.starts).toHaveLength(0);
        expect(state.checks).toBe(0);
        await page.getByRole('button', { name: 'Check payment status' }).click();
        await browserExpect(
          page.getByText('Payment confirmed · ORIGINAL-TERMINAL.', { exact: false }),
        ).toBeVisible();
        expect(state.checks).toBe(1);
        expect(state.adopts).toHaveLength(1);
        expect(state.unexpected).toEqual([]);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });
    it('recovers a committed lost cancellation after reload with one command and no payment or local cart completion', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page, false, true);
        state.loseCancel = 'committed';
        await page.goto(origin + '/__order-payment-test__');
        await page.getByRole('button', { name: 'Cancel pending order', exact: true }).click();
        await page.getByRole('button', { name: 'Confirm pending order cancellation' }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Check original cancellation' }),
        ).toBeVisible();
        await page.reload();
        await browserExpect(
          page.getByText('Order cancellation confirmed.', { exact: false }),
        ).toBeVisible();
        expect(state.cancels).toHaveLength(1);
        expect(state.starts).toHaveLength(0);
        expect(state.unexpected).toEqual([]);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });
    it('keeps an absent cancellation GET-only until an explicit retry of its original UUID and snapshot', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page, false, true);
        state.loseCancel = 'absent';
        await page.goto(origin + '/__order-payment-test__');
        await page.getByRole('button', { name: 'Cancel pending order', exact: true }).click();
        await page.getByRole('button', { name: 'Confirm pending order cancellation' }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Check original cancellation' }),
        ).toBeVisible();
        await page.reload();
        await browserExpect(
          page.getByRole('button', { name: 'Retry original cancellation' }),
        ).toBeVisible();
        expect(state.cancels).toHaveLength(1);
        await page.getByRole('button', { name: 'Retry original cancellation' }).click();
        await browserExpect(
          page.getByText('Order cancellation confirmed.', { exact: false }),
        ).toBeVisible();
        expect(state.cancels).toHaveLength(2);
        expect(state.cancels[1]).toEqual(state.cancels[0]);
        expect(state.starts).toHaveLength(0);
        expect(state.unexpected).toEqual([]);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });

    it('reviews approved benefit restoration and confirms retained expiry, unavailable voucher value and prior membership without a cash refund', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page, false, true);
        state.benefits = true;
        await page.goto(origin + '/__order-payment-test__');
        await page.getByRole('button', { name: 'Cancel pending order', exact: true }).click();
        await browserExpect(page.getByText('Restore TSS Money: 15')).toBeVisible();
        await browserExpect(page.getByText(/Already expired value remains unusable/)).toBeVisible();
        await browserExpect(page.getByText(/credit remains unavailable/)).toBeVisible();
        await browserExpect(
          page.getByText('Preserve the previously owned membership.'),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Confirm pending order cancellation' }).click();
        await browserExpect(page.getByText('Restored TSS Money: 15')).toBeVisible();
        await browserExpect(
          page.getByText('The previously owned membership was restored.'),
        ).toBeVisible();
        expect(state.cancels).toHaveLength(1);
        expect(state.starts).toHaveLength(0);
        expect(state.invoiceReads).toBe(0);
        expect(state.unexpected).toEqual([]);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });
    it('retains an existing-order confirmed payment and the unrelated cart if automatic invoice publication fails', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.invoiceDenied = true;
        await page.goto(origin + '/__order-payment-test__');
        await page.getByRole('button', { name: 'Record received payment' }).click();
        await browserExpect(
          page.getByText('Payment confirmed · ORIGINAL-CASH.', { exact: false }),
        ).toBeVisible();
        await browserExpect(page.getByRole('alert')).toContainText(
          'Invoice temporarily unavailable.',
        );
        expect(state.starts).toHaveLength(1);
        expect(state.paid).toBe(true);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });
  },
);
