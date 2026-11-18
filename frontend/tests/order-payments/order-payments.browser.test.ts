import { sourceOrderDefaults } from '../../../backend/src/modules/order-history/search/default-ranges.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cashReturnFixture,
  cashPending,
  currentCashPayment,
  handleCashReturn,
  cashOrderId,
  type CashReturnFixture,
} from './cash-return-fixture';
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
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = await mkdtemp(join(tmpdir(), 'pos-actual-order-payments-'));
      server = await createServer({
        configFile: false,
        cacheDir: cache,
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
            `<!doctype html><html><body>
              <script>
                // These cases control online requests/reply loss via routes.
                // Declare the online baseline instead of inheriting host link state.
                document.documentElement.dataset.orderFixtureHostOnline = String(navigator.onLine);
                Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
              </script>
              <div id="root"></div><script type="module" src="/tests/order-payments/harness.tsx"></script>
            </body></html>`,
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
      if (cache) await rm(cache, { recursive: true, force: true });
    });
    async function fixture(
      page: Page,
      legacy = false,
      cancellable = false,
      options: { cash?: CashReturnFixture; actor?: '44' | '55' } = {},
    ) {
      page.setDefaultTimeout(6500);
      await installInvoicePrintProbe(page);
      const cash = options.cash;
      const state = {
        actor: options.actor ?? '44',
        scopeStore: '1',
        detailReads: 0,
        detailErrors: 0,
        detailDeniedAfterCorrection: false,
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
      const orderId = cashOrderId,
        base = `/api/v1/stores/1/orders/${orderId}`;
      await page.route('**/api/v1/**', async (route) => {
        const path = new URL(route.request().url()).pathname,
          method = route.request().method(),
          actor = state.actor;
        if (cash && (await handleCashReturn(route, cash, actor))) return;
        if (path.includes('/operators/')) {
          if (
            method !== 'GET' ||
            path !== `/api/v1/operators/${actor}/stores/1/orders/${orderId}/invoices/store/preview`
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
              { operatorId: actor, storeId: '1', orderId, kind: 'store' },
              'ISOLATED-INVOICE',
            ),
          });
        }
        expect(route.request().headers()['x-operator-id']).toBe(actor);
        if (method === 'GET' && path === `/api/v1/stores/${state.scopeStore}/order-search-options`)
          return route.fulfill({
            json: {
              stores: [{ id: state.scopeStore, name: 'Fixture store', locationCode: 'FIXTURE' }],
              methods: [],
              paymentStatuses: [],
              orderStatuses: [],
              orderTypes: ['ST'],
              checkedInStoreId: state.scopeStore,
              defaults: sourceOrderDefaults(Date.now(), 'Asia/Kolkata'),
            },
          });
        if (method === 'POST' && path === `/api/v1/stores/${state.scopeStore}/orders/searches`) {
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
        if (method === 'GET' && path === base) {
          state.detailReads++;
          if (cash?.receipt && state.detailDeniedAfterCorrection) {
            state.detailErrors++;
            return route.fulfill({
              status: 503,
              json: {
                error: {
                  code: 'ORDER_DETAIL_UNAVAILABLE',
                  message: 'Fixture order detail temporarily unavailable.',
                },
              },
            });
          }
          return route.fulfill({
            json: {
              reference: 'EXISTING-ORDER',
              amount: 99.95,
              isPaid: cash ? !cash.receipt : state.paid,
              status: (cash ? !cash.receipt : state.paid) ? 'Delivered' : 'Order Placed',
              createdAt: '2026-11-17T12:00:00',
              lines: cash
                ? [
                    {
                      id: '9007199254740995',
                      productId: '10',
                      name: 'Original counter goods',
                      quantity: '2',
                      amount: 99.95,
                      gst: 5,
                      status: cash.receipt ? 'PLACED' : 'DELIVERED',
                    },
                  ]
                : [],
            },
          });
        }
        if (
          cash &&
          method === 'GET' &&
          [
            base + '/payment-context',
            base + '/payment-attempts',
            base + '/payment-attempts/' + cash.originalPayment.id,
          ].includes(path) &&
          cashPending(cash)
        )
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: 'CASH_RETURN_RECONCILIATION_REQUIRED',
                message: 'Original returned cash requires manager reconciliation.',
              },
            },
          });
        if (cash && method === 'GET' && path === base + '/payment-context')
          return route.fulfill({
            json: {
              orderId,
              storeId: '1',
              counterId: '3',
              payable: '99.95',
              canRecordPayment: !!cash.receipt,
              activeAttemptId: cash.originalPayment.id,
              legacyPayment: null,
              blocker: cash.receipt ? null : 'ORDER_NOT_PAYABLE',
            },
          });
        if (cash && method === 'GET' && path === base + '/payment-attempts')
          return route.fulfill({ json: { data: [currentCashPayment(cash)] } });
        if (
          cash &&
          method === 'GET' &&
          path === base + '/payment-attempts/' + cash.originalPayment.id
        )
          return route.fulfill({ json: currentCashPayment(cash) });
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
    async function reportHostOffline(page: Page) {
      // The document's explicit fixture baseline must win before app modules,
      // even if the host/browser reports offline when a new context starts.
      await page.addInitScript(() =>
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }),
      );
    }
    const cashPanel = (page: Page) =>
      page.getByRole('region', { name: 'Durable cash return', exact: true });
    async function openManager(
      page: Page,
      cash: CashReturnFixture,
      operatorId: '44' | '55' = '44',
    ) {
      const state = await fixture(page, false, false, { cash, actor: operatorId });
      await page.goto(origin + '/__order-payment-test__?manager&operator=' + operatorId);
      await browserExpect(
        page.getByRole('heading', { name: 'EXISTING-ORDER', exact: true }),
      ).toBeVisible();
      await browserExpect(
        page.getByText('Correct recorded cash payment', { exact: true }),
      ).toBeVisible();
      return state;
    }
    async function expandCash(page: Page) {
      await page.getByText('Correct recorded cash payment', { exact: true }).click();
      await browserExpect(
        cashPanel(page).getByRole('button', { name: 'Prepare return of 99.95' }),
      ).toBeVisible();
    }
    async function prepareCash(page: Page) {
      const panel = cashPanel(page);
      await panel.getByRole('checkbox', { name: /Goods have not been handed over/ }).check();
      await panel.getByRole('button', { name: 'Prepare return of 99.95' }).click();
      await browserExpect(
        panel.getByRole('button', { name: 'Authorize one cash handback' }),
      ).toBeVisible();
    }
    async function armCash(page: Page) {
      await cashPanel(page).getByRole('button', { name: 'Authorize one cash handback' }).click();
      await browserExpect(
        cashPanel(page).getByText(/One cash handback is authorized:/),
      ).toBeVisible();
    }
    async function attestCash(page: Page) {
      await cashPanel(page)
        .getByRole('checkbox', { name: /I confirm this original cash was already returned/ })
        .check();
      await cashPanel(page).getByRole('button', { name: 'Attest original cash return' }).click();
      await browserExpect(
        cashPanel(page).getByRole('button', { name: 'Reconcile returned cash' }),
      ).toBeVisible();
    }
    async function prepareReturnedCash(page: Page) {
      await expandCash(page);
      await prepareCash(page);
      await armCash(page);
      await attestCash(page);
    }
    it('prepares before any handback and atomically refreshes the actual order after the same reserved correction', async () => {
      const page = await browser.newPage(),
        cash = cashReturnFixture();
      try {
        const state = await openManager(page, cash),
          original = JSON.stringify(cash.originalPayment);
        expect(cash.reads).toEqual([]);
        expect(cash.writes).toEqual([]);
        await expandCash(page);
        await prepareCash(page);
        expect(cash.writes.map((row) => row.kind)).toEqual(['prepare']);
        expect(cash.view?.phase).toBe('PREPARED');
        await browserExpect(
          cashPanel(page).getByText(/One cash handback is authorized:/),
        ).toHaveCount(0);
        const saved = await page.evaluate(() =>
          localStorage.getItem('pos:cash-return:v1:44:1:9007199254740993'),
        );
        expect(JSON.parse(saved!) as unknown).toMatchObject({
          intentId: cash.view!.id,
          correctionId: cash.view!.correctionId,
          instructionConsumed: false,
        });
        await armCash(page);
        expect(cash.view?.phase).toBe('RETURN_PENDING');
        await attestCash(page);
        const reserved = cash.view!.correctionId;
        await cashPanel(page).getByRole('button', { name: 'Reconcile returned cash' }).click();
        await browserExpect(cashPanel(page).getByText(/Cash correction recorded ·/)).toBeVisible();
        await browserExpect(page.getByText('2 item(s) · PLACED')).toBeVisible();
        expect(cash.writes.map((row) => row.kind)).toEqual(['prepare', 'arm', 'attest', 'resolve']);
        expect(cash.writes.at(-1)!.operationId).toBe(reserved);
        expect(cash.receipt).toMatchObject({
          id: reserved,
          returnedCash: '99.95',
          operatorId: '44',
          cashReturn: { returnedBy: '44', attestedBy: '44' },
        });
        expect(JSON.stringify(cash.originalPayment)).toBe(original);
        expect(state.starts).toEqual([]);
        expect(state.adopts).toEqual([]);
        expect(state.cancels).toEqual([]);
        expect(state.invoiceReads).toBe(0);
        expect(state.unexpected).toEqual([]);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });
    it('keeps the confirmed financial UUID visible when actual order-detail refresh fails', async () => {
      const page = await browser.newPage(),
        cash = cashReturnFixture();
      try {
        const state = await openManager(page, cash);
        await prepareReturnedCash(page);
        state.detailDeniedAfterCorrection = true;
        const reserved = cash.view!.correctionId;
        await cashPanel(page).getByRole('button', { name: 'Reconcile returned cash' }).click();
        await browserExpect.poll(() => state.detailErrors).toBeGreaterThan(0);
        await browserExpect(
          page.getByText('Fixture order detail temporarily unavailable.'),
        ).toBeVisible();
        await browserExpect(page.getByText(reserved, { exact: false })).toBeVisible();
        expect(cash.writes).toHaveLength(4);
        expect(cash.receipt?.id).toBe(reserved);
        expect(state.starts).toEqual([]);
        expect(state.invoiceReads).toBe(0);
        expect(state.unexpected).toEqual([]);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });
    it('reopens a saved actual-order correction GET-only after its committed response was lost', async () => {
      const page = await browser.newPage(),
        cash = cashReturnFixture();
      try {
        const state = await openManager(page, cash);
        await prepareReturnedCash(page);
        cash.drop = { kind: 'resolve', outcome: 'committed' };
        await cashPanel(page).getByRole('button', { name: 'Reconcile returned cash' }).click();
        await browserExpect(
          cashPanel(page).getByRole('button', { name: 'Check original return action' }),
        ).toBeVisible();
        const reserved = cash.view!.correctionId;
        expect(cash.writes).toHaveLength(4);
        await page.reload();
        await browserExpect(cashPanel(page).getByText(/Cash correction recorded ·/)).toBeVisible();
        expect(cash.writes).toHaveLength(4);
        expect(cash.reads.some((row) => row.path.endsWith('/payment-reversals/' + reserved))).toBe(
          true,
        );
        await browserExpect(page.getByText(/One cash handback is authorized:/)).toHaveCount(0);
        expect(cash.receipt?.id).toBe(reserved);
        expect(state.starts).toEqual([]);
        expect(state.invoiceReads).toBe(0);
        expect(state.unexpected).toEqual([]);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });
    it('a lost actual-order arm acknowledgment recovers by original operation GET and never repeats a cash instruction', async () => {
      const page = await browser.newPage(),
        cash = cashReturnFixture();
      try {
        const state = await openManager(page, cash);
        await expandCash(page);
        await prepareCash(page);
        cash.drop = { kind: 'arm', outcome: 'committed' };
        await cashPanel(page).getByRole('button', { name: 'Authorize one cash handback' }).click();
        await browserExpect(
          cashPanel(page).getByRole('button', { name: 'Check original return action' }),
        ).toBeVisible();
        const armId = cash.writes.at(-1)!.operationId;
        await page.reload();
        await browserExpect(
          cashPanel(page).getByText(/Cash may already have been handed back/),
        ).toBeVisible();
        expect(cash.writes.map((row) => row.kind)).toEqual(['prepare', 'arm']);
        expect(cash.reads.some((row) => row.path.endsWith('/operations/' + armId))).toBe(true);
        await browserExpect(page.getByText(/One cash handback is authorized:/)).toHaveCount(0);
        await browserExpect(
          page.getByRole('button', { name: 'Cancel unperformed preparation' }),
        ).toHaveCount(0);
        expect(cash.receipt).toBeNull();
        expect(state.starts).toEqual([]);
        expect(state.invoiceReads).toBe(0);
        expect(state.unexpected).toEqual([]);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });
    it('an absent correction keeps its original attested return and UUID until explicit reconciliation', async () => {
      const page = await browser.newPage(),
        cash = cashReturnFixture();
      try {
        const state = await openManager(page, cash);
        await prepareReturnedCash(page);
        cash.drop = { kind: 'resolve', outcome: 'absent' };
        await cashPanel(page).getByRole('button', { name: 'Reconcile returned cash' }).click();
        await browserExpect(
          cashPanel(page).getByRole('button', { name: 'Check original return action' }),
        ).toBeVisible();
        const original = cash.writes.at(-1)!;
        await page.reload();
        await browserExpect(
          cashPanel(page).getByRole('button', { name: 'Reconcile returned cash' }),
        ).toBeVisible();
        expect(cash.writes).toHaveLength(4);
        expect(cash.view?.phase).toBe('ATTESTED');
        expect(cash.receipt).toBeNull();
        await browserExpect(page.getByText(/One cash handback is authorized:/)).toHaveCount(0);
        await cashPanel(page).getByRole('button', { name: 'Reconcile returned cash' }).click();
        await browserExpect(cashPanel(page).getByText(/Cash correction recorded ·/)).toBeVisible();
        expect(cash.writes.at(-1)!.input).toEqual(original.input);
        expect(cash.writes.at(-1)!.operationId).toBe(original.operationId);
        expect(cash.writes.filter((row) => row.kind === 'arm')).toHaveLength(1);
        expect(state.starts).toEqual([]);
        expect(state.invoiceReads).toBe(0);
        expect(state.unexpected).toEqual([]);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });
    it('actual-page storage failure prevents preparation, physical permission and all money dispatch', async () => {
      const page = await browser.newPage(),
        cash = cashReturnFixture();
      try {
        const state = await openManager(page, cash);
        await expandCash(page);
        await page.evaluate(() => {
          Storage.prototype.setItem = () => {
            throw new DOMException('Fixture recovery storage unavailable', 'QuotaExceededError');
          };
        });
        await cashPanel(page)
          .getByRole('checkbox', { name: /Goods have not been handed over/ })
          .check();
        await cashPanel(page).getByRole('button', { name: 'Prepare return of 99.95' }).click();
        await browserExpect(cashPanel(page).getByRole('alert')).toContainText(
          'Fixture recovery storage unavailable',
        );
        expect(cash.writes).toEqual([]);
        expect(cash.view).toBeNull();
        expect(state.starts).toEqual([]);
        expect(state.unexpected).toEqual([]);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });
    it.each(['manager', 'store'] as const)(
      'a late recorded return cannot publish into a different actual OrdersPage %s scope',
      async (kind) => {
        const page = await browser.newPage(),
          cash = cashReturnFixture();
        try {
          const state = await openManager(page, cash);
          await prepareReturnedCash(page);
          cash.holdResolution = true;
          await cashPanel(page).getByRole('button', { name: 'Reconcile returned cash' }).click();
          await browserExpect.poll(() => cash.writes.length).toBe(4);
          if (kind === 'manager') {
            state.actor = '55';
            // External session/workspace changes can arrive while the order modal is open.
            await page
              .getByRole('button', { name: 'Switch fixture manager' })
              .dispatchEvent('click');
            await browserExpect(page.getByLabel('Fixture operator')).toHaveText('55');
          } else {
            state.scopeStore = '2';
            await page.getByRole('button', { name: 'Switch fixture store' }).dispatchEvent('click');
          }
          await browserExpect(page.getByRole('dialog')).toHaveCount(0);
          cash.releaseResolution();
          await browserExpect.poll(() => cash.receipt?.id).toBe(cash.view!.correctionId);
          await browserExpect(page.getByText(/Cash correction recorded ·/)).toHaveCount(0);
          await browserExpect(
            page.getByText(cash.view!.correctionId, { exact: false }),
          ).toHaveCount(0);
          expect(cash.writes.every((row) => row.actorId === '44')).toBe(true);
          expect(state.starts).toEqual([]);
          expect(state.invoiceReads).toBe(0);
          expect(state.unexpected).toEqual([]);
          await assertCartRetained(page);
        } finally {
          cash.releaseResolution();
          await page.close();
        }
      },
    );
    it('another manager on a fresh device reconciles the shared pending queue with the original financial UUID', async () => {
      const first = await browser.newPage(),
        cash = cashReturnFixture();
      let second: Page | undefined;
      try {
        const originalState = await openManager(first, cash);
        await prepareReturnedCash(first);
        const original = JSON.stringify(cash.originalPayment),
          reserved = cash.view!.correctionId,
          originalCashDate = cash.view!.attestation!.evidence.businessDate;
        cash.drop = { kind: 'resolve', outcome: 'absent' };
        await cashPanel(first).getByRole('button', { name: 'Reconcile returned cash' }).click();
        await browserExpect(
          cashPanel(first).getByRole('button', { name: 'Check original return action' }),
        ).toBeVisible();
        expect(cash.writes).toHaveLength(4);
        await first.close();
        second = await browser.newPage();
        const currentState = await openManager(second, cash, '55');
        expect(
          await second.evaluate(() =>
            Object.keys(localStorage).filter((key) => key.startsWith('pos:cash-return:')),
          ),
        ).toEqual([]);
        await second.getByRole('button', { name: 'Close order', exact: true }).click();
        await second.getByRole('button', { name: 'Review store cash returns' }).click();
        await browserExpect(second.getByRole('listitem')).toContainText('ATTESTED');
        await second.getByRole('button', { name: 'Review return ' + cash.view!.id }).click();
        await browserExpect(
          cashPanel(second).getByText(/Cash already returned by operator 44/),
        ).toBeVisible();
        await browserExpect(second.getByText(/One cash handback is authorized:/)).toHaveCount(0);
        await cashPanel(second).getByRole('button', { name: 'Reconcile returned cash' }).click();
        await browserExpect(
          second.getByText(
            'Original cash correction ' +
              reserved +
              ' is recorded. No additional cash handback is authorized.',
          ),
        ).toBeVisible();
        expect(cash.receipt).toMatchObject({
          id: reserved,
          operatorId: '55',
          businessDate: originalCashDate,
          cashReturn: { returnedBy: '44', attestedBy: '44' },
        });
        expect(cash.writes.at(-1)).toMatchObject({
          kind: 'resolve',
          operationId: reserved,
          actorId: '55',
          input: { operationId: reserved },
        });
        expect(cash.writes.filter((row) => row.kind === 'arm')).toHaveLength(1);
        expect(JSON.stringify(cash.originalPayment)).toBe(original);
        expect(originalState.starts).toEqual([]);
        expect(currentState.starts).toEqual([]);
        expect(currentState.invoiceReads).toBe(0);
        expect(currentState.unexpected).toEqual([]);
        await assertCartRetained(second);
      } finally {
        if (!first.isClosed()) await first.close();
        await second?.close();
      }
    });
    it('records existing-order cash and refreshes its detail without clearing or completing a local sale', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.goto(origin + '/__order-payment-test__');
        await browserExpect(
          page.getByText('Correct recorded cash payment', { exact: true }),
        ).toHaveCount(0);
        await browserExpect(
          page.getByRole('button', { name: 'Review store cash returns' }),
        ).toHaveCount(0);
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
    it('declares online transport and enforces actual offline payment and cancellation transitions', async () => {
      const page = await browser.newPage();
      try {
        await reportHostOffline(page);
        const state = await fixture(page, false, true);
        await page.goto(origin + '/__order-payment-test__');
        await browserExpect(page.locator('html')).toHaveAttribute(
          'data-order-fixture-host-online',
          'false',
        );
        const pay = page.getByRole('button', { name: 'Record received payment' }),
          cancel = page.getByRole('button', { name: 'Cancel pending order', exact: true });
        await browserExpect(pay).toBeEnabled();
        await browserExpect(cancel).toBeEnabled();
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
          window.dispatchEvent(new Event('offline'));
        });
        await browserExpect(pay).toBeDisabled();
        await browserExpect(cancel).toBeDisabled();
        await browserExpect(
          page.getByText('Reconnect to confirm payment. Products remain pending delivery.'),
        ).toBeVisible();
        expect(state.starts).toEqual([]);
        expect(state.cancels).toEqual([]);
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
          window.dispatchEvent(new Event('online'));
        });
        await browserExpect(pay).toBeEnabled();
        await pay.click();
        await browserExpect(
          page.getByText('Payment confirmed · ORIGINAL-CASH.', { exact: false }),
        ).toBeVisible();
        expect(state.starts).toHaveLength(1);
        expect(state.cancels).toEqual([]);
        expect(state.unexpected).toEqual([]);
        await assertCartRetained(page);
      } finally {
        await page.close();
      }
    });
    it('reloads an absent original cash request GET-only and explicitly retries the exact saved body', async () => {
      const page = await browser.newPage();
      try {
        await reportHostOffline(page);
        const state = await fixture(page);
        state.loseStart = true;
        await page.goto(origin + '/__order-payment-test__');
        await browserExpect(page.locator('html')).toHaveAttribute(
          'data-order-fixture-host-online',
          'false',
        );
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
        await reportHostOffline(page);
        const state = await fixture(page, true);
        state.loseAdopt = true;
        await page.goto(origin + '/__order-payment-test__');
        await browserExpect(page.locator('html')).toHaveAttribute(
          'data-order-fixture-host-online',
          'false',
        );
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
        await reportHostOffline(page);
        const state = await fixture(page, false, true);
        state.loseCancel = 'committed';
        await page.goto(origin + '/__order-payment-test__');
        await browserExpect(page.locator('html')).toHaveAttribute(
          'data-order-fixture-host-online',
          'false',
        );
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
        await reportHostOffline(page);
        const state = await fixture(page, false, true);
        state.loseCancel = 'absent';
        await page.goto(origin + '/__order-payment-test__');
        await browserExpect(page.locator('html')).toHaveAttribute(
          'data-order-fixture-host-online',
          'false',
        );
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
        await reportHostOffline(page);
        const state = await fixture(page, false, true);
        state.benefits = true;
        await page.goto(origin + '/__order-payment-test__');
        await browserExpect(page.locator('html')).toHaveAttribute(
          'data-order-fixture-host-online',
          'false',
        );
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
