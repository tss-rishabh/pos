import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chromium,
  expect as browserExpect,
  type Browser,
  type BrowserContext,
} from '@playwright/test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import {
  feedbackCommand,
  feedbackComment,
  feedbackOrder,
  nativeFeedbackFixture,
} from '../../../backend/tools/product-feedback/native-workflow-fixture';
import { feedbackWorkspace } from '../../../backend/src/modules/product-feedback/contracts';
import { storeListSchema } from '../../src/api/schemas';
import { registerSourceBrowserWorkflows } from './source-browser-workflows';

describe.skipIf(!process.env.PRODUCT_FEEDBACK_WORKFLOW_MYSQL_URL)(
  'pinned source / actual authenticated API / built feedback UI / native MySQL',
  () => {
    let browser: Browser,
      temporary: string,
      fixture: Awaited<ReturnType<typeof nativeFeedbackFixture>>;
    const contexts: BrowserContext[] = [];
    beforeAll(async () => {
      temporary = await mkdtemp(join(tmpdir(), 'pos-native-feedback-build-'));
      const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
      await build({
        root: frontend,
        configFile: false,
        cacheDir: join(temporary, 'vite-cache'),
        plugins: [react()],
        logLevel: 'silent',
        build: {
          outDir: join(temporary, 'dist'),
          emptyOutDir: true,
          rollupOptions: { input: join(frontend, 'tests/product-feedback/native-workflow.html') },
        },
      });
      await build({
        root: frontend,
        configFile: join(frontend, 'vite.config.ts'),
        cacheDir: join(temporary, 'production-vite-cache'),
        logLevel: 'silent',
        build: { outDir: join(temporary, 'production-dist'), emptyOutDir: true },
      });
      fixture = await nativeFeedbackFixture(
        join(temporary, 'dist'),
        join(temporary, 'production-dist'),
      );
      const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      const executablePath =
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
        (process.platform === 'darwin' && existsSync(mac) ? mac : undefined);
      browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
    });
    beforeEach(async () => {
      await fixture.reset();
    });
    afterEach(async () => {
      await Promise.all(contexts.splice(0).map((context) => context.close()));
      await fixture?.drainSource();
    });
    afterAll(async () => {
      await Promise.all(contexts.map((context) => context.close()));
      await browser?.close();
      await fixture?.close();
      if (temporary) await rm(temporary, { recursive: true, force: true });
    });
    async function workspace(orderId = feedbackOrder) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      contexts.push(context);
      await context.addCookies([await fixture.cookie()]);
      const page = await context.newPage();
      const consoleMessages: string[] = [];
      page.on('console', (message) => consoleMessages.push(message.text()));
      await page.goto(fixture.origin + fixture.path.replace(feedbackOrder, orderId));
      return { context, page, consoleMessages };
    }
    async function read(id = '7', path = fixture.api) {
      const cookie = await fixture.cookie(id);
      const response = await fetch(fixture.origin + path, {
        headers: { Cookie: `${cookie.name}=${cookie.value}`, 'X-Operator-Id': id },
      });
      return { response, value: (await response.json()) as unknown };
    }
    async function post(raw: Record<string, unknown>, path = fixture.api) {
      const cookie = await fixture.cookie();
      const response = await fetch(fixture.origin + path, {
        method: 'POST',
        headers: {
          Cookie: `${cookie.name}=${cookie.value}`,
          Origin: fixture.origin,
          'X-Operator-Id': '7',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(raw),
      });
      return { response, value: (await response.json()) as unknown };
    }
    async function fill(page: Awaited<ReturnType<typeof workspace>>['page']) {
      await page.getByLabel('Overall rating for line 9007199254740997').fill('4.5');
      await page.getByLabel('Product size for line 9007199254740997').fill('3.2');
      await page.getByLabel('Comment for line 9007199254740997').fill(feedbackComment);
      await page.getByRole('button', { name: 'Save feedback', exact: true }).first().click();
    }
    function normalized(page: ReturnType<typeof feedbackWorkspace.parse>) {
      return [
        {
          id: page.orderId,
          orderAmount: page.orderAmount,
          items: page.items.map((item) => ({
            productId: item.productId,
            name: item.name,
            feedback: item.feedback.map(({ id: _id, ...rating }) => rating),
          })),
        },
      ];
    }
    registerSourceBrowserWorkflows({
      fixture: () => fixture,
      browser: () => browser,
      contexts,
      candidate: workspace,
    });

    it('enters the actual production App with a native session and enforces selected-store and current-customer gates for an older order', async () => {
      fixture.useProductionApp();
      const { page } = await workspace();
      await browserExpect(page.getByLabel('Current store')).toHaveValue('1');
      await browserExpect(
        page.getByRole('button', { name: 'Save feedback', exact: true }),
      ).toHaveCount(2);
      for (const path of [
        '/api/v1/auth/sessions/current',
        '/api/v1/stores',
        '/api/v1/stores/1/counters',
      ]) {
        await browserExpect
          .poll(() => fixture.traffic.some((row) => row.path === path && row.status === 200))
          .toBe(true);
      }
      const feedbackCalls = () => fixture.traffic.filter((row) => row.path.startsWith(fixture.api));
      const beforeSwitch = feedbackCalls().length;
      await page.getByLabel('Current store').selectOption('2');
      await browserExpect(
        page.getByText('Open product feedback from the customer history in your current store.', {
          exact: true,
        }),
      ).toBeVisible();
      await browserExpect(
        page.getByRole('button', { name: 'Save feedback', exact: true }),
      ).toHaveCount(0);
      await page.reload();
      await browserExpect(page.getByLabel('Current store')).toHaveValue('2');
      await browserExpect(
        page.getByText('Open product feedback from the customer history in your current store.', {
          exact: true,
        }),
      ).toBeVisible();
      expect(feedbackCalls()).toHaveLength(beforeSwitch);
      expect(await fixture.rows()).toEqual([]);
      await page.getByLabel('Current store').selectOption('1');
      await browserExpect(
        page.getByRole('button', { name: 'Save feedback', exact: true }),
      ).toHaveCount(2);
      await fixture.attachCustomer('778', 2);
      await page.reload();
      await browserExpect(
        page.getByRole('button', { name: 'Save feedback', exact: true }),
      ).toHaveCount(0);
      await browserExpect.poll(() => feedbackCalls().some((row) => row.status === 404)).toBe(true);
      expect(await fixture.rows()).toEqual([]);
      await fixture.attachCustomer('777', 1);
      await page.reload();
      await browserExpect(
        page.getByRole('button', { name: 'Save feedback', exact: true }),
      ).toHaveCount(2);
      await fill(page);
      await browserExpect(page.getByText('Product feedback saved.', { exact: true })).toBeVisible();
      expect(await fixture.rows()).toHaveLength(4);
      expect(
        feedbackCalls().filter((row) => row.method === 'POST' && row.status === 200),
      ).toHaveLength(1);
    });

    it('renders exact duplicate source occurrences and all four constrained controls through the real API', async () => {
      const original = fixture.originalRead();
      expect(original.queries).toBeGreaterThanOrEqual(6);
      expect(original.orders[0]?.items).toHaveLength(2);
      expect(original.mainHtml.match(/type="number"/g)).toHaveLength(8);
      expect(original.mainHtml.match(/max=5 min=0 step=0\.1/g)).toHaveLength(8);
      expect(original.mainHtml.match(/maxlength="255"/g)).toHaveLength(2);
      const actual = await read();
      expect(actual.response.status).toBe(200);
      expect(normalized(feedbackWorkspace.parse(actual.value))).toEqual(original.orders);
      const { page } = await workspace();
      await browserExpect(
        page.getByRole('button', { name: 'Save feedback', exact: true }),
      ).toHaveCount(2);
      await browserExpect(page.locator('input[type="number"]')).toHaveCount(8);
      await browserExpect(
        page.getByLabel('Overall rating for line 9007199254740997'),
      ).toHaveAttribute('required', '');
      await browserExpect(page.getByLabel('Comment for line 9007199254740997')).toHaveAttribute(
        'maxlength',
        '255',
      );
      await browserExpect(
        page.getByText('<Synthetic feedback product>', { exact: true }),
      ).toHaveCount(2);
      expect(
        fixture.traffic.some(
          (row) => row.method === 'GET' && row.path.startsWith(fixture.api) && row.status === 200,
        ),
      ).toBe(true);
    });
    it('executes the original four Django writes on this physical fixture, then matches a real UI submission and defaults', async () => {
      const source = fixture.originalWrite();
      expect(source.responses.map((row) => row.status)).toEqual(['200', '200', '200', '200']);
      expect(source.nativeInserts).toBe(4);
      expect(source.queries).toBeGreaterThanOrEqual(4);
      const expectedRows = await fixture.rows();
      expect(expectedRows).toHaveLength(4);
      await fixture.reset();
      const { page, consoleMessages } = await workspace();
      await fill(page);
      await browserExpect(page.getByText('Product feedback saved.', { exact: true })).toBeVisible();
      expect(await fixture.rows()).toEqual(expectedRows);
      expect(
        fixture.traffic.filter((row) => row.method === 'POST' && row.path === fixture.api),
      ).toHaveLength(1);
      const original = fixture.originalRead(),
        actual = await read();
      expect(normalized(feedbackWorkspace.parse(actual.value))).toEqual(original.orders);
      await page.reload();
      await browserExpect(page.getByRole('button', { name: 'Save feedback' })).toHaveCount(0);
      await browserExpect(page.getByRole('table')).toHaveCount(2);
      expect(await page.evaluate(() => Object.hasOwn(window, 'feedbackPwned'))).toBe(false);
      expect(consoleMessages.join('\n')).not.toContain(feedbackComment);
      const stored = await page.evaluate(() => window.nativeFeedbackStored());
      expect(stored).not.toContain(feedbackComment);
    });
    it('loses the response only after native commit, then recovers through real receipt GET without a second POST', async () => {
      fixture.loseNextCommittedResponse();
      const { page } = await workspace();
      await fill(page);
      await browserExpect(
        page.getByText('The result is unknown. Check this submission before trying again.'),
      ).toBeVisible();
      expect(await fixture.rows()).toHaveLength(4);
      await page.getByRole('button', { name: 'Check submission', exact: true }).click();
      await browserExpect(page.getByText('Product feedback saved.', { exact: true })).toBeVisible();
      expect(
        fixture.traffic.filter((row) => row.method === 'POST' && row.path === fixture.api),
      ).toHaveLength(1);
      expect(
        fixture.traffic.filter(
          (row) => row.method === 'GET' && row.path.includes('/submissions/') && row.status === 200,
        ),
      ).toHaveLength(1);
      expect(await fixture.rows()).toHaveLength(4);
    });
    it('preserves native partial/null/unknown-option/mobile source data and makes both SKU occurrences readonly', async () => {
      await fixture.seedPartial();
      const original = fixture.originalRead(),
        actual = await read();
      expect(normalized(feedbackWorkspace.parse(actual.value))).toEqual(original.orders);
      const { page } = await workspace();
      await browserExpect(page.getByRole('table')).toHaveCount(2);
      await browserExpect(page.getByRole('button', { name: 'Save feedback' })).toHaveCount(0);
      expect(await page.locator('img, script:not([src])').count()).toBe(0);
      const result = await post(feedbackCommand);
      expect(result.response.status).toBe(409);
      expect(result.value).toMatchObject({ error: { code: 'PRODUCT_FEEDBACK_ALREADY_EXISTS' } });
      expect(await fixture.rows()).toHaveLength(4);
    });
    it('uses genuine current sessions for all five roles and refuses wrong store/customer/order/product/version or archived authority', async () => {
      for (const role of [1, 2, 3, 4, 5]) {
        await fixture.setRole(role);
        expect((await read()).response.status).toBe(200);
      }
      await fixture.setRole(4);
      expect(fixture.originalRead('778').orders).toEqual([]);
      expect(
        (await read('7', fixture.api.replace('/customers/777/', '/customers/778/'))).response
          .status,
      ).toBe(404);
      expect(
        (await read('7', fixture.api.replace(feedbackOrder, '9007199254740994'))).response.status,
      ).toBe(404);
      expect((await read('8')).response.status).toBe(403);
      expect((await post({ ...feedbackCommand, productId: '11' })).response.status).toBe(404);
      expect((await post({ ...feedbackCommand, expectedVersion: 2 })).response.status).toBe(409);
      const cookie = await fixture.cookie();
      await fixture.archiveOperator(false);
      const archived = await fetch(fixture.origin + fixture.api, {
        headers: {
          Cookie: `${cookie.name}=${cookie.value}`,
          'X-Operator-Id': '7',
        },
      });
      expect(archived.status).toBe(401);
      await fixture.archiveOperator(true);
      expect(await fixture.rows()).toEqual([]);
    });
    it('normalizes a native NULL store display location and bootstraps the production App without changing native store or checkout data', async () => {
      const baseline = storeListSchema.parse((await read('7', '/api/v1/stores')).value);
      await fixture.setStoreLocation(null);
      const nativeBefore = await fixture.bootstrapRows();
      expect(nativeBefore.stores.find((store) => store.id === '1')?.location_code).toBeNull();
      const actual = await read('7', '/api/v1/stores');
      expect(actual.response.status).toBe(200);
      expect(storeListSchema.parse(actual.value)).toEqual({
        data: baseline.data.map((store) =>
          store.id === '1' ? { ...store, locationCode: '' } : store,
        ),
      });
      fixture.useProductionApp();
      const { page } = await workspace();
      await browserExpect(page.getByLabel('Current store')).toHaveValue('1');
      await browserExpect(
        page.getByRole('button', { name: 'Save feedback', exact: true }),
      ).toHaveCount(2);
      expect(await page.getByLabel('Current store').locator('option').allTextContents()).toEqual([
        'Synthetic store 1',
        'Synthetic store 2',
      ]);
      expect(
        fixture.traffic.some(
          (row) =>
            new URL(row.path, fixture.origin).pathname === fixture.api &&
            row.method === 'GET' &&
            row.status === 200,
        ),
      ).toBe(true);
      expect(fixture.traffic.filter((row) => row.method !== 'GET')).toEqual([]);
      expect(await fixture.bootstrapRows()).toEqual(nativeBefore);
      expect(await fixture.rows()).toEqual([]);
    });
  },
);
