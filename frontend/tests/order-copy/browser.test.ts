import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orderCopyResultSchema } from '../../src/pages/order-copy/client';

describe.skipIf(process.env.ORDER_COPY_BROWSER_TESTS !== 'true')(
  'legacy Sync Order Cart panel in Chromium',
  { timeout: 15000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = await mkdtemp(join(tmpdir(), 'pos-order-copy-vite-'));
      server = await createServer({
        configFile: false,
        cacheDir: cache,
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__order-copy__')) return next();
        try {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            await server.transformIndexHtml(
              '/__order-copy__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/order-copy/harness.tsx"></script></body></html>',
            ),
          );
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Isolated copy browser server failed.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cache) await rm(cache, { recursive: true, force: true });
    });
    async function fixture(page: Page, reply: { status: number; json: unknown }) {
      const state = { posts: [] as unknown[], errors: [] as string[] };
      page.setDefaultTimeout(7000);
      page.on('pageerror', (error) => state.errors.push(error.message));
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        expect(request.headers()['x-operator-id']).toBe('44');
        if (
          request.method() !== 'POST' ||
          path !==
            '/api/v1/stores/1/checkout-sessions/11111111-1111-4111-8111-111111111111/order-copies'
        )
          throw new Error('Unexpected copy request ' + request.method() + ' ' + path);
        state.posts.push(request.postDataJSON() as unknown);
        return route.fulfill(reply);
      });
      return state;
    }
    it('posts only the order ID, shows the legacy message and refreshes the checkout', async () => {
      const page = await browser.newPage();
      const state = await fixture(page, {
        status: 200,
        json: orderCopyResultSchema.parse({
          orderId: '9007199254740993',
          partial: true,
          message: 'Cart partially synced - please review the cart',
        }),
      });
      await page.goto(origin + '/__order-copy__');
      await page.getByPlaceholder('Enter Order Id You Wanna Sync').fill('9007199254740993');
      await page.getByRole('button', { name: 'Submit' }).click();
      await browserExpect(
        page.getByText('Cart partially synced - please review the cart'),
      ).toBeVisible();
      await browserExpect(page.getByTestId('saved')).toHaveText('1');
      await browserExpect(page.getByTestId('requires-online')).toHaveText('true');
      await browserExpect(page.getByTestId('pending')).toHaveText('false');
      expect(state.posts).toEqual([{ orderId: '9007199254740993' }]);
      expect(state.errors).toEqual([]);
      await page.close();
    });
    it('validates the order ID locally and shows server refusals without refreshing', async () => {
      const page = await browser.newPage();
      const state = await fixture(page, {
        status: 404,
        json: {
          error: { code: 'ORDER_COPY_SOURCE_NOT_FOUND', message: 'Please Enter Correct Order Id' },
        },
      });
      await page.goto(origin + '/__order-copy__');
      await page.getByRole('button', { name: 'Submit' }).click();
      await browserExpect(page.getByText('Please Provide a Valid Order ID')).toBeVisible();
      expect(state.posts).toEqual([]);
      await page.getByPlaceholder('Enter Order Id You Wanna Sync').fill('42');
      await page.getByRole('button', { name: 'Submit' }).click();
      await browserExpect(page.getByText('Please Enter Correct Order Id')).toBeVisible();
      await browserExpect(page.getByTestId('saved')).toHaveText('0');
      expect(state.posts).toEqual([{ orderId: '42' }]);
      await page.close();
    });
    it('keeps the panel disabled offline', async () => {
      const page = await browser.newPage();
      const state = await fixture(page, { status: 500, json: {} });
      await page.goto(origin + '/__order-copy__?offline=true');
      await browserExpect(page.getByRole('button', { name: 'Submit' })).toBeDisabled();
      expect(state.posts).toEqual([]);
      await page.close();
    });
  },
);
