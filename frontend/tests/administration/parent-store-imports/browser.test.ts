import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';
import { prepareBrowserFixture } from '../../prepare-browser-fixture';

describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'parent/store import workspace components in isolated Chromium',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = await mkdtemp(join(tmpdir(), 'pos-parent-import-browser-'));
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
        if (request.url?.split('?')[0] !== '/__parent_import__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__parent_import__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/administration/parent-store-imports/harness.tsx"></script></body></html>',
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
        throw new Error('Parent import browser fixture did not bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
      await prepareBrowserFixture(browser, async (page) => {
        await fixture(page);
        await browserExpect(
          page.getByRole('heading', { level: 1, name: 'Parent/store CSV imports', exact: true }),
        ).toBeVisible();
        await server.waitForRequestsIdle();
      });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cache) await rm(cache, { recursive: true, force: true });
    });
    async function fixture(
      page: Page,
      mode: 'normal' | 'lost' | 'blocked' | 'failed' | 'pending' | 'delayed' = 'normal',
      query = '',
    ) {
      page.setDefaultTimeout(6000);
      const calls: { method: string; path: string; actor: string; body: unknown }[] = [],
        saved = new Map<string, ReturnType<typeof job>>();
      const command = {
          kind: 'parent-store',
          productId: '9007199254740993',
          storeId: '1',
          active: true,
        },
        cells = ['9007199254740993', '1', '1'];
      let release: (() => Promise<void>) | undefined;
      function job(id: string) {
        return {
          id,
          actorId: '900001',
          name: 'ParentStore.csv',
          state: mode === 'blocked' ? 'BLOCKED' : mode === 'pending' ? 'RUNNING' : 'COMPLETED',
          totalRows: 1,
          processedRows: ['blocked', 'pending'].includes(mode) ? 0 : 1,
          successfulRows: ['blocked', 'pending', 'failed'].includes(mode) ? 0 : 1,
          failedRows: mode === 'failed' ? 1 : 0,
          errorCode: mode === 'blocked' ? 'STOCK_UNAVAILABLE' : null,
          createdAt: '2026-11-10 00:00:00.000',
          updatedAt: '2026-11-10 00:01:00.000',
        };
      }
      const base =
        '/api/v1/admin/' + (query.includes('stock') ? 'inventory-imports' : 'parent-store-imports');
      await page.route('**/api/v1/**', async (route) => {
        const req = route.request(),
          url = new URL(req.url()),
          body = req.postDataJSON() as unknown;
        calls.push({
          method: req.method(),
          path: url.pathname + url.search,
          actor: req.headers()['x-operator-id'] || '',
          body,
        });
        if (url.pathname === base + '/capabilities') {
          await route.fulfill({
            json: {
              maximumBytes: 262144,
              maximumRows: 5000,
              visibilityEnabled: true,
              stockEnabled: true,
              historyEnabled: true,
              stores: [{ id: '1', name: 'Synthetic <Store>' }],
            },
          });
          return;
        }
        if (url.pathname === base + '/template') {
          await route.fulfill({
            contentType: 'text/csv; charset=utf-8',
            body: '"SkuId","StoreId","IsActive"\r\n"1234","1","1"\r\n',
          });
          return;
        }
        if (url.pathname === base + '/preview') {
          const stock = query.includes('stock'),
            result = {
              totalRows: 1,
              validRows: mode === 'failed' ? 0 : 1,
              invalidRows: mode === 'failed' ? 1 : 0,
              remainingRows: 0,
              requiresStockProcedure: true,
              canSubmit: true,
              rows: [
                {
                  rowNumber: 2,
                  cells: stock ? ['20', '1', '', '', '1', '0'] : cells,
                  command: stock
                    ? {
                        productId: '20',
                        storeId: '1',
                        movement: 'none',
                        quantity: 0,
                        available: true,
                        archived: false,
                      }
                    : command,
                  errorCode: mode === 'failed' ? 'PARENT_STORE_CSV_ROW_INVALID' : null,
                  message: mode === 'failed' ? '<img src=x onerror=alert(1)>' : null,
                  saleableStock: null,
                  heldStock: null,
                  familySize: 3,
                },
              ],
            };
          const finish = () => route.fulfill({ json: result });
          if (mode === 'delayed') {
            release = finish;
            return;
          }
          await finish();
          return;
        }
        if (url.pathname === base && req.method() === 'POST') {
          const input = z
              .object({ id: z.uuid(), name: z.string(), csv: z.string() })
              .strict()
              .parse(body),
            value = job(input.id);
          saved.set(input.id, value);
          if (mode === 'lost' && saved.size === 1) {
            await route.abort('failed');
            return;
          }
          await route.fulfill({ json: value });
          return;
        }
        if (url.pathname === base || url.pathname === base + '/history') {
          await route.fulfill({
            json: {
              reader: url.pathname.endsWith('/history') ? 'bigquery' : undefined,
              data: [...saved.values()],
              nextCursor: null,
            },
          });
          return;
        }
        const id = url.pathname.split('/')[5] || '',
          value = saved.get(id);
        if (url.pathname.endsWith('/rows')) {
          await route.fulfill({
            json: {
              data: value
                ? [
                    {
                      importId: id,
                      rowNumber: 2,
                      cells,
                      command: mode === 'failed' ? null : command,
                      state:
                        value.state === 'CANCELLED'
                          ? 'CANCELLED'
                          : value.state === 'COMPLETED'
                            ? mode === 'failed'
                              ? 'FAILED'
                              : 'SUCCEEDED'
                            : 'PENDING',
                      errorCode: mode === 'failed' ? 'PARENT_STORE_CSV_ROW_INVALID' : null,
                      message: mode === 'failed' ? '<img src=x onerror=alert(1)>' : null,
                    },
                  ]
                : [],
              nextCursor: null,
            },
          });
          return;
        }
        if (url.pathname.endsWith('/failures.csv')) {
          await route.fulfill({
            contentType: 'text/csv',
            body: '"SkuId","StoreId","IsActive","Message"\r\n"\'=1","1","1","Invalid"\r\n',
          });
          return;
        }
        if (url.pathname.endsWith('/resume') || url.pathname.endsWith('/cancel')) {
          if (value) {
            value.state = url.pathname.endsWith('/resume') ? 'COMPLETED' : 'CANCELLED';
            value.processedRows = value.state === 'COMPLETED' ? 1 : 0;
            value.successfulRows = value.processedRows;
          }
          await route.fulfill({ json: { status: 'success', message: 'Updated.' } });
          return;
        }
        if (value) {
          await route.fulfill({ json: value });
          return;
        }
        await route.fulfill({
          status: 404,
          json: { error: { code: 'INVENTORY_IMPORT_NOT_FOUND', message: 'Import not found.' } },
        });
      });
      await page.goto(origin + '/__parent_import__' + query);
      return {
        calls,
        saved,
        async release() {
          await release?.().catch(() => undefined);
        },
        async wait() {
          await browserExpect.poll(() => !!release).toBe(true);
        },
      };
    }
    async function choose(page: Page, stock = false) {
      await page
        .getByLabel(stock ? 'Choose inventory CSV' : 'Choose parent/store CSV', { exact: true })
        .setInputFiles({
          name: 'ParentStore.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(
            stock
              ? 'SkuId,StoreId,IsHold,Hold/UnholdQty,IsAvailable,IsDelete\n20,1,,,1,0\n'
              : 'SkuId,StoreId,IsActive\n9007199254740993,1,1\n',
          ),
        });
    }
    it('shows scoped store IDs, source reset warning, three-column preview and exact template for franchise cashiers', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'normal', '?franchise');
        await browserExpect(
          page.getByRole('heading', { level: 1, name: 'Parent/store CSV imports', exact: true }),
        ).toBeVisible();
        await page.getByText('Permitted store IDs (1)', { exact: true }).click();
        await browserExpect(page.getByText('1 · Synthetic <Store>', { exact: true })).toBeVisible();
        await browserExpect(
          page.getByText(/Both actions reset existing saleable stock to zero/),
        ).toBeVisible();
        await choose(page);
        await browserExpect(
          page.getByRole('cell', { name: 'Reset and assign', exact: true }),
        ).toBeVisible();
        await browserExpect(
          page.getByRole('cell', { name: '9007199254740993', exact: true }),
        ).toBeVisible();
        expect(await page.getByRole('columnheader', { name: 'IsHold', exact: true }).count()).toBe(
          0,
        );
        const download = page.waitForEvent('download');
        await page
          .getByRole('button', { name: 'Download parent/store template', exact: true })
          .click();
        expect((await download).suggestedFilename()).toBe('ProductStore-template.csv');
        expect(f.calls.every((call) => call.actor === '900001')).toBe(true);
      } finally {
        await page.close();
      }
    });
    it('recovers a committed lost queue reply using the original UUID GET without another mutation', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'lost');
        await choose(page);
        await page.getByRole('button', { name: 'Queue import', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Check original import', exact: true }),
        ).toBeVisible();
        const post = f.calls.find(
          (call) => call.method === 'POST' && call.path === '/api/v1/admin/parent-store-imports',
        );
        await page.getByRole('button', { name: 'Check original import', exact: true }).click();
        await browserExpect(
          page.getByText('COMPLETED · 1/1 processed · 1 succeeded · 0 failed', { exact: false }),
        ).toBeVisible();
        expect(
          f.calls.filter(
            (call) => call.method === 'POST' && call.path === '/api/v1/admin/parent-store-imports',
          ),
        ).toHaveLength(1);
        expect(
          f.calls.some(
            (call) =>
              call.method === 'GET' &&
              call.path.endsWith('/' + z.object({ id: z.uuid() }).parse(post?.body).id),
          ),
        ).toBe(true);
      } finally {
        await page.close();
      }
    });
    it('resumes a blocked row through the same queue controls and refreshes the preserved progress', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'blocked');
        await choose(page);
        await page.getByRole('button', { name: 'Queue import', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Resume import', exact: true }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Resume import', exact: true }).click();
        await browserExpect(
          page.getByText('COMPLETED · 1/1 processed · 1 succeeded · 0 failed', { exact: false }),
        ).toBeVisible();
        expect(
          f.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/resume')),
        ).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
    it('cancels only pending records after explicit confirmation while retaining the audit view', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'pending');
        await choose(page);
        await page.getByRole('button', { name: 'Queue import', exact: true }).click();
        await page.getByRole('button', { name: 'Cancel pending records', exact: true }).click();
        await browserExpect(
          page.getByRole('heading', { name: 'Cancel remaining import records?', exact: true }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Cancel remaining records', exact: true }).click();
        await browserExpect(
          page.getByText('CANCELLED · 0/1 processed · 0 succeeded · 0 failed', { exact: false }),
        ).toBeVisible();
        expect(
          f.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/cancel')),
        ).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
    it('renders failed fields literally, downloads protected CSV and fetches completed history through its separate resource', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'failed');
        await choose(page);
        await browserExpect(
          page.getByRole('cell', { name: '<img src=x onerror=alert(1)>', exact: true }),
        ).toBeVisible();
        expect(await page.locator('img').count()).toBe(0);
        await page.getByRole('button', { name: 'Queue import', exact: true }).click();
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download failed records', exact: true }).click();
        expect((await download).suggestedFilename()).toMatch(/^InventoryImport-.*-failed.csv$/);
        await page.getByLabel('Import history scope', { exact: true }).selectOption('historical');
        await browserExpect
          .poll(() =>
            f.calls.some(
              (call) =>
                call.method === 'GET' &&
                call.path.startsWith('/api/v1/admin/parent-store-imports/history?'),
            ),
          )
          .toBe(true);
      } finally {
        await page.close();
      }
    });
    it('fences delayed preview continuation after an operator switch', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'delayed');
        await choose(page);
        await f.wait();
        await page.getByRole('button', { name: 'Fixture switch operator', exact: true }).click();
        await f.release();
        await browserExpect.poll(() => f.calls.some((call) => call.actor === '900002')).toBe(true);
        expect(
          f.calls.filter(
            (call) => call.method === 'POST' && call.path === '/api/v1/admin/parent-store-imports',
          ),
        ).toHaveLength(0);
        expect(await page.getByRole('button', { name: 'Queue import', exact: true }).count()).toBe(
          0,
        );
      } finally {
        await page.close();
      }
    });
    it('preserves six-column stock preview contracts in the shared workspace', async () => {
      const page = await browser.newPage();
      try {
        await fixture(page, 'normal', '?stock');
        await choose(page, true);
        await browserExpect(
          page.getByRole('heading', { name: 'Inventory CSV imports', exact: true }),
        ).toBeVisible();
        await browserExpect(
          page.getByRole('columnheader', { name: 'Movement', exact: true }),
        ).toBeVisible();
        await browserExpect(page.getByRole('cell', { name: 'none', exact: true })).toBeVisible();
        expect(
          await page
            .getByRole('columnheader', { name: 'Affected assignments', exact: true })
            .count(),
        ).toBe(0);
      } finally {
        await page.close();
      }
    });
  },
);
