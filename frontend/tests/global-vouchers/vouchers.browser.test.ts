import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';
import { fixtureCheckout } from './fixtures';
import {
  voucherConversionResultSchema,
  voucherReceiptSchema,
  type VoucherConversionResult,
  type VoucherReceipt,
} from '../../src/pages/global-vouchers/api';

const checkoutId = '33333333-3333-4333-8333-333333333333',
  selectionId = '22222222-2222-4222-8222-222222222222';
describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'actual voucher issuance and check/top-up in Chromium',
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
        noIssueCommit: false,
        dropConversion: false,
        holdConversion: false,
        checkNeedsPin: false,
        convertNeedsPin: false,
        release: () => undefined as void,
        seen: false,
        issues: 0,
        conversions: 0,
        posts: [] as { path: string; actor: string; body: Record<string, unknown> }[],
        operations: new Map<
          string,
          | { status: 'succeeded'; receipt: VoucherReceipt | VoucherConversionResult }
          | { status: 'cancelled'; receipt: null }
        >(),
      };
      const reject = (code: string, message: string, status = 422) => ({
        status,
        json: { error: { code, message } },
      });
      function receipt(operationId: string, amount: string) {
        return voucherReceiptSchema.parse({
          operationId,
          kind: 'issuance',
          operatorId: '1',
          customerId: '7',
          voucherId: '9007199254740993',
          couponId: '42',
          voucherCode: 'GFVSYNTHETICFIXTURE',
          amount,
          voucherHistoryId: '9007199254740994',
          nonExpiring: true,
          createdAt: '2026-06-15 12:00:00',
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
          return route.fulfill(reject('FIXTURE_SCOPE', 'Synthetic scope rejection', 403));
        const body =
          request.method() === 'POST'
            ? z.record(z.string(), z.unknown()).parse(request.postDataJSON() as unknown)
            : {};
        if (request.method() === 'POST') value.posts.push({ path, actor, body });
        if (path === '/api/v1/gift-vouchers/capabilities')
          return route.fulfill({ json: { enabled: true } });
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
          const input = z.object({ operationId: z.uuid(), amount: z.string() }).parse(body);
          if (value.noIssueCommit) {
            value.noIssueCommit = false;
            return route.abort('failed');
          }
          if (!value.operations.has(input.operationId)) {
            value.issues++;
            value.operations.set(input.operationId, {
              status: 'succeeded',
              receipt: receipt(input.operationId, Number(input.amount).toFixed(2)),
            });
          }
          if (value.dropIssue) {
            value.dropIssue = false;
            return route.abort('failed');
          }
          return route.fulfill({ json: value.operations.get(input.operationId)!.receipt });
        }
        if (path.endsWith('/voucher-checks')) {
          const input = z
            .object({ voucherCode: z.string(), giftCardPin: z.string().optional() })
            .parse(body);
          if (value.checkNeedsPin && !input.giftCardPin)
            return route.fulfill(reject('GIFT_CARD_PIN_REQUIRED', 'Please enter the PIN'));
          if (value.checkNeedsPin && input.giftCardPin !== '123456')
            return route.fulfill(reject('GIFT_CARD_PIN_INVALID', 'Invalid PIN'));
          return route.fulfill({
            json: {
              voucherCode: input.voucherCode,
              voucherValue: '25.49',
              validity: value.checkNeedsPin ? '2027-01-31' : '0000-00-00',
              nonExpiring: !value.checkNeedsPin,
              pinUsed: Boolean(input.giftCardPin),
            },
          });
        }
        if (path.endsWith('/voucher-conversions') && request.method() === 'POST') {
          const input = z
            .object({ operationId: z.uuid(), giftCardPin: z.string().optional() })
            .parse(body);
          value.seen = true;
          if (value.convertNeedsPin && !input.giftCardPin)
            return route.fulfill(reject('GIFT_CARD_PIN_REQUIRED', 'Please enter the PIN'));
          if (!value.operations.has(input.operationId)) {
            value.conversions++;
            value.operations.set(input.operationId, {
              status: 'succeeded',
              receipt: voucherConversionResultSchema.parse({
                operationId: input.operationId,
                kind: 'conversion',
                operatorId: actor,
                customerId: '7',
                storeId: '1',
                checkoutId,
                voucherCode: 'GFVSYNTHETICFIXTURE',
                pinUsed: Boolean(input.giftCardPin),
                status: 'success',
                message: input.giftCardPin
                  ? "Gift Card Amount Has Been Transfered To User's TSS Money"
                  : "Gift Voucher Amount Has Been Transfered To User's TSS Money",
              }),
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
          if (path.endsWith('/cancellations') && !value.operations.has(id))
            value.operations.set(id, { status: 'cancelled', receipt: null });
          const result = value.operations.get(id);
          if (!result)
            return route.fulfill(
              reject('GLOBAL_VOUCHER_OPERATION_NOT_FOUND', 'Synthetic absent operation', 404),
            );
          return route.fulfill({ json: result });
        }
        if (path === `/api/v1/stores/1/checkout-sessions/${checkoutId}`)
          return route.fulfill({ json: fixtureCheckout('1', 2) });
        return route.fulfill(
          reject('UNEXPECTED_FIXTURE_REQUEST', 'Unexpected fixture resource', 404),
        );
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
    async function topUp(page: Page) {
      await page.getByLabel('Voucher code', { exact: true }).fill('GFVSYNTHETICFIXTURE');
      await page.getByRole('button', { name: 'Top-up' }).click();
      await browserExpect(
        page.getByText(
          'Are You Sure You Want To Top Up All Of This Gift Voucher/Card To TSS Money',
        ),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Confirm' }).click();
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
    it('checks balance and validity, prompting for a gift card PIN only when required', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.goto(origin + '/__global-voucher-test__/conversion');
        await page.getByLabel('Voucher code', { exact: true }).fill('GFVSYNTHETICFIXTURE');
        await page.getByRole('button', { name: 'Check' }).click();
        const details = page.getByRole('region', { name: 'Gift Voucher/Card Details' });
        await browserExpect(details).toContainText('Your Voucher have -> ₹25.49');
        await browserExpect(details).toContainText('This Coupon Won’t Expire');
        await browserExpect(page.getByText('Gift Voucher Data Fetched')).toBeVisible();
        state.checkNeedsPin = true;
        await page.getByRole('button', { name: 'Check' }).click();
        const pin = page.getByRole('dialog', { name: 'GC PIN' });
        await browserExpect(pin).toContainText('Please Enter the GIFT CARD PIN');
        await pin.getByRole('button', { name: 'Submit' }).click();
        await browserExpect(pin).toContainText('Please Provide a Valid PIN');
        await pin.getByLabel('Gift card PIN').fill('111111');
        await pin.getByRole('button', { name: 'Submit' }).click();
        await browserExpect(pin).toContainText('Invalid PIN');
        await pin.getByLabel('Gift card PIN').fill('123456');
        await pin.getByRole('button', { name: 'Submit' }).click();
        await browserExpect(details).toContainText('This voucher is valid till -> 2027-01-31');
        await browserExpect(page.getByText('Gift Card Data Fetched')).toBeVisible();
        expect(state.conversions).toBe(0);
        await privateJournal(page);
      } finally {
        await page.close();
      }
    });
    it('confirms a top-up, asks for a PIN on demand and reloads the sale', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.goto(origin + '/__global-voucher-test__/conversion');
        await page.getByRole('button', { name: 'Top-up' }).click();
        await browserExpect(page.getByText('Please enter a valid voucher code')).toBeVisible();
        state.convertNeedsPin = true;
        await topUp(page);
        const pin = page.getByRole('dialog', { name: 'GC PIN' });
        await pin.getByLabel('Gift card PIN').fill('123456');
        await pin.getByRole('button', { name: 'Submit' }).click();
        await browserExpect(
          page.getByText("Gift Card Amount Has Been Transfered To User's TSS Money"),
        ).toBeVisible();
        await browserExpect(page.getByText('Checkout version 2')).toBeVisible();
        const commands = state.posts.filter((p) => p.path.endsWith('/voucher-conversions'));
        expect(commands).toHaveLength(2);
        expect(commands[0]?.body.operationId).toBe(commands[1]?.body.operationId);
        expect(state.conversions).toBe(1);
        await privateJournal(page);
      } finally {
        await page.close();
      }
    });
    it('keeps a lost top-up reply for a status check after reload and never resends it', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.dropConversion = true;
        await page.goto(origin + '/__global-voucher-test__/conversion');
        await topUp(page);
        await browserExpect(page.getByRole('alert')).toBeVisible();
        await privateJournal(page);
        await page.reload();
        await browserExpect(page.getByRole('button', { name: 'Fixture payment' })).toBeDisabled();
        await page.getByRole('button', { name: 'Check top-up status' }).click();
        await browserExpect(
          page.getByText("Gift Voucher Amount Has Been Transfered To User's TSS Money"),
        ).toBeVisible();
        await browserExpect(page.getByText('Checkout version 2')).toBeVisible();
        await browserExpect(page.getByRole('button', { name: 'Fixture payment' })).toBeEnabled();
        expect(state.conversions).toBe(1);
        expect(state.posts.filter((p) => p.path.endsWith('/voucher-conversions'))).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
    it('fences a delayed response on operator switch', async () => {
      const page = await browser.newPage();
      const state = await fixture(page);
      try {
        state.holdConversion = true;
        await page.goto(origin + '/__global-voucher-test__/conversion');
        await topUp(page);
        await expect.poll(() => state.seen).toBe(true);
        await page.getByRole('button', { name: 'Switch fixture operator' }).click();
        state.release();
        await browserExpect(page.getByText('Current operator 2')).toBeVisible();
        await browserExpect(page.getByText('Checkout version 2')).toHaveCount(0);
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
