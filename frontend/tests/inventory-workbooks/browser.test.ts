import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'inventory workbook export UI in isolated Chromium',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cacheDir: string;
    beforeAll(async () => {
      cacheDir = await mkdtemp(join(tmpdir(), 'pos-inventory-workbook-browser-'));
      server = await createServer({
        configFile: false,
        cacheDir,
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__inventory-workbooks__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__inventory-workbooks__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/inventory-workbooks/harness.tsx"></script></body></html>',
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
        throw new Error('Workbook browser fixture did not bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
    });
    async function fixture(page: Page) {
      page.setDefaultTimeout(6000);
      const creates: { commandId: string; input: unknown }[] = [],
        calls: { path: string; actor: string | undefined }[] = [],
        bytes = Buffer.from('PK\x03\x04controlled workbook download');
      let loseReply = false,
        complete = false,
        legacy = false,
        unsafeLegacy = false,
        wrongMime = false;
      let release: (() => Promise<void>) | undefined;
      const row = () => ({
        id: '8aa45fcf-2e06-423b-906d-ddc5116c391a',
        origin: 'current',
        kind: 'current-inventory-workbook',
        reportName: 'Fixture workbook',
        from: null,
        to: null,
        status: complete ? 'COMPLETED' : 'QUEUED',
        message: complete ? 'Report file is ready.' : 'Waiting to prepare the report.',
        requestedBy: '1',
        requestedAt: '2026-06-15T06:30:00Z',
        completedAt: complete ? '2026-06-15T06:31:00Z' : null,
        format: 'XLSX',
        byteCount: complete ? bytes.length : null,
        rowCount: complete ? 2 : null,
        canDownload: complete,
      });
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        calls.push({ path: url.pathname + url.search, actor: request.headers()['x-operator-id'] });
        if (url.pathname === '/api/v1/reports/store-cash-balances/stores') {
          await route.fulfill({
            json: {
              data: [
                { id: '1', name: 'First store' },
                { id: '2', name: 'Second store' },
              ],
            },
          });
          return;
        }
        if (url.pathname === '/api/v1/report-exports/search') {
          const body = z
            .object({ origin: z.enum(['current', 'legacy']) })
            .parse(request.postDataJSON() as unknown);
          legacy = body.origin === 'legacy';
          const data = legacy
            ? [
                {
                  ...row(),
                  id: '71',
                  origin: 'legacy',
                  kind: 'INVENTORY',
                  reportName: 'Legacy workbook',
                  status: 'COMPLETED',
                  canDownload: true,
                  format: 'XLSX',
                },
              ]
            : creates.length
              ? [row()]
              : [];
          await route.fulfill({ json: { data, total: data.length, page: 1, pageSize: 25 } });
          return;
        }
        if (url.pathname === '/api/v1/report-exports' && request.method() === 'POST') {
          const body = z
            .object({ commandId: z.uuid(), input: z.unknown() })
            .strict()
            .parse(request.postDataJSON() as unknown);
          creates.push(body);
          if (loseReply) {
            loseReply = false;
            await route.abort('failed');
            return;
          }
          await route.fulfill({ json: row() });
          return;
        }
        if (url.pathname.endsWith('/file')) {
          if (unsafeLegacy) {
            await route.fulfill({
              status: 409,
              json: {
                error: {
                  code: 'LEGACY_WORKBOOK_UNVERIFIED',
                  message:
                    'This archived workbook requires safe file reconciliation before download.',
                },
              },
            });
            return;
          }
          const fulfill = () =>
            route.fulfill({
              headers: {
                'Content-Type': wrongMime
                  ? 'text/html'
                  : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Length': String(bytes.length),
              },
              body: bytes,
            });
          if (new URL(page.url()).searchParams.has('delayed')) {
            release = fulfill;
            return;
          }
          await fulfill();
          return;
        }
        await route.fulfill({
          status: 404,
          json: { error: { code: 'FIXTURE_NOT_FOUND', message: 'Fixture route missing.' } },
        });
      });
      await page.goto(origin + '/__inventory-workbooks__');
      await browserExpect(
        page.getByRole('heading', { level: 1, name: /^Report exports\s*\.$/ }),
      ).toBeVisible();
      return {
        creates,
        calls,
        bytes,
        complete() {
          complete = true;
        },
        lose() {
          loseReply = true;
        },
        unsafe() {
          unsafeLegacy = true;
        },
        wrong() {
          wrongMime = true;
        },
        async release() {
          await release?.();
        },
        async waitForDownload() {
          await browserExpect.poll(() => release !== undefined).toBe(true);
        },
      };
    }
    async function choose(page: Page) {
      await browserExpect(
        page.getByRole('checkbox', { name: 'Report', exact: true, includeHidden: true }),
      ).toBeChecked();
      await page
        .getByRole('combobox', { name: 'Report', exact: true })
        .selectOption('current-inventory-workbook');
      await page.getByLabel('Export name', { exact: true }).fill('Fixture workbook');
      await page.getByLabel(/^Stores/).selectOption(['1', '2']);
    }
    it('requests ordered current sheets without dates, polls status and downloads the XLSX with its lossless name', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await choose(page);
        await browserExpect(page.getByLabel('From', { exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'Move store 2 up' }).click();
        await page.getByRole('button', { name: 'Request export', exact: true }).click();
        await browserExpect(
          page.getByText('Export requested. Its status appears below.'),
        ).toBeVisible();
        expect(state.creates[0]?.input).toEqual({
          kind: 'current-inventory-workbook',
          storeIds: ['2', '1'],
          label: 'Fixture workbook',
        });
        state.complete();
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await browserExpect(page.getByText('Current snapshot', { exact: true })).toBeVisible();
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download Fixture workbook' }).click();
        expect((await download).suggestedFilename()).toBe(
          'inventory-8aa45fcf-2e06-423b-906d-ddc5116c391a.xlsx',
        );
        expect(state.calls.every((call) => call.actor === '1')).toBe(true);
      } finally {
        await page.close();
      }
    });
    it('reuses the same UUID and body after a lost request reply and keeps search/label text out of stored recovery records', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await choose(page);
        state.lose();
        await page.getByRole('button', { name: 'Request export', exact: true }).click();
        await browserExpect(
          page.getByText(
            'Could not connect to the store service. Check your connection and try again.',
          ),
        ).toBeVisible();
        const local = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
        expect(local).not.toContain('Fixture workbook');
        await page.getByRole('button', { name: 'Request export', exact: true }).click();
        await browserExpect(
          page.getByText('Export requested. Its status appears below.'),
        ).toBeVisible();
        expect(state.creates).toHaveLength(2);
        expect(state.creates[0]).toEqual(state.creates[1]);
        expect(state.calls.every((call) => !call.path.includes('?'))).toBe(true);
      } finally {
        await page.close();
      }
    });
    it('offers safe legacy XLSX downloads and exposes the explicit integrity gate for unaccepted files', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.getByLabel('History', { exact: true }).selectOption('legacy');
        await browserExpect(
          page.getByRole('button', { name: 'Download Legacy workbook' }),
        ).toBeEnabled();
        state.unsafe();
        await page.getByRole('button', { name: 'Download Legacy workbook' }).click();
        await browserExpect(
          page.getByText(
            'This archived workbook requires safe file reconciliation before download.',
          ),
        ).toBeVisible();
        expect(state.creates).toHaveLength(0);
      } finally {
        await page.close();
      }
    });
    it('rejects unexpected response MIME without publishing a downloaded file', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.wrong();
        await choose(page);
        await page.getByRole('button', { name: 'Request export', exact: true }).click();
        state.complete();
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await page.getByRole('button', { name: 'Download Fixture workbook' }).click();
        await browserExpect(
          page.getByText('The report returned an unexpected file format.'),
        ).toBeVisible();
      } finally {
        await page.close();
      }
    });
    it('does not publish a late owner-bound download after the signed-in operator changes', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await choose(page);
        await page.getByRole('button', { name: 'Request export', exact: true }).click();
        state.complete();
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await page.evaluate(() => history.replaceState(null, '', location.pathname + '?delayed'));
        let downloads = 0;
        page.on('download', () => {
          downloads++;
        });
        await page.getByRole('button', { name: 'Download Fixture workbook' }).click();
        await state.waitForDownload();
        await page.getByRole('button', { name: 'Fixture switch operator' }).click();
        await state.release().catch(() => undefined);
        await browserExpect
          .poll(() => page.getByRole('button', { name: 'Download Fixture workbook' }).isEnabled())
          .toBe(true);
        expect(downloads).toBe(0);
      } finally {
        await page.close();
      }
    });
  },
);
