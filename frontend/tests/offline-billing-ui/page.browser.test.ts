import { afterAll, beforeAll, describe, it } from 'vitest';
import { chromium, expect, type Browser } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

/** The desktop offline billing page in Chromium with a fake bridge (harness.tsx): the resolve
 * dialog's busy state and in-dialog errors, the catalogue truncation notice, and the page's
 * route-level error boundary. Run with OFFLINE_BILLING_BROWSER_TESTS=true. */
describe.skipIf(process.env.OFFLINE_BILLING_BROWSER_TESTS !== 'true')(
  'desktop offline billing page in Chromium',
  { timeout: 30000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        root: fileURLToPath(new URL('../..', import.meta.url)),
        configFile: false,
        cacheDir: '.cache/offline-billing-browser',
        plugins: [react()],
        appType: 'custom',
        logLevel: 'silent',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__offline_billing__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__offline_billing__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/offline-billing-ui/harness.tsx"></script></body></html>',
          );
          response.setHeader('Content-Type', 'text/html');
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Fixture did not bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 30000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });

    it('keeps resolve errors in the dialog and shows the dialog busy while saving', async () => {
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(`${origin}/__offline_billing__`);
      const row = page.getByRole('row').filter({ hasText: 'OFF-12-3-ABCDEF01-1' });
      await row.getByRole('button', { name: 'Resolve' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Order ID from Orders').fill('9001');
      await dialog.getByLabel('Reason').fill('Found the order in Orders');
      await dialog.getByRole('button', { name: 'Save decision' }).click();
      // The main process refused: the message is shown inside the dialog, which stays open.
      await expect(dialog.getByRole('alert')).toHaveText('A store manager must be signed in.');
      // Only the dialog's alert: the page shows no copy of the error behind the dialog.
      expect(await page.getByRole('alert').count()).toBe(1);

      await page.evaluate(() => (window.offlineHarness.resolve = 'hold'));
      await dialog.getByRole('button', { name: 'Save decision' }).click();
      const saving = dialog.getByRole('button', { name: 'Saving…' });
      await expect(saving).toBeDisabled();
      await expect(saving).toHaveAttribute('aria-busy', 'true');
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
      // Not dismissible while saving: Escape does not close it.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await page.evaluate(() => window.offlineHarness.release());
      await expect(dialog).toHaveCount(0);
      await expect(row.getByText('Synced')).toBeVisible();
      await page.close();
    });

    it('shows a truncated catalogue on the status strip', async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/__offline_billing__`);
      // The strip is relevant (a sale needs a manager) and carries the truncation notice.
      await expect(page.getByText(/only part of the store’s catalogue/)).toBeVisible();
      await page.close();
    });

    it('contains a rendering failure in the page boundary and recovers in place', async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/__offline_billing__?crash=1`);
      const fallback = page.getByRole('alert');
      await expect(fallback).toContainText('Offline billing could not be shown.');
      await expect(fallback).toContainText('stay on this device');
      await expect(fallback.getByRole('button', { name: 'Try again' })).toBeVisible();
      await page.close();
    });
  },
);
