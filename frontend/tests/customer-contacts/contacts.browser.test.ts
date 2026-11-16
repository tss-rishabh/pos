import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';
import {
  contactChallenge,
  contactCreateInput,
  contactVerifyInput,
  contactVersionInput,
  contactCommitInput,
  type ContactChallenge,
} from '../../src/pages/customer-contacts/api';

describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'verified customer contacts in Chromium',
  { timeout: 15000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        configFile: false,
        cacheDir: 'node_modules/.vite-customer-contact-tests',
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__contact-test__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__contact-test__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/customer-contacts/harness.tsx"></script></body></html>',
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
        throw new Error('Contact browser fixture failed to bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });
    async function fixture(page: Page, kind: 'telephone' | 'email' = 'email') {
      page.setDefaultTimeout(7000);
      const state = {
        kind,
        record: null as ContactChallenge | null,
        checkoutVersion: 5,
        dropCreate: false,
        dropCommit: false,
        holdCreate: false,
        releaseCreate: () => undefined as void,
        createSeen: false,
        posts: [] as { path: string; operator: string; input: Record<string, unknown> }[],
        urls: [] as string[],
        receipts: new Map<string, unknown>(),
        commits: 0,
      };
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname,
          actor = request.headers()['x-operator-id'] ?? '';
        state.urls.push(url.href);
        if (url.search || !['1', '2'].includes(actor)) {
          await route.fulfill({
            status: 403,
            json: { error: { code: 'ACTOR_CHANGED', message: 'Operator changed.' } },
          });
          return;
        }
        if (path === '/api/v1/contact-fixture-checkout') {
          await route.fulfill({ json: { version: state.checkoutVersion } });
          return;
        }
        if (path.endsWith('/customer-contacts')) {
          await route.fulfill({
            json: {
              customerId: '7',
              checkoutVersion: state.checkoutVersion,
              contactFingerprint: 'a'.repeat(64),
              enabled: true,
              addableKinds: [state.kind],
              activeChallenge: actor === '1' ? state.record : null,
              pendingElsewhere: false,
            },
          });
          return;
        }
        if (path.endsWith('/customer-contact-challenges') && request.method() === 'POST') {
          const input = contactCreateInput.parse(request.postDataJSON() as unknown);
          state.posts.push({ path, operator: actor, input });
          state.createSeen = true;
          if (!state.record)
            state.record = contactChallenge.parse({
              id: input.operationId,
              kind: input.kind,
              stage: 'current',
              status: 'PENDING_CURRENT',
              version: 1,
              customerId: '7',
              value: input.value,
              currentDestination: input.kind === 'telephone' ? 'e•••@example.test' : '••••••3210',
              expiresAt: Date.now() + 1200000,
              codeExpiresAt: Date.now() + 600000,
              retryAt: Date.now() - 1000,
              attemptsRemaining: 3,
              delivery: 'DELIVERED',
            });
          if (state.holdCreate)
            await new Promise<void>((resolve) => {
              state.releaseCreate = resolve;
            });
          if (state.dropCreate) {
            state.dropCreate = false;
            await route.abort('failed');
            return;
          }
          await route.fulfill({ json: state.record }).catch(() => undefined);
          return;
        }
        if (path.includes('/operations/')) {
          const receipt = state.receipts.get(path.split('/').at(-1)!);
          await route.fulfill(
            receipt
              ? { json: { challenge: state.record, receipt } }
              : {
                  status: 404,
                  json: { error: { code: 'NOT_FOUND', message: 'No saved operation.' } },
                },
          );
          return;
        }
        if (request.method() === 'GET' && state.record && path.endsWith('/' + state.record.id)) {
          await route.fulfill({ json: state.record });
          return;
        }
        if (request.method() === 'POST' && state.record) {
          const action = path.split('/').at(-1),
            input =
              action === 'verifications'
                ? contactVerifyInput.parse(request.postDataJSON() as unknown)
                : action === 'commits'
                  ? contactCommitInput.parse(request.postDataJSON() as unknown)
                  : contactVersionInput.parse(request.postDataJSON() as unknown);
          state.posts.push({ path, operator: actor, input });
          let receipt = state.receipts.get(input.operationId);
          if (!receipt) {
            const wrong =
              'code' in input &&
              input.code !== (state.record.stage === 'current' ? '111111' : '222222');
            state.record = { ...state.record, version: state.record.version + 1 };
            receipt = {
              id: input.operationId,
              challengeId: state.record.id,
              status: wrong ? 'error' : 'success',
              message: wrong ? 'The verification code is incorrect.' : 'Contact operation saved.',
              ...(wrong ? { errorCode: 'CUSTOMER_CONTACT_CODE_INVALID', errorStatus: 400 } : {}),
            };
            if (wrong) {
              state.record.attemptsRemaining--;
              state.receipts.set(input.operationId, receipt);
              await route.fulfill({
                status: 400,
                json: {
                  error: {
                    code: 'CUSTOMER_CONTACT_CODE_INVALID',
                    message: 'The verification code is incorrect.',
                  },
                },
              });
              return;
            }
            if (action === 'verifications')
              state.record =
                state.record.stage === 'current'
                  ? {
                      ...state.record,
                      stage: 'new',
                      status: 'PENDING_NEW',
                      attemptsRemaining: state.kind === 'email' ? 5 : 3,
                    }
                  : { ...state.record, status: 'READY' };
            if (action === 'commits') {
              state.commits++;
              state.checkoutVersion++;
              state.record.status = 'COMMITTED';
              receipt = {
                ...z.record(z.string(), z.unknown()).parse(receipt),
                checkoutVersion: state.checkoutVersion,
              };
            }
            if (action === 'cancellations') state.record.status = 'CANCELLED';
            state.receipts.set(input.operationId, receipt);
          }
          if (action === 'commits' && state.dropCommit) {
            state.dropCommit = false;
            await route.abort('failed');
            return;
          }
          await route.fulfill({ json: { challenge: state.record, receipt } });
          return;
        }
        await route.fulfill({
          status: 404,
          json: { error: { code: 'NOT_FOUND', message: 'Fixture route unavailable.' } },
        });
      });
      await page.goto(origin + '/__contact-test__');
      await page.getByRole('button', { name: 'Add a missing contact', exact: true }).click();
      return state;
    }
    async function create(page: Page, value = 'new.fixture@example.test') {
      await page.getByLabel('New email', { exact: true }).fill(value);
      await page.getByRole('button', { name: 'Verify existing contact', exact: true }).click();
      await browserExpect(page.getByText('Step 1 of 2:', { exact: false })).toBeVisible();
    }
    async function prove(page: Page) {
      await create(page);
      await page.getByLabel('Verification code', { exact: true }).fill('111111');
      await page.getByRole('button', { name: 'Verify code', exact: true }).click();
      await browserExpect(page.getByText('Step 2 of 2:', { exact: false })).toBeVisible();
      await page.getByLabel('Verification code', { exact: true }).fill('222222');
      await page.getByRole('button', { name: 'Verify code', exact: true }).click();
      await browserExpect(
        page.getByRole('button', { name: 'Confirm contact addition', exact: true }),
      ).toBeVisible();
    }
    it('proves both contact stages and confirms one addition with body-only private data and captured actor', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await prove(page);
        await page.getByRole('button', { name: 'Confirm contact addition', exact: true }).click();
        await browserExpect(page.getByText('Saved refreshes 1', { exact: true })).toBeVisible();
        expect(state.commits).toBe(1);
        expect(state.posts.map((item) => item.operator)).toEqual(['1', '1', '1', '1']);
        expect(
          state.urls.every((url) => !url.includes('example.test') && !url.includes('111111&')),
        ).toBe(true);
      } finally {
        await page.close();
      }
    });
    it('selects the available missing-phone flow and uses its existing email proof', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page, 'telephone');
        await page.getByLabel('New mobile number', { exact: true }).fill('9876543212');
        await page.getByRole('button', { name: 'Verify existing contact', exact: true }).click();
        await browserExpect(
          page.getByText('Step 1 of 2: code sent to e•••@example.test.', { exact: true }),
        ).toBeVisible();
        expect(state.posts[0]?.input.kind).toBe('telephone');
      } finally {
        await page.close();
      }
    });
    it('recovers a lost create response without another POST or losing the target proof', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.dropCreate = true;
        await page.getByLabel('New email', { exact: true }).fill('new.fixture@example.test');
        await page.getByRole('button', { name: 'Verify existing contact', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Check saved status', exact: true }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Check saved status', exact: true }).click();
        await browserExpect(page.getByText('Step 1 of 2:', { exact: false })).toBeVisible();
        expect(state.posts).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
    it('keeps GET reconciliation mounted through busy/version changes after a lost committed response', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await prove(page);
        state.dropCommit = true;
        await page.getByRole('button', { name: 'Confirm contact addition', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Check saved status', exact: true }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Toggle other sale action', exact: true }).click();
        await page.getByRole('button', { name: 'Check saved status', exact: true }).click();
        await browserExpect(page.getByText('Saved refreshes 1', { exact: true })).toBeVisible();
        expect(state.commits).toBe(1);
        expect(state.posts.filter((item) => item.path.endsWith('/commits'))).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
    it('refreshes a committed wrong-attempt receipt before allowing another code', async () => {
      const page = await browser.newPage();
      try {
        await fixture(page);
        await create(page);
        await page.getByLabel('Verification code', { exact: true }).fill('000000');
        await page.getByRole('button', { name: 'Verify code', exact: true }).click();
        await browserExpect(page.getByRole('alert')).toHaveText(
          'The verification code is incorrect.',
        );
        await browserExpect(
          page.getByText('2 attempts remaining.', { exact: false }),
        ).toBeVisible();
        await browserExpect(page.getByLabel('Verification code', { exact: true })).toHaveValue('');
      } finally {
        await page.close();
      }
    });
    it('discards a delayed old-actor response and private form values after operator switch', async () => {
      const page = await browser.newPage();
      let release = () => undefined as void;
      try {
        const state = await fixture(page);
        state.holdCreate = true;
        await page.getByLabel('New email', { exact: true }).fill('private.fixture@example.test');
        await page.getByRole('button', { name: 'Verify existing contact', exact: true }).click();
        await browserExpect.poll(() => state.createSeen).toBe(true);
        release = () => state.releaseCreate();
        await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
        await browserExpect(page.getByText('Current operator 2', { exact: true })).toBeVisible();
        release();
        await browserExpect(
          page.getByText('private.fixture@example.test', { exact: true }),
        ).toHaveCount(0);
        expect(state.posts).toHaveLength(1);
        expect(state.posts[0]?.operator).toBe('1');
      } finally {
        release();
        await page.close();
      }
    });
    it('disables contact forms offline without sending another request', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page),
          before = state.posts.length;
        await page.getByRole('button', { name: 'Toggle connection', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Add a missing contact', exact: true }),
        ).toBeDisabled();
        await browserExpect(page.getByLabel('New email', { exact: true })).toHaveCount(0);
        expect(state.posts).toHaveLength(before);
      } finally {
        await page.close();
      }
    });
  },
);
