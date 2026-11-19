import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

// Controlled transport race tests of the mounted production CounterPage, not native API parity.
describe.skipIf(process.env.COUNTER_BARCODE_BROWSER_TESTS !== 'true')('counter scan races', () => {
  let server: ViteDevServer, browser: Browser, origin: string;
  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      cacheDir: 'node_modules/.vite-counter-scan',
      plugins: [react()],
      appType: 'custom',
      server: { host: '127.0.0.1', port: 0, hmr: false },
      logLevel: 'silent',
    });
    server.middlewares.use(async (request, response, next) => {
      if (request.url?.split('?')[0] !== '/__counter_scan__') return next();
      try {
        response.setHeader('Content-Type', 'text/html');
        response.end(
          await server.transformIndexHtml(
            '/__counter_scan__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/counter-catalog/browser-entry.tsx"></script></body></html>',
          ),
        );
      } catch (error) {
        next(error);
      }
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind.');
    origin = `http://127.0.0.1:${address.port}`;
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      (process.platform === 'darwin' && existsSync(mac) ? mac : undefined);
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
  }, 20000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });
  for (const outcome of ['success', 'not-found', 'switch-sale'] as const) {
    it(`binds captured scan through ${outcome} without stale fuzzy add or duplicate dispatch`, async () => {
      const context = await browser.newContext({ serviceWorkers: 'block' }),
        page = await context.newPage();
      const stale = {
        id: '10',
        parentId: '9',
        name: 'Previous fuzzy result',
        erpName: '',
        barcode: '111',
        type: '1',
        price: '25',
        specialPrice: '25',
        exclusivePrice: null,
        stock: 5,
        gst: 5,
        image: null,
      };
      let scans = 0,
        mutations = 0,
        release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await page.route('**/api/v1/**', async (route) => {
          const request = route.request(),
            path = new URL(request.url()).pathname;
          if (request.method() !== 'GET') mutations++;
          if (path.includes('/by-barcode/')) {
            scans++;
            expect(path.endsWith('/222')).toBe(true);
            await gate;
            await route.fulfill(
              outcome === 'not-found'
                ? {
                    status: 404,
                    json: { error: { code: 'BARCODE_NOT_FOUND', message: 'Barcode not found.' } },
                  }
                : {
                    json: {
                      matchedBarcode: '222',
                      product: {
                        ...stale,
                        id: '20',
                        name: 'Exact scanned product',
                        barcode: '999',
                      },
                    },
                  },
            );
          } else if (path.endsWith('/catalog/products'))
            await route.fulfill({ json: { data: [stale], nextCursor: null } });
          else await route.fulfill({ json: { quote: null } });
        });
        await page.goto(origin + '/__counter_scan__');
        const input = page.getByRole('textbox', { name: 'Search products or scan a barcode' });
        await browserExpect(
          page.getByRole('button', { name: 'Add Previous fuzzy result to sale' }),
        ).toBeVisible();
        await browserExpect(
          page.getByRole('link', { name: 'View details for Previous fuzzy result' }),
        ).toHaveAttribute('href', '/catalog/products/9');
        await browserExpect(
          page.getByRole('link', { name: 'Troubleshoot Previous fuzzy result', exact: true }),
        ).toHaveCount(0);
        await input.fill('222');
        await input.press('Enter');
        await browserExpect(input).toBeDisabled();
        await browserExpect.poll(() => scans).toBe(1);
        // Deliberate synthetic second Enter reaches the handler even though a real disabled input cannot.
        await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
        expect(scans).toBe(1);
        if (outcome === 'switch-sale')
          await page.getByRole('button', { name: 'New sale', exact: true }).click();
        release!();
        await browserExpect(input).toBeEnabled();
        if (outcome === 'success') {
          await browserExpect(
            page.getByText('Exact scanned product', { exact: true }),
          ).toBeVisible();
          await browserExpect(page.getByText('Previous fuzzy result', { exact: true })).toHaveCount(
            1,
          );
        } else if (outcome === 'not-found')
          // The message, followed by the request reference shown beside errors (80b43d4f).
          await browserExpect(page.getByRole('alert')).toHaveText(
            /^Barcode not found\.(?:Reference [0-9a-f-]{36})?$/,
          );
        if (outcome === 'success')
          await browserExpect(
            page.getByRole('link', { name: 'Exact scanned product', exact: true }),
          ).toHaveAttribute('href', '/catalog/products/9');
        // Inspect only the synthetic local drafts; no financial HTTP is dispatched.
        const lines = await page.evaluate(() => window.counterScanFixtureLines());
        expect(lines.flat()).toEqual(
          outcome === 'success' ? [{ productId: '20', quantity: 1, barcode: '999' }] : [],
        );
        expect(scans).toBe(1);
        expect(mutations).toBe(0);
      } finally {
        release?.();
        await context.close();
      }
    });
  }
  it('exposes existing safe troubleshooting for eligible administrators without firing a repair', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    let mutations = 0;
    try {
      await page.route('**/api/v1/**', async (route) => {
        if (route.request().method() !== 'GET') mutations++;
        await route.fulfill({
          json: {
            data: [
              {
                id: '21',
                parentId: '9',
                name: 'Eligible product',
                erpName: '',
                barcode: '111',
                type: '1',
                price: '25',
                specialPrice: '25',
                exclusivePrice: null,
                stock: 5,
                gst: 5,
                image: null,
              },
              {
                id: '22',
                parentId: '9',
                name: 'Out of stock product',
                erpName: '',
                barcode: '222',
                type: '1',
                price: '25',
                specialPrice: '25',
                exclusivePrice: null,
                stock: 0,
                gst: 5,
                image: null,
              },
              {
                id: '23',
                parentId: '9',
                name: 'Missing barcode product',
                erpName: '',
                barcode: null,
                type: '1',
                price: '25',
                specialPrice: '25',
                exclusivePrice: null,
                stock: 5,
                gst: 5,
                image: null,
              },
            ],
            nextCursor: null,
          },
        });
      });
      await page.goto(origin + '/__counter_scan__?role=1');
      const link = page.getByRole('link', { name: 'Troubleshoot Eligible product', exact: true });
      await browserExpect(link).toHaveAttribute(
        'href',
        '/catalog/products/21#product-troubleshooting',
      );
      await browserExpect(link).toHaveAttribute('target', '_blank');
      await browserExpect(
        page.getByRole('link', { name: 'Troubleshoot Out of stock product', exact: true }),
      ).toHaveCount(0);
      await browserExpect(
        page.getByRole('link', { name: 'Troubleshoot Missing barcode product', exact: true }),
      ).toHaveCount(0);
      expect(mutations).toBe(0);
    } finally {
      await context.close();
    }
  });
  it('direct quantity buffers blanks, validates integers, preserves buttons and removes only explicit zero', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await page.route('**/api/v1/**', (route) =>
        route.fulfill({
          json: {
            data: [
              {
                id: '31',
                parentId: '9',
                name: 'Quantity product',
                erpName: '',
                barcode: '111',
                type: '1',
                price: '25',
                specialPrice: '25',
                exclusivePrice: null,
                stock: 100,
                gst: 5,
                image: null,
              },
            ],
            nextCursor: null,
          },
        }),
      );
      await page.goto(origin + '/__counter_scan__');
      await page.getByRole('button', { name: 'Add Quantity product to sale', exact: true }).click();
      const quantity = page.getByRole('textbox', {
        name: 'Quantity Quantity product',
        exact: true,
      });
      await browserExpect(quantity).toHaveValue('1');
      await quantity.fill('');
      await quantity.press('Tab');
      await browserExpect(quantity).toHaveValue('1');
      await quantity.fill('1.5');
      await quantity.press('Enter');
      await browserExpect(
        page.getByText('Enter a whole quantity from 0 to 999.', { exact: true }),
      ).toBeVisible();
      expect(
        (await page.evaluate(() => window.counterScanFixtureLines())).flat()[0]?.quantity,
      ).toBe(1);
      await quantity.fill('25');
      await quantity.press('Enter');
      await browserExpect(quantity).toHaveValue('25');
      await page.getByRole('button', { name: 'Increase Quantity product', exact: true }).click();
      await browserExpect(quantity).toHaveValue('26');
      await quantity.fill('0');
      await quantity.press('Enter');
      await browserExpect(quantity).toHaveCount(0);
      expect((await page.evaluate(() => window.counterScanFixtureLines())).flat()).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
