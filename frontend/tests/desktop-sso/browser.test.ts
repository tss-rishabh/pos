import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

describe.skipIf(process.env.DESKTOP_SSO_BROWSER_TESTS !== 'true')(
  'desktop Google pairing through isolated Chromium',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        configFile: false,
        cacheDir: 'node_modules/.vite-desktop-sso-tests',
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0, hmr: false },
        logLevel: 'silent',
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__desktop-sso__') return next();
        try {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            await server.transformIndexHtml(
              '/__desktop-sso__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/desktop-sso/browser-entry.tsx"></script></body></html>',
            ),
          );
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Desktop SSO fixture could not bind.');
      origin = `http://127.0.0.1:${address.port}`;
      const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : process.platform === 'darwin' && existsSync(mac)
            ? { executablePath: mac }
            : {}),
      });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });
    async function workspace(
      options: {
        lost?: boolean;
        refreshFailure?: boolean;
        approval?: boolean;
        lostApproval?: boolean;
        badUrl?: boolean;
      } = {},
    ) {
      const context = await browser.newContext({
        serviceWorkers: 'block',
        userAgent: 'Fixture Chromium Electron/45.3.2',
      });
      const page = await context.newPage();
      const id = 'a53b9ec4-76ce-4641-95d5-7d3f4f073ab4',
        ticket = 'b'.repeat(43);
      const expires = Date.now() + 600000;
      const user = {
        id: '7',
        role: 4,
        userType: 1,
        name: 'Fixture operator',
        email: 'operator@example.test',
        storeIds: ['1'],
      };
      let phase: 'pending' | 'authorized' | 'consumed' | 'cancelled' = 'pending',
        approved = false,
        refreshFailure = Boolean(options.refreshFailure);
      const requests: { method: string; path: string }[] = [],
        errors: string[] = [];
      let consumptions = 0;
      page.on('pageerror', (error) => errors.push(error.name));
      await page.route('**/api/v1/**', async (route) => {
        const path = new URL(route.request().url()).pathname,
          method = route.request().method();
        requests.push({ method, path });
        if (path === '/api/v1/auth/capabilities') {
          await route.fulfill({
            json: { password: true, sso: true, desktopSso: true, demo: false },
          });
          return;
        }
        if (path === '/api/v1/auth/challenges/current') {
          await route.fulfill({
            status: 401,
            json: { error: { code: 'AUTH_REQUIRED', message: 'Sign in.' } },
          });
          return;
        }
        if (path === '/api/v1/auth/desktop-sso-sessions') {
          expect(method).toBe('POST');
          expect(route.request().postDataJSON() as unknown).toEqual({});
          await route.fulfill({
            json: {
              id,
              code: '123456',
              expires,
              browserUrl:
                (options.badUrl ? 'https://attacker.example.test' : origin) +
                `/api/v1/auth/sso/login?desktop=${id}&ticket=${ticket}`,
            },
          });
          return;
        }
        if (path === `/api/v1/auth/desktop-sso-sessions/${id}`) {
          expect(method).toBe('GET');
          expect(route.request().headers()['x-pos-desktop-sso-proof']).toBeUndefined();
          await route.fulfill({ json: { status: phase, expires } });
          return;
        }
        if (path === `/api/v1/auth/desktop-sso-sessions/${id}/consumptions`) {
          expect(method).toBe('POST');
          expect(route.request().headers()['x-pos-desktop-sso-proof']).toBeUndefined();
          consumptions++;
          phase = 'consumed';
          if (options.lost && consumptions === 1) {
            await route.abort('failed');
            return;
          }
          await route.fulfill({ json: { user, sessionExpiresAt: Date.now() + 3600000 } });
          return;
        }
        if (path === `/api/v1/auth/desktop-sso-sessions/${id}/cancellations`) {
          phase = 'cancelled';
          await route.fulfill({ json: { cancelled: true } });
          return;
        }
        if (path === '/api/v1/auth/sessions/current') {
          if (refreshFailure) {
            await route.abort('failed');
            return;
          }
          await route.fulfill({ json: { user, sessionExpiresAt: Date.now() + 3600000 } });
          return;
        }
        if (path === '/api/v1/auth/desktop-sso/approval') {
          if (method === 'POST') {
            expect(route.request().postDataJSON() as unknown).toEqual({ code: '123456' });
            approved = true;
            if (options.lostApproval) {
              await route.abort('failed');
              return;
            }
            await route.fulfill({ json: { approved: true } });
            return;
          }
          await route.fulfill({ json: { user, expires, approved } });
          return;
        }
        throw new Error('Unexpected desktop SSO fixture resource: ' + path);
      });
      await page.goto(origin + '/__desktop-sso__' + (options.approval ? '?approval=true' : ''));
      return {
        context,
        page,
        requests,
        errors,
        authorize: () => {
          phase = 'authorized';
        },
        refresh: () => {
          refreshFailure = false;
        },
        consumptions: () => consumptions,
      };
    }
    it('opens only the app handoff link, pairs a desktop session and blocks competing password input', async () => {
      const value = await workspace();
      try {
        await value.page.getByRole('button', { name: 'Continue with Google' }).click();
        await browserExpect(value.page.getByLabel('Desktop pairing code')).toHaveText('123456');
        await browserExpect(value.page.getByLabel('Password', { exact: true })).toBeDisabled();
        const opened = await value.page.evaluate(() => window.desktopSsoFixture.opened);
        expect(opened).toHaveLength(1);
        const target = new URL(opened[0]!);
        expect(target.origin).toBe(origin);
        expect([...target.searchParams.keys()].sort()).toEqual(['desktop', 'ticket']);
        value.authorize();
        await value.page.getByRole('button', { name: 'Check sign-in', exact: true }).click();
        await browserExpect(value.page.getByText('Signed in as Fixture operator')).toBeVisible();
        expect(value.consumptions()).toBe(1);
        expect(value.errors).toEqual([]);
      } finally {
        await value.context.close();
      }
    });
    it('polls unknown consumption with GET only and recovers explicitly using the saved proof', async () => {
      const value = await workspace({ lost: true });
      try {
        await value.page.getByRole('button', { name: 'Continue with Google' }).click();
        await browserExpect(value.page.getByLabel('Desktop pairing code')).toBeVisible();
        value.authorize();
        await value.page.getByRole('button', { name: 'Check sign-in', exact: true }).click();
        await browserExpect(
          value.page.getByRole('button', { name: 'Recover sign-in' }),
        ).toBeVisible();
        for (let index = 0; index < 3; index++)
          await value.page.getByRole('button', { name: 'Check sign-in', exact: true }).click();
        expect(value.consumptions()).toBe(1);
        await value.page.getByRole('button', { name: 'Recover sign-in' }).click();
        await browserExpect(value.page.getByText('Signed in as Fixture operator')).toBeVisible();
        expect(value.consumptions()).toBe(2);
      } finally {
        await value.context.close();
      }
    });
    it('uses only session refresh after known consumption and supports explicit cancellation', async () => {
      const value = await workspace({ refreshFailure: true });
      try {
        await value.page.getByRole('button', { name: 'Continue with Google' }).click();
        await browserExpect(value.page.getByLabel('Desktop pairing code')).toBeVisible();
        value.authorize();
        await value.page.getByRole('button', { name: 'Check sign-in', exact: true }).click();
        await browserExpect(
          value.page.getByRole('button', { name: 'Finish sign-in' }),
        ).toBeVisible();
        value.refresh();
        await value.page.getByRole('button', { name: 'Finish sign-in' }).click();
        await browserExpect(value.page.getByText('Signed in as Fixture operator')).toBeVisible();
        expect(value.consumptions()).toBe(1);
      } finally {
        await value.context.close();
      }
      const cancelled = await workspace();
      try {
        await cancelled.page.getByRole('button', { name: 'Continue with Google' }).click();
        await browserExpect(cancelled.page.getByLabel('Desktop pairing code')).toBeVisible();
        await cancelled.page.getByRole('button', { name: 'Cancel sign-in' }).click();
        await browserExpect(cancelled.page.getByLabel('Password', { exact: true })).toBeEnabled();
        expect(cancelled.consumptions()).toBe(0);
      } finally {
        await cancelled.context.close();
      }
    });
    it('rejects a foreign browser link before any OS-open request', async () => {
      const value = await workspace({ badUrl: true });
      try {
        await value.page.getByRole('button', { name: 'Continue with Google' }).click();
        await browserExpect(
          value.page.getByText('The desktop sign-in link could not be verified.'),
        ).toBeVisible();
        expect(await value.page.evaluate(() => window.desktopSsoFixture.opened)).toEqual([]);
      } finally {
        await value.context.close();
      }
    });
    it('shows the verified browser identity and confirms a lost approval reply through GET', async () => {
      const value = await workspace({ approval: true, lostApproval: true });
      try {
        await browserExpect(
          value.page.getByText('operator@example.test', { exact: false }),
        ).toBeVisible();
        await value.page.getByLabel('Desktop pairing code').fill('123456');
        await value.page.getByRole('button', { name: 'Approve desktop sign-in' }).click();
        await value.page.getByRole('button', { name: 'Check approval' }).click();
        await browserExpect(
          value.page.getByText('Sign-in approved. Return to Souled POS.'),
        ).toBeVisible();
        expect(
          value.requests.filter(
            (entry) => entry.method === 'POST' && entry.path.endsWith('/approval'),
          ),
        ).toHaveLength(1);
        expect(value.errors).toEqual([]);
      } finally {
        await value.context.close();
      }
    });
  },
);
