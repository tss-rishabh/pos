import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';
import {
  ecommerceInput,
  ecommerceReceipt,
} from '../../../src/pages/administration/ecommerce-sync/api';

describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'ecommerce settings and full-sync recovery components',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = await mkdtemp(join(tmpdir(), 'pos-ecommerce-sync-browser-'));
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
        if (request.url?.split('?')[0] !== '/__ecommerce_sync__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__ecommerce_sync__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/administration/ecommerce-sync/harness.tsx"></script></body></html>',
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
        throw new Error('Ecommerce browser fixture did not bind.');
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
      mode: 'normal' | 'lost' | 'missing' | 'cancel-lost' | 'delayed' | 'blocked' = 'normal',
    ) {
      page.setDefaultTimeout(6000);
      const calls: { method: string; path: string; actor: string }[] = [],
        writes: z.infer<typeof ecommerceInput>[] = [],
        receipts = new Map<string, z.infer<typeof ecommerceReceipt>>(),
        controls: unknown[] = [],
        syncId = '1f7b518c-cb35-4988-8326-595ad41edb9b';
      let complete = false,
        blocked = mode === 'blocked',
        release: (() => Promise<void>) | undefined,
        threshold = 5;
      await page.route('**/api/v1/**', async (route) => {
        const req = route.request(),
          url = new URL(req.url()),
          actor = req.headers()['x-operator-id'] || '',
          base = '/api/v1/admin/stores/1';
        calls.push({ method: req.method(), path: url.pathname + url.search, actor });
        if (url.pathname === base + '/ecommerce-settings' && req.method() === 'GET') {
          await route.fulfill({
            json: {
              id: '1',
              name: 'Synthetic store',
              threshold,
              active: true,
              version: 'a'.repeat(64),
              lockedUntil: null,
              editable: true,
            },
          });
          return;
        }
        if (url.pathname === base + '/ecommerce-settings' && req.method() === 'PUT') {
          const input = ecommerceInput.parse(req.postDataJSON() as unknown);
          writes.push(input);
          const value = {
            status: 'success' as const,
            message: 'Ecom Setting Updated! Please wait, It will take time to reflect',
            effectsQueued: true,
            storeId: '1',
            operationId: input.operationId,
            actorId: actor,
            ecommerceSyncId: syncId,
          };
          if (mode !== 'missing' && mode !== 'cancel-lost') {
            receipts.set(input.operationId, value);
            threshold = input.threshold;
          }
          if (['lost', 'missing', 'cancel-lost'].includes(mode) && writes.length === 1) {
            await route.abort('failed');
            return;
          }
          if (mode === 'delayed') {
            release = () => route.fulfill({ json: value });
            return;
          }
          await route.fulfill({ json: receipts.get(input.operationId) || value });
          return;
        }
        if (url.pathname === base + '/ecommerce-settings/cancellations') {
          const input = z
            .object({ operationId: z.uuid(), original: ecommerceInput })
            .strict()
            .parse(req.postDataJSON() as unknown);
          controls.push(input);
          const prior = receipts.get(input.original.operationId),
            value = {
              ...(prior || {
                status: 'success' as const,
                message: 'The original settings request was cancelled before acceptance.',
                effectsQueued: false,
                storeId: '1',
                actorId: actor,
                cancelled: true,
              }),
              operationId: input.operationId,
              originalOperationId: input.original.operationId,
            };
          receipts.set(input.operationId, value);
          if (mode === 'cancel-lost') {
            await route.abort('failed');
            return;
          }
          await route.fulfill({ json: value });
          return;
        }
        if (url.pathname.includes('/ecommerce-settings/operations/')) {
          const row = receipts.get(url.pathname.split('/').at(-1)!);
          await route.fulfill(
            row
              ? { json: row }
              : {
                  status: 404,
                  json: {
                    error: {
                      code: 'ECOMMERCE_OPERATION_NOT_FOUND',
                      message: 'The original ecommerce settings operation was not found.',
                    },
                  },
                },
          );
          return;
        }
        if (url.pathname.endsWith('/records')) {
          await route.fulfill({
            json: {
              data: [
                {
                  associationId: '9007199254740993',
                  productId: '9007199254740995',
                  selectedStock: 9,
                  currentStock: 9,
                  state: complete ? 'PROCESSED' : 'PENDING',
                },
              ],
              nextCursor: null,
            },
          });
          return;
        }
        if (url.pathname.endsWith('/retries')) {
          const input = z
            .object({ operationId: z.uuid() })
            .strict()
            .parse(req.postDataJSON() as unknown);
          controls.push(input);
          blocked = false;
          const value = {
            status: 'success' as const,
            message: 'Ecommerce synchronization queued for recovery.',
            effectsQueued: true,
            storeId: '1',
            operationId: input.operationId,
            actorId: actor,
            ecommerceSyncId: syncId,
          };
          receipts.set(input.operationId, value);
          await route.fulfill({ json: value });
          return;
        }
        if (url.pathname === base + '/ecommerce-inventory-syncs/' + syncId) {
          await route.fulfill({
            json: {
              id: syncId,
              storeId: '1',
              state: complete ? 'COMPLETED' : blocked ? 'BLOCKED' : 'FULL_SYNC',
              fullState: complete ? 'SUCCEEDED' : 'UNCERTAIN',
              selectedRows: 1,
              processedRows: 1,
              skippedRows: 0,
              errorCode: blocked ? 'ECOMMERCE_SYNC_PRODUCT_MISSING' : null,
              attempts: 0,
              completed: complete,
              fullProof: complete
                ? { mongoWrites: 25, redisWrites: 25, cdnBatches: 1, catalogDigest: 'b'.repeat(64) }
                : null,
            },
          });
          return;
        }
        await route.fulfill({
          status: 500,
          json: { error: { code: 'FIXTURE_ROUTE_MISSING', message: 'Fixture route missing.' } },
        });
      });
      await page.goto(origin + '/__ecommerce_sync__');
      await browserExpect(
        page.getByRole('button', { name: 'Edit e-commerce delivery', exact: true }),
      ).toBeEnabled();
      return {
        calls,
        writes,
        controls,
        complete: () => {
          complete = true;
        },
        release: async () => {
          if (!release) throw new Error('Delayed fixture not ready.');
          await release();
        },
      };
    }
    async function change(page: Page) {
      await page.getByRole('button', { name: 'Edit e-commerce delivery', exact: true }).click();
      await page.getByLabel('Delivery stock threshold', { exact: true }).fill('7');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    }
    it('keeps started/unknown full sync pending and displays completed only after GET proof, without another settings write', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await change(page);
        await browserExpect(
          page.getByText('Stock refreshed. Full catalog synchronization is still pending.', {
            exact: true,
          }),
        ).toBeVisible();
        await browserExpect(
          page.getByRole('cell', { name: '9007199254740995', exact: true }),
        ).toBeVisible();
        expect(
          await page
            .getByText('Inventory and full catalog synchronization completed.', { exact: true })
            .count(),
        ).toBe(0);
        state.complete();
        await page
          .getByRole('button', { name: 'Check synchronization status', exact: true })
          .click();
        await browserExpect(
          page.getByText('Inventory and full catalog synchronization completed.', { exact: true }),
        ).toBeVisible();
        expect(state.writes).toHaveLength(1);
        expect(state.calls.every((row) => row.actor === '900001')).toBe(true);
      } finally {
        await page.close();
      }
    }, 20000);
    it('recovers a committed lost settings reply after reload with original GET only', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page, 'lost');
        await change(page);
        await browserExpect(
          page.getByRole('button', { name: 'Check original settings action', exact: true }),
        ).toBeVisible();
        const id = state.writes[0]!.operationId;
        await page.reload();
        await page
          .getByRole('button', { name: 'Check original settings action', exact: true })
          .click();
        await browserExpect(
          page.getByText('Stock refreshed. Full catalog synchronization is still pending.', {
            exact: true,
          }),
        ).toBeVisible();
        expect(state.writes).toHaveLength(1);
        expect(state.calls.some((row) => row.path.endsWith('/operations/' + id))).toBe(true);
      } finally {
        await page.close();
      }
    }, 20000);
    it('retains a genuinely missing action and only explicitly retries identical UUID/body', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page, 'missing');
        await change(page);
        await page
          .getByRole('button', { name: 'Check original settings action', exact: true })
          .click();
        await browserExpect(
          page.getByRole('button', { name: 'Retry original settings action', exact: true }),
        ).toBeVisible();
        await page
          .getByRole('button', { name: 'Retry original settings action', exact: true })
          .click();
        await browserExpect(
          page.getByText('Stock refreshed. Full catalog synchronization is still pending.', {
            exact: true,
          }),
        ).toBeVisible();
        expect(state.writes).toHaveLength(2);
        expect(state.writes[1]).toEqual(state.writes[0]);
      } finally {
        await page.close();
      }
    }, 20000);
    it('recovers lost cancellation by its own receipt without repeating PUT or cancellation POST', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page, 'cancel-lost');
        await change(page);
        await page.getByRole('button', { name: 'Cancel if not accepted', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Check original settings action', exact: true }),
        ).toBeVisible();
        await page.reload();
        await page
          .getByRole('button', { name: 'Check original settings action', exact: true })
          .click();
        await browserExpect(
          page.getByText('The original settings request was cancelled before acceptance.', {
            exact: true,
          }),
        ).toBeVisible();
        expect(state.writes).toHaveLength(1);
        expect(state.controls).toHaveLength(1);
      } finally {
        await page.close();
      }
    }, 20000);
    it('only explicitly resumes a reconciled job and records its separate immutable control operation', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page, 'blocked');
        await change(page);
        await browserExpect(
          page.getByText('Synchronization needs reconciliation.', { exact: true }),
        ).toBeVisible();
        await page
          .getByRole('button', { name: 'Resume after reconciliation', exact: true })
          .click();
        await browserExpect(
          page.getByText('Stock refreshed. Full catalog synchronization is still pending.', {
            exact: true,
          }),
        ).toBeVisible();
        expect(state.writes).toHaveLength(1);
        expect(state.controls).toHaveLength(1);
      } finally {
        await page.close();
      }
    }, 20000);
    it('fences delayed completion after an operator switch and preserves only the original owners journal', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page, 'delayed');
        await change(page);
        await browserExpect.poll(() => state.writes.length).toBe(1);
        await page.getByRole('button', { name: 'Fixture switch operator', exact: true }).click();
        await state.release().catch(() => undefined);
        await browserExpect(
          page.getByRole('button', { name: 'Edit e-commerce delivery', exact: true }),
        ).toBeEnabled();
        expect(
          await page
            .getByRole('button', { name: 'Check original settings action', exact: true })
            .count(),
        ).toBe(0);
        const journal = await page.evaluate(() =>
          localStorage.getItem('pos-ecommerce-sync-v1:900001:1'),
        );
        expect(journal).toContain(state.writes[0]!.operationId);
        expect(state.writes).toHaveLength(1);
        expect(
          state.calls.filter((row) => row.method !== 'GET').every((row) => row.actor === '900001'),
        ).toBe(true);
      } finally {
        await page.close();
      }
    }, 20000);
  },
);
