import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  importInputSchema,
  type OrderImportInput,
  type OrderImportJob,
} from '../../src/pages/administration/order-imports/client';

const columns = [
  'SerialNo',
  'StoreId',
  'Email',
  'UserName',
  'IsExclusive',
  'ProductId',
  'ProductQty',
  'ProductPrice',
  'PaymentMode',
  'OrderDate',
  'OrderPlacedSms',
  'OrderMessage',
];
const csv =
  columns.join(',') +
  '\nA,1,private-import@example.test,Private fixture,1,9007199254740993,2,25.49,cash,2026-06-15 12:00:00,0,Private message';
describe.skipIf(process.env.ORDER_IMPORT_BROWSER_TESTS !== 'true')(
  'actual historical CSV import recovery screen',
  { timeout: 20000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = await mkdtemp(join(tmpdir(), 'pos-order-imports-vite-'));
      server = await createServer({
        configFile: false,
        cacheDir: cache,
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__order-imports__')) return next();
        try {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            await server.transformIndexHtml(
              '/__order-imports__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/order-imports/harness.tsx"></script></body></html>',
            ),
          );
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Isolated import browser failed.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 25000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cache) await rm(cache, { recursive: true, force: true });
    });
    async function fixture(page: Page) {
      page.setDefaultTimeout(7000);
      const state = {
        job: null as OrderImportJob | null,
        starts: [] as OrderImportInput[],
        gets: [] as string[],
        dropStage: false,
        dropCancellation: false,
        cancellations: 0,
        commitBeforeDrop: true,
        holdPreview: false,
        releasePreview: () => undefined as void,
        errors: [] as string[],
        resumeRequests: [] as { operationId: string; jobId: string }[],
        resumeReceipts: new Map<
          string,
          { operationId: string; jobId: string; acceptedAt: string }
        >(),
        dropResume: false,
        commitResumeBeforeDrop: true,
      };
      page.on('pageerror', (error) => state.errors.push(error.message));
      await page.route('**/api/v1/admin/order-imports**', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        expect(['44', '45']).toContain(request.headers()['x-operator-id']);
        if (request.method() === 'GET') {
          state.gets.push(path);
          if (path.includes('/resumptions/')) {
            const value = state.resumeReceipts.get(path.split('/').at(-1)!);
            return value
              ? route.fulfill({ json: value })
              : route.fulfill({
                  status: 404,
                  json: {
                    error: {
                      code: 'ORDER_IMPORT_RESUMPTION_NOT_FOUND',
                      message: 'The original resume request is unconfirmed.',
                    },
                  },
                });
          }
          if (path.endsWith('/capabilities'))
            return route.fulfill({
              json: {
                ready: true,
                canPreview: true,
                kinds: ['offline', 'shopify'],
                maximumFileBytes: 5242880,
                maximumRows: 50000,
                maximumStores: 100,
              },
            });
          if (path.endsWith('/results') && state.job)
            return route.fulfill({ json: { data: [], nextAfter: null } });
          if (state.job && path.endsWith('/' + state.job.id))
            return route.fulfill({ json: state.job });
          return route.fulfill({
            status: 404,
            json: {
              error: {
                code: 'ORDER_IMPORT_NOT_FOUND',
                message: 'The original import is unconfirmed.',
              },
            },
          });
        }
        if (path.endsWith('/resumptions') && state.job) {
          const body = z
              .object({ operationId: z.uuid() })
              .strict()
              .parse(request.postDataJSON() as unknown),
            value = {
              operationId: body.operationId,
              jobId: state.job.id,
              acceptedAt: '2026-11-17 12:02:00.000',
            };
          state.resumeRequests.push({ operationId: body.operationId, jobId: state.job.id });
          if (!state.dropResume || state.commitResumeBeforeDrop) {
            if (!state.resumeReceipts.has(body.operationId)) {
              state.resumeReceipts.set(body.operationId, value);
              state.job = {
                ...state.job,
                state: 'QUEUED',
                errorCode: null,
                updatedAt: value.acceptedAt,
              };
            }
          }
          return state.dropResume ? route.abort() : route.fulfill({ status: 202, json: value });
        }
        if (path.endsWith('/cancellations') && state.job) {
          state.cancellations++;
          state.job = {
            ...state.job,
            state: 'CANCELLED',
            cancelledOrders: 1,
            completedAt: '2026-11-17 12:01:00',
          };
          return state.dropCancellation ? route.abort() : route.fulfill({ json: state.job });
        }
        const body = importInputSchema.parse(request.postDataJSON() as unknown);
        if (path.endsWith('/previews')) {
          if (state.holdPreview)
            await new Promise<void>((resolve) => {
              state.releasePreview = resolve;
            });
          return route.fulfill({
            json: {
              id: body.id,
              kind: body.kind,
              totalOrders: 1,
              totalUnits: 2,
              lineValue: '50.98',
              scopes: body.counters,
              earliestBusinessDate: '2026-06-15',
              latestBusinessDate: '2026-06-15',
            },
          });
        }
        if (path === '/api/v1/admin/order-imports') {
          state.starts.push(body);
          if (!state.dropStage || state.commitBeforeDrop)
            state.job = {
              id: body.id,
              kind: body.kind,
              state: 'QUEUED',
              totalOrders: 1,
              importedOrders: 0,
              failedOrders: 0,
              cancelledOrders: 0,
              errorCode: null,
              createdAt: '2026-11-17 12:00:00',
              updatedAt: '2026-11-17 12:00:00',
              completedAt: null,
            };
          return state.dropStage ? route.abort() : route.fulfill({ status: 202, json: state.job });
        }
        return route.fulfill({
          status: 503,
          json: { error: { code: 'FIXTURE_UNSELECTED', message: 'Unexpected import action.' } },
        });
      });
      return state;
    }
    const selectFile = (page: Page, text = csv) =>
      page.getByLabel('Order CSV file', { exact: true }).setInputFiles({
        name: 'customer-export.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(text),
      });
    async function prepare(page: Page) {
      await page.goto(origin + '/__order-imports__');
      await page.getByLabel('Store ID 1', { exact: true }).fill('1');
      await page.getByLabel('Counter ID 1', { exact: true }).fill('2');
      await selectFile(page);
      await page.getByRole('button', { name: 'Review file', exact: true }).click();
      await browserExpect(
        page.getByRole('region', { name: 'Import preview', exact: true }),
      ).toBeVisible();
    }
    it('queues an explicitly reviewed file and keeps only opaque recovery data across reload', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        await prepare(page);
        await page.getByRole('button', { name: 'Queue reviewed orders', exact: true }).click();
        await browserExpect(page.getByText('Status: QUEUED', { exact: true })).toBeVisible();
        expect(state.starts).toHaveLength(1);
        const storage = await page.evaluate(() =>
          localStorage.getItem('pos-legacy-order-import:' + JSON.stringify(['44'])),
        );
        expect(storage).toContain(state.starts[0]!.id);
        expect(storage).not.toMatch(
          /private-import|Private fixture|Private message|customer-export|csv/,
        );
        await page.reload();
        await browserExpect(page.getByText('Status: QUEUED', { exact: true })).toBeVisible();
        expect(state.starts).toHaveLength(1);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('uses original GET recovery after a lost committed response without another order submission', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        state.dropStage = true;
        await prepare(page);
        await page.getByRole('button', { name: 'Queue reviewed orders', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Retry exact saved import', exact: true }),
        ).toBeVisible();
        await page.reload();
        await browserExpect(page.getByText('Status: QUEUED', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Refresh import', exact: true }).click();
        expect(state.starts).toHaveLength(1);
        expect(state.gets.some((path) => path.endsWith('/' + state.job!.id))).toBe(true);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('does not treat404 as permission for a new file and retries only the exact saved input and UUID', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        state.dropStage = true;
        state.commitBeforeDrop = false;
        await prepare(page);
        await page.getByRole('button', { name: 'Queue reviewed orders', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Retry exact saved import', exact: true }),
        ).toBeVisible();
        const original = state.starts[0]!;
        await page.reload();
        await selectFile(page, csv.replace('25.49', '26.49'));
        await page.getByRole('button', { name: 'Retry exact saved import', exact: true }).click();
        await browserExpect(
          page.getByText('Retry requires the exact original file, format and counter selections.', {
            exact: true,
          }),
        ).toBeVisible();
        expect(state.starts).toHaveLength(1);
        state.dropStage = false;
        await selectFile(page);
        await page.getByRole('button', { name: 'Retry exact saved import', exact: true }).click();
        await browserExpect(page.getByText('Status: QUEUED', { exact: true })).toBeVisible();
        expect(state.starts).toHaveLength(2);
        expect(state.starts[1]).toEqual(original);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('retains a lost cancellation until original GET proves terminal status before retiring the reference', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        state.dropCancellation = true;
        await prepare(page);
        await page.getByRole('button', { name: 'Queue reviewed orders', exact: true }).click();
        await browserExpect(page.getByText('Status: QUEUED', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Cancel unsent orders', exact: true }).click();
        await browserExpect(page.getByRole('alert')).toBeVisible();
        const savedKey = 'pos-legacy-order-import:' + JSON.stringify(['44']);
        expect(await page.evaluate((key) => localStorage.getItem(key), savedKey)).not.toBeNull();
        await page.reload();
        await browserExpect(page.getByText('Status: CANCELLED', { exact: true })).toBeVisible();
        expect(state.starts).toHaveLength(1);
        expect(state.cancellations).toBe(1);
        expect(await page.evaluate((key) => localStorage.getItem(key), savedKey)).not.toBeNull();
        await page.getByRole('button', { name: 'Prepare another file', exact: true }).click();
        expect(await page.evaluate((key) => localStorage.getItem(key), savedKey)).toBeNull();
        const oldReads = state.gets.filter((path) => path.endsWith('/' + state.job!.id)).length,
          capabilitiesReads = state.gets.filter((path) => path.endsWith('/capabilities')).length;
        await page.getByRole('button', { name: 'Go offline', exact: true }).click();
        await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
        await browserExpect
          .poll(() => state.gets.filter((path) => path.endsWith('/capabilities')).length)
          .toBe(capabilitiesReads + 1);
        expect(state.gets.filter((path) => path.endsWith('/' + state.job!.id))).toHaveLength(
          oldReads,
        );
        await browserExpect(page.getByText('Status: CANCELLED', { exact: true })).toHaveCount(0);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('blocks dispatch when the recovery reference cannot be persisted', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        await page.addInitScript(() => {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key: string, value: string) {
            if (key.startsWith('pos-legacy-order-import:'))
              throw new DOMException('Fixture quota', 'QuotaExceededError');
            original.call(this, key, value);
          };
        });
        const state = await fixture(page);
        await prepare(page);
        await page.getByRole('button', { name: 'Queue reviewed orders', exact: true }).click();
        await browserExpect(
          page.getByText('The recovery reference could not be saved. No file was queued.', {
            exact: true,
          }),
        ).toBeVisible();
        expect(state.starts).toHaveLength(0);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('recovers a committed resume by GET after reload without re-uploading the CSV or repeating the resume', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        await prepare(page);
        await page.getByRole('button', { name: 'Queue reviewed orders', exact: true }).click();
        await browserExpect(page.getByText('Status: QUEUED', { exact: true })).toBeVisible();
        state.job = { ...state.job!, state: 'BLOCKED', errorCode: 'ORDER_IMPORT_ACCESS_CHANGED' };
        state.dropResume = true;
        await page.getByRole('button', { name: 'Refresh import', exact: true }).click();
        await page.getByRole('button', { name: 'Resume unsent orders', exact: true }).click();
        await browserExpect(
          page.getByText('Saved resume reference:', { exact: false }),
        ).toBeVisible();
        expect(state.resumeRequests).toHaveLength(1);
        const resumeKeys = await page.evaluate(() =>
          Object.keys(localStorage).filter((key) => key.startsWith('pos-order-import-resumption:')),
        );
        expect(resumeKeys).toHaveLength(1);
        const saved = await page.evaluate((key) => localStorage.getItem(key), resumeKeys[0]!);
        expect(saved).toContain(state.resumeRequests[0]!.operationId);
        expect(saved).not.toMatch(
          /private-import|Private fixture|Private message|customer-export|csv/,
        );
        await page.reload();
        await browserExpect(page.getByText('Status: QUEUED', { exact: true })).toBeVisible();
        await browserExpect(
          page.getByText('The original resume request was accepted.', { exact: false }),
        ).toBeVisible();
        expect(state.resumeRequests).toHaveLength(1);
        expect(state.starts).toHaveLength(1);
        expect(await page.evaluate((key) => localStorage.getItem(key), resumeKeys[0]!)).toBeNull();
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('retries only the original resume UUID after an absent receipt and disables sending while offline', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        await prepare(page);
        await page.getByRole('button', { name: 'Queue reviewed orders', exact: true }).click();
        await browserExpect(page.getByText('Status: QUEUED', { exact: true })).toBeVisible();
        state.job = { ...state.job!, state: 'BLOCKED', errorCode: 'ORDER_IMPORT_ACCESS_CHANGED' };
        state.dropResume = true;
        state.commitResumeBeforeDrop = false;
        await page.getByRole('button', { name: 'Refresh import', exact: true }).click();
        await page.getByRole('button', { name: 'Resume unsent orders', exact: true }).click();
        await browserExpect(
          page.getByText('Saved resume reference:', { exact: false }),
        ).toBeVisible();
        const original = state.resumeRequests[0]!;
        await page.reload();
        const retry = page.getByRole('button', {
          name: 'Retry the same resume request',
          exact: true,
        });
        await browserExpect(retry).toBeVisible();
        expect(state.resumeRequests).toHaveLength(1);
        await page.getByRole('button', { name: 'Go offline', exact: true }).click();
        await browserExpect(retry).toBeDisabled();
        await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
        await browserExpect(retry).toBeEnabled();
        state.dropResume = false;
        await retry.click();
        await browserExpect(page.getByText('Status: QUEUED', { exact: true })).toBeVisible();
        expect(state.resumeRequests).toHaveLength(2);
        expect(state.resumeRequests[1]).toEqual(original);
        expect(state.starts).toHaveLength(1);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('sends no resume request when its opaque reference cannot be persisted', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        await page.addInitScript(() => {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key: string, value: string) {
            if (key.startsWith('pos-order-import-resumption:'))
              throw new DOMException('Fixture quota', 'QuotaExceededError');
            original.call(this, key, value);
          };
        });
        const state = await fixture(page);
        await prepare(page);
        await page.getByRole('button', { name: 'Queue reviewed orders', exact: true }).click();
        await browserExpect(page.getByText('Status: QUEUED', { exact: true })).toBeVisible();
        state.job = { ...state.job!, state: 'BLOCKED', errorCode: 'ORDER_IMPORT_ACCESS_CHANGED' };
        await page.getByRole('button', { name: 'Refresh import', exact: true }).click();
        await page.getByRole('button', { name: 'Resume unsent orders', exact: true }).click();
        await browserExpect(
          page.getByText('The resume reference could not be saved. No resume request was sent.', {
            exact: true,
          }),
        ).toBeVisible();
        expect(state.resumeRequests).toHaveLength(0);
        expect(state.starts).toHaveLength(1);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('discards a late old-operator preview and never sends its file under the new operator', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        state.holdPreview = true;
        await page.goto(origin + '/__order-imports__');
        await page.getByLabel('Store ID 1', { exact: true }).fill('1');
        await page.getByLabel('Counter ID 1', { exact: true }).fill('2');
        await selectFile(page);
        await page.getByRole('button', { name: 'Review file', exact: true }).click();
        await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
        state.releasePreview();
        await browserExpect(page.getByTestId('operator')).toHaveText('45');
        await browserExpect(
          page.getByRole('region', { name: 'Import preview', exact: true }),
        ).toHaveCount(0);
        await browserExpect(page.getByLabel('Store ID 1', { exact: true })).toHaveValue('');
        expect(state.starts).toHaveLength(0);
        expect(
          await page.evaluate(() =>
            Object.keys(localStorage).filter((key) => key.startsWith('pos-legacy-order-import:')),
          ),
        ).toEqual([]);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('does not dispatch the old file if assignments change while its digest is pending', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        await prepare(page);
        await page.evaluate(() => {
          const digest = crypto.subtle.digest.bind(crypto.subtle);
          Object.defineProperty(crypto.subtle, 'digest', {
            value: async (...args: Parameters<SubtleCrypto['digest']>) => {
              await new Promise<void>((resolve) => {
                Object.assign(window, { releaseImportDigest: resolve });
              });
              const result = await digest(...args);
              Object.assign(window, { importDigestCompleted: true });
              return result;
            },
          });
        });
        await page.getByRole('button', { name: 'Queue reviewed orders', exact: true }).click();
        await browserExpect
          .poll(() => page.evaluate(() => typeof Reflect.get(window, 'releaseImportDigest')))
          .toBe('function');
        await page.getByRole('button', { name: 'Change store assignments', exact: true }).click();
        await page.evaluate(() => {
          const release = Reflect.get(window, 'releaseImportDigest') as unknown;
          if (typeof release === 'function') release();
        });
        await browserExpect
          .poll(() => page.evaluate(() => Reflect.get(window, 'importDigestCompleted') as unknown))
          .toBe(true);
        await browserExpect(page.getByLabel('Store ID 1', { exact: true })).toHaveValue('');
        expect(state.starts).toHaveLength(0);
        expect(
          await page.evaluate(() =>
            Object.keys(localStorage).filter((key) => key.startsWith('pos-legacy-order-import:')),
          ),
        ).toEqual([]);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  },
);
