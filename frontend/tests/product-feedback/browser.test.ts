import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { feedbackInput, type FeedbackInput } from '../../src/pages/product-feedback/client';

describe.skipIf(process.env.PRODUCT_FEEDBACK_BROWSER_TESTS !== 'true')(
  'staff product feedback in Chromium',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        configFile: false,
        cacheDir: 'node_modules/.vite-product-feedback-tests',
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0, hmr: false },
        logLevel: 'silent',
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__product-feedback__') return next();
        try {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            await server.transformIndexHtml(
              '/__product-feedback__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/product-feedback/browser-entry.tsx"></script></body></html>',
            ),
          );
        } catch (cause) {
          next(cause);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Product feedback fixture could not bind.');
      origin = `http://127.0.0.1:${address.port}`;
      const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      const executablePath =
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
        (process.platform === 'darwin' && existsSync(mac) ? mac : undefined);
      browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });
    async function workspace(
      mode:
        | 'normal'
        | 'existing'
        | 'lost'
        | 'retry'
        | 'wrong-customer'
        | 'wrong-receipt'
        | 'offline' = 'normal',
    ) {
      const context = await browser.newContext({ serviceWorkers: 'block' }),
        page = await context.newPage();
      const commands: FeedbackInput[] = [],
        requests: string[] = [],
        consoleMessages: string[] = [];
      page.on('console', (message) => consoleMessages.push(message.text()));
      let saved: FeedbackInput | undefined;
      const receipt = (input: FeedbackInput) => ({
        operationId: input.operationId,
        customerId: '777',
        checkoutId: 'a53b9ec4-76ce-4641-95d5-7d3f4f073ab4',
        checkoutVersion: 1,
        orderId: '9007199254740993',
        productId: mode === 'wrong-receipt' ? '11' : input.productId,
        ratingIds: ['1001', '1002', '1003', '1004'],
        appliedAt: '2026-11-16T11:00:00.000Z',
      });
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        requests.push(request.method() + ' ' + url.pathname);
        expect(request.headers()['x-operator-id']).toBe('7');
        if (url.pathname.includes('/submissions/')) {
          if (!saved) {
            await route.fulfill({
              status: 404,
              json: {
                error: { code: 'PRODUCT_FEEDBACK_NOT_FOUND', message: 'Submission not found.' },
              },
            });
            return;
          }
          expect(url.pathname.endsWith(saved.operationId)).toBe(true);
          await route.fulfill({ json: receipt(saved) });
          return;
        }
        if (request.method() === 'POST') {
          const raw: unknown = request.postDataJSON(),
            input = feedbackInput.parse(raw);
          commands.push(input);
          if (mode !== 'retry' || commands.length > 1) saved = input;
          if (mode === 'lost' || (mode === 'retry' && commands.length === 1)) {
            await route.fulfill({
              status: 503,
              json: {
                error: { code: 'TEMPORARY_FAILURE', message: 'Service temporarily unavailable.' },
              },
            });
            return;
          }
          await route.fulfill({ json: receipt(input) });
          return;
        }
        expect(url.searchParams.get('limit')).toBe('25');
        const existing =
          mode === 'existing'
            ? [
                {
                  id: '9007199254741001',
                  optionId: '2',
                  rating: 3,
                  platform: 'IOS',
                  comment: null,
                },
                {
                  id: '9007199254741002',
                  optionId: '0',
                  rating: null,
                  platform: 'WEB',
                  comment: '<script>window.feedbackPwned=true</script>',
                },
              ]
            : [];
        await route.fulfill({
          json: {
            customerId: mode === 'wrong-customer' ? '778' : '777',
            checkoutVersion: 1,
            orderId: '9007199254740993',
            orderAmount: 125.5,
            editable: true,
            items: ['9007199254740997', '9007199254740998'].map((lineId) => ({
              lineId,
              productId: '9007199254740995',
              name: '<img src=x onerror="window.feedbackPwned=true">',
              feedback: existing,
            })),
            nextCursor: null,
          },
        });
      });
      await page.goto(origin + '/__product-feedback__' + (mode === 'offline' ? '?offline=1' : ''));
      return { context, page, commands, requests, consoleMessages };
    }
    async function fill(page: Awaited<ReturnType<typeof workspace>>['page']) {
      await page.getByLabel('Overall rating for line 9007199254740997').fill('4.5');
      await page.getByLabel('Product size for line 9007199254740997').fill('3.2');
      await page
        .getByLabel('Comment for line 9007199254740997')
        .fill('feedback-private-canary café €');
      await page.getByRole('button', { name: 'Save feedback', exact: true }).first().click();
    }
    it('renders every duplicate-SKU occurrence and partial source ratings as readonly escaped text', async () => {
      const { context, page, commands } = await workspace('existing');
      try {
        await browserExpect(page.getByRole('table')).toHaveCount(2);
        await browserExpect(page.getByRole('button', { name: 'Save feedback' })).toHaveCount(0);
        expect(await page.locator('img, script:not([src])').count()).toBe(0);
        expect(await page.evaluate(() => Object.hasOwn(window, 'feedbackPwned'))).toBe(false);
        expect(commands).toHaveLength(0);
      } finally {
        await context.close();
      }
    });
    it('submits all source defaults in one operation and keeps feedback comments out of persistent state and console', async () => {
      const { context, page, commands, consoleMessages } = await workspace();
      try {
        await fill(page);
        await browserExpect(
          page.getByText('Product feedback saved.', { exact: true }),
        ).toBeVisible();
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({
          expectedVersion: 1,
          productId: '9007199254740995',
          overall: 4.5,
          fit: 0,
          size: 3.2,
          quality: 0,
          comment: 'feedback-private-canary café €',
        });
        await browserExpect(page.getByRole('button', { name: 'Save feedback' })).toHaveCount(0);
        expect(await page.evaluate(() => window.productFeedbackFixture.stored())).not.toContain(
          'feedback-private-canary',
        );
        expect(consoleMessages.join('\n')).not.toContain('feedback-private-canary');
      } finally {
        await context.close();
      }
    });
    it('recovers a lost response through receipt GET without posting again', async () => {
      const { context, page, commands, requests } = await workspace('lost');
      try {
        await fill(page);
        await browserExpect(
          page.getByText('The result is unknown. Check this submission before trying again.'),
        ).toBeVisible();
        await browserExpect(
          page.getByRole('button', { name: 'Save feedback' }).first(),
        ).toBeDisabled();
        await page.getByRole('button', { name: 'Check submission', exact: true }).click();
        await browserExpect(
          page.getByText('Product feedback saved.', { exact: true }),
        ).toBeVisible();
        expect(commands).toHaveLength(1);
        expect(requests.filter((path) => path.includes('/submissions/'))).toHaveLength(1);
      } finally {
        await context.close();
      }
    });
    it('requires receipt lookup before an explicit exact retry after a missing result', async () => {
      const { context, page, commands } = await workspace('retry');
      try {
        await fill(page);
        await page.getByRole('button', { name: 'Check submission', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Retry saved feedback' }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Retry saved feedback' }).click();
        await browserExpect(
          page.getByText('Product feedback saved.', { exact: true }),
        ).toBeVisible();
        expect(commands).toHaveLength(2);
        expect(commands[0]).toEqual(commands[1]);
      } finally {
        await context.close();
      }
    });
    it('refuses a feedback response bound to another customer', async () => {
      const { context, page, commands } = await workspace('wrong-customer');
      try {
        await browserExpect(
          page.getByText('This product feedback page does not match the current sale.'),
        ).toBeVisible();
        await browserExpect(page.getByRole('button', { name: 'Save feedback' })).toHaveCount(0);
        expect(commands).toHaveLength(0);
      } finally {
        await context.close();
      }
    });
    it('treats a receipt for another product as unknown and freezes new submissions', async () => {
      const { context, page, commands } = await workspace('wrong-receipt');
      try {
        await fill(page);
        await browserExpect(
          page.getByText('The result is unknown. Check this submission before trying again.'),
        ).toBeVisible();
        await browserExpect(
          page.getByRole('button', { name: 'Save feedback' }).first(),
        ).toBeDisabled();
        expect(commands).toHaveLength(1);
      } finally {
        await context.close();
      }
    });
    it('makes no customer request offline and hides previously loaded ratings when disconnected', async () => {
      const { context, page, requests } = await workspace('offline');
      try {
        await browserExpect(
          page.getByText('Connect to view and save product feedback.'),
        ).toBeVisible();
        expect(requests).toHaveLength(0);
        await page.evaluate(() => window.productFeedbackFixture.online(true));
        await browserExpect(page.getByRole('button', { name: 'Save feedback' })).toHaveCount(2);
        await page.evaluate(() => window.productFeedbackFixture.online(false));
        await browserExpect(page.getByRole('button', { name: 'Save feedback' })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  },
);
