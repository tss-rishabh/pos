import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { checkoutSchema } from '../../src/pages/checkout/client';
import {
  copyCommandSchema,
  copyReviewSchema,
  type CopyCommand,
  type CopyReview,
} from '../../src/pages/order-copy/client';

describe.skipIf(process.env.ORDER_COPY_BROWSER_TESTS !== 'true')(
  'counter order-copy integration in Chromium',
  { timeout: 20000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = await mkdtemp(join(tmpdir(), 'pos-copy-checkout-vite-'));
      server = await createServer({
        configFile: false,
        cacheDir: cache,
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__copy-checkout__')) return next();
        try {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            await server.transformIndexHtml(
              '/__copy-checkout__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/order-copy/checkout-harness.tsx"></script></body></html>',
            ),
          );
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Isolated counter fixture failed.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 25000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cache) await rm(cache, { recursive: true, force: true });
    });
    async function fixture(page: Page) {
      page.setDefaultTimeout(8000);
      const state = {
        checkout: checkoutSchema.parse({
          id: '11111111-1111-4111-8111-111111111111',
          operatorId: '44',
          storeId: '1',
          counterId: '2',
          draftId: '22222222-2222-4222-8222-222222222222',
          draftVersion: 1000,
          draftImport: {
            status: 'complete',
            lineItems: [{ productId: '10', quantity: 1 }],
            completedProductIds: ['10'],
          },
          customerId: '1001',
          version: 2,
          verifiedCustomerUntil: null,
          phase: 'open',
          orderId: null,
          busyOperationId: null,
          orderCopy: null,
          cart: {
            products: { items: [{ id: '10', name: 'Original shirt', quantity: 1, price: '100' }] },
          },
          quote: null,
          giftCards: {},
        }),
        review: null as CopyReview | null,
        command: null as CopyCommand | null,
        posts: [] as string[],
        genericReads: 0,
        dropReply: false,
        errors: [] as string[],
      };
      page.on('pageerror', (error) => state.errors.push(error.message));
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        if (request.method() === 'GET') {
          if (path.includes('/operations/')) state.genericReads++;
          if (path.endsWith('/checkout-sessions/' + state.checkout.id))
            return route.fulfill({ json: state.checkout });
          if (path.endsWith('/catalog/products'))
            return route.fulfill({ json: { data: [], nextCursor: null } });
          if (path.endsWith('/motivational-quotes/random'))
            return route.fulfill({ json: { quote: 'Fixture quote' } });
          if (path.endsWith('/order-copies/current')) return route.fulfill({ json: state.command });
          if (path.includes('/order-copies/') && state.command)
            return route.fulfill({ json: state.command });
          if (path.includes('/order-copy-reviews/') && state.review)
            return route.fulfill({ json: state.review });
          return route.fulfill({
            status: 404,
            json: {
              error: { code: 'FIXTURE_UNAVAILABLE', message: 'Unselected fixture resource.' },
            },
          });
        }
        state.posts.push(path);
        const body = z.record(z.string(), z.unknown()).parse(request.postDataJSON() as unknown);
        if (path.endsWith('/order-copy-reviews')) {
          state.review = copyReviewSchema.parse({
            id: body.reviewId,
            hash: 'a'.repeat(64),
            checkoutVersion: state.checkout.version,
            expiresAt: Date.now() + 300000,
            source: body.source,
            before: [
              {
                kind: 'product',
                productId: '10',
                quantity: 1,
                name: 'Original shirt',
                price: '100',
                identity: null,
              },
            ],
            steps: [
              {
                id: '33333333-3333-4333-8333-333333333333',
                productId: '10',
                sourceLineIds: ['9007199254740993'],
                beforeQuantity: 1,
                targetQuantity: 2,
                status: 'not-dispatched',
                errorCode: null,
              },
            ],
          });
          return route.fulfill({ json: state.review });
        }
        if (path.endsWith('/order-copies') && state.review) {
          state.command = copyCommandSchema.parse({
            id: body.operationId,
            reviewId: state.review.id,
            source: state.review.source,
            status: state.dropReply ? 'uncertain' : 'review-required',
            steps: state.review.steps.map((step) => ({
              ...step,
              status: state.dropReply ? 'dispatched' : 'confirmed',
            })),
            result: state.dropReply
              ? null
              : [
                  {
                    kind: 'product',
                    productId: '10',
                    quantity: 2,
                    name: 'Copied shirt',
                    price: '100',
                    identity: null,
                  },
                ],
            resultHash: state.dropReply ? null : 'b'.repeat(64),
            partial: false,
            errorCode: null,
            originHash: 'c'.repeat(64),
            checkoutVersion: 3,
            acknowledgementId: null,
            canContinue: false,
          });
          state.checkout = {
            ...state.checkout,
            version: 3,
            busyOperationId: state.command.id,
            phase: state.dropReply ? 'uncertain' : 'open',
            orderCopy: {
              commandId: state.command.id,
              reviewId: state.command.reviewId,
              status: state.command.status,
              originHash: state.command.originHash,
              resultHash: state.command.resultHash,
            },
          };
          if (state.dropReply) return route.abort();
          state.checkout.cart = {
            products: { items: [{ id: '10', name: 'Copied shirt', quantity: 2, price: '100' }] },
          };
          return route.fulfill({ json: state.command });
        }
        if (path.endsWith('/acknowledgements') && state.command) {
          state.command = {
            ...state.command,
            status: 'acknowledged',
            checkoutVersion: 4,
            acknowledgementId: z.uuid().parse(body.operationId),
          };
          state.checkout = {
            ...state.checkout,
            version: 4,
            busyOperationId: null,
            orderCopy: { ...state.checkout.orderCopy!, status: 'acknowledged' },
          };
          return route.fulfill({ json: state.command });
        }
        if (path.endsWith('/clear')) {
          const operationId = z.uuid().parse(body.operationId);
          state.checkout = {
            ...state.checkout,
            version: state.checkout.version + 1,
            phase: 'cleared',
            cart: { products: { items: [] } },
            quote: null,
            busyOperationId: null,
            lastClear: {
              status: 'cleared',
              checkoutId: state.checkout.id,
              operationId,
              operatorId: '44',
              storeId: '1',
              counterId: '2',
              draftId: state.checkout.draftId!,
              draftVersion: 1000,
              reason: 'cart-clear',
              clearedAt: Date.now(),
            },
          };
          return route.fulfill({
            json: { status: 'succeeded', state: state.checkout, operationId },
          });
        }
        return route.fulfill({
          status: 503,
          json: { error: { code: 'UNEXPECTED_FIXTURE_MUTATION', message: 'Unexpected mutation.' } },
        });
      });
      return state;
    }
    async function open(page: Page) {
      await page.goto(origin + '/__copy-checkout__');
      await page.getByRole('button', { name: 'Review sale', exact: true }).click();
      await browserExpect(
        page.getByRole('button', { name: 'Review order products', exact: true }),
      ).toBeDisabled();
      await page.getByLabel('Source order ID', { exact: true }).fill('9007199254740994');
      await browserExpect(
        page.getByRole('button', { name: 'Review order products', exact: true }),
      ).toBeEnabled();
    }
    async function begin(page: Page) {
      await page.getByRole('button', { name: 'Review order products', exact: true }).click();
      await page.getByRole('button', { name: 'Copy reviewed products', exact: true }).click();
    }
    it('keeps copying recoverable while generic sale actions wait for acknowledgement and a new quote', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        await open(page);
        await begin(page);
        await browserExpect(
          page.getByText('Copy status: review-required', { exact: true }),
        ).toBeVisible();
        await browserExpect(
          page.getByRole('button', { name: 'Accept copied cart for quoting', exact: true }),
        ).toBeEnabled();
        await browserExpect(
          page.getByRole('button', { name: 'Get final quote', exact: true }),
        ).toHaveCount(0);
        await browserExpect(page.getByRole('button', { name: /Check action status/ })).toHaveCount(
          0,
        );
        expect(state.genericReads).toBe(0);
        await page
          .getByRole('button', { name: 'Accept copied cart for quoting', exact: true })
          .click();
        await browserExpect(
          page.getByRole('button', { name: 'Get final quote', exact: true }),
        ).toBeEnabled();
        expect(state.checkout.draftImport?.lineItems).toEqual([{ productId: '10', quantity: 1 }]);
        await page.getByRole('button', { name: 'Inspect original snapshot', exact: true }).click();
        await browserExpect(page.getByTestId('original-quantity')).toHaveText('1');
        await page.getByRole('button', { name: 'Close checkout', exact: true }).click();
        await browserExpect(
          page.getByText('Finish or clear the copied sale online before recording separate cash.', {
            exact: true,
          }),
        ).toBeVisible();
        await browserExpect(
          page.getByRole('button', { name: 'Complete cash offline', exact: true }),
        ).toBeDisabled();
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('recovers an uncertain copy after reload using only its original copy GET resource', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        state.dropReply = true;
        await open(page);
        await begin(page);
        await browserExpect(page.getByText(/action reply is unconfirmed/i)).toBeVisible();
        const mutations = state.posts.length;
        await page.reload();
        await page.getByRole('button', { name: 'Review sale', exact: true }).click();
        await browserExpect(
          page.getByText('Copy status: uncertain', { exact: true }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Refresh original copy', exact: true }).click();
        expect(state.posts).toHaveLength(mutations);
        expect(state.genericReads).toBe(0);
        await browserExpect(page.getByRole('button', { name: /Check action status/ })).toHaveCount(
          0,
        );
        await browserExpect(
          page.getByRole('button', { name: 'Get final quote', exact: true }),
        ).toHaveCount(0);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('retires the offline origin marker only after the server clearance passes local completion validation', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        await open(page);
        await begin(page);
        await page
          .getByRole('button', { name: 'Accept copied cart for quoting', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Clear checkout and start a new sale', exact: true })
          .click();
        await browserExpect(page.getByRole('dialog', { name: 'Confirm the sale' })).toHaveCount(0);
        await browserExpect(
          page.getByText('Finish or clear the copied sale online before recording separate cash.', {
            exact: true,
          }),
        ).toHaveCount(0);
        const marker = await page.evaluate(() =>
          localStorage.getItem(
            'pos-order-copy-origin:' +
              JSON.stringify(['44', '1', '11111111-1111-4111-8111-111111111111']),
          ),
        );
        expect(marker).toBeNull();
        expect(state.checkout.phase).toBe('cleared');
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  },
);
