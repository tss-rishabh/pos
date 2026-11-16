import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';

describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'model history in Chromium with isolated API fixtures',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        configFile: false,
        cacheDir: 'node_modules/.vite-administration-history-tests',
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__administration-test__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__administration-test__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/administration/browser-harness.tsx"></script></body></html>',
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
        throw new Error('Local history fixture failed to bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });
    async function fixture(page: Page) {
      page.setDefaultTimeout(5000);
      const calls: { path: string; actor: string | null; body: unknown }[] = [];
      let failure = false;
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          body: unknown = request.method() === 'POST' ? request.postDataJSON() : null;
        calls.push({
          path: url.pathname + url.search,
          actor: request.headers()['x-operator-id'] || null,
          body,
        });
        if (url.pathname === '/api/v1/admin/model-history/capabilities') {
          await route.fulfill({
            json: {
              today: '2026-11-16',
              timeZone: 'Asia/Kolkata',
              models: [
                { id: 'operator', label: 'Operator' },
                { id: 'store', label: 'Store' },
                { id: 'group', label: 'Group' },
              ],
              pageSize: 100,
              dailyConfigured: true,
              historyConfigured: true,
            },
          });
          return;
        }
        if (url.pathname === '/api/v1/admin/model-history/search') {
          if (failure) {
            await route.fulfill({
              status: 503,
              json: {
                error: {
                  code: 'ADMINISTRATION_HISTORY_SOURCE_UNVERIFIED',
                  message: 'Model history requires a verified source and reader publication.',
                },
              },
            });
            return;
          }
          const input = z
            .object({
              model: z.enum(['operator', 'store', 'group']),
              objectId: z.string(),
              from: z.string().nullable(),
              to: z.string().nullable(),
              page: z.string(),
            })
            .parse(body);
          const actual = input.page === '1' || input.page === 'invalid' ? '1' : '2',
            count = actual === '1' ? 100 : 1;
          await route.fulfill({
            json: {
              resource: {
                model: input.model,
                objectId: input.objectId,
                label: input.model === 'group' ? 'Imported source group' : 'Fixture object',
              },
              reader:
                input.from === '2026-11-16' && input.to === '2026-11-16'
                  ? 'data-reader'
                  : 'bigquery',
              today: '2026-11-16',
              timeZone: 'Asia/Kolkata',
              provenance: 'django-admin',
              notice: null,
              total: '101',
              page: actual,
              pages: '2',
              start: actual === '1' ? '0' : '100',
              count,
              pageSize: 100,
              data: Array.from({ length: count }, (_, index) => ({
                id: String((actual === '1' ? 0 : 100) + index + 1),
                actionTime: '2026-11-16 12:00:00.123456',
                actionTimeLabel: 'Nov. 16, 2026, noon',
                actorId: '7',
                actor: 'source-author (Saved Actor)',
                actionFlag: 2,
                action: index === 0 ? 'Changed <img src=x onerror=alert(1)>.' : 'Changed role.',
                messageState: 'available',
              })),
            },
          });
          return;
        }
        await route.fulfill({
          status: 404,
          json: { error: { code: 'FIXTURE_NOT_FOUND', message: 'Fixture route not found.' } },
        });
      });
      await page.goto(origin + '/__administration-test__?screen=model-history');
      await browserExpect(page.getByRole('status')).toHaveText('101 changes. Page 1 of 2.');
      return {
        calls,
        fail() {
          failure = true;
        },
        recover() {
          failure = false;
        },
      };
    }
    it('pages source history, keeps filters in POST bodies and escapes legacy messages', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await browserExpect(page.getByRole('columnheader')).toHaveText([
          'Date/time',
          'User',
          'Action',
        ]);
        expect(await page.locator('td img').count()).toBe(0);
        await browserExpect(
          page.getByText('Changed <img src=x onerror=alert(1)>.', { exact: true }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Next history page' }).click();
        await browserExpect(page.getByRole('status')).toHaveText('101 changes. Page 2 of 2.');
        await page.getByLabel('Model history page', { exact: true }).fill('invalid');
        await page.getByRole('button', { name: 'Go to history page' }).click();
        await browserExpect(page.getByRole('status')).toHaveText('101 changes. Page 1 of 2.');
        await page.getByRole('button', { name: 'Today', exact: true }).click();
        await browserExpect
          .poll(() => state.calls.filter((call) => call.path.endsWith('/search')).at(-1)?.body)
          .toMatchObject({ from: '2026-11-16', to: '2026-11-16', page: '1' });
        await page.getByRole('button', { name: 'All history', exact: true }).click();
        await browserExpect
          .poll(() => state.calls.filter((call) => call.path.endsWith('/search')).at(-1)?.body)
          .toMatchObject({ from: null, to: null, page: '1' });
        expect(state.calls.every((call) => !call.path.includes('?') && call.actor === '1')).toBe(
          true,
        );
        expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(
          'source-author',
        );
      } finally {
        await page.close();
      }
    },15000);
    it('selects imported group history and exposes source readiness errors with retry', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.getByLabel('History model', { exact: true }).selectOption('group');
        await page
          .getByLabel('History object ID', { exact: true })
          .fill('64f6d568-21d5-448c-87bc-e184fd4fcbdc');
        await page.getByRole('button', { name: 'View history', exact: true }).click();
        await browserExpect(
          page.getByRole('heading', { name: 'Imported source group' }),
        ).toBeVisible();
        expect(
          state.calls.filter((call) => call.path.endsWith('/search')).at(-1)?.body,
        ).toMatchObject({ model: 'group', objectId: '64f6d568-21d5-448c-87bc-e184fd4fcbdc' });
        state.fail();
        await page.getByRole('button', { name: 'Today', exact: true }).click();
        await browserExpect(page.getByRole('alert')).toContainText(
          'Model history requires a verified source',
        );
        state.recover();
        await page.getByRole('button', { name: 'Try again', exact: true }).click();
        await browserExpect(page.getByRole('status')).toHaveText('101 changes. Page 1 of 2.');
      } finally {
        await page.close();
      }
    });
    it('hides private history offline', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        await fixture(page);
        await context.setOffline(true);
        await browserExpect(
          page.getByRole('heading', { name: 'Reconnect to view model history' }),
        ).toBeVisible();
        expect(await page.getByText('source-author (Saved Actor)', { exact: true }).count()).toBe(
          0,
        );
        await context.setOffline(false);
        await browserExpect(page.getByRole('status')).toHaveText('101 changes. Page 1 of 2.');
      } finally {
        await context.close();
      }
    }, 15000);
    it('prevents a stale actor from starting another read', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        await page.evaluate(
          "import('/src/api/client.ts').then(({setRequestOperator})=>setRequestOperator('2'))",
        );
        const count = state.calls.filter((call) => call.path.endsWith('/search')).length;
        await page.getByRole('button', { name: 'Next history page' }).click();
        await browserExpect.poll(() => page.getByRole('status').count()).toBe(0);
        expect(state.calls.filter((call) => call.path.endsWith('/search'))).toHaveLength(count);
      } finally {
        await context.close();
      }
    }, 15000);
  },
);
