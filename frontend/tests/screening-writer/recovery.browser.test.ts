import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as webExpect, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'screening recovery actual browser component',
  { timeout: 15000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        configFile: false,
        cacheDir: 'node_modules/.vite-screening-recovery-tests',
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__screening-test__') {
          next();
          return;
        }
        try {
          res.setHeader('Content-Type', 'text/html');
          res.end(
            await server.transformIndexHtml(
              '/__screening-test__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/screening-writer/harness.tsx"></script></body></html>',
            ),
          );
        } catch (e) {
          next(e);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Fixture binding failed');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });
    const base = {
      operationId: '22222222-2222-4222-8222-222222222222',
      checkoutId: '11111111-1111-4111-8111-111111111111',
      orderId: '9007199254740993',
      status: 'awaiting-payment',
      paymentReceiptId: null,
      publicationStatus: null,
      canAbandon: true,
      reviewCode: 'SCREENING_PAYMENT_RECONCILIATION_REQUIRED',
    };
    it('lost abandonment response reloads the original opaque intent and confirms via GET without reposting', async () => {
      const page = await browser.newPage(),
        methods: string[] = [];
      let abandoned = false;
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/api/v1/**', async (route) => {
        const req = route.request();
        methods.push(req.method());
        expect(req.headers()['x-operator-id']).toBe('1');
        if (req.method() === 'POST') {
          expect(req.url()).toContain('/abandonments');
          const body = req.postDataJSON() as { commandId: string; reason: string };
          expect(body.reason).toBe('cash-abandoned');
          abandoned = true;
          await route.abort('connectionfailed');
        } else
          await route.fulfill({
            json: abandoned
              ? {
                  ...base,
                  status: 'abandoned',
                  canAbandon: false,
                  publicationStatus: 'cancelled',
                  reviewCode: null,
                }
              : base,
          });
      });
      try {
        await page.goto(origin + '/__screening-test__');
        await page.getByRole('button', { name: 'Fence unpaid screening order' }).click();
        await webExpect(page.getByRole('alert')).toBeVisible();
        await page.reload();
        await webExpect(
          page.getByText('The original unpaid order is fenced. Its audit is retained.', {
            exact: true,
          }),
        ).toBeVisible();
        await webExpect(page.locator('output')).toHaveText('Saved 1; pending false');
        expect(methods.filter((method) => method === 'POST')).toHaveLength(1);
        const storage = await page.evaluate(() => JSON.stringify(localStorage));
        expect(storage).not.toContain('cashAmount');
        expect(storage).not.toContain('customer');
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('offline/changed actor never dispatches a saved action', async () => {
      const page = await browser.newPage(),
        requests: string[] = [];
      await page.route('**/api/v1/**', async (route) => {
        requests.push(route.request().method());
        await route.fulfill({ json: base });
      });
      try {
        await page.goto(origin + '/__screening-test__');
        await webExpect(
          page.getByRole('button', { name: 'Fence unpaid screening order' }),
        ).toBeEnabled();
        await page.getByRole('button', { name: 'Toggle network' }).click();
        await webExpect(
          page.getByRole('button', { name: 'Fence unpaid screening order' }),
        ).toBeDisabled();
        await page.getByRole('button', { name: 'Switch operator' }).click();
        await page.getByRole('button', { name: 'Toggle network' }).click();
        await page.getByRole('button', { name: 'Fence unpaid screening order' }).click();
        expect(requests.filter((method) => method === 'POST')).toHaveLength(0);
      } finally {
        await page.close();
      }
    });
    it('a completed read shows genuine payment/publication state without a payment or printing callback', async () => {
      const page = await browser.newPage(),
        methods: string[] = [];
      await page.route('**/api/v1/**', async (route) => {
        methods.push(route.request().method());
        await route.fulfill({
          json: {
            ...base,
            status: 'completed',
            paymentReceiptId: '33333333-3333-4333-8333-333333333333',
            publicationStatus: 'uncertain',
            reviewCode: 'SCREENING_PUBLICATION_OUTCOME_UNKNOWN',
            canAbandon: false,
          },
        });
      });
      try {
        await page.goto(origin + '/__screening-test__');
        await webExpect(
          page.getByText('Original payment is confirmed.', { exact: true }),
        ).toBeVisible();
        await webExpect(
          page.getByText('Order notifications are awaiting reconciliation.', { exact: true }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Check screening status' }).click();
        await webExpect(page.locator('output')).toHaveText('Saved 0; pending false');
        expect(methods.every((method) => method === 'GET')).toBe(true);
        await webExpect(
          page.getByRole('button', { name: 'Fence unpaid screening order' }),
        ).toHaveCount(0);
      } finally {
        await page.close();
      }
    });
    it('lost no-order closure reloads via GET only and keeps only the original operation marker', async () => {
      const page = await browser.newPage(),
        methods: string[] = [];
      let closed = false;
      await page.route('**/api/v1/**', async (route) => {
        const req = route.request();
        methods.push(req.method());
        if (req.method() === 'POST') {
          expect(req.url()).toContain('/closures');
          expect(req.postDataJSON()).toEqual({});
          closed = true;
          await route.abort('connectionfailed');
        } else
          await route.fulfill({
            json: {
              ...base,
              orderId: null,
              status: closed ? 'closed-no-order' : 'awaiting-source',
              canCloseNoOrder: !closed,
              canAbandon: false,
              reviewCode: closed ? null : 'SCREENING_SOURCE_OUTCOME_UNKNOWN',
            },
          });
      });
      try {
        await page.goto(origin + '/__screening-test__');
        await page
          .getByRole('button', { name: 'Close original command with source proof' })
          .click();
        await webExpect(page.getByRole('alert')).toBeVisible();
        const before = await page.evaluate(() => JSON.stringify(localStorage));
        expect(before).toContain('close-no-order');
        expect(before).not.toMatch(/customer|cashAmount|price|contact|token/i);
        await page.reload();
        await webExpect(
          page.getByText(
            'The source proved that no order was created. The original command is fenced and your cart is retained.',
          ),
        ).toBeVisible();
        await webExpect(page.locator('output')).toHaveText('Saved 1; pending false');
        expect(methods.filter((method) => method === 'POST')).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
    it('unknown closure is retained across reload and only explicit same-nonce retry can finish it', async () => {
      const page = await browser.newPage(),
        paths: string[] = [];
      let posts = 0,
        closed = false;
      await page.route('**/api/v1/**', async (route) => {
        const req = route.request();
        paths.push(req.method() + ' ' + new URL(req.url()).pathname);
        if (req.method() === 'POST') {
          posts++;
          if (posts === 1) await route.abort('connectionfailed');
          else {
            closed = true;
            await route.fulfill({
              json: { operationId: base.operationId, status: 'closed-no-order' },
            });
          }
        } else
          await route.fulfill({
            json: {
              ...base,
              orderId: null,
              status: closed ? 'closed-no-order' : 'awaiting-source',
              canCloseNoOrder: !closed,
              canAbandon: false,
              reviewCode: closed ? null : 'SCREENING_SOURCE_OUTCOME_UNKNOWN',
            },
          });
      });
      try {
        await page.goto(origin + '/__screening-test__');
        await page
          .getByRole('button', { name: 'Close original command with source proof' })
          .click();
        await webExpect(page.getByRole('alert')).toBeVisible();
        await page.reload();
        await webExpect(page.getByRole('button', { name: 'Retry original closure' })).toBeEnabled();
        expect(posts).toBe(1);
        await page.getByRole('button', { name: 'Retry original closure' }).click();
        await webExpect(page.locator('output')).toHaveText('Saved 1; pending false');
        expect(posts).toBe(2);
        expect(paths.filter((path) => path.startsWith('POST '))).toEqual(
          Array(2).fill(
            `POST /api/v1/stores/1/checkout-sessions/${base.checkoutId}/screening-admissions/${base.operationId}/closures`,
          ),
        );
      } finally {
        await page.close();
      }
    });
    it('corrupt or unwritable recovery storage blocks the new source closure action', async () => {
      for (const kind of ['corrupt', 'unwritable'] as const) {
        const page = await browser.newPage(),
          methods: string[] = [];
        await page.addInitScript((failure) => {
          if (failure === 'corrupt')
            localStorage.setItem(
              'pos-screening-recovery:' +
                JSON.stringify([
                  '1',
                  '1',
                  '11111111-1111-4111-8111-111111111111',
                  '22222222-2222-4222-8222-222222222222',
                ]),
              '{bad',
            );
          else
            Storage.prototype.setItem = () => {
              throw new Error('Fixture storage denied');
            };
        }, kind);
        await page.route('**/api/v1/**', async (route) => {
          methods.push(route.request().method());
          await route.fulfill({
            json: {
              ...base,
              orderId: null,
              status: 'awaiting-source',
              canCloseNoOrder: true,
              canAbandon: false,
              reviewCode: 'SCREENING_SOURCE_OUTCOME_UNKNOWN',
            },
          });
        });
        try {
          await page.goto(origin + '/__screening-test__');
          const button = page.getByRole('button', {
            name: 'Close original command with source proof',
          });
          if (kind === 'unwritable') {
            await button.click();
            await webExpect(page.getByRole('alert')).toBeVisible();
          }
          await webExpect(button).toBeDisabled();
          expect(methods.every((method) => method === 'GET')).toBe(true);
        } finally {
          await page.close();
        }
      }
    });
  },
);
