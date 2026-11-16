import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';

const input = z
  .object({ operationId: z.uuid(), productId: z.string(), barcode: z.string() })
  .strict();
type Input = z.infer<typeof input>;
describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'barcode assignment and country components in isolated Chromium',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = await mkdtemp(join(tmpdir(), 'pos-barcodes-browser-'));
      server = await createServer({
        configFile: false,
        cacheDir: cache,
        plugins: [react()],
        appType: 'custom',
        server: {
          host: '127.0.0.1',
          port: 0,
          fs: { allow: [process.cwd(), realpathSync('node_modules'), cache] },
        },
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__barcodes__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__barcodes__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/administration/barcodes/harness.tsx"></script></body></html>',
          );
          response.setHeader('Content-Type', 'text/html');
          response.setHeader(
            'Content-Security-Policy',
            `default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ${origin.replace('http:', 'ws:')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'`,
          );
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Barcode browser fixture did not bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cache) await rm(cache, { recursive: true, force: true });
    });
    async function fixture(
      page: Page,
      mode: 'normal' | 'lost' | 'missing' | 'delayed' | 'conflict' = 'normal',
      query = '',
    ) {
      page.setDefaultTimeout(6000);
      const posts: Input[] = [],
        calls: { method: string; path: string; actor: string | undefined; body: unknown }[] = [],
        saved = new Map<string, { body: Input; actor: string }>();
      let release: (() => Promise<void>) | undefined;
      function receipt(body: Input, actor: string) {
        const conflict = mode === 'conflict';
        return {
          id: body.operationId,
          operatorId: actor,
          productId: body.productId,
          barcode: body.barcode,
          status: conflict ? 'fail' : 'success',
          code: conflict ? 'GTIN_ASSIGNED' : 'ASSIGNED',
          message: conflict
            ? 'Barcode already belongs to another product, Product ID : 13'
            : `Barcode ${body.barcode} has been added for product Id ${body.productId}`,
          barcodeRowId: conflict ? null : '9007199254740993',
          auditId: conflict ? null : '9007199254740995',
          createdAt: '2026-06-15 12:00:00',
          requestId: null,
        };
      }
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          actor = request.headers()['x-operator-id'] || '';
        calls.push({
          method: request.method(),
          path: url.pathname + url.search,
          actor,
          body: request.postDataJSON() as unknown,
        });
        if (url.pathname === '/api/v1/admin/barcode-assignments' && request.method() === 'POST') {
          const body = input.parse(request.postDataJSON() as unknown);
          posts.push(body);
          if (!(mode === 'missing' && posts.length === 1))
            saved.set(body.operationId, { body, actor });
          if ((mode === 'lost' || mode === 'missing') && posts.length === 1) {
            await route.abort('failed');
            return;
          }
          const finish = () => route.fulfill({ json: receipt(body, actor) });
          if (mode === 'delayed') {
            release = finish;
            return;
          }
          await finish();
          return;
        }
        if (url.pathname.startsWith('/api/v1/admin/barcode-assignments/')) {
          const stored = saved.get(url.pathname.split('/').at(-1)!);
          if (stored) {
            await route.fulfill({ json: receipt(stored.body, stored.actor) });
            return;
          }
          await route.fulfill({
            status: 404,
            json: {
              error: {
                code: 'BARCODE_ASSIGNMENT_NOT_FOUND',
                message: 'This barcode assignment has not been saved.',
              },
            },
          });
          return;
        }
        if (url.pathname === '/api/v1/countries/secondary/search') {
          const body = z
            .object({ search: z.string() })
            .strict()
            .parse(request.postDataJSON() as unknown);
          await route.fulfill({
            json: {
              status: 'success',
              message: 'Country name',
              data: body.search
                ? {
                    country: [
                      {
                        id: '3',
                        text:
                          body.search === '%'
                            ? 'Percent % land'
                            : 'Literal <img src=x onerror=alert(1)>',
                      },
                    ],
                  }
                : {},
            },
          });
          return;
        }
        await route.fulfill({
          status: 404,
          json: { error: { code: 'FIXTURE_NOT_FOUND', message: 'Fixture route missing.' } },
        });
      });
      await page.goto(origin + '/__barcodes__' + query);
      return {
        posts,
        calls,
        async release() {
          await release?.().catch(() => undefined);
        },
        async waitForBody() {
          await browserExpect.poll(() => Boolean(release)).toBe(true);
        },
      };
    }
    async function fill(page: Page) {
      await page.getByLabel('Product ID', { exact: true }).fill('_00011_');
      await page.getByLabel('Scan or enter barcode', { exact: true }).fill('000_9007199254740995');
    }
    it('submits scanner Enter with canonical exact IDs and displays the saved source message/activity receipt', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page);
        await fill(page);
        await page.getByLabel('Scan or enter barcode', { exact: true }).press('Enter');
        await browserExpect(page.getByRole('status')).toContainText(
          'Barcode 9007199254740995 has been added for product Id 11',
        );
        expect(f.posts[0]).toMatchObject({ productId: '11', barcode: '9007199254740995' });
        await browserExpect(page.getByRole('status')).toContainText('9007199254740995');
        await browserExpect(page.getByLabel('Scan or enter barcode', { exact: true })).toHaveValue(
          '',
        );
        expect(f.calls.every((call) => call.actor === '900001')).toBe(true);
      } finally {
        await page.close();
      }
    });
    it('recovers a committed lost reply after reload using GET only, without another barcode assignment', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'lost');
        await fill(page);
        await page.getByRole('button', { name: 'Assign barcode', exact: true }).click();
        await browserExpect(
          page.getByRole('heading', { name: 'Saved assignments', exact: true }),
        ).toBeVisible();
        await browserExpect(
          page.getByRole('button', { name: 'Assign barcode', exact: true }),
        ).toBeDisabled();
        await page.reload();
        await page.getByRole('button', { name: 'Check original action', exact: true }).click();
        await browserExpect(page.getByRole('status')).toContainText('has been added');
        expect(f.posts).toHaveLength(1);
        expect(f.calls.filter((call) => call.method === 'GET')).toHaveLength(1);
        await browserExpect(
          page.getByRole('heading', { name: 'Saved assignments', exact: true }),
        ).toHaveCount(0);
      } finally {
        await page.close();
      }
    });
    it('retries only the exact saved UUID/payload after GET proves the original action is not saved', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'missing');
        await fill(page);
        await page.getByRole('button', { name: 'Assign barcode', exact: true }).click();
        await page.getByRole('button', { name: 'Check original action', exact: true }).click();
        await page.getByRole('button', { name: 'Retry original assignment', exact: true }).click();
        await browserExpect(page.getByRole('status')).toContainText('has been added');
        expect(f.posts).toHaveLength(2);
        expect(f.posts[0]).toEqual(f.posts[1]);
      } finally {
        await page.close();
      }
    });
    it('retains pending evidence and does not publish a delayed prior-actor result after operator switch', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'delayed');
        await fill(page);
        await page.getByRole('button', { name: 'Assign barcode', exact: true }).click();
        await f.waitForBody();
        await page.getByRole('button', { name: 'Fixture switch operator' }).click();
        await f.release();
        await browserExpect(page.getByText('has been added', { exact: false })).toHaveCount(0);
        expect(
          await page.evaluate(
            () =>
              Object.keys(localStorage).filter((key) =>
                key.startsWith('pos-barcode-assignment-v1:900001:'),
              ).length,
          ),
        ).toBe(1);
        expect(f.posts).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
    it('shows a source GTIN conflict as a completed receipt and allows a fresh corrected assignment', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'conflict');
        await fill(page);
        await page.getByRole('button', { name: 'Assign barcode', exact: true }).click();
        await browserExpect(page.getByRole('alert')).toContainText(
          'Barcode already belongs to another product, Product ID : 13',
        );
        await browserExpect(
          page.getByRole('button', { name: 'Assign barcode', exact: true }),
        ).toBeEnabled();
        expect(f.posts).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
    it('fails before network dispatch if original action evidence cannot be saved', async () => {
      const page = await browser.newPage();
      try {
        await page.addInitScript(() => {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key: string, value: string) {
            if (key.startsWith('pos-barcode-assignment-v1:'))
              throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
            return original.call(this, key, value);
          };
        });
        const f = await fixture(page);
        await fill(page);
        await page.getByRole('button', { name: 'Assign barcode', exact: true }).click();
        await browserExpect(page.getByRole('alert')).toContainText(
          'Saved barcode actions are unavailable',
        );
        expect(f.posts).toHaveLength(0);
      } finally {
        await page.close();
      }
    });
    it('keeps the secondary profile as a POST body search with exact blank/whitespace/wildcard inputs and safe literal names', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'normal', '?country');
        await page.getByRole('button', { name: 'Search countries', exact: true }).click();
        await browserExpect(
          page.getByText('Enter a country name to search.', { exact: true }),
        ).toBeVisible();
        await page.getByLabel('Country name', { exact: true }).fill(' ');
        await page.getByRole('button', { name: 'Search countries', exact: true }).click();
        await browserExpect(
          page.getByRole('cell', { name: 'Literal <img src=x onerror=alert(1)>' }),
        ).toBeVisible();
        expect(await page.locator('img').count()).toBe(0);
        await page.getByLabel('Country name', { exact: true }).fill('%');
        await page.getByRole('button', { name: 'Search countries', exact: true }).click();
        await browserExpect(page.getByRole('cell', { name: 'Percent % land' })).toBeVisible();
        expect(f.calls.map((call) => call.body)).toEqual([
          { search: '' },
          { search: ' ' },
          { search: '%' },
        ]);
        expect(
          f.calls.every(
            (call) =>
              call.path === '/api/v1/countries/secondary/search' &&
              call.method === 'POST' &&
              call.actor === '900001',
          ),
        ).toBe(true);
      } finally {
        await page.close();
      }
    });
    it('does not expose the global barcode form to franchise operators or staff', async () => {
      for (const query of ['?franchise', '?staff']) {
        const page = await browser.newPage();
        try {
          const f = await fixture(page, 'normal', query);
          await browserExpect(page.getByRole('alert')).toHaveText(
            'Barcode assignment requires an internal administrator.',
          );
          expect(f.calls).toHaveLength(0);
        } finally {
          await page.close();
        }
      }
    });
  },
);
