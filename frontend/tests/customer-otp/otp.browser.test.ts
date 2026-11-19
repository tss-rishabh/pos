import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';
import { checkoutSchema } from '../../src/pages/checkout/client';

const checkoutIds = {
  '1': '33333333-3333-4333-8333-333333333333',
  '2': '44444444-4444-4444-8444-444444444444',
} as const;
const draftIds = {
  '1': '11111111-1111-4111-8111-111111111111',
  '2': '22222222-2222-4222-8222-222222222222',
} as const;
const mutation = z.object({ operationId: z.uuid(), expectedVersion: z.number().int() });
interface Challenge {
  id: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
  sent: boolean;
  deliveryStatus: 'pending' | 'sent' | 'uncertain' | 'rejected';
  requestOperationId: string;
  verifyOperationId: string | null;
}
describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'actual CheckoutReview safe customer OTP recovery in Chromium',
  { timeout: 15000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        configFile: false,
        cacheDir: 'node_modules/.vite-customer-otp-tests',
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__customer-otp-test__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__customer-otp-test__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/customer-otp/harness.tsx"></script></body></html>',
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
        throw new Error('Customer OTP browser fixture failed to bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });

    async function fixture(page: Page) {
      page.setDefaultTimeout(7000);
      const value = {
        version: 1,
        challenge: null as Challenge | null,
        verifiedUntil: null as number | null,
        proofUntil: Date.now() + 900000,
        busyOperationId: null as string | null,
        pending: null as { id: string; kind: 'request' | 'verify'; error: string | null } | null,
        delivery: 'pending' as Challenge['deliveryStatus'],
        dropRequest: false,
        dropVerify: false,
        holdRequest: false,
        requestSeen: false,
        releaseRequest: () => undefined as void,
        posts: [] as { path: string; actor: string; body: Record<string, unknown> }[],
        urls: [] as URL[],
        requests: 0,
        verifies: 0,
        reconciliations: 0,
        receipts: new Map<
          string,
          { status: 'succeeded' | 'inflight' | 'rejected'; errorCode: string | null }
        >(),
      };
      const state = (actor: '1' | '2') =>
        checkoutSchema.parse({
          id: checkoutIds[actor],
          operatorId: actor,
          storeId: '1',
          counterId: '1',
          draftId: draftIds[actor],
          draftVersion: 1000,
          draftImport: {
            lineItems: [{ productId: '123', quantity: 1 }],
            completedProductIds: ['123'],
            status: 'complete',
          },
          version: actor === '1' ? value.version : 1,
          customerId: actor === '1' ? '7' : null,
          salespersonId: null,
          lineSalespersons: {},
          settlementNote: null,
          verifiedCustomerUntil: actor === '1' ? value.verifiedUntil : null,
          verificationChallenge: actor === '1' ? value.challenge : null,
          phase: 'open',
          orderId: null,
          orderSubmissionOperationId: null,
          confirmationPhase: null,
          busyOperationId: actor === '1' ? value.busyOperationId : null,
          giftCards: {},
          cart: {
            products: { items: [{ prod_id: '123', quantity: 1, prod_type: 1 }] },
            giftvouchers: { items: [] },
            meta: { items: [{ name: 'calculations', products_total: 100, total: 100 }] },
          },
          quote: null,
          settlement: null,
        });
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname,
          rawActor = request.headers()['x-operator-id'];
        value.urls.push(url);
        if (
          url.searchParams.has('otp') ||
          url.searchParams.has('code') ||
          url.searchParams.has('email') ||
          url.searchParams.has('phone') ||
          !['1', '2'].includes(rawActor ?? '')
        ) {
          await route.fulfill({
            status: 403,
            json: { error: { code: 'ACTOR_CHANGED', message: 'Operator changed.' } },
          });
          return;
        }
        const actor = rawActor as '1' | '2';
        if (path === '/api/v1/stores/1/salespeople') {
          await route.fulfill({ json: { data: [], nextCursor: null } });
          return;
        }
        const base = '/api/v1/stores/1/checkout-sessions/' + checkoutIds[actor];
        if (request.method() === 'GET' && path === base) {
          if (actor === '1' && value.challenge && !value.busyOperationId)
            value.challenge = {
              ...value.challenge,
              deliveryStatus: value.delivery,
              sent: value.delivery === 'sent' || value.delivery === 'uncertain',
            };
          await route.fulfill({ json: state(actor) });
          return;
        }
        if (request.method() === 'GET' && path.startsWith(base + '/operations/')) {
          const id = path.split('/').at(-1)!,
            receipt = value.receipts.get(id);
          await route.fulfill({
            json: {
              status: receipt?.status ?? 'inflight',
              operationId: id,
              state: state(actor),
              errorCode: receipt?.errorCode ?? null,
            },
          });
          return;
        }
        if (request.method() === 'GET' && path.endsWith('/discount-approval')) {
          await route.fulfill({
            json: {
              status: 'not-required',
              amount: '0.00',
              productsTotal: '100.00',
              challengeId: null,
              expiresAt: null,
              retryAt: null,
              delivered: 0,
              pending: 0,
            },
          });
          return;
        }
        if (request.method() === 'POST' && path.startsWith(base + '/customer-verification/')) {
          const body = mutation.parse(request.postDataJSON() as unknown);
          value.posts.push({
            path,
            actor,
            body: z.record(z.string(), z.unknown()).parse(request.postDataJSON() as unknown),
          });
          expect(body.expectedVersion).toBe(value.version);
          if (path.endsWith('/challenges')) {
            value.requests++;
            value.requestSeen = true;
            value.challenge = {
              id: crypto.randomUUID(),
              expiresAt: Date.now() + 300000,
              attempts: 0,
              lastSentAt: Date.now(),
              sent: false,
              deliveryStatus: 'pending',
              requestOperationId: body.operationId,
              verifyOperationId: null,
            };
            value.pending = { id: body.operationId, kind: 'request', error: null };
            if (value.holdRequest)
              await new Promise<void>((resolve) => {
                value.releaseRequest = resolve;
              });
            if (value.dropRequest) {
              value.dropRequest = false;
              value.busyOperationId = body.operationId;
              value.receipts.set(body.operationId, { status: 'inflight', errorCode: null });
              await route
                .fulfill({
                  status: 503,
                  json: {
                    error: {
                      code: 'CONTROLLED_OTP_REPLY_LOST',
                      message: 'Verification response was interrupted.',
                    },
                  },
                })
                .catch(() => undefined);
              return;
            }
            value.version++;
          } else if (path.endsWith('/confirmations')) {
            value.verifies++;
            const input = z
                .object({ otp: z.string().regex(/^\d{6}$/) })
                .parse(request.postDataJSON() as unknown),
              valid = input.otp === '487209';
            value.challenge = {
              ...value.challenge!,
              verifyOperationId: body.operationId,
              attempts: value.challenge!.attempts + (valid ? 0 : 1),
            };
            value.pending = {
              id: body.operationId,
              kind: 'verify',
              error: valid ? null : 'CUSTOMER_OTP_INVALID',
            };
            if (value.dropVerify) {
              value.dropVerify = false;
              value.busyOperationId = body.operationId;
              value.receipts.set(body.operationId, { status: 'inflight', errorCode: null });
              await route.fulfill({
                status: 503,
                json: {
                  error: {
                    code: 'CONTROLLED_OTP_REPLY_LOST',
                    message: 'Verification response was interrupted.',
                  },
                },
              });
              return;
            }
            if (!valid) {
              value.version++;
              await route.fulfill({
                status: 422,
                json: {
                  error: {
                    code: 'CUSTOMER_OTP_INVALID',
                    message: 'The customer verification code is incorrect.',
                  },
                },
              });
              return;
            }
            value.verifiedUntil = value.proofUntil;
            value.version++;
          } else if (path.endsWith('/reconciliations')) {
            value.reconciliations++;
            expect(body.operationId).toBe(value.pending?.id);
            value.busyOperationId = null;
            if (value.challenge)
              value.challenge = {
                ...value.challenge,
                deliveryStatus: value.delivery,
                sent: value.delivery === 'sent' || value.delivery === 'uncertain',
              };
            if (value.pending?.kind === 'verify' && !value.pending.error)
              value.verifiedUntil = value.proofUntil;
            value.version++;
            const error = value.pending?.error ?? null;
            value.receipts.set(body.operationId, {
              status: error ? 'rejected' : 'succeeded',
              errorCode: error,
            });
            await route.fulfill({
              json: {
                status: error ? 'rejected' : 'succeeded',
                operationId: body.operationId,
                errorCode: error,
                state: state(actor),
                result: {},
              },
            });
            return;
          } else throw new Error('Unexpected customer OTP browser mutation.');
          value.receipts.set(body.operationId, { status: 'succeeded', errorCode: null });
          await route
            .fulfill({
              json: {
                status: 'succeeded',
                operationId: body.operationId,
                state: state(actor),
                result: { queued: true },
              },
            })
            .catch(() => undefined);
          return;
        }
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'FIXTURE_UNAVAILABLE',
              message: 'This unrelated fixture capability is unavailable.',
            },
          },
        });
      });
      await page.goto(origin + '/__customer-otp-test__');
      await browserExpect(page.getByRole('heading', { name: 'Confirm the sale' })).toBeVisible();
      await page.getByText('Customer and verification', { exact: true }).click();
      await browserExpect(
        page.getByRole('button', { name: 'Send verification code', exact: true }),
      ).toBeVisible();
      return value;
    }
    async function openCustomer(page: Page) {
      if (
        !(await page
          .getByRole('button', { name: 'Send verification code', exact: true })
          .isVisible())
      )
        await page.getByText('Customer and verification', { exact: true }).click();
    }
    async function deliver(
      page: Page,
      state: Awaited<ReturnType<typeof fixture>>,
      status: 'sent' | 'uncertain' = 'sent',
    ) {
      state.delivery = status;
      await page.getByRole('button', { name: 'Check verification delivery', exact: true }).click();
      await browserExpect(page.getByLabel('Verification code', { exact: true })).toBeEnabled();
    }
    async function storedText(page: Page) {
      return page.evaluate(async () => {
        const request = indexedDB.open('souled-pos-v1');
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(new Error('OTP browser storage fixture unavailable.'));
        });
        try {
          const names = Array.from(database.objectStoreNames),
            transaction = database.transaction(names, 'readonly');
          const records = await Promise.all(
            names.map(
              (name) =>
                new Promise<unknown[]>((resolve, reject) => {
                  const read = transaction.objectStore(name).getAll();
                  read.onsuccess = () => resolve(read.result as unknown[]);
                  read.onerror = () =>
                    reject(new Error('OTP browser storage fixture unavailable.'));
                }),
            ),
          );
          return JSON.stringify({
            records,
            local: { ...localStorage },
            session: { ...sessionStorage },
          });
        } finally {
          database.close();
        }
      });
    }
    it('queues once, checks uncertain delivery by GET and verifies an arrived code without persisting it', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.getByRole('button', { name: 'Send verification code', exact: true }).click();
        await openCustomer(page);
        await browserExpect(
          page.getByText('The verification code is queued for delivery.', { exact: true }),
        ).toBeVisible();
        await browserExpect(page.getByLabel('Verification code', { exact: true })).toBeDisabled();
        await deliver(page, state, 'uncertain');
        await browserExpect(
          page.getByText('Delivery is unconfirmed.', { exact: false }),
        ).toBeVisible();
        await page.getByLabel('Verification code', { exact: true }).fill('487209');
        await page.getByRole('button', { name: 'Verify customer', exact: true }).click();
        await browserExpect(page.getByText('Customer verified.', { exact: true })).toBeVisible();
        expect(state.requests).toBe(1);
        expect(state.verifies).toBe(1);
        expect(state.reconciliations).toBe(0);
        expect(await storedText(page)).not.toContain('"487209"');
        expect(
          state.urls.every(
            (url) => !['code', 'otp', 'phone', 'email'].some((key) => url.searchParams.has(key)),
          ),
        ).toBe(true);
      } finally {
        await page.close();
      }
    });
    it('recovers a lost queued-request response with the original metadata operation and never resends', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.dropRequest = true;
        state.delivery = 'sent';
        await page.getByRole('button', { name: 'Send verification code', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Check action status', exact: true }),
        ).toBeVisible();
        const original = state.pending!.id;
        await page.getByRole('button', { name: 'Check action status', exact: true }).click();
        await browserExpect(
          page.getByText('The last action was confirmed.', { exact: true }),
        ).toBeVisible();
        expect(state.requests).toBe(1);
        expect(state.verifies).toBe(0);
        expect(state.reconciliations).toBe(1);
        expect(
          state.posts.find((post) => post.path.endsWith('/reconciliations'))?.body.operationId,
        ).toBe(original);
        await openCustomer(page);
        await browserExpect(page.getByLabel('Verification code', { exact: true })).toBeEnabled();
      } finally {
        await page.close();
      }
    });
    it('reloads after a lost wrong-code reply and reconciles the original failure without another guess', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.getByRole('button', { name: 'Send verification code', exact: true }).click();
        await openCustomer(page);
        await deliver(page, state);
        state.dropVerify = true;
        await page.getByLabel('Verification code', { exact: true }).fill('000000');
        await page.getByRole('button', { name: 'Verify customer', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Check action status', exact: true }),
        ).toBeVisible();
        const original = state.pending!.id;
        await page.reload();
        await browserExpect(
          page.getByRole('button', { name: 'Check action status', exact: true }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Check action status', exact: true }).click();
        await browserExpect(
          page.getByText('The last action was rejected (CUSTOMER_OTP_INVALID).', { exact: true }),
        ).toBeVisible();
        expect(state.verifies).toBe(1);
        expect(state.challenge?.attempts).toBe(1);
        expect(
          state.posts.find((post) => post.path.endsWith('/reconciliations'))?.body.operationId,
        ).toBe(original);
        await openCustomer(page);
        await browserExpect(page.getByLabel('Verification code', { exact: true })).toHaveValue('');
        await page.getByLabel('Verification code', { exact: true }).fill('487209');
        await page.getByRole('button', { name: 'Verify customer', exact: true }).click();
        await browserExpect(page.getByText('Customer verified.', { exact: true })).toBeVisible();
        expect(state.verifies).toBe(2);
      } finally {
        await page.close();
      }
    });
    it('reconciles a lost successful verification without extending proof or posting the code again', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page.getByRole('button', { name: 'Send verification code', exact: true }).click();
        await openCustomer(page);
        await deliver(page, state);
        state.dropVerify = true;
        await page.getByLabel('Verification code', { exact: true }).fill('487209');
        await page.getByRole('button', { name: 'Verify customer', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Check action status', exact: true }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Check action status', exact: true }).click();
        await browserExpect(
          page.getByText('The last action was confirmed.', { exact: true }),
        ).toBeVisible();
        expect(state.verifiedUntil).toBe(state.proofUntil);
        const checkoutReadsBeforeReload = state.urls.filter((url) =>
          url.pathname.endsWith('/checkout-sessions/' + checkoutIds['1']),
        ).length;
        const reloadStartedAt = Date.now();
        try {
          await page.reload();
          await browserExpect(
            page.getByText('Customer and verification', { exact: true }),
          ).toBeVisible();
        } catch (error: unknown) {
          // Fixed-name phase timings and booleans only: never serialize the DOM,
          // browser storage, requests, errors, customer data or verification codes.
          const phase = await page
            .evaluate(() => {
              const summary = Array.from(document.querySelectorAll('summary')).find(
                (element) => element.textContent?.trim() === 'Customer and verification',
              );
              return {
                documentReadyState: document.readyState,
                headingMounted: Array.from(document.querySelectorAll('h1,h2,h3')).some(
                  (element) => element.textContent?.trim() === 'Confirm the sale',
                ),
                summaryMounted: Boolean(summary),
                summaryVisible: Boolean(
                  summary &&
                  summary.getClientRects().length &&
                  getComputedStyle(summary).visibility === 'visible',
                ),
                bootstrapMarks: performance
                  .getEntriesByType('mark')
                  .filter((entry) =>
                    [
                      'customer-otp-fixture-bootstrap-start',
                      'customer-otp-fixture-drafts-ready',
                      'customer-otp-fixture-session-ready',
                      'customer-otp-fixture-mounted',
                    ].includes(entry.name),
                  )
                  .map((entry) => ({ phase: entry.name, elapsedMs: Math.round(entry.startTime) })),
              };
            })
            .catch(() => ({ diagnosticsUnavailable: true }));
          console.error(
            JSON.stringify({
              eventId: 'customer_otp.browser.reload_recovery_failure',
              module: 'customer-otp-browser-fixture',
              resource: 'customer-otp-reload',
              eventInstanceId: randomUUID(),
              requestId: null,
              userId: null,
              elapsedMs: Date.now() - reloadStartedAt,
              checkoutReadsSinceReload:
                state.urls.filter((url) =>
                  url.pathname.endsWith('/checkout-sessions/' + checkoutIds['1']),
                ).length - checkoutReadsBeforeReload,
              ...phase,
            }),
          );
          throw error;
        }
        await browserExpect(
          page.getByRole('button', { name: 'Check action status', exact: true }),
        ).toHaveCount(0);
        expect(state.verifies).toBe(1);
        expect(state.requests).toBe(1);
        expect(state.reconciliations).toBe(1);
        expect(state.verifiedUntil).toBe(state.proofUntil);
        expect(await storedText(page)).not.toContain('"487209"');
      } finally {
        await page.close();
      }
    });
    it('drops an old operator continuation before it can restore private verification UI', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.holdRequest = true;
        await page.getByRole('button', { name: 'Send verification code', exact: true }).click();
        await browserExpect.poll(() => state.requestSeen).toBe(true);
        await page.getByRole('button', { name: 'Switch fixture operator', exact: true }).click();
        await browserExpect(page.getByText('Current operator 2', { exact: true })).toBeVisible();
        state.releaseRequest();
        await browserExpect(
          page.getByText('Customer and verification', { exact: true }),
        ).toBeVisible();
        await browserExpect(
          page.getByText('Verification queued. Check delivery before entering the code.', {
            exact: true,
          }),
        ).toHaveCount(0);
        expect(state.verifies).toBe(0);
        expect(state.requests).toBe(1);
        expect(state.posts.every((post) => post.actor === '1')).toBe(true);
      } finally {
        await page.close();
      }
    });
    it('loads the real checkout component with an immutable draft and blocks verification while offline', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await browserExpect(
          page.getByRole('button', { name: 'Send verification code', exact: true }),
        ).toBeEnabled();
        await page.getByRole('button', { name: 'Toggle fixture connection' }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Send verification code', exact: true }),
        ).toBeDisabled();
        expect(state.requests).toBe(0);
      } finally {
        await page.close();
      }
    });
  },
);
