import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  copyCommandSchema,
  copyCancellationSchema,
  copyReviewSchema,
  type CopyCommand,
  type CopyReview,
} from '../../src/pages/order-copy/client';

describe.skipIf(process.env.ORDER_COPY_BROWSER_TESTS !== 'true')(
  'actual order-copy child recovery in Chromium',
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
    async function fixture(page: Page) {
      const state = {
        review: null as CopyReview | null,
        command: null as CopyCommand | null,
        posts: [] as { path: string; body: Record<string, unknown> }[],
        gets: 0,
        dropCopy: false,
        dropAck: false,
        dropCancel: false,
        absentCancel: false,
        absentCopy: false,
        holdCopy: false,
        release: () => undefined as void,
        seen: false,
        errors: [] as string[],
      };
      page.setDefaultTimeout(7000);
      page.on('pageerror', (error) => state.errors.push(error.message));
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname,
          method = request.method();
        expect(request.headers()['x-operator-id']).toBe('44');
        if (method === 'GET') {
          state.gets++;
          if (path.endsWith('/order-copies/current')) return route.fulfill({ json: state.command });
          if (path.includes('/cancellations/'))
            return state.command?.status === 'cancelled-unsent'
              ? route.fulfill({ json: state.command })
              : route.fulfill({
                  status: 404,
                  json: {
                    error: {
                      code: 'ORDER_COPY_CANCELLATION_NOT_FOUND',
                      message: 'No saved cancellation',
                    },
                  },
                });
          if (path.includes('/order-copy-reviews/') && state.review)
            return route.fulfill({ json: state.review });
          if (path.includes('/order-copies/') && state.command)
            return route.fulfill({ json: state.command });
          return route.fulfill({
            status: 404,
            json: { error: { code: 'ORDER_COPY_NOT_FOUND', message: 'Fixture copy missing' } },
          });
        }
        const body = z.record(z.string(), z.unknown()).parse(request.postDataJSON() as unknown);
        state.posts.push({ path, body });
        if (path.endsWith('/order-copy-reviews')) {
          state.review = copyReviewSchema.parse({
            id: body.reviewId,
            hash: 'a'.repeat(64),
            checkoutVersion: 2,
            expiresAt: Date.now() + 300000,
            source: body.source,
            before: [
              {
                kind: 'product',
                productId: '10',
                quantity: 2,
                name: 'Current shirt',
                price: '100',
                identity: null,
              },
            ],
            steps: [
              {
                id: '22222222-2222-4222-8222-222222222222',
                productId: '10',
                sourceLineIds: ['9007199254740994', '9007199254740995'],
                beforeQuantity: 2,
                targetQuantity: 4,
                status: 'not-dispatched',
                errorCode: null,
              },
            ],
          });
          return route.fulfill({ json: state.review });
        }
        if (path.endsWith('/order-copies')) {
          state.seen = true;
          if (state.absentCopy) {
            state.absentCopy = false;
            return route.abort();
          }
          state.command = copyCommandSchema.parse({
            id: body.operationId,
            reviewId: body.reviewId,
            source: state.review!.source,
            status: state.dropCopy ? 'uncertain' : 'review-required',
            steps: state.review!.steps.map((step) => ({
              ...step,
              status: state.dropCopy ? 'dispatched' : 'confirmed',
            })),
            result: state.dropCopy
              ? null
              : [
                  {
                    kind: 'product',
                    productId: '10',
                    quantity: 4,
                    name: '<img src=x onerror=alert(1)>',
                    price: '100',
                    identity: null,
                  },
                ],
            resultHash: state.dropCopy ? null : 'b'.repeat(64),
            partial: false,
            errorCode: state.dropCopy ? 'ORDER_COPY_OUTCOME_UNCERTAIN' : null,
            originHash: 'c'.repeat(64),
            checkoutVersion: 3,
            acknowledgementId: null,
            canContinue: false,
          });
          if (state.holdCopy)
            await new Promise<void>((resolve) => {
              state.release = resolve;
            });
          if (state.dropCopy) {
            state.dropCopy = false;
            return route.abort();
          }
          return route.fulfill({ json: state.command });
        }
        if (path.endsWith('/cancellations')) {
          if (state.absentCancel) {
            state.absentCancel = false;
            return route.abort();
          }
          const original = z
            .object({ operationId: z.uuid(), reviewId: z.uuid() })
            .passthrough()
            .parse(body.original);
          state.command = copyCancellationSchema.parse({
            status: 'cancelled-unsent',
            id: original.operationId,
            reviewId: original.reviewId,
            cancellationId: body.operationId,
            checkoutId: '11111111-1111-4111-8111-111111111111',
            operatorId: '44',
            storeId: '1',
            counterId: '3',
            originalRequestHash: 'd'.repeat(64),
            cancelledAt: Date.now(),
            checkoutVersion: 3,
            requiresOnlineClear: true,
            markerRequired: true,
            source: null,
            steps: [],
            result: null,
            resultHash: null,
            originHash: null,
            partial: false,
            errorCode: null,
            acknowledgementId: null,
            canContinue: false,
          });
          if (state.dropCancel) {
            state.dropCancel = false;
            return route.abort();
          }
          return route.fulfill({ json: state.command });
        }
        if (path.endsWith('/acknowledgements')) {
          expect(body.expectedVersion).toBe(3);
          if (!state.command || state.command.status === 'cancelled-unsent')
            throw new Error('Fixture copy is not acknowledgeable');
          state.command = {
            ...state.command!,
            status: 'acknowledged',
            checkoutVersion: 4,
            acknowledgementId: z.uuid().parse(body.operationId),
          };
          if (state.dropAck) {
            state.dropAck = false;
            return route.abort();
          }
          return route.fulfill({ json: state.command });
        }
        throw new Error('Unexpected copy request ' + method + ' ' + path);
      });
      return state;
    }
    async function prepare(page: Page, query = '') {
      await page.goto(origin + '/__order-copy__' + query);
      await page.getByLabel('Source order ID').fill('9007199254740993');
      await page.getByRole('button', { name: 'Review order products' }).click();
      await browserExpect(page.getByText(/2 → 4/)).toBeVisible();
    }
    it('reviews exact quantities, explicitly accepts result, escapes text and persists no customer/cart body', async () => {
      const page = await browser.newPage();
      const value = await fixture(page);
      await prepare(page);
      await page.getByRole('button', { name: 'Copy reviewed products' }).click();
      await browserExpect(
        page.getByRole('button', { name: 'Accept copied cart for quoting' }),
      ).toBeVisible();
      await browserExpect(page.getByTestId('pending')).toHaveText('true');
      expect(await page.locator('section img').count()).toBe(0);
      const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
      expect(stored).not.toContain('Current shirt');
      expect(stored).not.toContain('onerror');
      await page.getByRole('button', { name: 'Accept copied cart for quoting' }).click();
      await browserExpect(page.getByTestId('pending')).toHaveText('false');
      await browserExpect(page.getByTestId('requires-online')).toHaveText('true');
      expect(value.posts.filter((row) => row.path.endsWith('/order-copies'))).toHaveLength(1);
      expect(value.posts.filter((row) => row.path.endsWith('/acknowledgements'))).toHaveLength(1);
      expect(value.errors).toEqual([]);
      await page.close();
    });
    it('cancels only an unsent saved nonce despite a late source/cash preflight block and retains the online marker', async () => {
      const page = await browser.newPage(),
        value = await fixture(page);
      await prepare(page);
      value.absentCopy = true;
      await page.getByRole('button', { name: 'Copy reviewed products' }).click();
      await browserExpect(page.getByRole('alert')).toBeVisible();
      await page.getByRole('button', { name: 'Block source changes' }).click();
      const checks = await page.getByTestId('preflights').textContent();
      await page.getByRole('button', { name: 'Cancel only if copy is unsent' }).click();
      await browserExpect(
        page.getByText('Copy status: cancelled-unsent', { exact: true }),
      ).toBeVisible();
      await browserExpect(page.getByTestId('pending')).toHaveText('true');
      await browserExpect(page.getByTestId('requires-online')).toHaveText('true');
      await browserExpect(page.getByTestId('cancelled')).toHaveText('1');
      expect(await page.getByTestId('preflights').textContent()).toBe(checks);
      expect(value.posts.filter((row) => row.path.endsWith('/order-copies'))).toHaveLength(1);
      expect(value.posts.filter((row) => row.path.endsWith('/cancellations'))).toHaveLength(1);
      await page.reload();
      await browserExpect(
        page.getByText('Copy status: cancelled-unsent', { exact: true }),
      ).toBeVisible();
      expect(value.posts).toHaveLength(3);
      expect(value.errors).toEqual([]);
      await page.close();
    });
    it('recovers a lost committed cancellation through GET without resending or releasing the marker', async () => {
      const page = await browser.newPage(),
        value = await fixture(page);
      await prepare(page);
      value.absentCopy = true;
      await page.getByRole('button', { name: 'Copy reviewed products' }).click();
      await browserExpect(page.getByRole('alert')).toBeVisible();
      value.dropCancel = true;
      await page.getByRole('button', { name: 'Cancel only if copy is unsent' }).click();
      await browserExpect(page.getByRole('alert')).toBeVisible();
      await page.reload();
      await browserExpect(
        page.getByText('Copy status: cancelled-unsent', { exact: true }),
      ).toBeVisible();
      await browserExpect(page.getByTestId('requires-online')).toHaveText('true');
      expect(value.posts.filter((row) => row.path.endsWith('/cancellations'))).toHaveLength(1);
      expect(await page.getByRole('button', { name: 'Copy reviewed products' }).count()).toBe(0);
      expect(value.errors).toEqual([]);
      await page.close();
    });
    it('does not infer cancellation from two missing GETs and only explicitly retries the exact saved cancellation', async () => {
      const page = await browser.newPage(),
        value = await fixture(page);
      await prepare(page);
      value.absentCopy = true;
      await page.getByRole('button', { name: 'Copy reviewed products' }).click();
      await browserExpect(page.getByRole('alert')).toBeVisible();
      value.absentCancel = true;
      await page.getByRole('button', { name: 'Cancel only if copy is unsent' }).click();
      await browserExpect(page.getByRole('alert')).toBeVisible();
      const first = value.posts.find((row) => row.path.endsWith('/cancellations'))!.body;
      await page.reload();
      await browserExpect(
        page.getByRole('button', { name: 'Retry original unsent cancellation' }),
      ).toBeVisible();
      expect(value.posts.filter((row) => row.path.endsWith('/cancellations'))).toHaveLength(1);
      await browserExpect(page.getByTestId('pending')).toHaveText('true');
      await browserExpect(page.getByTestId('requires-online')).toHaveText('true');
      expect(await page.getByRole('button', { name: 'Retry exact saved copy' }).count()).toBe(0);
      await page.getByRole('button', { name: 'Retry original unsent cancellation' }).click();
      await browserExpect(
        page.getByText('Copy status: cancelled-unsent', { exact: true }),
      ).toBeVisible();
      expect(
        value.posts.filter((row) => row.path.endsWith('/cancellations')).map((row) => row.body),
      ).toEqual([first, first]);
      expect(value.errors).toEqual([]);
      await page.close();
    });
    it('keeps the cancellation proof and receipt marker when parent adoption refuses late cash', async () => {
      const page = await browser.newPage(),
        value = await fixture(page);
      await prepare(page, '?failCancelAdopt=true');
      value.absentCopy = true;
      await page.getByRole('button', { name: 'Copy reviewed products' }).click();
      await browserExpect(page.getByRole('alert')).toBeVisible();
      await page.getByRole('button', { name: 'Cancel only if copy is unsent' }).click();
      await browserExpect(
        page.getByText('Copy status: cancelled-unsent', { exact: true }),
      ).toBeVisible();
      await browserExpect(page.getByRole('alert')).toContainText('reconcile its cash');
      await browserExpect(page.getByTestId('requires-online')).toHaveText('true');
      expect(value.posts.filter((row) => row.path.endsWith('/cancellations'))).toHaveLength(1);
      expect(value.errors).toEqual([]);
      await page.close();
    });
    it('does not send cancellation if saving its opaque intent fails', async () => {
      const page = await browser.newPage(),
        value = await fixture(page);
      await prepare(page);
      value.absentCopy = true;
      await page.getByRole('button', { name: 'Copy reviewed products' }).click();
      await browserExpect(page.getByRole('alert')).toBeVisible();
      await page.evaluate(() => {
        Storage.prototype.setItem = () => {
          throw new Error('Storage unavailable');
        };
      });
      await page.getByRole('button', { name: 'Cancel only if copy is unsent' }).click();
      await browserExpect(page.getByRole('alert')).toBeVisible();
      expect(value.posts.filter((row) => row.path.endsWith('/cancellations'))).toHaveLength(0);
      await browserExpect(page.getByTestId('requires-online')).toHaveText('true');
      expect(value.errors).toEqual([]);
      await page.close();
    });
    it('reloads a lost dispatched addition through GET only and never infers success from target quantity', async () => {
      const page = await browser.newPage();
      const value = await fixture(page);
      await prepare(page);
      value.dropCopy = true;
      await page.getByRole('button', { name: 'Copy reviewed products' }).click();
      await browserExpect(page.getByRole('alert')).toBeVisible();
      await page.reload();
      await browserExpect(page.getByText('Copy status: uncertain')).toBeVisible();
      await page.getByRole('button', { name: 'Refresh original copy' }).click();
      await browserExpect(page.getByText('Copy status: uncertain')).toBeVisible();
      expect(value.posts.filter((row) => row.path.endsWith('/order-copies'))).toHaveLength(1);
      expect(
        await page.getByRole('button', { name: 'Accept copied cart for quoting' }).count(),
      ).toBe(0);
      expect(value.errors).toEqual([]);
      await page.close();
    });
    it('recovers a lost committed acknowledgement without repeating copying or acknowledgement', async () => {
      const page = await browser.newPage();
      const value = await fixture(page);
      await prepare(page);
      await page.getByRole('button', { name: 'Copy reviewed products' }).click();
      await browserExpect(
        page.getByRole('button', { name: 'Accept copied cart for quoting' }),
      ).toBeVisible();
      value.dropAck = true;
      await page.getByRole('button', { name: 'Accept copied cart for quoting' }).click();
      await browserExpect(page.getByRole('alert')).toBeVisible();
      await page.reload();
      await browserExpect(page.getByText('Copy status: acknowledged')).toBeVisible();
      await browserExpect(page.getByTestId('pending')).toHaveText('false');
      expect(value.posts.filter((row) => row.path.endsWith('/order-copies'))).toHaveLength(1);
      expect(value.posts.filter((row) => row.path.endsWith('/acknowledgements'))).toHaveLength(1);
      expect(value.errors).toEqual([]);
      await page.close();
    });
    it('allows only an explicit exact saved retry after the original command is absent', async () => {
      const page = await browser.newPage();
      const value = await fixture(page);
      await prepare(page);
      value.absentCopy = true;
      await page.getByRole('button', { name: 'Copy reviewed products' }).click();
      await browserExpect(page.getByRole('alert')).toBeVisible();
      await page.reload();
      await browserExpect(
        page.getByRole('button', { name: 'Retry exact saved copy' }),
      ).toBeVisible();
      expect(value.posts.filter((row) => row.path.endsWith('/order-copies'))).toHaveLength(1);
      await page.getByRole('button', { name: 'Retry exact saved copy' }).click();
      await browserExpect(
        page.getByRole('button', { name: 'Accept copied cart for quoting' }),
      ).toBeVisible();
      const posts = value.posts.filter((row) => row.path.endsWith('/order-copies'));
      expect(posts[0]!.body).toEqual(posts[1]!.body);
      expect(value.errors).toEqual([]);
      await page.close();
    });
    it('aborts stale operator publication and blocks offline operations', async () => {
      const page = await browser.newPage();
      const value = await fixture(page);
      await prepare(page);
      value.holdCopy = true;
      await page.getByRole('button', { name: 'Copy reviewed products' }).click();
      await browserExpect.poll(() => value.seen).toBe(true);
      await page.getByRole('button', { name: 'Switch operator' }).click();
      value.release();
      await browserExpect(page.getByText('Other operator workspace')).toBeVisible();
      expect(
        await page.getByRole('button', { name: 'Accept copied cart for quoting' }).count(),
      ).toBe(0);
      expect(value.posts.filter((row) => row.path.endsWith('/order-copies'))).toHaveLength(1);
      expect(value.errors).toEqual([]);
      await page.close();
      const offline = await browser.newPage();
      const blocked = await fixture(offline);
      await offline.goto(origin + '/__order-copy__?offline=true');
      await browserExpect(
        offline.getByRole('button', { name: 'Review order products' }),
      ).toBeDisabled();
      expect(blocked.posts).toEqual([]);
      expect(blocked.gets).toBe(0);
      await offline.close();
    });
    it('does not send a copy when the durable origin marker cannot be stored', async () => {
      const page = await browser.newPage();
      const value = await fixture(page);
      await prepare(page);
      await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key.startsWith('pos-order-copy-origin:')) throw new Error('fixture quota');
          original.call(this, key, value);
        };
      });
      await page.getByRole('button', { name: 'Copy reviewed products' }).click();
      await browserExpect(page.getByRole('alert')).toBeVisible();
      expect(value.posts.filter((row) => row.path.endsWith('/order-copies'))).toHaveLength(0);
      expect(value.errors).toEqual([]);
      await page.close();
    });
  },
);
