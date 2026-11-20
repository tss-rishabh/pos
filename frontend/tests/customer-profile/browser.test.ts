import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { prepareBrowserFixture } from '../prepare-browser-fixture';
import {
  profileAdjustmentInput,
  type ProfileAdjustmentInput,
} from '../../src/pages/customer-insights/client';

describe.skipIf(process.env.CUSTOMER_PROFILE_BROWSER_TESTS !== 'true')(
  'checkout customer details in isolated Chromium',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = await mkdtemp(join(tmpdir(), 'pos-customer-profile-browser-'));
      server = await createServer({
        configFile: false,
        cacheDir: cache,
        plugins: [react()],
        appType: 'custom',
        server: {
          host: '127.0.0.1',
          port: 0,
          hmr: false,
          fs: { allow: [process.cwd(), realpathSync('node_modules'), cache] },
        },
        logLevel: 'silent',
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__customer-profile__') return next();
        try {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            await server.transformIndexHtml(
              '/__customer-profile__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/customer-profile/browser-entry.tsx"></script></body></html>',
            ),
          );
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Customer profile fixture could not bind.');
      origin = `http://127.0.0.1:${address.port}`;
      const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      const executablePath =
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
        (process.platform === 'darwin' && existsSync(mac) ? mac : undefined);
      browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
      await prepareBrowserFixture(browser, async (page) => {
        const prepared = await workspace({}, page);
        expect(prepared.requests).toEqual([]);
        await server.waitForRequestsIdle();
      });
    }, 20_000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cache) await rm(cache, { recursive: true, force: true });
    });
    const response = () => ({
      customerId: '777',
      checkoutVersion: 1,
      etag: 'a'.repeat(64),
      editable: true,
      profile: {
        firstName: '<img src=x onerror="window.profilePwned=true">',
        lastName: 'Fixture',
        email: 'guest@example.test',
        telephone: '9876543210',
        gender: 'F',
        birthday: '2000-02-29',
        anniversary: null,
        customerType: 'B2B',
        gstin: '27ABCDE1234F1Z5',
      },
    });
    async function workspace(
      options: {
        changedCustomer?: boolean;
        hold?: Promise<void>;
        mutation?: 'lost' | 'missing-proof' | 'wrong-customer' | 'rejected';
        insightFailure?: boolean;
        wrongInsightCustomer?: boolean;
        wrongBenefitsCustomer?: boolean;
        wrongBenefitsVersion?: boolean;
        benefitsFailure?: boolean;
        wrongHistoryCustomer?: boolean;
        wrongHistoryVersion?: boolean;
        historyFailure?: boolean;
        wrongLineOrder?: boolean;
        badHistoryCursor?: boolean;
      } = {},
      preparedPage?: Page,
    ) {
      const context =
        preparedPage?.context() ?? (await browser.newContext({ serviceWorkers: 'block' }));
      const page = preparedPage ?? (await context.newPage());
      const errors: string[] = [];
      const requests: string[] = [];
      const mutationInputs: ProfileAdjustmentInput[] = [];
      let saved: ProfileAdjustmentInput | undefined;
      let reconciliationCount = 0;
      const returnsCursor = 'cmV0dXJucw.' + 'a'.repeat(43);
      const linesCursor = 'bGluZXM.' + 'b'.repeat(43);
      const savedResponse = (input: ProfileAdjustmentInput) => ({
        adjustment: {
          operationId: input.operationId,
          customerId: options.mutation === 'wrong-customer' ? '778' : '777',
          checkoutVersion: 2,
          beforeEtag: input.expectedEtag,
          etag: 'b'.repeat(64),
          fields: Object.keys(input.changes),
          appliedAt: '2026-11-16T11:00:00.000Z',
        },
        profile: {
          ...response(),
          checkoutVersion: 2,
          etag: 'b'.repeat(64),
          profile: { ...response().profile, ...input.changes },
        },
      });
      page.on('pageerror', (error) => errors.push(error.name));
      await page.route('**/api/v1/**', async (route) => {
        requests.push(new URL(route.request().url()).pathname);
        expect(route.request().headers()['x-operator-id']).toBe('7');
        if (options.hold) await options.hold;
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/customer-history')) {
          expect(route.request().method()).toBe('GET');
          const query = new URL(route.request().url()).searchParams;
          expect(query.get('limit')).toBe('25');
          expect([...query.keys()].every((key) => ['limit', 'returnBefore'].includes(key))).toBe(
            true,
          );
          if (options.historyFailure) {
            await route.fulfill({
              status: 503,
              json: {
                error: {
                  code: 'WAREHOUSE_UNAVAILABLE',
                  message: 'Historical reports are temporarily unavailable.',
                },
              },
            });
            return;
          }
          const older = query.has('returnBefore');
          if (older) expect(query.get('returnBefore')).toBe(returnsCursor);
          await route.fulfill({
            json: {
              customerId: options.wrongHistoryCustomer ? '778' : '777',
              checkoutVersion: options.wrongHistoryVersion ? 2 : 1,
              reader: 'primary',
              fetchedAt: '2026-11-16T11:00:00.000Z',
              summary: {
                exclusiveSavings: 125.5,
                totalOrders: '9007199254740993',
                totalStoreOrders: '2',
                totalOnlineOrders: '9007199254740991',
                last30DaysOrders: '4',
                cancelledOrders: '1',
                returnedOrders: '2',
                npsScore: 5.5,
              },
              recentOrders: [
                {
                  id: '9007199254740993',
                  orderAmount: 1999.5,
                  createdDate: '2026-11-01',
                  status: 3,
                  isStoreOrder: false,
                },
              ],
              returnedOrders: {
                items: options.badHistoryCursor
                  ? []
                  : [
                      {
                        id: older ? '11' : '9007199254740995',
                        orderAmount: 200,
                        itemNames: older
                          ? ['Older returned item']
                          : [
                              '<img src=x onerror="window.historyPwned=true">',
                              'Repeated product',
                              'Repeated product',
                            ],
                        itemCount: older ? '1' : '4',
                        hasMoreItems: !older,
                        isStoreOrder: true,
                      },
                    ],
                nextCursor: older ? null : returnsCursor,
              },
            },
          });
          return;
        }
        if (path.includes('/customer-orders/') && path.endsWith('/lines')) {
          expect(route.request().method()).toBe('GET');
          const query = new URL(route.request().url()).searchParams;
          expect(query.get('limit')).toBe('50');
          expect([...query.keys()].every((key) => ['limit', 'before'].includes(key))).toBe(true);
          const orderId = path.split('/').at(-2)!;
          const older = query.has('before');
          if (older) expect(query.get('before')).toBe(linesCursor);
          await route.fulfill({
            json: {
              customerId: '777',
              checkoutVersion: 1,
              orderId: options.wrongLineOrder ? '999' : orderId,
              items: older
                ? [{ id: '12', productId: '100', name: 'Last order item' }]
                : [
                    { id: '9007199254741995', productId: '100', name: 'Repeated product' },
                    { id: '9007199254741994', productId: '100', name: 'Repeated product' },
                  ],
              nextCursor: older ? null : linesCursor,
            },
          });
          return;
        }
        if (path.endsWith('/customer-benefits')) {
          expect(new URL(route.request().url()).search).toBe('');
          expect(route.request().method()).toBe('GET');
          if (options.benefitsFailure) {
            await route.fulfill({
              status: 503,
              json: {
                error: {
                  code: 'DEPENDENCY_UNAVAILABLE',
                  message: 'Customer benefits are temporarily unavailable.',
                },
              },
            });
            return;
          }
          await route.fulfill({
            json: {
              customerId: options.wrongBenefitsCustomer ? '778' : '777',
              checkoutVersion: options.wrongBenefitsVersion ? 2 : 1,
              membership: {
                active: false,
                expiry: '2060-01-02T03:04:05',
                message: "User's Membership is deactivated.",
              },
              wallet: { money: '100.12', points: '0.00' },
              app: { isAppUser: true, discountEligible: null },
              activeGiftVoucherCount: '999999999999999999',
              customerSince: '2020-01-01T00:00:00',
              fetchedAt: '2026-11-16T11:00:00.000Z',
            },
          });
          return;
        }
        if (path.endsWith('/customer-insights')) {
          expect(new URL(route.request().url()).search).toBe('');
          if (options.insightFailure) {
            await route.fulfill({
              status: 503,
              json: {
                error: {
                  code: 'CUSTOMER_INSIGHTS_UNAVAILABLE',
                  message: 'Customer insights are unavailable. You can continue the sale.',
                },
              },
            });
            return;
          }
          await route.fulfill({
            json: {
              customerId: options.wrongInsightCustomer ? '778' : '777',
              checkoutVersion: 1,
              fetchedAt: '2026-11-16T11:00:00.000Z',
              briefing: {
                user_id: 'different-service-id',
                customer: {
                  name: '<img src=x onerror="window.insightPwned=true">',
                  is_exclusive: true,
                },
                occasion: { emoji: '🎂', text: 'Birthday month' },
                segment: 'Regular visitor',
                last_visit: '2026-11-01',
                home_store: 'Fixture store',
                avg_order_value: 1999.5,
                total_spend: 50000,
                customer_since: { date: '2020-01-01', tenure: '6 years' },
                sizes: [{ label: 'Tees', usual_size: 'M', recent_size: 'L', size_drifted: true }],
                action_points: [
                  {
                    kind: 'rec',
                    category: 'cart',
                    prompt: 'Try the saved tee',
                    text: null,
                    note: null,
                    count: 2,
                    items: [
                      {
                        name: 'Fixture tee',
                        image_url: 'javascript:alert(1)',
                        store: 3,
                        online: 5,
                        sizes: [{ size: 'L', store: 2, online: 4 }],
                      },
                    ],
                  },
                  {
                    kind: 'action',
                    category: null,
                    prompt: null,
                    text: 'Wallet balance available',
                    note: 'Ask before applying',
                    count: 0,
                    items: [],
                  },
                ],
              },
            },
          });
          return;
        }
        if (route.request().method() === 'POST') {
          expect(path.endsWith('/customer-profile-adjustments')).toBe(true);
          const input = profileAdjustmentInput.parse(route.request().postDataJSON() as unknown);
          mutationInputs.push(input);
          if (options.mutation === 'rejected') {
            await route.fulfill({
              status: 409,
              json: {
                error: {
                  code: 'CUSTOMER_PROFILE_CHANGED',
                  message: 'Customer details changed. Reload them before saving.',
                },
              },
            });
            return;
          }
          saved = input;
          if (
            (options.mutation === 'lost' || options.mutation === 'missing-proof') &&
            mutationInputs.length === 1
          ) {
            await route.abort('failed');
            return;
          }
          await route.fulfill({ json: savedResponse(input) });
          return;
        }
        if (path.includes('/customer-profile-adjustments/')) {
          reconciliationCount++;
          if (!saved || (options.mutation === 'missing-proof' && reconciliationCount === 1)) {
            await route.fulfill({
              status: 404,
              json: {
                error: {
                  code: 'CUSTOMER_PROFILE_ADJUSTMENT_NOT_FOUND',
                  message: 'This update was not found.',
                },
              },
            });
            return;
          }
          expect(path.endsWith('/' + saved.operationId)).toBe(true);
          await route.fulfill({ json: savedResponse(saved) });
          return;
        }
        const body = response();
        if (options.changedCustomer) body.customerId = '778';
        await route.fulfill({ json: saved ? savedResponse(saved).profile : body });
      });
      await page.goto(origin + '/__customer-profile__');
      await browserExpect(
        page.getByRole('button', { name: 'Customer details', exact: true }),
      ).toBeVisible();
      return { page, context, requests, errors, mutationInputs };
    }
    async function open(page: Page) {
      await page.getByRole('button', { name: 'Customer details', exact: true }).click();
    }
    async function editGender(page: Page) {
      await open(page);
      await page
        .getByRole('button', { name: 'Edit customer details', exact: true })
        .click({ timeout: 3000 });
      await page.getByLabel('Gender', { exact: true }).selectOption('M', { timeout: 3000 });
      await page
        .getByRole('button', { name: 'Save customer details', exact: true })
        .click({ timeout: 3000 });
    }
    it('renders private fields as escaped text, keeps one scope and hides them offline', async () => {
      const value = await workspace();
      try {
        await open(value.page);
        await browserExpect(value.page.getByText('guest@example.test')).toBeVisible();
        await browserExpect(value.page.getByText('2000-02-29')).toBeVisible();
        expect(
          await value.page.evaluate(() => Reflect.get(window, 'profilePwned')),
        ).toBeUndefined();
        expect(value.requests).toEqual([
          '/api/v1/stores/1/checkout-sessions/a53b9ec4-76ce-4641-95d5-7d3f4f073ab4/customer-profile',
        ]);
        await value.page.evaluate(() => window.customerProfileFixture.online(false));
        await browserExpect(value.page.getByText('guest@example.test')).toHaveCount(0);
        await browserExpect(
          value.page.getByRole('button', { name: 'Customer details', exact: true }),
        ).toBeDisabled();
        expect(value.errors).toEqual([]);
      } finally {
        await value.context.close();
      }
    });
    it('requires an unexpired cached session before making a private request', async () => {
      const value = await workspace();
      try {
        await value.page.evaluate(() => window.customerProfileFixture.expire());
        await open(value.page);
        await browserExpect(
          value.page.getByText('Sign in with a current operator session for this store.'),
        ).toBeVisible();
        expect(value.requests).toEqual([]);
      } finally {
        await value.context.close();
      }
    });
    it('rejects another customer returned under the requested checkout', async () => {
      const value = await workspace({ changedCustomer: true });
      try {
        await open(value.page);
        await browserExpect(
          value.page.getByText('This sale changed. Refresh it before viewing customer details.'),
        ).toBeVisible();
        await browserExpect(value.page.getByText('guest@example.test')).toHaveCount(0);
      } finally {
        await value.context.close();
      }
    });
    it('aborts an old operator response before it can publish private fields', async () => {
      let release = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const value = await workspace({ hold });
      try {
        await open(value.page);
        await browserExpect.poll(() => value.requests.length).toBe(1);
        await value.page.evaluate(() => window.customerProfileFixture.changeOperator());
        release();
        await browserExpect(value.page.getByRole('alert')).toBeVisible();
        await browserExpect(value.page.getByText('guest@example.test')).toHaveCount(0);
        expect(value.errors).toEqual([]);
      } finally {
        release();
        await value.context.close();
      }
    });
    it('saves only changed fields and refreshes the checkout version before further editing', async () => {
      const value = await workspace();
      try {
        await editGender(value.page);
        await browserExpect(value.page.getByText('Male', { exact: true })).toBeVisible();
        expect(value.mutationInputs).toHaveLength(1);
        expect(value.mutationInputs[0]).toMatchObject({
          expectedVersion: 1,
          expectedEtag: 'a'.repeat(64),
          changes: { gender: 'M' },
        });
        expect(Object.keys(value.mutationInputs[0]!.changes)).toEqual(['gender']);
        await browserExpect
          .poll(() => value.page.evaluate(() => window.customerProfileFixture.pending))
          .toBe(false);
        expect(value.errors).toEqual([]);
      } finally {
        await value.context.close();
      }
    });
    it('retains an uncertain intent across offline hiding and reconciles with GET without redispatching', async () => {
      const value = await workspace({ mutation: 'lost' });
      try {
        await editGender(value.page);
        await browserExpect(
          value.page.getByText(
            'The update is unconfirmed. Check its saved status before retrying.',
          ),
        ).toBeVisible();
        await browserExpect(
          value.page.getByRole('button', { name: 'Hide customer details' }),
        ).toBeDisabled();
        expect(await value.page.evaluate(() => window.customerProfileFixture.pending)).toBe(true);
        await value.page.evaluate(() => window.customerProfileFixture.online(false));
        await browserExpect(value.page.getByText('guest@example.test')).toHaveCount(0);
        await browserExpect(
          value.page.getByRole('button', { name: 'Check saved update' }),
        ).toBeHidden();
        await value.page.evaluate(() => window.customerProfileFixture.online(true));
        await value.page.getByRole('button', { name: 'Check saved update' }).click();
        await browserExpect(value.page.getByText('Male', { exact: true })).toBeVisible();
        expect(value.mutationInputs).toHaveLength(1);
        expect(
          value.requests.filter((path) => path.includes('/customer-profile-adjustments/')),
        ).toHaveLength(1);
        expect(value.errors).toEqual([]);
      } finally {
        await value.context.close();
      }
    });
    it('uses the exact UUID and body for an explicit retry after missing proof', async () => {
      const value = await workspace({ mutation: 'missing-proof' });
      try {
        await editGender(value.page);
        await value.page.getByRole('button', { name: 'Check saved update' }).click();
        await browserExpect(
          value.page.getByText(
            'No saved update is visible yet. Check again, or retry the exact saved update.',
          ),
        ).toBeVisible();
        await value.page.getByRole('button', { name: 'Retry exact saved update' }).click();
        await browserExpect(value.page.getByText('Male', { exact: true })).toBeVisible();
        expect(value.mutationInputs).toHaveLength(2);
        expect(value.mutationInputs[1]).toEqual(value.mutationInputs[0]);
      } finally {
        await value.context.close();
      }
    });
    it('refreshes after a confirmed write without repeating it when the first UI refresh fails', async () => {
      const value = await workspace();
      try {
        await value.page.evaluate(() => window.customerProfileFixture.refreshFailure(true));
        await editGender(value.page);
        await browserExpect(
          value.page.getByText('Customer details were saved. Reload the sale before continuing.'),
        ).toBeVisible();
        await browserExpect(
          value.page.getByRole('button', { name: 'Retry exact saved update' }),
        ).toHaveCount(0);
        await value.page.evaluate(() => window.customerProfileFixture.refreshFailure(false));
        await value.page.getByRole('button', { name: 'Reload sale', exact: true }).click();
        await browserExpect(value.page.getByText('Male', { exact: true })).toBeVisible();
        expect(value.mutationInputs).toHaveLength(1);
      } finally {
        await value.context.close();
      }
    });
    it('releases definite rejections and keeps wrong-customer success responses unconfirmed', async () => {
      const rejected = await workspace({ mutation: 'rejected' });
      try {
        await editGender(rejected.page);
        await browserExpect(
          rejected.page.getByText('Customer details changed. Reload them before saving.'),
        ).toBeVisible();
        await browserExpect
          .poll(() => rejected.page.evaluate(() => window.customerProfileFixture.pending))
          .toBe(false);
        await browserExpect(
          rejected.page.getByRole('button', { name: 'Save customer details' }),
        ).toBeEnabled();
      } finally {
        await rejected.context.close();
      }
      const wrong = await workspace({ mutation: 'wrong-customer' });
      try {
        await editGender(wrong.page);
        await browserExpect(
          wrong.page.getByText(
            'The update is unconfirmed. Check its saved status before retrying.',
          ),
        ).toBeVisible();
        await browserExpect(
          wrong.page.locator('.customer-profile-panel dd').filter({ hasText: /^Male$/ }),
        ).toHaveCount(0);
        await browserExpect(
          wrong.page.locator('.customer-profile-panel dd').filter({ hasText: /^Female$/ }),
        ).toHaveCount(1);
        expect(wrong.mutationInputs).toHaveLength(1);
      } finally {
        await wrong.context.close();
      }
    });
    it('renders the complete briefing and escaped recommendations with size stock and operational notes', async () => {
      const value = await workspace();
      try {
        await value.page.getByRole('button', { name: 'Customer insights', exact: true }).click();
        const card = value.page.getByRole('article', { name: 'Customer briefing' });
        await browserExpect(card.getByRole('heading')).toContainText('<img src=x');
        await browserExpect(card.getByText('★ Exclusive')).toBeVisible();
        await browserExpect(card.getByText('🎂 Birthday month')).toBeVisible();
        await browserExpect(card.getByText('₹2,000')).toBeVisible();
        await browserExpect(card.getByText('₹50,000')).toBeVisible();
        await browserExpect(card.getByText('M → L Tees')).toBeVisible();
        await card.locator('summary').filter({ hasText: 'Try the saved tee' }).click();
        await browserExpect(
          card.getByRole('table', { name: 'Stock by size for Fixture tee' }),
        ).toBeVisible();
        await browserExpect(card.getByRole('cell', { name: '2', exact: true })).toBeVisible();
        await browserExpect(card.getByText('No image')).toBeVisible();
        await browserExpect(card.getByText('⚠ Ask before applying')).toBeVisible();
        expect(
          await value.page.evaluate(() => Reflect.get(window, 'insightPwned')),
        ).toBeUndefined();
        expect(await card.locator('img').count()).toBe(0);
        expect(value.errors).toEqual([]);
      } finally {
        await value.context.close();
      }
    });
    it('reuses the scoped three-minute memory cache and requires current session before reopening', async () => {
      const value = await workspace();
      try {
        await value.page.getByRole('button', { name: 'Customer insights', exact: true }).click();
        await browserExpect(
          value.page.getByRole('article', { name: 'Customer briefing' }),
        ).toBeVisible();
        await value.page.getByRole('button', { name: 'Hide customer insights' }).click();
        await value.page.getByRole('button', { name: 'Customer insights', exact: true }).click();
        await browserExpect(
          value.page.getByRole('article', { name: 'Customer briefing' }),
        ).toBeVisible();
        expect(value.requests.filter((path) => path.endsWith('/customer-insights'))).toHaveLength(
          1,
        );
        await value.page.getByRole('button', { name: 'Hide customer insights' }).click();
        await value.page.evaluate(() => window.customerProfileFixture.expire());
        await value.page.getByRole('button', { name: 'Customer insights', exact: true }).click();
        await browserExpect(
          value.page.getByText('Sign in with a current operator session for this store.'),
        ).toBeVisible();
        await browserExpect(
          value.page.getByRole('article', { name: 'Customer briefing' }),
        ).toHaveCount(0);
        expect(value.requests.filter((path) => path.endsWith('/customer-insights'))).toHaveLength(
          1,
        );
      } finally {
        await value.context.close();
      }
    });
    it('hides the briefing offline and isolates provider failures from customer details', async () => {
      const value = await workspace();
      try {
        await value.page.getByRole('button', { name: 'Customer insights', exact: true }).click();
        await browserExpect(
          value.page.getByRole('article', { name: 'Customer briefing' }),
        ).toBeVisible();
        await value.page.evaluate(() => window.customerProfileFixture.online(false));
        await browserExpect(
          value.page.getByRole('article', { name: 'Customer briefing' }),
        ).toHaveCount(0);
        await browserExpect(
          value.page.getByRole('button', { name: 'Customer insights', exact: true }),
        ).toBeDisabled();
      } finally {
        await value.context.close();
      }
      const failed = await workspace({ insightFailure: true });
      try {
        await failed.page.getByRole('button', { name: 'Customer insights', exact: true }).click();
        await browserExpect(
          failed.page.getByText('Customer insights are unavailable. You can continue the sale.'),
        ).toBeVisible();
        await open(failed.page);
        await browserExpect(failed.page.getByText('guest@example.test')).toBeVisible();
        expect(failed.errors).toEqual([]);
      } finally {
        await failed.context.close();
      }
    });
    it('rejects an insight response for another POS customer even though service IDs may differ', async () => {
      const value = await workspace({ wrongInsightCustomer: true });
      try {
        await value.page.getByRole('button', { name: 'Customer insights', exact: true }).click();
        await browserExpect(
          value.page.getByText('This sale changed. Reopen customer insights.'),
        ).toBeVisible();
        await browserExpect(
          value.page.getByRole('article', { name: 'Customer briefing' }),
        ).toHaveCount(0);
      } finally {
        await value.context.close();
      }
    });
    it('shows scoped current benefits without rounding count IDs or persisting customer fields, then hides them offline', async () => {
      const value = await workspace();
      try {
        await value.page.getByRole('button', { name: 'Customer benefits', exact: true }).click();
        await browserExpect(value.page.getByText('₹100.12', { exact: true })).toBeVisible();
        await browserExpect(
          value.page.getByText('999999999999999999', { exact: true }),
        ).toBeVisible();
        await browserExpect(
          value.page.getByText('Temporarily unavailable', { exact: true }),
        ).toBeVisible();
        await browserExpect(
          value.page.getByText("User's Membership is deactivated.", { exact: true }),
        ).toBeVisible();
        const stored = await value.page.evaluate(() => window.customerProfileFixture.storedData());
        expect(stored).not.toContain('2060-01-02');
        expect(stored).not.toContain('999999999999999999');
        await value.page.evaluate(() => window.customerProfileFixture.online(false));
        await browserExpect(value.page.getByText('₹100.12', { exact: true })).toHaveCount(0);
        expect(value.requests.filter((path) => path.endsWith('/customer-benefits'))).toHaveLength(
          1,
        );
        expect(value.errors).toEqual([]);
      } finally {
        await value.context.close();
      }
    });
    it('rejects customer benefits returned for another customer or checkout version', async () => {
      for (const option of [{ wrongBenefitsCustomer: true }, { wrongBenefitsVersion: true }]) {
        const value = await workspace(option);
        try {
          await value.page.getByRole('button', { name: 'Customer benefits', exact: true }).click();
          await browserExpect(
            value.page.getByText('This sale changed. Reopen customer benefits.'),
          ).toBeVisible();
          await browserExpect(value.page.getByText('₹100.12', { exact: true })).toHaveCount(0);
        } finally {
          await value.context.close();
        }
      }
    });
    it('keeps the existing profile usable when the benefits reader is unavailable', async () => {
      const value = await workspace({ benefitsFailure: true });
      try {
        await value.page.getByRole('button', { name: 'Customer benefits', exact: true }).click();
        await browserExpect(
          value.page.getByText('Customer benefits are temporarily unavailable.'),
        ).toBeVisible();
        await open(value.page);
        await browserExpect(value.page.getByText('guest@example.test')).toBeVisible();
        expect(value.mutationInputs).toEqual([]);
      } finally {
        await value.context.close();
      }
    });
    it('discards a late benefits response after the operator changes', async () => {
      let release = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const value = await workspace({ hold });
      try {
        await value.page.getByRole('button', { name: 'Customer benefits', exact: true }).click();
        await browserExpect.poll(() => value.requests.length).toBe(1);
        await value.page.evaluate(() => window.customerProfileFixture.changeOperator());
        release();
        await browserExpect(value.page.getByRole('alert')).toBeVisible();
        await browserExpect(value.page.getByText('₹100.12', { exact: true })).toHaveCount(0);
        expect(value.errors).toEqual([]);
      } finally {
        release();
        await value.context.close();
      }
    });
    it('renders historical totals, exact long IDs and inert product names with scoped order links', async () => {
      const value = await workspace();
      try {
        await value.page.getByRole('button', { name: 'Customer history', exact: true }).click();
        await browserExpect(
          value.page.getByRole('heading', { name: 'Recent orders', exact: true }),
        ).toBeVisible();
        await browserExpect(
          value.page.getByText(BigInt('9007199254740993').toLocaleString('en-IN'), { exact: true }),
        ).toBeVisible();
        await browserExpect(
          value.page.getByRole('button', {
            name: 'View items for order 9007199254740993',
            exact: true,
          }),
        ).toBeVisible();
        await browserExpect(
          value.page
            .getByRole('cell')
            .filter({ hasText: '<img src=x onerror="window.historyPwned=true">' }),
        ).toBeVisible();
        expect(
          await value.page.evaluate(() => Reflect.get(window, 'historyPwned')),
        ).toBeUndefined();
        expect(
          await value.page
            .getByRole('link', { name: 'View feedback', exact: true })
            .getAttribute('href'),
        ).toBe(
          '/stores/1/checkout-sessions/a53b9ec4-76ce-4641-95d5-7d3f4f073ab4/customers/777/orders/9007199254740993/feedback',
        );
        expect(
          await value.page
            .getByRole('link', { name: 'Open order', exact: true })
            .first()
            .getAttribute('href'),
        ).toBe('/orders?orderId=9007199254740993');
        const stored = await value.page.evaluate(() => window.customerProfileFixture.storedData());
        expect(stored).not.toContain('9007199254740993');
        expect(stored).not.toContain('historyPwned');
        await value.page.evaluate(() => window.customerProfileFixture.online(false));
        await browserExpect(
          value.page.getByRole('heading', { name: 'Recent orders', exact: true }),
        ).toHaveCount(0);
        expect(value.errors).toEqual([]);
      } finally {
        await value.context.close();
      }
    });
    it('pages through all returned orders and per-line items while preserving duplicate SKU rows', async () => {
      const value = await workspace();
      try {
        await value.page.getByRole('button', { name: 'Customer history', exact: true }).click();
        await value.page
          .getByRole('button', {
            name: 'View all items for returned order 9007199254740995',
            exact: true,
          })
          .click();
        const items = value.page.getByRole('region', {
          name: 'Items for order 9007199254740995',
          exact: true,
        });
        await browserExpect(items.getByRole('listitem')).toHaveCount(2);
        await browserExpect(items.getByText('Repeated product', { exact: true })).toHaveCount(2);
        await items.getByRole('button', { name: 'More items', exact: true }).click();
        await browserExpect(items.getByText('Last order item', { exact: true })).toBeVisible();
        await browserExpect(
          items.getByRole('button', { name: 'More items', exact: true }),
        ).toBeDisabled();
        await value.page.getByRole('button', { name: 'More returned orders', exact: true }).click();
        await browserExpect(
          value.page.getByText('Older returned item', { exact: true }),
        ).toBeVisible();
        await browserExpect(items).toHaveCount(0);
        await browserExpect(
          value.page.getByRole('button', { name: 'More returned orders', exact: true }),
        ).toBeDisabled();
        await value.page.getByRole('button', { name: 'Previous returns', exact: true }).click();
        await browserExpect(
          value.page.getByRole('button', {
            name: 'View returned order 9007199254740995',
            exact: true,
          }),
        ).toBeVisible();
        expect(value.requests.filter((path) => path.endsWith('/customer-history'))).toHaveLength(3);
        expect(value.requests.filter((path) => path.endsWith('/lines'))).toHaveLength(2);
        expect(value.errors).toEqual([]);
      } finally {
        await value.context.close();
      }
    });
    it('rejects mismatched history customer/version and order-line scope', async () => {
      for (const option of [{ wrongHistoryCustomer: true }, { wrongHistoryVersion: true }]) {
        const value = await workspace(option);
        try {
          await value.page.getByRole('button', { name: 'Customer history', exact: true }).click();
          await browserExpect(
            value.page.getByText('This sale changed. Reopen customer history.'),
          ).toBeVisible();
          await browserExpect(
            value.page.getByRole('heading', { name: 'Recent orders', exact: true }),
          ).toHaveCount(0);
        } finally {
          await value.context.close();
        }
      }
      const value = await workspace({ wrongLineOrder: true });
      try {
        await value.page.getByRole('button', { name: 'Customer history', exact: true }).click();
        await value.page
          .getByRole('button', { name: 'View items for order 9007199254740993', exact: true })
          .click();
        const items = value.page.getByRole('region', {
          name: 'Items for order 9007199254740993',
          exact: true,
        });
        await browserExpect(
          items.getByText('The order items could not be verified for this customer.'),
        ).toBeVisible();
        await browserExpect(items.getByRole('listitem')).toHaveCount(0);
      } finally {
        await value.context.close();
      }
    });
    it('discards historical results after an operator change during the request', async () => {
      let release = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const value = await workspace({ hold });
      try {
        await value.page.getByRole('button', { name: 'Customer history', exact: true }).click();
        await browserExpect.poll(() => value.requests.length).toBe(1);
        await value.page.evaluate(() => window.customerProfileFixture.changeOperator());
        release();
        await browserExpect(value.page.getByRole('alert')).toBeVisible();
        await browserExpect(
          value.page.getByRole('heading', { name: 'Recent orders', exact: true }),
        ).toHaveCount(0);
        expect(value.errors).toEqual([]);
      } finally {
        release();
        await value.context.close();
      }
    });
    it('keeps current customer details usable when historical data is unavailable', async () => {
      const value = await workspace({ historyFailure: true });
      try {
        await value.page.getByRole('button', { name: 'Customer history', exact: true }).click();
        await browserExpect(
          value.page.getByText('Historical reports are temporarily unavailable.'),
        ).toBeVisible();
        await open(value.page);
        await browserExpect(value.page.getByText('guest@example.test')).toBeVisible();
        expect(value.mutationInputs).toEqual([]);
      } finally {
        await value.context.close();
      }
    });
    it('rejects a malformed continuation instead of skipping customer return rows', async () => {
      const value = await workspace({ badHistoryCursor: true });
      try {
        await value.page.getByRole('button', { name: 'Customer history', exact: true }).click();
        await browserExpect(
          value.page.getByText(
            'The historical page could not be verified. Refresh customer history.',
          ),
        ).toBeVisible();
        await browserExpect(
          value.page.getByRole('heading', { name: 'Recent orders', exact: true }),
        ).toHaveCount(0);
      } finally {
        await value.context.close();
      }
    });
  },
);
