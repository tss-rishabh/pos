import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  expect as browserExpect,
  type Browser,
  type Page,
  type Locator,
} from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  importApprovalReasonSchema,
  type ImportApprovalResponse,
} from '../../src/pages/administration/order-imports/approval-client';
import {
  approvalJobId,
  approvalGrantId,
  approvalJob,
  approvalResult,
  approvalResponse,
  approvalIntent,
} from './approval-fixtures';
import { importApprovalIntentSchema } from '../../src/pages/administration/order-imports/approval-journal';

describe.skipIf(process.env.ORDER_IMPORT_BROWSER_TESTS !== 'true')(
  'actual CSV financial approval recovery',
  { timeout: 20000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = await mkdtemp(join(tmpdir(), 'pos-order-approvals-vite-'));
      server = await createServer({
        configFile: false,
        cacheDir: cache,
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__order-approvals__')) return next();
        try {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            await server.transformIndexHtml(
              '/__order-approvals__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/order-imports/harness.tsx"></script></body></html>',
            ),
          );
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Isolated approval browser failed.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : {}),
      });
    }, 25000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cache) await rm(cache, { recursive: true, force: true });
    });
    async function fixture(page: Page) {
      page.setDefaultTimeout(7000);
      const state = {
        job: approvalJob(),
        rows: [approvalResult()],
        posts: [] as {
          commandId: string;
          reason: z.infer<typeof importApprovalReasonSchema>;
          operationId: string;
        }[],
        gets: [] as string[],
        otherMutations: [] as string[],
        receipts: new Map<string, ImportApprovalResponse>(),
        latest: approvalResponse(),
        drop: false,
        commitBeforeDrop: true,
        hold: false,
        release: () => {},
        deny: false,
        errors: [] as string[],
      };
      page.on('pageerror', (error) => state.errors.push(error.message));
      await page.route('**/api/v1/admin/order-imports**', async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname,
          method = request.method();
        expect(['44', '45']).toContain(request.headers()['x-operator-id']);
        if (method === 'GET') state.gets.push(path);
        if (path.endsWith('/capabilities'))
          return route.fulfill({
            json: {
              ready: true,
              canPreview: true,
              kinds: ['offline', 'shopify'],
              maximumFileBytes: 5242880,
              maximumRows: 50000,
              maximumStores: 100,
            },
          });
        if (request.headers()['x-operator-id'] === '45' || state.deny)
          return route.fulfill({
            status: 403,
            json: {
              error: {
                code: 'ORDER_IMPORT_ACCESS_CHANGED',
                message: 'Current import authority changed.',
              },
            },
          });
        if (path.endsWith('/results'))
          return route.fulfill({ json: { data: state.rows, nextAfter: null } });
        const match = /\/orders\/([^/]+)\/approvals(?:\/([^/]+))?$/.exec(path);
        if (match) {
          const operationId = z.uuid().parse(match[1]),
            commandId = match[2];
          if (method === 'GET') {
            const value = commandId
              ? (state.receipts.get(commandId) ??
                approvalResponse(commandId, false, 'late-recording', operationId))
              : { ...state.latest, review: { ...state.latest.review, operationId } };
            return route.fulfill({ json: value });
          }
          const body = z
              .object({ commandId: z.uuid(), reason: importApprovalReasonSchema })
              .strict()
              .parse(request.postDataJSON() as unknown),
            value = approvalResponse(body.commandId, true, body.reason, operationId);
          state.posts.push({ ...body, operationId });
          const storage = await page.evaluate(() =>
            Object.fromEntries(
              Object.entries(localStorage).filter(([key]) =>
                key.startsWith('pos-order-import-approval:'),
              ),
            ),
          );
          expect(
            Object.values(storage).some(
              (raw) =>
                importApprovalIntentSchema.parse(JSON.parse(raw) as unknown).commandId ===
                body.commandId,
            ),
          ).toBe(true);
          expect(JSON.stringify(storage)).not.toMatch(
            /price|amount|lineValue|csv|email|customer|productId/,
          );
          if (!state.drop || state.commitBeforeDrop) state.receipts.set(body.commandId, value);
          if (state.hold)
            await new Promise<void>((resolve) => {
              state.release = resolve;
            });
          return state.drop ? route.abort() : route.fulfill({ status: 201, json: value });
        }
        if (method === 'GET' && path.endsWith('/' + state.job.id))
          return route.fulfill({ json: state.job });
        state.otherMutations.push(method + ' ' + path);
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'UNEXPECTED_FIXTURE_ACTION',
              message: 'No order or financial action is permitted by this fixture.',
            },
          },
        });
      });
      return state;
    }
    async function open(page: Page) {
      await page.goto(origin + '/__order-approvals__');
      await page.getByLabel('Import reference', { exact: true }).fill(approvalJobId);
      await page.getByRole('button', { name: 'Refresh import', exact: true }).click();
      await browserExpect(page.getByText('Status: QUEUED', { exact: true })).toBeVisible();
    }
    const rowReview = (page: Page, row = 2) =>
      page.getByRole('row').filter({
        has: page.getByRole('button', {
          name: `Review financial approval for CSV row ${row}`,
          exact: true,
        }),
      });
    async function review(page: Page, row = 2) {
      const parent = rowReview(page, row);
      await parent
        .getByRole('button', { name: `Review financial approval for CSV row ${row}`, exact: true })
        .click();
      const panel = parent.getByRole('region', { name: 'Financial approval review', exact: true });
      await browserExpect(panel.getByText('INR 50.98', { exact: true })).toBeVisible();
      return panel;
    }
    async function grant(panel: Locator) {
      await panel
        .getByLabel('I reviewed the original date, payment value and all products.', {
          exact: true,
        })
        .check();
      await panel.getByRole('button', { name: 'Grant financial approval', exact: true }).click();
    }
    const markers = (page: Page) =>
      page.evaluate(() =>
        Object.entries(localStorage).filter(([key]) =>
          key.startsWith('pos-order-import-approval:'),
        ),
      );
    async function restoreJob(page: Page) {
      await page.getByLabel('Import reference', { exact: true }).fill(approvalJobId);
      await page.getByRole('button', { name: 'Refresh import', exact: true }).click();
    }

    it('lazily reviews exact source date/value/products and grants only after explicit confirmation', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        await open(page);
        expect(state.gets.filter((path) => path.includes('/approvals'))).toEqual([]);
        const panel = await review(page);
        await browserExpect(panel.getByText('2026-06-15', { exact: true })).toBeVisible();
        await browserExpect(
          panel.getByRole('cell', { name: '9007199254740993', exact: true }),
        ).toBeVisible();
        await browserExpect(panel.getByText('INR 25.49', { exact: true })).toBeVisible();
        await browserExpect(
          panel.getByRole('button', { name: 'Grant financial approval', exact: true }),
        ).toBeDisabled();
        await panel
          .getByLabel('Approval reason', { exact: true })
          .selectOption('historical-correction');
        await grant(panel);
        await browserExpect(panel.getByText(approvalGrantId, { exact: true })).toBeVisible();
        expect(state.posts).toHaveLength(1);
        expect(state.posts[0]!.commandId).not.toBe(approvalGrantId);
        expect(state.posts[0]!.reason).toBe('historical-correction');
        expect(await markers(page)).toEqual([]);
        expect(state.otherMutations).toEqual([]);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('recovers a lost committed response by exact-command GET after reload without another approval or order', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        state.drop = true;
        await open(page);
        const panel = await review(page);
        await grant(panel);
        await browserExpect(
          panel.getByText('Saved approval request:', { exact: false }),
        ).toBeVisible();
        expect(await markers(page)).toHaveLength(1);
        const command = state.posts[0]!.commandId;
        await page.reload();
        await restoreJob(page);
        await browserExpect(
          rowReview(page).getByText(approvalGrantId, { exact: true }),
        ).toBeVisible();
        expect(state.posts).toHaveLength(1);
        expect(state.gets.some((path) => path.endsWith('/approvals/' + command))).toBe(true);
        expect(await markers(page)).toEqual([]);
        expect(state.otherMutations).toEqual([]);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('retains an absent original receipt despite a newer latest grant; retry is explicit and uses the same UUID/reason', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        state.drop = true;
        state.commitBeforeDrop = false;
        await open(page);
        const panel = await review(page);
        await panel
          .getByLabel('Approval reason', { exact: true })
          .selectOption('source-reconciliation');
        await grant(panel);
        await browserExpect(
          panel.getByText('Saved approval request:', { exact: false }),
        ).toBeVisible();
        const original = state.posts[0]!;
        state.latest = approvalResponse(null, true, 'historical-correction');
        const latestReads = state.gets.filter((path) => path.endsWith('/approvals')).length;
        await page.reload();
        await restoreJob(page);
        const restored = rowReview(page).getByRole('region', {
            name: 'Financial approval review',
            exact: true,
          }),
          retry = restored.getByRole('button', {
            name: 'Retry same approval request',
            exact: true,
          });
        await browserExpect(retry).toBeDisabled();
        expect(await markers(page)).toHaveLength(1);
        expect(state.posts).toHaveLength(1);
        expect(state.gets.filter((path) => path.endsWith('/approvals'))).toHaveLength(latestReads);
        await page.getByRole('button', { name: 'Go offline', exact: true }).click();
        await browserExpect(retry).toBeDisabled();
        await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
        await browserExpect(restored.getByText('INR 50.98', { exact: true })).toBeVisible();
        await restored
          .getByLabel('I reviewed the original date, payment value and all products.', {
            exact: true,
          })
          .check();
        state.drop = false;
        await retry.click();
        await browserExpect(restored.getByText(approvalGrantId, { exact: true })).toBeVisible();
        expect(state.posts).toEqual([original, original]);
        expect(await markers(page)).toEqual([]);
        expect(state.otherMutations).toEqual([]);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it.each(['expired', 'stale'] as const)(
      'shows an %s original grant and never renews from GET',
      async (kind) => {
        const context = await browser.newContext(),
          page = await context.newPage();
        try {
          const state = await fixture(page),
            latest = approvalResponse(null, true);
          if (kind === 'expired') {
            latest.approval!.issuedAt = Date.now() - 3600001;
            latest.approval!.expiresAt = latest.approval!.issuedAt + 3600000;
            latest.approval!.status = 'stale';
          } else latest.approval!.status = 'stale';
          state.latest = latest;
          await open(page);
          const panel = await review(page);
          await browserExpect(
            panel.getByText(kind === 'expired' ? 'Expired approval' : 'Stale approval', {
              exact: false,
            }),
          ).toBeVisible();
          await browserExpect(
            panel.getByRole('button', { name: 'Grant financial approval', exact: true }),
          ).toBeDisabled();
          await panel.getByRole('button', { name: 'Refresh approval status', exact: true }).click();
          await browserExpect(panel.getByText('INR 50.98', { exact: true })).toBeVisible();
          expect(state.posts).toHaveLength(0);
          expect(await markers(page)).toEqual([]);
          expect(state.otherMutations).toEqual([]);
          expect(state.errors).toEqual([]);
        } finally {
          await context.close();
        }
      },
    );
    it('retains pending commands after a changed-authority denial and never treats it as an absent receipt', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        state.drop = true;
        state.commitBeforeDrop = false;
        await open(page);
        await grant(await review(page));
        await browserExpect(
          page.getByText('Saved approval request:', { exact: false }),
        ).toBeVisible();
        state.deny = true;
        await page.reload();
        const saved = page.getByRole('region', {
          name: 'Saved financial approval requests',
          exact: true,
        });
        await saved.getByRole('button', { name: /Recover approval/ }).click();
        const panel = saved.getByRole('region', { name: 'Financial approval review', exact: true });
        await browserExpect(
          panel.getByText('Current import authority changed.', { exact: true }),
        ).toBeVisible();
        await browserExpect(
          panel.getByRole('button', { name: 'Retry same approval request', exact: true }),
        ).toHaveCount(0);
        expect(await markers(page)).toHaveLength(1);
        expect(state.posts).toHaveLength(1);
        expect(state.otherMutations).toEqual([]);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('blocks approval dispatch when its metadata cannot be persisted', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        await page.addInitScript(() => {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key: string, value: string) {
            if (key.startsWith('pos-order-import-approval:'))
              throw new DOMException('Fixture quota', 'QuotaExceededError');
            original.call(this, key, value);
          };
        });
        const state = await fixture(page);
        await open(page);
        const panel = await review(page);
        await grant(panel);
        await browserExpect(
          panel.getByText(
            'The approval reference could not be saved. No approval request was sent.',
            { exact: true },
          ),
        ).toBeVisible();
        expect(state.posts).toHaveLength(0);
        expect(await markers(page)).toEqual([]);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('blocks a corrupt saved row marker without posting or losing it', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        await page.addInitScript((value) => {
          localStorage.setItem(
            'pos-order-import-approval:' + JSON.stringify(['44', value.jobId, value.operationId]),
            '{corrupt',
          );
        }, approvalIntent());
        const state = await fixture(page);
        await page.goto(origin + '/__order-approvals__');
        await browserExpect(
          page.getByText(
            'The saved approval references are unreadable. Keep this device for administrator recovery.',
            { exact: true },
          ),
        ).toBeVisible();
        expect(await markers(page)).toHaveLength(1);
        expect(state.posts).toHaveLength(0);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it.each(['operator', 'assignments'] as const)(
      'discards a late approval after the %s scope changes without retiring the original marker',
      async (change) => {
        const context = await browser.newContext(),
          page = await context.newPage();
        try {
          const state = await fixture(page);
          state.hold = true;
          await open(page);
          await grant(await review(page));
          await browserExpect.poll(() => state.posts.length).toBe(1);
          state.deny = true;
          await page
            .getByRole('button', {
              name: change === 'operator' ? 'Switch operator' : 'Change store assignments',
              exact: true,
            })
            .click();
          state.release();
          await browserExpect(page.getByText(approvalGrantId, { exact: true })).toHaveCount(0);
          await browserExpect(page.getByLabel('Store ID 1', { exact: true })).toHaveValue('');
          expect(await markers(page)).toHaveLength(1);
          expect(state.posts).toHaveLength(1);
          expect(state.errors).toEqual([]);
        } finally {
          await context.close();
        }
      },
    );
    it('keeps independent row markers recoverable after preparing another file', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page),
          second = '55555555-5555-4555-8555-555555555555';
        state.job = approvalJob({ totalOrders: 2 });
        state.rows = [
          approvalResult(),
          approvalResult({ sequence: 2, firstRow: 3, operationId: second }),
        ];
        state.drop = true;
        await open(page);
        await grant(await review(page));
        await browserExpect.poll(() => state.posts.length).toBe(1);
        await grant(await review(page, 3));
        await browserExpect.poll(() => state.posts.length).toBe(2);
        expect(await markers(page)).toHaveLength(2);
        state.job = {
          ...state.job,
          state: 'CANCELLED',
          cancelledOrders: 2,
          completedAt: '2026-11-17 12:01:00',
        };
        state.rows = state.rows.map((row) => ({ ...row, state: 'CANCELLED' }));
        await page.getByRole('button', { name: 'Refresh import', exact: true }).click();
        const prepare = page.getByRole('button', { name: 'Prepare another file', exact: true });
        await browserExpect(prepare).toBeEnabled();
        await prepare.click();
        expect(await markers(page)).toHaveLength(2);
        await browserExpect(
          page.getByRole('region', { name: 'Import status', exact: true }),
        ).toHaveCount(0);
        const saved = page.getByRole('region', {
          name: 'Saved financial approval requests',
          exact: true,
        });
        await saved
          .getByRole('button', {
            name: 'Recover approval ' + state.posts[0]!.commandId,
            exact: true,
          })
          .click();
        await browserExpect.poll(async () => (await markers(page)).length).toBe(1);
        await saved
          .getByRole('button', {
            name: 'Recover approval ' + state.posts[1]!.commandId,
            exact: true,
          })
          .click();
        await browserExpect.poll(async () => (await markers(page)).length).toBe(0);
        await browserExpect(page.getByLabel('Store ID 1', { exact: true })).toHaveValue('');
        expect(state.posts).toHaveLength(2);
        expect(state.otherMutations).toEqual([]);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('keeps the original marker if assignment changes while receipt retirement is waiting for another tab', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        state.hold = true;
        await open(page);
        const panel = await review(page);
        await grant(panel);
        await browserExpect.poll(() => state.posts.length).toBe(1);
        const [entry] = await markers(page);
        expect(entry).toBeDefined();
        await page.evaluate(async (key) => {
          await new Promise<void>((ready) => {
            void navigator.locks.request(key, async () => {
              ready();
              await new Promise<void>((resolve) => {
                Object.assign(window, { releaseApprovalReferenceLock: resolve });
              });
            });
          });
        }, entry![0]);
        state.release();
        await browserExpect(panel.getByText(approvalGrantId, { exact: true })).toBeVisible();
        state.deny = true;
        await page.getByRole('button', { name: 'Change store assignments', exact: true }).click();
        await page.evaluate(() => {
          const release = Reflect.get(window, 'releaseApprovalReferenceLock') as unknown;
          if (typeof release === 'function') release();
        });
        await browserExpect(page.getByText(approvalGrantId, { exact: true })).toHaveCount(0);
        expect(await markers(page)).toHaveLength(1);
        expect(state.posts).toHaveLength(1);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
    it('handles development StrictMode remounts with GET-only review and one explicitly granted command', async () => {
      const context = await browser.newContext(),
        page = await context.newPage();
      try {
        const state = await fixture(page);
        await page.goto(origin + '/__order-approvals__?strict');
        await restoreJob(page);
        const panel = await review(page);
        await grant(panel);
        await browserExpect(panel.getByText(approvalGrantId, { exact: true })).toBeVisible();
        expect(state.posts).toHaveLength(1);
        expect(await markers(page)).toEqual([]);
        expect(state.otherMutations).toEqual([]);
        expect(state.errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  },
);
