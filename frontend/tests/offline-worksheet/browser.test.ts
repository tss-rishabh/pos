import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

describe.skipIf(process.env.OFFLINE_WORKSHEET_BROWSER_TESTS !== 'true')(
  'offline worksheet in Chromium',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        root: fileURLToPath(new URL('../..', import.meta.url)),
        configFile: false,
        cacheDir: '.cache/offline-worksheet-browser',
        plugins: [react()],
        appType: 'custom',
        logLevel: 'silent',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__worksheet__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__worksheet__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/offline-worksheet/harness.tsx"></script></body></html>',
          );
          response.setHeader('Content-Type', 'text/html');
          response.setHeader(
            'Content-Security-Policy',
            `default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ${origin.replace('http:', 'ws:')}; style-src 'self' 'unsafe-inline'; object-src 'none'`,
          );
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Worksheet fixture did not bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });
    async function fixture(page: Page) {
      let offline = false;
      const calls: {
        method: string;
        path: string;
        includeOutOfStock: string | null;
        actor: string | undefined;
      }[] = [];
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        calls.push({
          method: request.method(),
          path: url.pathname,
          includeOutOfStock: url.searchParams.get('includeOutOfStock'),
          actor: request.headers()['x-operator-id'],
        });
        if (offline) {
          await route.abort('internetdisconnected');
          return;
        }
        if (url.pathname === '/api/v1/stores/1/catalog/products') {
          const rows = [
            {
              id: '9007199254740993',
              name: 'Synthetic shirt',
              erpName: 'SYNTHETIC',
              barcode: '0012345678901',
              parentId: '1',
              type: '1',
              price: '99.95',
              specialPrice: '99.95',
              exclusivePrice: '0.00',
              stock: 0,
              gst: 18,
              image: null,
            },
            {
              id: '14',
              name: 'Literal <img src=x onerror=alert(1)>',
              erpName: 'SYNTHETIC-TWO',
              barcode: null,
              parentId: '1',
              type: '1',
              price: '20.00',
              specialPrice: '20.00',
              exclusivePrice: '0.00',
              stock: 3,
              gst: 18,
              image: null,
            },
          ];
          const search = url.searchParams.get('search')?.toLowerCase() ?? '';
          await route.fulfill({
            json: {
              data: rows.filter((row) =>
                `${row.name} ${row.barcode} ${row.id}`.toLowerCase().includes(search),
              ),
              nextCursor: null,
            },
          });
          return;
        }
        await route.fulfill({
          status: 404,
          json: {
            error: { code: 'FIXTURE_UNAVAILABLE', message: 'Fixture resource unavailable.' },
          },
        });
      });
      await page.goto(origin + '/__worksheet__');
      await browserExpect(
        page.getByRole('heading', { level: 1, name: /Invoice worksheet/ }),
      ).toBeVisible();
      await browserExpect(
        page.getByLabel('Product', { exact: true }).locator('option'),
      ).toHaveCount(3);
      return {
        calls,
        disconnect() {
          offline = true;
        },
      };
    }
    async function add(page: Page, quantity = '2', price = '25.49') {
      await page.getByLabel('Product', { exact: true }).selectOption('9007199254740993');
      await page.getByLabel('Quantity', { exact: true }).fill(quantity);
      await page.getByLabel('Unit price', { exact: true }).fill(price);
      await page.getByRole('button', { name: 'Add to worksheet', exact: true }).click();
    }
    it('prints and exports manual rows while preserving exact totals and making no sale request', async () => {
      const page = await browser.newPage();
      try {
        const { calls } = await fixture(page);
        await page.getByLabel('Customer name').fill('Synthetic, "label"');
        await page.getByLabel('Customer email').fill('synthetic@example.test');
        await add(page);
        await add(page, '1', '10.01');
        const preview = page.getByRole('article', { name: 'Invoice worksheet preview' });
        await browserExpect(preview.getByRole('row')).toHaveCount(3);
        await browserExpect(preview.locator('dl')).toContainText('₹60.99');
        await page
          .getByRole('button', { name: 'Remove worksheet line Synthetic shirt', exact: true })
          .first()
          .click();
        await browserExpect(preview.getByRole('row')).toHaveCount(2);
        await browserExpect(preview.locator('dl')).toContainText('₹10.01');
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Export invoice.csv', exact: true }).click();
        const download = await downloadPromise,
          path = await download.path();
        expect(download.suggestedFilename()).toBe('invoice.csv');
        if (!path) throw new Error('Worksheet CSV download missing.');
        const content = await readFile(path, 'utf8');
        expect(content).toContain(
          'SerialNo,StoreId,Email,UserName,IsExclusive,ProductId,ProductQty,ProductPrice,TotalProductPrice,TotalPrice,PaymentMode,OrderDate,OrderMessage,OrderPlacedSms',
        );
        expect(content).toContain('"Synthetic, ""label"""');
        expect(content).toContain('9007199254740993,1,10.01,10.01,10.01,cash,');
        await page.evaluate(() => {
          const frame = document.querySelector<HTMLIFrameElement>(
            'iframe[title="Worksheet print document"]',
          );
          if (!frame?.contentWindow) throw new Error('Worksheet frame missing.');
          frame.contentWindow.print = () => Reflect.set(window, 'worksheetPrintCount', 1);
        });
        await page.getByRole('button', { name: 'Print worksheet', exact: true }).click();
        expect(
          await page.evaluate(() => Reflect.get(window, 'worksheetPrintCount') as unknown),
        ).toBe(1);
        const print = page.frameLocator('iframe[title="Worksheet print document"]');
        await browserExpect(
          print.getByText('Draft · Payment not recorded', { exact: true }),
        ).toHaveText('Draft · Payment not recorded');
        await browserExpect(print.getByRole('button')).toHaveCount(0);
        await browserExpect(print.locator('img')).toHaveCount(0);
        expect(
          calls.every(
            (call) =>
              call.method === 'GET' &&
              call.path.endsWith('/catalog/products') &&
              call.includeOutOfStock === 'true' &&
              call.actor === '1',
          ),
        ).toBe(true);
      } finally {
        await page.close();
      }
    }, 20000);
    it('uses cached products offline and clears customer labels when the current operator changes', async () => {
      const page = await browser.newPage();
      try {
        const transport = await fixture(page);
        await page.getByLabel('Customer name').fill('Previous synthetic customer');
        transport.disconnect();
        await page.context().setOffline(true);
        await page.getByLabel('Find a product').fill('Synthetic shirt');
        await browserExpect(page.getByRole('status')).toHaveText(
          'Using products already cached on this device.',
        );
        await add(page, '1', '0.01');
        await browserExpect(page.getByRole('article').locator('dl')).toContainText('₹0.01');
        await page.getByRole('button', { name: 'Switch fixture operator' }).click();
        await browserExpect(page.getByLabel('Customer name')).toHaveValue('');
        await browserExpect(page.getByRole('article')).not.toContainText(
          'Previous synthetic customer',
        );
        await browserExpect(
          page.getByRole('button', { name: 'Export invoice.csv', exact: true }),
        ).toBeDisabled();
      } finally {
        await page.close();
      }
    }, 20000);
  },
);
