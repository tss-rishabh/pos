import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'source dashboard in isolated Chromium',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        configFile: false,
        cacheDir: 'node_modules/.vite-dashboard-tests',
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__dashboard__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__dashboard__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/dashboard/harness.tsx"></script></body></html>',
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
        throw new Error('Dashboard browser fixture did not bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });
    async function fixture(
      page: Page,
      mode: 'normal' | 'missing' | 'delayed' | 'franchise' = 'normal',
    ) {
      page.setDefaultTimeout(6000);
      const calls: { path: string; actor: string | undefined }[] = [];
      let release: (() => Promise<void>) | undefined,
        missing = mode === 'missing';
      const history = {
        reader: 'bigquery',
        asOf: '2026-06-15T06:00:00.000000Z',
        generationId: 'bd586727-f763-4515-bb51-c8fa25e27b98',
        contract: 'pos-dashboard-orders-v1',
        year: 2026,
        orderAssociations: '9007199254740993',
        months: [
          'Jan',
          'Feb',
          'Mar',
          'Apr',
          'May',
          'Jun',
          'Jul',
          'Aug',
          'Sep',
          'Oct',
          'Nov',
          'Dec',
        ],
        series: [
          {
            id: '1',
            name: 'Literal <img src=x onerror=alert(1)>',
            counts: ['2', '0', '1', '0', '0', '3', '0', '0', '0', '0', '0', '0'],
          },
          {
            id: '9007199254740993',
            name: null,
            counts: ['0', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0'],
          },
        ],
      };
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        calls.push({ path, actor: request.headers()['x-operator-id'] });
        if (path === '/api/v1/dashboard/overview') {
          await route.fulfill({
            json: {
              reader: 'primary',
              asOf: '2026-06-15T06:30:00Z',
              businessDate: '2026-06-15',
              year: 2026,
              activeStores: '4',
              activeOperators: '9',
              parentProducts: '42',
              stores: [
                { id: '1', name: 'First' },
                { id: '9007199254740993', name: null },
              ],
            },
          });
          return;
        }
        if (path === '/api/v1/dashboard/orders/today') {
          await route.fulfill({
            json: {
              reader: 'data',
              asOf: '2026-06-15T06:30:00Z',
              businessDate: '2026-06-15',
              orderAssociations: '3',
            },
          });
          return;
        }
        if (path === '/api/v1/dashboard/orders/history') {
          const finish = () =>
            missing
              ? route.fulfill({
                  status: 503,
                  json: {
                    error: {
                      code: 'DASHBOARD_PUBLICATION_UNAVAILABLE',
                      message:
                        'Dashboard history requires a complete, source-matching warehouse publication.',
                    },
                  },
                })
              : route.fulfill({ json: history });
          if (mode === 'delayed') {
            release = finish;
            return;
          }
          await finish();
          return;
        }
        await route.fulfill({
          status: 404,
          json: { error: { code: 'FIXTURE_NOT_FOUND', message: 'Fixture route missing.' } },
        });
      });
      await page.goto(origin + '/__dashboard__' + (mode === 'franchise' ? '?franchise' : ''));
      if (mode !== 'franchise')
        await browserExpect(
          page.getByRole('heading', { level: 1, name: /^Dashboard\s*\.$/ }),
        ).toBeVisible();
      return {
        calls,
        complete() {
          missing = false;
        },
        async release() {
          await release?.();
        },
        async waitForBody() {
          await browserExpect.poll(() => Boolean(release)).toBe(true);
        },
      };
    }
    it('renders exact association metrics, publication freshness and twelve source months with safe literal names', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page);
        await browserExpect(
          page.locator('.metric').filter({ hasText: 'Active stores' }).locator('strong'),
        ).toHaveText('4');
        await browserExpect(
          page.locator('.metric').filter({ hasText: 'Total order associations' }).locator('strong'),
        ).toHaveText('9,00,71,99,25,47,40,993');
        await browserExpect(
          page
            .locator('.metric')
            .filter({ hasText: 'Today’s order associations' })
            .locator('strong'),
        ).toHaveText('3');
        await browserExpect(page.locator('time')).toHaveAttribute(
          'datetime',
          '2026-06-15T06:00:00.000000Z',
        );
        await browserExpect(page.getByRole('table')).toHaveCount(1);
        await browserExpect(page.getByRole('columnheader')).toHaveCount(13);
        await browserExpect(
          page.getByRole('rowheader', { name: 'Literal <img src=x onerror=alert(1)>' }),
        ).toBeVisible();
        expect(await page.locator('img').count()).toBe(0);
        await page.getByLabel('Graph stores').selectOption('9007199254740993');
        await browserExpect(page.getByRole('rowheader')).toHaveText('Unnamed store');
        await browserExpect(page.getByRole('cell')).toHaveCount(12);
        expect(f.calls.every((call) => call.actor === '900001')).toBe(true);
      } finally {
        await page.close();
      }
    });
    it('preserves current figures and an unavailable historical total until a valid publication is retried', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'missing');
        await browserExpect(page.getByRole('alert')).toContainText(
          'complete, source-matching warehouse publication',
        );
        await browserExpect(
          page.locator('.metric').filter({ hasText: 'Parent products' }).locator('strong'),
        ).toHaveText('42');
        await browserExpect(
          page.locator('.metric').filter({ hasText: 'Total order associations' }).locator('strong'),
        ).toHaveText('—');
        await browserExpect(page.getByRole('table')).toHaveCount(0);
        f.complete();
        await page.getByRole('button', { name: 'Try again', exact: true }).click();
        await browserExpect(page.getByRole('table')).toBeVisible();
        expect(f.calls.filter((call) => call.path.endsWith('/orders/history'))).toHaveLength(2);
      } finally {
        await page.close();
      }
    });
    it('does not paint a delayed prior-actor publication after the current operator changes', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'delayed');
        await f.waitForBody();
        await browserExpect(
          page.locator('.metric').filter({ hasText: 'Parent products' }).locator('strong'),
        ).toHaveText('42');
        await page.getByRole('button', { name: 'Fixture switch operator' }).click();
        await f.release();
        await browserExpect(page.getByRole('alert')).toBeVisible();
        await browserExpect(page.getByRole('table')).toHaveCount(0);
        await browserExpect(
          page.locator('.metric').filter({ hasText: 'Total order associations' }).locator('strong'),
        ).toHaveText('—');
      } finally {
        await page.close();
      }
    });
    it('retains the source user-type restriction without issuing any metric request', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'franchise');
        await browserExpect(page.getByRole('alert')).toHaveText(
          'This dashboard is available to internal operators.',
        );
        expect(f.calls).toHaveLength(0);
      } finally {
        await page.close();
      }
    });
  },
);
