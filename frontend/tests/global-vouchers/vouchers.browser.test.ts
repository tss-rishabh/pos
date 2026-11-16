import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';
import { fixtureCheckout } from './fixtures';
import { voucherReceiptSchema, type VoucherReceipt } from '../../src/pages/global-vouchers/api';

const checkoutId = '33333333-3333-4333-8333-333333333333',
  selectionId = '22222222-2222-4222-8222-222222222222';
describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'actual voucher issuance/conversion recovery in Chromium',
  { timeout: 15000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        configFile: false,
        cacheDir: 'node_modules/.vite-global-voucher-tests',
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__global-voucher-test__')) return next();
        try {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            await server.transformIndexHtml(
              '/__global-voucher-test__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/global-vouchers/harness.tsx"></script></body></html>',
            ),
          );
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Voucher fixture failed to bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });
    async function fixture(page: Page) {
      page.setDefaultTimeout(6000);
      const value = {
        dropIssue: false,
        dropConversion: false,
        failRefresh: false,
        rejectPin: false,
        noIssueCommit: false,
        holdConversion: false,
        release: () => undefined as void,
        seen: false,
        issues: 0,
        conversions: 0,
        reads: 0,
        posts: [] as { path: string; actor: string; body: Record<string, unknown> }[],
        operations: new Map<
          string,
          | { status: 'succeeded'; errorCode: null; receipt: VoucherReceipt }
          | { status: 'rejected'; errorCode: 'GIFT_CARD_PIN_INVALID'; receipt: null }
          | { status: 'cancelled'; errorCode: null; receipt: null }
        >(),
      };
      function receipt(operationId: string, kind: 'issuance' | 'conversion', amount: string) {
        return voucherReceiptSchema.parse({
          operationId,
          kind,
          operatorId: '1',
          customerId: '7',
          voucherId: '9007199254740993',
          couponId: '42',
          voucherCode: 'GFVSYNTHETICFIXTURE',
          amount,
          voucherHistoryId: '9007199254740994',
          moneyHistoryId: kind === 'conversion' ? '9007199254740995' : null,
          walletBefore: kind === 'conversion' ? '100.00' : null,
          walletAfter: kind === 'conversion' ? '125.49' : null,
          nonExpiring: true,
          createdAt: '2026-06-15 12:00:00',
          contract: 'pos-global-vouchers-v1',
          valueContract: 'pos-gift-voucher-exact-cents-v1',
          checkoutId: kind === 'conversion' ? checkoutId : null,
          checkoutVersion: kind === 'conversion' ? 2 : null,
          status: 'success',
          message: 'Synthetic success',
        });
      }
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname,
          actor = request.headers()['x-operator-id'] ?? '';
        if (url.search || !['1', '2'].includes(actor))
          return route.fulfill({
            status: 403,
            json: { error: { code: 'FIXTURE_SCOPE', message: 'Synthetic scope rejection' } },
          });
        if (request.method() === 'POST')
          value.posts.push({
            path,
            actor,
            body: z.record(z.string(), z.unknown()).parse(request.postDataJSON() as unknown),
          });
        if (path === '/api/v1/gift-vouchers/capabilities')
          return route.fulfill({
            json: {
              enabled: true,
              conversionEnabled: true,
              exactCents: true,
              nonExpiring: true,
              contract: 'pos-global-vouchers-v1',
            },
          });
        if (path.endsWith('/voucher-conversions/capabilities'))
          return route.fulfill({ json: { enabled: true } });
        if (path === '/api/v1/gift-voucher-customer-lookups')
          return route.fulfill({
            json: {
              selectionId,
              customerId: '7',
              name: 'Fixture Customer',
              expiresAt: Date.now() + 300000,
            },
          });
        if (path === '/api/v1/gift-voucher-issuances') {
          const input = z
            .object({ operationId: z.uuid(), amount: z.string() })
            .parse(request.postDataJSON() as unknown);
          if (value.noIssueCommit) {
            value.noIssueCommit = false;
            return route.abort('failed');
          }
          if (!value.operations.has(input.operationId)) {
            value.issues++;
            value.operations.set(input.operationId, {
              status: 'succeeded',
              errorCode: null,
              receipt: receipt(input.operationId, 'issuance', Number(input.amount).toFixed(2)),
            });
          }
          if (value.dropIssue) {
            value.dropIssue = false;
            return route.abort('failed');
          }
          const result = value.operations.get(input.operationId)!;
          return route.fulfill({ json: result.receipt });
        }
        if (path.endsWith('/voucher-conversions') && request.method() === 'POST') {
          const input = z
            .object({ operationId: z.uuid() })
            .parse(request.postDataJSON() as unknown);
          value.seen = true;
          if (value.rejectPin) {
            value.rejectPin = false;
            value.operations.set(input.operationId, {
              status: 'rejected',
              errorCode: 'GIFT_CARD_PIN_INVALID',
              receipt: null,
            });
            return route.abort('failed');
          }
          if (!value.operations.has(input.operationId)) {
            value.conversions++;
            value.operations.set(input.operationId, {
              status: 'succeeded',
              errorCode: null,
              receipt: receipt(input.operationId, 'conversion', '25.49'),
            });
          }
          if (value.holdConversion)
            await new Promise<void>((resolve) => {
              value.release = resolve;
            });
          if (value.dropConversion) {
            value.dropConversion = false;
            return route.abort('failed');
          }
          return route
            .fulfill({ json: value.operations.get(input.operationId)!.receipt })
            .catch(() => undefined);
        }
        if (path.startsWith('/api/v1/gift-voucher-operations/')) {
          const id = path.split('/')[4]!;
          value.reads++;
          if (path.endsWith('/cancellations') && !value.operations.has(id))
            value.operations.set(id, { status: 'cancelled', errorCode: null, receipt: null });
          const result = value.operations.get(id);
          if (!result)
            return route.fulfill({
              status: 404,
              json: {
                error: {
                  code: 'GLOBAL_VOUCHER_OPERATION_NOT_FOUND',
                  message: 'Synthetic absent operation',
                },
              },
            });
          return route.fulfill({ json: result });
        }
        if (path === `/api/v1/stores/1/checkout-sessions/${checkoutId}`) {
          if (value.failRefresh) {
            value.failRefresh = false;
            return route.fulfill({
              status: 503,
              json: {
                error: { code: 'FIXTURE_REFRESH_FAILED', message: 'Synthetic refresh failure' },
              },
            });
          }
          return route.fulfill({
            json: fixtureCheckout('1', 2),
          });
        }
        return route.fulfill({
          status: 404,
          json: {
            error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unexpected fixture resource' },
          },
        });
      });
      return value;
    }
    async function issue(page: Page, amount = '25.49') {
      await page.getByLabel('Customer email').fill('fixture@example.test');
      await page.getByRole('button', { name: 'Find customer' }).click();
      await page.getByLabel('Voucher amount').fill(amount);
      await page.getByRole('button', { name: 'Review voucher', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm voucher issuance' }).click();
    }
    async function convert(page: Page) {
      await page.getByLabel('Voucher code', { exact: true }).fill('GFVSYNTHETICFIXTURE');
      await page.getByLabel('Gift card PIN, if required').fill('123456');
      await page.getByRole('button', { name: 'Convert voucher balance' }).click();
    }
    async function privateJournal(page: Page) {
      const stored = await page.evaluate(() => Object.values(localStorage).join('|'));
      for (const text of [
        'fixture@example.test',
        'GFVSYNTHETICFIXTURE',
        '123456',
        'Fixture Customer',
      ])
        expect(stored).not.toContain(text);
    }
    it('issues approved exact paise and displays nonexpiry with one explicit command', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.goto(origin + '/__global-voucher-test__/issuance');
        await issue(page, '0.01');
        await browserExpect(
          page.getByRole('region', { name: 'Confirmed voucher operation' }),
        ).toContainText('Won’t expire');
        expect(state.issues).toBe(1);
        expect(
          state.posts.find((p) => p.path.endsWith('/gift-voucher-issuances'))?.body.amount,
        ).toBe('0.01');
        await privateJournal(page);
      } finally {
        await page.close();
      }
    });
    it('recovers a lost issuance reply after reload through GET without issuing twice or persisting recipient/code', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.dropIssue = true;
        await page.goto(origin + '/__global-voucher-test__/issuance');
        await issue(page);
        await browserExpect(page.getByRole('alert')).toBeVisible();
        await privateJournal(page);
        await page.reload();
        await page.getByRole('button', { name: 'Check voucher status' }).click();
        await browserExpect(
          page.getByRole('region', { name: 'Confirmed voucher operation' }),
        ).toBeVisible();
        expect(state.issues).toBe(1);
        expect(state.posts.filter((p) => p.path.endsWith('/gift-voucher-issuances'))).toHaveLength(
          1,
        );
      } finally {
        await page.close();
      }
    });
    it('stops an unknown uncommitted issuance with its original ID before permitting a new form', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.noIssueCommit = true;
        await page.goto(origin + '/__global-voucher-test__/issuance');
        await issue(page);
        await browserExpect(page.getByRole('alert')).toBeVisible();
        await page.getByRole('button', { name: 'Stop original issuance' }).click();
        await browserExpect(page.getByRole('button', { name: 'Find customer' })).toBeVisible();
        expect(state.issues).toBe(0);
        expect(state.posts.filter((p) => p.path.endsWith('/cancellations'))).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
    it('recovers a converted receipt independently of a failed sale refresh without another value transfer', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.dropConversion = true;
        state.failRefresh = true;
        await page.goto(origin + '/__global-voucher-test__/conversion');
        await convert(page);
        await browserExpect(page.getByRole('alert')).toBeVisible();
        await privateJournal(page);
        await page.reload();
        await page.getByRole('button', { name: 'Check conversion status' }).click();
        await browserExpect(
          page.getByRole('region', { name: 'Confirmed voucher operation' }),
        ).toContainText('125.49');
        await browserExpect(page.getByRole('button', { name: 'Fixture payment' })).toBeDisabled();
        await page.getByRole('button', { name: 'Refresh sale after conversion' }).click();
        await browserExpect(page.getByText('Checkout version 2')).toBeVisible();
        await browserExpect(page.getByRole('button', { name: 'Fixture payment' })).toBeEnabled();
        expect(state.conversions).toBe(1);
        expect(state.posts.filter((p) => p.path.endsWith('/voucher-conversions'))).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
    it('reconciles one rejected PIN attempt by GET and creates a different intent for a new PIN', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.rejectPin = true;
        await page.goto(origin + '/__global-voucher-test__/conversion');
        await convert(page);
        await browserExpect(page.getByRole('alert')).toBeVisible();
        await page.getByRole('button', { name: 'Check conversion status' }).click();
        await browserExpect(page.getByLabel('Voucher code', { exact: true })).toBeVisible();
        await convert(page);
        await browserExpect(
          page.getByRole('region', { name: 'Confirmed voucher operation' }),
        ).toBeVisible();
        const commands = state.posts.filter((p) => p.path.endsWith('/voucher-conversions'));
        expect(commands).toHaveLength(2);
        expect(commands[0]?.body.operationId).not.toBe(commands[1]?.body.operationId);
        expect(state.conversions).toBe(1);
        await privateJournal(page);
      } finally {
        await page.close();
      }
    });
    it('fences a delayed response on operator switch and never adopts the old actor receipt', async () => {
      const page = await browser.newPage();
      const state = await fixture(page);
      try {
        state.holdConversion = true;
        await page.goto(origin + '/__global-voucher-test__/conversion');
        await convert(page);
        await expect.poll(() => state.seen).toBe(true);
        await page.getByRole('button', { name: 'Switch fixture operator' }).click();
        state.release();
        await browserExpect(page.getByText('Current operator 2')).toBeVisible();
        await browserExpect(
          page.getByRole('region', { name: 'Confirmed voucher operation' }),
        ).toHaveCount(0);
        expect(
          state.posts.filter((p) => p.path.endsWith('/voucher-conversions')).map((p) => p.actor),
        ).toEqual(['1']);
      } finally {
        state.release();
        await page.close();
      }
    });
  },
);
