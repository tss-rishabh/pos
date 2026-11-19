import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

describe.skipIf(process.env.CHECKOUT_ACTIONS_BROWSER_TESTS !== 'true')(
  'checkout quote and complementary controls',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        configFile: false,
        cacheDir: 'node_modules/.vite-checkout-actions',
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0, hmr: false },
        logLevel: 'silent',
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__checkout_actions__') return next();
        try {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            await server.transformIndexHtml(
              '/__checkout_actions__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/checkout-actions/browser-entry.tsx"></script></body></html>',
            ),
          );
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Checkout fixture did not bind.');
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
    for (const mode of [
      'normal',
      'missing',
      'payable-only',
      'stale',
      'cashback',
      'ineligible',
      'wrong-customer',
      'remove',
    ] as const) {
      it(`renders source quote controls through ${mode} without financial recomputation`, async () => {
        const context = await browser.newContext({ serviceWorkers: 'block' }),
          page = await context.newPage();
        let mutations = 0,
          benefitReads = 0;
        try {
          await page.route('**/api/v1/**', async (route) => {
            const req = route.request();
            if (req.method() !== 'GET') mutations++;
            if (new URL(req.url()).pathname.endsWith('/customer-benefits')) {
              benefitReads++;
              expect(req.headers()['x-operator-id']).toBe('1');
              await route.fulfill({
                json: {
                  customerId: mode === 'wrong-customer' ? '12' : '11',
                  checkoutVersion: 1,
                  membership: { active: mode === 'cashback', expiry: null, message: '' },
                  wallet: { money: '0.00', points: '0.00' },
                  app: { isAppUser: true, discountEligible: mode !== 'ineligible' },
                  activeGiftVoucherCount: '0',
                  customerSince: null,
                  fetchedAt: new Date().toISOString(),
                },
              });
            } else
              await route.fulfill({
                status: 404,
                json: {
                  error: { code: 'FIXTURE_UNEXPECTED_READ', message: 'Unexpected fixture read.' },
                },
              });
          });
          await page.goto(origin + '/__checkout_actions__?mode=' + mode);
          const summary = page.getByRole('region', { name: 'Quote breakdown' });
          if (mode === 'stale') {
            // W27: a stale quote shows no breakdown at all (no placeholder, no stale amounts).
            await browserExpect(page.getByRole('link', { name: 'Quoted shirt' })).toBeVisible();
            await browserExpect(summary).toHaveCount(0);
            await browserExpect(page.getByText('₹868.49', { exact: true })).toHaveCount(0);
          } else if (mode === 'payable-only') {
            // Only the payable is known: no breakdown (the dialog shows the payable alone).
            await browserExpect(page.getByRole('link', { name: 'Quoted shirt' })).toBeVisible();
            await browserExpect(summary).toHaveCount(0);
          } else await browserExpect(summary).toBeVisible();
          // W27: no placeholder text anywhere; values the quote does not carry are not shown.
          await browserExpect(page.getByText(/Unavailable/)).toHaveCount(0);
          if (mode === 'stale' || mode === 'payable-only') {
            // Checked above.
          } else if (mode === 'missing') {
            await browserExpect(summary.getByText('Cart Total', { exact: true })).toHaveCount(0);
            await browserExpect(summary.getByText('GST (included in cart total)')).toHaveCount(0);
            await browserExpect(summary.getByText('₹0.00', { exact: true })).toHaveCount(0);
            // The deduction sign applies to the number only.
            await browserExpect(summary.getByText('-₹0.49', { exact: true })).toBeVisible();
            await browserExpect(summary.getByText('₹868.00', { exact: true })).toBeVisible();
          } else {
            await browserExpect(summary.getByText('₹999.99', { exact: true })).toBeVisible();
            await browserExpect(summary.getByText('₹868.49', { exact: true })).toBeVisible();
            await browserExpect(summary.getByText('₹868.00', { exact: true })).toBeVisible();
          }
          const remove = page.getByRole('button', {
            name: 'Remove complimentary Complimentary bag',
            exact: true,
          });
          await browserExpect(
            page.getByRole('link', { name: 'Quoted shirt', exact: true }),
          ).toHaveAttribute('href', '/catalog/products/9');
          await browserExpect(
            page.getByRole('link', { name: 'Complimentary bag', exact: true }),
          ).toHaveAttribute('href', '/catalog/products/9007199254740995');
          if (mode === 'stale' || mode === 'payable-only') {
            await browserExpect(summary).toHaveCount(0);
            if (mode === 'stale') await browserExpect(remove).toBeDisabled();
          } else if (mode === 'cashback') {
            await browserExpect(
              summary.getByText('Cashback Earned (₹)', { exact: true }),
            ).toBeVisible();
            await browserExpect(summary.getByText('₹20.49', { exact: true })).toBeVisible();
            await browserExpect(
              // Legacy label (create_order.html; 3cd0da5d).
              summary.getByText('Membership Savings', { exact: true }),
            ).toBeVisible();
            await browserExpect(
              summary.getByText('Fixture configured cashback timing.', { exact: true }),
            ).toBeVisible();
          } else if (mode === 'ineligible' || mode === 'wrong-customer') {
            if (mode === 'ineligible')
              await browserExpect(summary.getByText('Discount', { exact: true })).toBeVisible();
            else
              // Unconfirmed membership: the savings row says so; no eligibility placeholder.
              await browserExpect(
                summary.getByText('Total savings (membership unconfirmed)', { exact: true }),
              ).toBeVisible();
            await browserExpect(
              summary.getByText('Cashback Earned (₹)', { exact: true }),
            ).toHaveCount(0);
          } else if (mode === 'remove') {
            await remove.click();
            await browserExpect(page.getByRole('status', { name: 'Recorded commands' })).toHaveText(
              JSON.stringify([
                { path: 'line-items/9007199254740995', method: 'PUT', body: { quantity: 0 } },
              ]),
            );
            // The removal invalidates the quote: its breakdown disappears until a new quote.
            await browserExpect(summary).toHaveCount(0);
            await browserExpect(remove).toBeDisabled();
          }
          expect(mutations).toBe(0);
          if (['cashback', 'ineligible', 'wrong-customer'].includes(mode))
            expect(benefitReads).toBe(1);
        } finally {
          await context.close();
        }
      });
    }
  },
);
