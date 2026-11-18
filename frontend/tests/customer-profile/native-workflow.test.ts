import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chromium,
  expect as browserExpect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { build } from 'vite';
import {
  nativeProfileFixture,
  profileApi,
  profileAdjustmentApi,
} from '../../../backend/tools/customer-profile/native-workflow-fixture';
import { customerProfileResponse } from '../../src/pages/customer-insights/client';

// This file is intentionally separate from the older synthetic browser suite.
// Candidate traffic always traverses actual buildApp and disposable MySQL.
describe.skipIf(!process.env.CUSTOMER_PROFILE_WORKFLOW_MYSQL_URL)(
  'pinned profile dispatch / original DOM / production App / authenticated API / native MySQL',
  () => {
    let browser: Browser,
      temporary: string,
      fixture: Awaited<ReturnType<typeof nativeProfileFixture>>;
    const contexts: BrowserContext[] = [];
    beforeAll(async () => {
      temporary = await mkdtemp(join(tmpdir(), 'pos-profile-native-build-'));
      const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
      await build({
        root: frontend,
        configFile: join(frontend, 'vite.config.ts'),
        cacheDir: join(temporary, 'vite-cache'),
        logLevel: 'silent',
        build: {
          outDir: join(temporary, 'dist'),
          emptyOutDir: true,
          rollupOptions: {
            input: [
              join(frontend, 'index.html'),
              join(frontend, 'tests/customer-profile/native-workflow-seed.html'),
            ],
          },
        },
      });
      fixture = await nativeProfileFixture(join(temporary, 'dist'));
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
      await fixture.drain();
    });
    afterAll(async () => {
      await Promise.all(contexts.map((context) => context.close()));
      await browser?.close();
      await fixture?.close();
      if (temporary) await rm(temporary, { recursive: true, force: true });
    });
    async function sourcePage() {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(fixture.origin + '/__profile_source__');
      await browserExpect(page.locator('#update-user')).toBeVisible();
      return page;
    }
    async function workspace() {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      contexts.push(context);
      await context.addCookies([await fixture.cookie()]);
      const page = await context.newPage();
      await page.goto(fixture.origin + '/__profile_seed__');
      await browserExpect(page.locator('body')).toHaveAttribute('data-ready', 'true');
      await page.goto(fixture.origin + '/');
      await browserExpect(page.getByLabel('Current store')).toHaveValue('1');
      await browserExpect(page.getByLabel('Current counter')).toHaveValue('2');
      await page.getByRole('button', { name: 'Review sale', exact: true }).click();
      await browserExpect(
        page.getByRole('button', { name: 'Customer details', exact: true }),
      ).toBeEnabled();
      await page.getByRole('button', { name: 'Customer details', exact: true }).click();
      await browserExpect(
        page.getByRole('button', { name: 'Edit customer details', exact: true }),
      ).toBeEnabled();
      return { page, context };
    }
    async function edit(page: Page) {
      await page.getByRole('button', { name: 'Edit customer details', exact: true }).click();
    }
    async function save(page: Page) {
      await page.getByRole('button', { name: 'Save customer details', exact: true }).click();
    }
    async function http(path = profileApi, body?: Record<string, unknown>, actor = '7') {
      const cookie = await fixture.cookie(actor);
      const response = await fetch(fixture.origin + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Cookie: `${cookie.name}=${cookie.value}`,
          'X-Operator-ID': actor,
          ...(body ? { Origin: fixture.origin, 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, value: (await response.json()) as unknown };
    }
    async function command(changes: Record<string, unknown>) {
      const value = customerProfileResponse.parse((await http()).value);
      return {
        operationId: randomUUID(),
        expectedVersion: value.checkoutVersion,
        expectedEtag: value.etag,
        changes,
      };
    }
    function sourcePost(target: string, fields: Record<string, string>, authenticated = true) {
      return fixture.source(
        'dispatch',
        target,
        new URLSearchParams(fields).toString(),
        authenticated,
      );
    }
    async function sourceProperty(
      page: Page,
      property: 'birthday' | 'anniversary' | 'gender',
      value: string,
    ) {
      const before = fixture.sourceTraffic.length;
      await page.locator('#' + property + '-edit').click();
      const control = page.locator('#' + property + '-value');
      if (property === 'gender') await control.selectOption(value);
      else await control.fill(value);
      await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
      await browserExpect.poll(() => fixture.sourceTraffic.length).toBe(before + 1);
      // In the real browser the undeclared status writes window.status: its
      // DOMString coercion turns null into the truthy string 'null'. The source
      // therefore updates optimistically before AJAX confirmation.
      expect(await page.evaluate(() => window.status)).toBe('null');
      await browserExpect(page.locator('#user-details-' + property)).toHaveText(value);
    }
    function business(rows: Awaited<ReturnType<typeof fixture.rows>>) {
      return rows.map(({ updated_at: _updated, ...row }) => row);
    }

    it('joins exact source DOM property/type/GSTIN requests and native writes to a real production App profile save and quote refresh', async () => {
      const source = await sourcePage();
      await sourceProperty(source, 'birthday', '2004-02-29');
      await sourceProperty(source, 'anniversary', '2022-12-01');
      await sourceProperty(source, 'gender', 'M');
      await source.locator('#customer_type').selectOption('B2B');
      await source.locator('#gstin').fill('27abcde1234f1z5');
      await browserExpect(source.locator('#gstin')).toHaveValue('27ABCDE1234F1Z5');
      await source.locator('#update-user').click();
      await browserExpect.poll(() => fixture.sourceTraffic.length).toBe(4);
      expect(fixture.sourceTraffic.map((row) => row.path)).toEqual([
        '/users/ajax-update-user-data/',
        '/users/ajax-update-user-data/',
        '/users/ajax-update-user-data/',
        '/users/update-user',
      ]);
      for (const [index, property] of ['birthday', 'anniversary', 'gender'].entries())
        expect(fixture.sourceTraffic[index]?.fields).toMatchObject({
          user_id: '777',
          user_property: property,
          property_value: ['2004-02-29', '2022-12-01', 'M'][index],
        });
      expect(fixture.sourceTraffic[3]?.fields).toMatchObject({
        user_id: '777',
        customer_type: 'B2B',
        gstin: '27ABCDE1234F1Z5',
      });
      const expected = business(await fixture.rows());
      await fixture.reset();
      const { page } = await workspace();
      expect(fixture.providerReadCount()).toBeGreaterThan(0);
      await edit(page);
      await page.getByLabel('Birthday', { exact: true }).fill('2004-02-29');
      await page.getByLabel('Anniversary', { exact: true }).fill('2022-12-01');
      await page.getByLabel('Gender', { exact: true }).selectOption('M');
      await page.getByLabel('Customer type', { exact: true }).selectOption('B2B');
      await page.getByLabel('GSTIN', { exact: true }).fill('27abcde1234f1z5');
      await save(page);
      await browserExpect(
        page.getByText(
          'Customer details saved. Recalculate the quote before completing this sale.',
          { exact: true },
        ),
      ).toBeVisible();
      expect(business(await fixture.rows())).toEqual(expected);
      expect(await fixture.receipts()).toHaveLength(1);
      expect((await fixture.checkout()).state).toMatchObject({
        version: 2,
        phase: 'open',
        quote: null,
        customerId: '777',
      });
      expect(
        fixture.traffic.filter((row) => row.method === 'POST' && row.path === profileAdjustmentApi),
      ).toHaveLength(1);
      expect(
        fixture.traffic.some(
          (row) => row.method === 'GET' && row.path === profileApi && row.status === 200,
        ),
      ).toBe(true);
      expect(JSON.stringify(await fixture.receipts())).not.toMatch(
        /2004-02-29|2022-12-01|ABCDE|example\.test|9876543210/,
      );
      await edit(page);
      await page.getByLabel('Customer type', { exact: true }).selectOption('B2C');
      await browserExpect(page.getByLabel('GSTIN', { exact: true })).toHaveCount(0);
      await save(page);
      await browserExpect.poll(async () => (await fixture.checkout()).state.version).toBe(3);
      expect(business(await fixture.rows())).toEqual(
        expected.map((row) =>
          row.id === '777' ? { ...row, customer_type: 'B2C', gstin: '' } : row,
        ),
      );
      expect(await fixture.receipts()).toHaveLength(2);
    });

    it('executes source class MRO, missing/invalid/not-found paths and documents the hardened current-session boundary', async () => {
      const businessAnonymous = sourcePost(
        '/users/update-user',
        { user_id: '777', customer_type: 'B2C', gstin: '' },
        false,
      );
      expect(businessAnonymous.status).toBe(302);
      expect(businessAnonymous.nativeUpdates).toBe(0);
      const propertyAnonymous = sourcePost(
        '/users/ajax-update-user-data/',
        { user_id: '777', user_property: 'gender', property_value: 'O' },
        false,
      );
      expect(propertyAnonymous.mro.AjaxUpdateEndUserDataView?.slice(0, 3)).toEqual([
        'AjaxUpdateEndUserDataView',
        'View',
        'LoginRequiredMixin',
      ]);
      expect(propertyAnonymous.status).toBe(200);
      expect(propertyAnonymous.body).toMatchObject({ status: 200 });
      expect(propertyAnonymous.nativeUpdates).toBe(1);
      const invalidFields: Record<string, string>[] = [
        {},
        { user_id: '777' },
        { user_id: '777', user_property: 'unknown', property_value: 'M' },
        { user_id: '777', user_property: 'gender' },
        { user_id: '999999', user_property: 'gender', property_value: 'M' },
      ];
      for (const fields of invalidFields) {
        const result = sourcePost('/users/ajax-update-user-data/', fields);
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ status: 400 });
        expect(result.nativeUpdates).toBe(0);
      }
      await fixture.reset();
      const before = await fixture.rows();
      const anonymous = await fetch(fixture.origin + profileApi);
      expect(anonymous.status).toBe(401);
      const invalid = await http(profileAdjustmentApi, await command({ gender: 'X' }));
      expect(invalid.status).toBe(400);
      expect(await fixture.rows()).toEqual(before);
      expect(await fixture.receipts()).toEqual([]);
    });

    it('retains exact source B2B validation, cancellation, sanitization and normal B2C clearing using actual source controls', async () => {
      const source = await sourcePage();
      const before = await fixture.rows();
      await source.locator('#birthday-edit').click();
      await source.getByRole('dialog').getByRole('button', { name: 'cancel', exact: true }).click();
      expect(fixture.sourceTraffic).toEqual([]);
      await source.locator('#customer_type').selectOption('B2B');
      await source.locator('#gstin').fill('');
      await source.locator('#update-user').click();
      expect(fixture.sourceTraffic).toEqual([]);
      await source.locator('#gstin').fill('short');
      await source.locator('#update-user').click();
      expect(fixture.sourceTraffic).toEqual([]);
      expect(await fixture.rows()).toEqual(before);
      await source.locator('#gstin').fill('27ab!cde1234f1z5EXTRA');
      await browserExpect(source.locator('#gstin')).toHaveValue('27ABCDE1234F1Z5');
      await source.locator('#customer_type').selectOption('B2C');
      await browserExpect(source.locator('#gstin')).toHaveValue('');
      await source.locator('#update-user').click();
      await browserExpect.poll(() => fixture.sourceTraffic.length).toBe(1);
      expect(fixture.sourceTraffic[0]?.fields.gstin).toBe('');
      // The source business-only SQL leaves updated_at unchanged.
      expect(await fixture.rows()).toEqual(before);
      await fixture.reset();
      const { page } = await workspace();
      expect(fixture.providerReadCount()).toBeGreaterThan(0);
      await edit(page);
      await page.getByLabel('Customer type', { exact: true }).selectOption('B2B');
      await page.getByLabel('GSTIN', { exact: true }).fill('short');
      await save(page);
      await browserExpect(
        page.getByText('Choose a valid change. Business customers need a 15 character GSTIN.', {
          exact: true,
        }),
      ).toBeVisible();
      expect(
        fixture.traffic.filter((row) => row.method === 'POST' && row.path === profileAdjustmentApi),
      ).toEqual([]);
      await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
      expect(await fixture.rows()).toEqual(before);
    });

    it('loses only the committed response then confirms the original native receipt through the actual App without a second POST', async () => {
      const { page } = await workspace();
      expect(fixture.providerReadCount()).toBeGreaterThan(0);
      await edit(page);
      await page.getByLabel('Gender', { exact: true }).selectOption('O');
      fixture.loseNextCommittedResponse();
      await save(page);
      await browserExpect(
        page.getByText('The update is unconfirmed. Check its saved status before retrying.', {
          exact: true,
        }),
      ).toBeVisible();
      expect((await fixture.rows())[0]?.gender).toBe('O');
      expect(await fixture.receipts()).toHaveLength(1);
      await page.getByRole('button', { name: 'Check saved update', exact: true }).click();
      await browserExpect(
        page.getByText(
          'Customer details saved. Recalculate the quote before completing this sale.',
          { exact: true },
        ),
      ).toBeVisible();
      expect(
        fixture.traffic.filter((row) => row.method === 'POST' && row.path === profileAdjustmentApi),
      ).toHaveLength(1);
      expect(
        fixture.traffic.some(
          (row) =>
            row.method === 'GET' &&
            row.path.startsWith(profileAdjustmentApi + '/') &&
            row.status === 200,
        ),
      ).toBe(true);
      expect(await fixture.receipts()).toHaveLength(1);
    });

    it('rejects a stale actual App edit after native attached-customer/version changes, then refuses archived and wrong-store authority', async () => {
      const { page } = await workspace();
      expect(fixture.providerReadCount()).toBeGreaterThan(0);
      await edit(page);
      await page.getByLabel('Gender', { exact: true }).selectOption('O');
      const before = await fixture.rows();
      await fixture.attachCustomer('778', 2);
      await save(page);
      await browserExpect
        .poll(() =>
          fixture.traffic.some(
            (row) =>
              row.method === 'POST' && row.path === profileAdjustmentApi && row.status === 409,
          ),
        )
        .toBe(true);
      expect(await fixture.rows()).toEqual(before);
      expect(await fixture.receipts()).toEqual([]);
      expect((await http(profileApi, undefined, '8')).status).toBe(403);
      const activeCookie = await fixture.cookie();
      await fixture.archiveOperator(false);
      const archived = await fetch(fixture.origin + profileApi, {
        headers: { Cookie: `${activeCookie.name}=${activeCookie.value}`, 'X-Operator-ID': '7' },
      });
      expect(archived.status).toBe(401);
      await fixture.archiveOperator(true);
      await fixture.archiveStore(false);
      const archivedStore = await http();
      expect(archivedStore.status).toBe(409);
      expect(archivedStore.value).toMatchObject({ error: { code: 'STORE_UNAVAILABLE' } });
      expect(await fixture.rows()).toEqual(before);
    });

    it('executes original native date and SQL error outcomes without copying raw-error disclosure into candidate responses', async () => {
      const before = await fixture.rows();
      const badDate = sourcePost('/users/ajax-update-user-data/', {
        user_id: '777',
        user_property: 'birthday',
        property_value: 'not-a-date',
      });
      expect(badDate.status).toBe(500);
      expect(badDate.exceptionType).toBe('ValidationError');
      expect(await fixture.rows()).toEqual(before);
      await fixture.rejectGstin();
      const original = sourcePost('/users/update-user', {
        user_id: '777',
        customer_type: 'B2B',
        gstin: '27ERROR1234F1Z5',
      });
      expect(original.status).toBe(200);
      expect(original.body).toMatchObject({ status: 500 });
      expect(await fixture.rows()).toEqual(before);
      const input = await command({ customerType: 'B2B', gstin: '27ERROR1234F1Z5' });
      const actual = await http(profileAdjustmentApi, input);
      expect(actual.status).toBe(500);
      expect(JSON.stringify(actual.value)).not.toMatch(
        /CHECK|profile_workflow_gstin|27ERROR1234F1Z5|UPDATE users/i,
      );
      expect(await fixture.rows()).toEqual(before);
      expect(await fixture.receipts()).toEqual([]);
    });

    it('rolls back native profile/version/receipt together after a controlled late DB fault and permits one exact confirmed retry', async () => {
      const input = await command({ gender: 'M' }),
        before = await fixture.rows(),
        checkout = await fixture.checkout();
      await fixture.rejectLateWrite();
      const failed = await http(profileAdjustmentApi, input);
      expect(failed.status).toBe(500);
      expect(await fixture.rows()).toEqual(before);
      expect(await fixture.checkout()).toEqual(checkout);
      expect(await fixture.receipts()).toEqual([]);
      expect((await http(profileAdjustmentApi + '/' + input.operationId)).status).toBe(404);
      await fixture.allowWrites();
      expect((await http(profileAdjustmentApi, input)).status).toBe(200);
      expect((await http(profileAdjustmentApi, input)).status).toBe(200);
      expect(await fixture.receipts()).toHaveLength(1);
      expect((await fixture.rows())[0]?.gender).toBe('M');
    });
  },
);
