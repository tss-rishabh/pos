import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';
import { prepareBrowserFixture } from '../../prepare-browser-fixture';

describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'inherited account create/recovery components in isolated Chromium',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = await mkdtemp(join(tmpdir(), 'pos-model-account-browser-'));
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
        if (request.url?.split('?')[0] !== '/__model_accounts__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__model_accounts__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/administration/model-accounts/harness.tsx"></script></body></html>',
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
        throw new Error('Model account browser fixture did not bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
      await prepareBrowserFixture(browser, async (page) => {
        await fixture(page);
        await browserExpect(
          page.getByRole('button', { name: 'Create administrative account', exact: true }),
        ).toBeVisible();
        await server.waitForRequestsIdle();
      });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cache) await rm(cache, { recursive: true, force: true });
    });
    async function fixture(
      page: Page,
      mode: 'normal' | 'lost' | 'missing' | 'delayed' | 'mismatch' | 'denied' = 'normal',
    ) {
      page.setDefaultTimeout(6000);
      const bodySchema = z
          .object({
            operationId: z.uuid(),
            username: z.string(),
            password: z.string(),
            confirmation: z.string(),
          })
          .strict(),
        posts: z.infer<typeof bodySchema>[] = [],
        calls: { method: string; actor: string; path: string }[] = [],
        saved = new Map<
          string,
          {
            id: string;
            actorId: string;
            operationId: string;
            status: 'success';
            message: 'Administrative account created.';
          }
        >();
      let release: (() => Promise<void>) | undefined;
      await page.route('**/api/v1/**', async (route) => {
        const req = route.request(),
          url = new URL(req.url()),
          actor = req.headers()['x-operator-id'] || '';
        calls.push({ method: req.method(), actor, path: url.pathname + url.search });
        const base = '/api/v1/admin/operator-model-accounts';
        if (url.pathname === base + '/capabilities') {
          if (mode === 'denied') {
            await route.fulfill({
              status: 403,
              json: {
                error: {
                  code: 'ADMIN_PRIVILEGE_MUTATION_DENIED',
                  message: 'Current internal superuser access is required.',
                },
              },
            });
            return;
          }
          await route.fulfill({
            json: {
              canCreate: true,
              defaults: {
                role: 1,
                userType: 1,
                otpMethod: 2,
                active: true,
                staff: false,
                superuser: false,
                mfa: false,
                firstName: '',
                lastName: '',
                email: '',
                phone: null,
                contactEmail: null,
                age: null,
                gender: null,
                lastLogin: null,
              },
            },
          });
          return;
        }
        if (url.pathname === base && req.method() === 'POST') {
          const body = bodySchema.parse(req.postDataJSON() as unknown);
          posts.push(body);
          const value = {
            id: '9007199254740993',
            actorId: actor,
            operationId: body.operationId,
            status: 'success' as const,
            message: 'Administrative account created.' as const,
          };
          if (!(mode === 'missing' && posts.length === 1)) saved.set(body.operationId, value);
          if ((mode === 'lost' || mode === 'missing') && posts.length === 1) {
            await route.abort('failed');
            return;
          }
          const finish = () =>
            route.fulfill({ json: mode === 'mismatch' ? { ...value, actorId: '999999' } : value });
          if (mode === 'delayed') {
            release = finish;
            return;
          }
          await finish();
          return;
        }
        const value = saved.get(url.pathname.split('/').at(-1)!);
        if (value) {
          await route.fulfill({ json: value });
          return;
        }
        await route.fulfill({
          status: 404,
          json: {
            error: {
              code: 'OPERATOR_MODEL_ACCOUNT_NOT_FOUND',
              message: 'The original account operation was not found.',
            },
          },
        });
      });
      await page.goto(origin + '/__model_accounts__');
      return {
        calls,
        posts,
        async release() {
          await release?.().catch(() => undefined);
        },
        async wait() {
          await browserExpect.poll(() => !!release).toBe(true);
        },
      };
    }
    const secret = 'Z8y!p4Nq#23rLt5x';
    async function fill(page: Page) {
      await page.getByLabel('Administrative username', { exact: true }).fill('model-fixture-user');
      await page.getByLabel('New administrative password', { exact: true }).fill(secret);
      await page.getByLabel('Confirm administrative password', { exact: true }).fill(secret);
    }
    async function storage(page: Page) {
      return page.evaluate(() =>
        Object.entries(localStorage).filter(([key]) => key.startsWith('pos-model-account-v1:')),
      );
    }
    it('submits only the source three fields plus UUID and clears passwords after dispatch with an exact large-ID receipt', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page);
        await fill(page);
        await page
          .getByRole('button', { name: 'Create administrative account', exact: true })
          .click();
        await browserExpect(page.getByRole('status')).toContainText('9007199254740993');
        expect(Object.keys(f.posts[0]!).sort()).toEqual([
          'confirmation',
          'operationId',
          'password',
          'username',
        ]);
        await browserExpect(
          page.getByLabel('New administrative password', { exact: true }),
        ).toHaveValue('');
        await browserExpect(
          page.getByLabel('Confirm administrative password', { exact: true }),
        ).toHaveValue('');
        expect(await storage(page)).toEqual([]);
        expect(
          f.calls.every(
            (call) =>
              call.actor === '900001' &&
              !call.path.includes('model-fixture-user') &&
              !call.path.includes(secret),
          ),
        ).toBe(true);
      } finally {
        await page.close();
      }
    });
    it('recovers committed lost reply after reload using GET only and persists no username/password/contact material', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'lost');
        await fill(page);
        await page
          .getByRole('button', { name: 'Create administrative account', exact: true })
          .click();
        await browserExpect(
          page.getByRole('button', { name: 'Check original account request', exact: true }),
        ).toBeVisible();
        const values = JSON.stringify(await storage(page));
        expect(values).not.toContain(secret);
        expect(values).not.toContain('model-fixture-user');
        expect(values).not.toContain('confirmation');
        await page.reload();
        await page
          .getByRole('button', { name: 'Check original account request', exact: true })
          .click();
        await browserExpect(page.getByRole('status')).toContainText('9007199254740993');
        expect(f.posts).toHaveLength(1);
        expect(await storage(page)).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('retains404 original UUID across reload and explicit secret re-entry rather than starting a second operation', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'missing');
        await fill(page);
        await page
          .getByRole('button', { name: 'Create administrative account', exact: true })
          .click();
        await browserExpect(
          page.getByRole('button', { name: 'Check original account request', exact: true }),
        ).toBeVisible();
        await page.reload();
        await page
          .getByRole('button', { name: 'Check original account request', exact: true })
          .click();
        await browserExpect(
          page.getByRole('button', { name: 'Retry original account request', exact: true }),
        ).toBeVisible();
        expect(await storage(page)).toHaveLength(1);
        await fill(page);
        await page
          .getByRole('button', { name: 'Retry original account request', exact: true })
          .click();
        await browserExpect(page.getByRole('status')).toContainText('Account created');
        expect(f.posts).toHaveLength(2);
        expect(f.posts[1]?.operationId).toBe(f.posts[0]?.operationId);
      } finally {
        await page.close();
      }
    });
    it('fails before dispatch when durable operation metadata cannot be saved', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page);
        await page.evaluate(() => {
          Storage.prototype.setItem = () => {
            throw new Error('synthetic denied');
          };
        });
        await fill(page);
        await page
          .getByRole('button', { name: 'Create administrative account', exact: true })
          .click();
        await browserExpect(
          page.getByText(
            'Saved account operations are unavailable. Restore browser storage before creating an account.',
            { exact: true },
          ),
        ).toBeVisible();
        expect(f.posts).toHaveLength(0);
      } finally {
        await page.close();
      }
    });
    it('does not accept a different actor/operation receipt or erase original pending evidence', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'mismatch');
        await fill(page);
        await page
          .getByRole('button', { name: 'Create administrative account', exact: true })
          .click();
        await browserExpect(
          page.getByText(
            'The result belongs to a different account operation. Keep the original request for reconciliation.',
            { exact: true },
          ),
        ).toBeVisible();
        expect(await storage(page)).toHaveLength(1);
        expect(
          await page.getByRole('heading', { name: 'Account created', exact: true }).count(),
        ).toBe(0);
        expect(f.posts).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
    it('fences a late create response after current operator switch and retains only its original owner metadata', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'delayed');
        await fill(page);
        await page
          .getByRole('button', { name: 'Create administrative account', exact: true })
          .click();
        await f.wait();
        await page.getByRole('button', { name: 'Fixture switch operator', exact: true }).click();
        await f.release();
        await browserExpect.poll(() => f.calls.some((call) => call.actor === '900002')).toBe(true);
        expect(
          await page.getByRole('heading', { name: 'Account created', exact: true }).count(),
        ).toBe(0);
        expect(
          await page
            .getByRole('button', { name: 'Check original account request', exact: true })
            .count(),
        ).toBe(0);
        expect((await storage(page))[0]?.[0]).toContain(':900001:');
        expect(f.posts).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
    it('keeps inherited privileged fields and create form unavailable after current capability refusal', async () => {
      const page = await browser.newPage();
      try {
        const f = await fixture(page, 'denied');
        await browserExpect(
          page.getByText('Current internal superuser access is required.', { exact: true }),
        ).toBeVisible();
        expect(await page.getByLabel('New administrative password', { exact: true }).count()).toBe(
          0,
        );
        expect(f.posts).toHaveLength(0);
      } finally {
        await page.close();
      }
    });
  },
);
