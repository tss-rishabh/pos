import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  correctionInputSchema,
  correctionReceiptSchema,
  type CorrectionInput,
  type CorrectionReceipt,
} from '../../src/pages/payment-reversals/client';

const originalId = '11111111-1111-4111-8111-111111111111';
describe.skipIf(process.env.PAYMENT_REVERSAL_BROWSER_TESTS !== 'true')(
  'actual cash-correction child and original payment recovery in Chromium',
  { timeout: 15000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = await mkdtemp(join(tmpdir(), 'pos-payment-correction-vite-'));
      server = await createServer({
        configFile: false,
        cacheDir: cache,
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__payment-correction__')) return next();
        try {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            await server.transformIndexHtml(
              '/__payment-correction__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/payment-reversals/harness.tsx"></script></body></html>',
            ),
          );
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Isolated correction browser server failed.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cache) await rm(cache, { recursive: true, force: true });
    });
    async function fixture(page: Page) {
      const state = {
        posts: [] as CorrectionInput[],
        receipt: null as CorrectionReceipt | null,
        gets: 0,
        drop: false,
        commit: true,
        held: false,
        release: () => undefined as void,
        errors: [] as string[],
      };
      page.setDefaultTimeout(7000);
      page.on('pageerror', (error) => state.errors.push(error.message));
      function receipt(body: CorrectionInput) {
        return correctionReceiptSchema.parse({
          id: body.operationId,
          contract: 'pos-payment-correction-v1',
          status: 'recorded',
          orderId: '91',
          storeId: '1',
          counterId: '3',
          operatorId: '44',
          originalPaymentId: originalId,
          originalPaymentHash: 'b'.repeat(64),
          transactionId: 'TXN-ORIGINAL',
          originalCash: '100.00',
          originalCashReceived: '150.00',
          originalFundingAt: '2026-11-16 10:00:00',
          orderDate: '2026-11-16',
          returnedCash: '100.00',
          cashReturnReceiptId: body.cashReturnReceiptId,
          reason: body.reason,
          recordedAt: '2026-11-16 11:00:00',
          businessDate: '2026-11-16',
          headerHash: 'c'.repeat(64),
          lines: [
            { id: '9007199254740994', productId: '10', quantity: '2', inputHash: 'd'.repeat(64) },
          ],
          stockChanged: false,
          benefitsChanged: false,
          providerRefunded: false,
          goodsRetainedAtCounter: true,
        });
      }
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        if (request.headers()['x-operator-id'] !== '44' || !path.includes('/stores/1/orders/91/'))
          return route.fulfill({
            status: 403,
            json: { error: { code: 'STORE_ACCESS_DENIED', message: 'Fixture authority changed' } },
          });
        if (request.method() === 'GET') {
          state.gets++;
          if (path.endsWith('/payment-reversals'))
            return route.fulfill({
              json: {
                orderId: '91',
                storeId: '1',
                counterId: '3',
                eligible: !state.receipt,
                blocker: state.receipt ? 'PAYMENT_REVERSAL_CASH_PROOF_REQUIRED' : null,
                snapshotHash: state.receipt ? null : 'a'.repeat(64),
                originalPaymentId: state.receipt ? null : originalId,
                returnedCash: state.receipt ? null : '100.00',
                latest: state.receipt,
              },
            });
          if (path.includes('/payment-reversals/')) {
            if (state.receipt) return route.fulfill({ json: state.receipt });
            return route.fulfill({
              status: 404,
              json: {
                error: {
                  code: 'PAYMENT_REVERSAL_NOT_FOUND',
                  message: 'Original correction not found.',
                },
              },
            });
          }
          throw new Error('Unexpected fixture read');
        }
        expect(path.endsWith('/payment-reversals')).toBe(true);
        const body = correctionInputSchema.parse(request.postDataJSON() as unknown);
        state.posts.push(body);
        if (state.held)
          await new Promise<void>((resolve) => {
            state.release = resolve;
          });
        if (state.commit) state.receipt = receipt(body);
        if (state.drop) {
          state.drop = false;
          return route.abort('failed');
        }
        return route.fulfill({ status: 201, json: state.receipt ?? receipt(body) });
      });
      return state;
    }
    async function open(page: Page) {
      await page.goto(origin + '/__payment-correction__');
      await browserExpect(page.getByRole('checkbox', { name: /I returned exactly/ })).toBeVisible();
    }
    async function submit(page: Page) {
      await page.getByRole('checkbox', { name: /I returned exactly/ }).check();
      await page.getByRole('checkbox', { name: /Goods have not been handed over/ }).check();
      await page.getByRole('button', { name: 'Record returned cash and reopen payment' }).click();
    }
    it('lost committed POST reloads with GET only and never returns cash or touches a cart twice', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      state.drop = true;
      try {
        await open(page);
        await submit(page);
        await browserExpect(
          page.getByRole('button', { name: 'Check original cash correction' }),
        ).toBeVisible();
        expect(state.posts).toHaveLength(1);
        await page.reload();
        await browserExpect(page.getByText(/Cash correction recorded ·/)).toBeVisible();
        expect(state.posts).toHaveLength(1);
        expect(state.errors).toEqual([]);
        const saved = await page.evaluate(() =>
          Object.keys(localStorage).filter((key) => key.startsWith('pos:payment-correction:')),
        );
        expect(saved).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('unknown absent outcome permits only an explicit exact original registration retry', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      state.drop = true;
      state.commit = false;
      try {
        await open(page);
        await submit(page);
        await page.reload();
        await browserExpect(
          page.getByRole('button', { name: 'Register original cash correction again' }),
        ).toBeVisible();
        expect(state.posts).toHaveLength(1);
        state.commit = true;
        await page.getByRole('button', { name: 'Register original cash correction again' }).click();
        await browserExpect(page.getByText(/Cash correction recorded ·/)).toBeVisible();
        expect(state.posts).toHaveLength(2);
        expect(state.posts[1]).toEqual(state.posts[0]);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('intent storage failure prevents dispatch', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      try {
        await open(page);
        await page.evaluate(() => {
          Storage.prototype.setItem = () => {
            throw new DOMException('Fixture storage unavailable', 'QuotaExceededError');
          };
        });
        await submit(page);
        await browserExpect(page.getByRole('alert')).toContainText('Fixture storage unavailable');
        expect(state.posts).toHaveLength(0);
      } finally {
        await page.close();
      }
    });
    it('detail refresh failure keeps confirmed money evidence and offers refresh without another command', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      try {
        await open(page);
        await page.getByRole('checkbox', { name: 'Fail detail refresh' }).check();
        await submit(page);
        await browserExpect(page.getByRole('alert')).toContainText('do not return cash again');
        expect(state.posts).toHaveLength(1);
        await page.getByRole('checkbox', { name: 'Fail detail refresh' }).uncheck();
        await page.getByRole('button', { name: 'Refresh corrected order' }).click();
        await browserExpect(page.getByLabel('Detail refresh count')).toHaveText('2');
        expect(state.posts).toHaveLength(1);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it.each(['Switch operator', 'Switch store'])(
      'a late result cannot publish after %s',
      async (button) => {
        const page = await browser.newPage(),
          state = await fixture(page);
        state.held = true;
        try {
          await open(page);
          await submit(page);
          await browserExpect.poll(() => state.posts.length).toBe(1);
          await page.getByRole('button', { name: button }).click();
          state.release();
          await browserExpect(page.getByLabel('Detail refresh count')).toHaveText('0');
          await browserExpect(page.getByText(/Cash correction recorded ·/)).toHaveCount(0);
          expect(state.posts).toHaveLength(1);
          expect(state.errors).toEqual([]);
        } finally {
          state.release();
          await page.close();
        }
      },
    );
    it('offline state hides an unspent correction form and sends no command', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      try {
        await open(page);
        await page.getByRole('button', { name: 'Toggle network' }).click();
        await browserExpect(
          page.getByText('Reconnect to review or record a cash correction.'),
        ).toBeVisible();
        await browserExpect(
          page.getByRole('button', { name: 'Record returned cash and reopen payment' }),
        ).toHaveCount(0);
        expect(state.posts).toHaveLength(0);
      } finally {
        await page.close();
      }
    });
    it('an original reversed payment never emits a paid callback and a new cash receipt has a distinct ID', async () => {
      const page = await browser.newPage(),
        posts: z.infer<typeof bodySchema>[] = [],
        errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const bodySchema = z.object({ operationId: z.uuid() }).passthrough();
      await page.route('**/api/v1/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/payment-options'))
          return route.fulfill({
            json: {
              payable: '100.00',
              options: [{ channel: 'cash', label: 'Cash', machineId: null }],
            },
          });
        const base = {
          id: originalId,
          orderId: '91',
          transactionId: 'TXN-ORIGINAL',
          channel: 'cash',
          cashAmount: '100.00',
          onlineAmount: '0.00',
          status: 'reversed',
          reversalId: '22222222-2222-4222-8222-222222222222',
          errorCode: null,
        };
        if (route.request().method() === 'GET') return route.fulfill({ json: base });
        const body = bodySchema.parse(route.request().postDataJSON() as unknown);
        posts.push(body);
        return route.fulfill({
          json: { ...base, id: body.operationId, status: 'paid', transactionId: 'TXN-NEW' },
        });
      });
      try {
        await page.goto(origin + '/__payment-correction__?payment');
        await browserExpect(page.getByText(/recorded cash payment was corrected/)).toBeVisible();
        await browserExpect(page.getByLabel('Paid callback')).toHaveText('');
        await page.getByRole('button', { name: 'Choose another payment' }).click();
        await page.getByRole('button', { name: 'Record received payment' }).click();
        await browserExpect(page.getByText(/Payment confirmed · TXN-NEW/)).toBeVisible();
        expect(posts).toHaveLength(1);
        expect(posts[0]?.operationId).not.toBe(originalId);
        await browserExpect(page.getByLabel('Paid callback')).toHaveText(posts[0]!.operationId);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  },
);
