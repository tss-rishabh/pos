import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as be, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'actual return/exchange manager date controls',
  { timeout: 15000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = mkdtempSync(join(tmpdir(), 'pos-return-window-browser-'));
      server = await createServer({
        configFile: false,
        cacheDir: cache,
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__return-window-test__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__return-window-test__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/return-window/harness.tsx"></script></body></html>',
          );
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Loopback fixture did not bind');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cache) rmSync(cache, { recursive: true, force: true });
    });
    async function fixture(page: Page) {
      page.setDefaultTimeout(6000);
      const state = {
        date: null as string | null,
        active: false,
        revision: 'a'.repeat(64),
        closed: true,
        drop: false,
        stale: false,
        wrongLine: false,
        puts: [] as { actor: string; body: Record<string, unknown> }[],
        gets: [] as string[],
        hold: false,
        seen: false,
        release: () => {},
      };
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          actor = request.headers()['x-operator-id'] ?? '';
        const json = (value: unknown, status = 200) =>
          route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        if (url.pathname.endsWith('/return-window')) {
          if (request.method() === 'GET') state.gets.push(actor);
          else {
            state.puts.push({ actor, body: request.postDataJSON() as Record<string, unknown> });
            state.seen = true;
            if (state.hold)
              await new Promise<void>((yes) => {
                state.release = yes;
              });
            if (state.stale) {
              state.stale = false;
              state.date = '2026-12-20';
              state.active = true;
              state.revision = 'c'.repeat(64);
              return json(
                {
                  error: {
                    code: 'RETURN_EXTENSION_CHANGED',
                    message: 'Read the current recorded date.',
                  },
                },
                409,
              );
            }
            state.date = String((request.postDataJSON() as { date: string }).date);
            state.active = true;
            state.closed = false;
            state.revision = 'b'.repeat(64);
            if (state.drop) {
              state.drop = false;
              await route.abort('failed');
              return;
            }
          }
          return json({
            orderId: '100',
            lineId: state.wrongLine ? '1001' : '1000',
            productId: '123',
            date: state.date,
            active: state.active,
            revision: state.revision,
            today: '2026-11-18',
            windowClosed: state.closed,
          });
        }
        if (url.pathname.endsWith('/exchange-recovery'))
          return json({ revision: 'f'.repeat(64), state: 'none', operation: null, newSize: null });
        if (url.pathname.endsWith('/return-eligibility')) {
          // A closed return window: show.html offers the manager "Extend Date" button.
          const closed = { status: false, reason: 'Return window closed', upto: null };
          const facts = {
            variant: 'store',
            shopifyOrder: false,
            eligibilityLoaded: true,
            productType: 1,
            lineStatus: 'DELIVERED',
            return: closed,
            exchange: { status: false, reason: '', upto: null },
            superAdminReturnOverride: false,
            failedExchange: null,
            checkinStoreId: '1',
            exchangeFeatureEnabled: true,
            operatorRole: 3,
            returnStatus: 0,
            merged: false,
          };
          return json({
            orderId: '100',
            lineId: '1000',
            kind: 'return',
            allowed: false,
            until: null,
            reason: closed.reason,
            overrideAvailable: false,
            exchangeFeatureEnabled: true,
            facts,
            cell: {
              branch: 'split',
              notice: null,
              parts: [],
              returnBranch: 'reason',
              exchangeBranch: 'not-applicable',
            },
          });
        }
        if (url.pathname.endsWith('/return-lines'))
          return json({
            data: [
              {
                id: '1000',
                productId: '123',
                name: 'Synthetic shirt',
                parentId: '50',
                quantity: '1',
                status: 'DELIVERED',
                returnStatus: 0,
              },
            ],
            nextCursor: null,
          });
        if (url.pathname.endsWith('/refund-preview'))
          return json({ pay_mode: 'other', pay_amt: 10, is_exchange_order: false });
        return json({ data: [], nextCursor: null });
      });
      return state;
    }
    async function select(page: Page, query = '') {
      await page.goto(origin + '/__return-window-test__' + query);
      await page.getByRole('button', { name: /Synthetic shirt/ }).click();
    }
    async function prepare(page: Page, date = '2026-12-01') {
      await page.getByRole('button', { name: /^(Extend|Change) return date$/ }).click();
      await page.getByLabel('Return through date').fill(date);
      await page.getByLabel('I request this return date for the selected item.').check();
    }
    it('both return and exchange screens bind exact line/date and Cancel changes no saved state', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await select(page);
        await prepare(page);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(state.puts).toHaveLength(0);
        await prepare(page);
        await page.getByRole('button', { name: 'Save return date' }).click();
        await be(page.getByText('Return date saved.')).toBeVisible();
        expect(state.puts).toEqual([
          {
            actor: '1',
            body: {
              counterId: '2',
              productId: '123',
              date: '2026-12-01',
              expectedRevision: 'a'.repeat(64),
            },
          },
        ]);
        await page.getByRole('button', { name: 'Exchange', exact: true }).click();
        await page.getByRole('button', { name: /Synthetic shirt/ }).click();
        await be(page.getByText('Recorded through 2026-12-01, 23:59:59.')).toBeVisible();
        await prepare(page, '2026-11-18');
        await page.getByRole('button', { name: 'Save return date' }).click();
        await be(page.getByText('Recorded through 2026-11-18, 23:59:59.')).toBeVisible();
        expect(state.puts).toHaveLength(2);
      } finally {
        await page.close();
      }
    });
    it('lost committed reply and reload recover by GET only without a second mutation', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.drop = true;
        await select(page);
        await prepare(page);
        await page.getByRole('button', { name: 'Save return date' }).click();
        await be(page.getByText(/save outcome is unconfirmed/)).toBeVisible();
        await be(page.getByRole('button', { name: 'Save return date' })).toBeDisabled();
        await page.getByRole('button', { name: 'Read recorded date' }).click();
        await be(page.getByText('Recorded through 2026-12-01, 23:59:59.')).toBeVisible();
        await page.reload();
        await page.getByRole('button', { name: /Synthetic shirt/ }).click();
        await be(page.getByText('Recorded through 2026-12-01, 23:59:59.')).toBeVisible();
        expect(state.puts).toHaveLength(1);
        expect(state.gets.length).toBeGreaterThanOrEqual(3);
      } finally {
        await page.close();
      }
    });
    it('CAS conflict requires an explicit read and renewed attestation', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.stale = true;
        await select(page);
        await prepare(page);
        await page.getByRole('button', { name: 'Save return date' }).click();
        await be(page.getByText(/save outcome is unconfirmed/)).toBeVisible();
        await page.getByRole('button', { name: 'Read recorded date' }).click();
        await be(page.getByText('Recorded through 2026-12-20, 23:59:59.')).toBeVisible();
        await be(page.getByRole('button', { name: 'Save return date' })).toBeDisabled();
        await page.getByLabel('I request this return date for the selected item.').check();
        await page.getByRole('button', { name: 'Save return date' }).click();
        await be(page.getByText('Return date saved.')).toBeVisible();
        expect(state.puts[1]?.body.expectedRevision).toBe('c'.repeat(64));
      } finally {
        await page.close();
      }
    });
    it('cashiers have no extension route requests and a currently open window has no new action', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await select(page, '?cashier=true');
        await be(page.getByRole('heading', { name: 'Return Synthetic shirt' })).toBeVisible();
        expect(state.gets).toHaveLength(0);
        await be(page.getByRole('button', { name: 'Extend return date' })).toHaveCount(0);
      } finally {
        await page.close();
      }
      const manager = await browser.newPage();
      try {
        const state = await fixture(manager);
        state.closed = false;
        await select(manager);
        await be(manager.getByText('No active extended date is recorded.')).toBeVisible();
        await be(manager.getByRole('button', { name: 'Extend return date' })).toHaveCount(0);
      } finally {
        await manager.close();
      }
    });
    it('a response for a different line cannot be displayed as a saved date', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.wrongLine = true;
        await select(page);
        await be(page.getByText(/did not match the selected item/)).toBeVisible();
        expect(state.puts).toHaveLength(0);
        await be(page.getByRole('button', { name: 'Extend return date' })).toHaveCount(0);
      } finally {
        await page.close();
      }
    });
  },
);
