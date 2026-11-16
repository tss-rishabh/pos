import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';
import type { BatchDetails } from '../../src/pages/administration/gift-card-batches/api';

describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'gift card batches in Chromium',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        configFile: false,
        cacheDir: 'node_modules/.vite-administration-gift-card-batch-tests',
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__administration-test__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__administration-test__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/administration/browser-harness.tsx"></script></body></html>',
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
        throw new Error('Gift batch browser fixture did not bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });
    async function fixture(page: Page) {
      page.setDefaultTimeout(5000);
      const record: BatchDetails = {
        id: '71',
        size: 3,
        message: 'Fixture batch',
        completed: true,
        blocked: false,
        printed: false,
        createdById: '1',
        createdByName: 'Fixture administrator',
        createdAt: '2026-11-16 12:00:00',
        version: 'a'.repeat(64),
        artifactAvailable: true,
        job: {
          phase: 'DELIVERED',
          errorCode: null,
          updatedAt: '2026-11-16 10:00:00.000',
          version: 'b'.repeat(64),
          canRetry: true,
        },
      };
      const state = {
        record,
        created: true,
        dropCreate: false,
        dropMutation: false,
        staleOnce: false,
        holdPassword: false,
        passwordRequested: false,
        releasePassword: () => undefined as void,
        archives: 0,
        createInputs: [] as { operationId: string; size: number; message: string }[],
        mutations: [] as {
          path: string;
          input: {
            operationId: string;
            expectedVersion: string;
            blocked?: boolean;
            printed?: true;
            confirmResend?: boolean;
          };
        }[],
        searches: [] as Record<string, unknown>[],
        headers: [] as string[],
        receipts: new Map<
          string,
          { id: string; batchId: string; status: 'success'; message: string }
        >(),
      };
      const archive = Buffer.from('PK-synthetic-fixture-encrypted-archive');
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        state.headers.push(request.headers()['x-operator-id'] || '');
        if (url.search || request.headers()['x-operator-id'] !== '1') {
          await route.fulfill({
            status: 403,
            json: { error: { code: 'ACTOR_CHANGED', message: 'The signed-in operator changed.' } },
          });
          return;
        }
        const path = url.pathname,
          base = '/api/v1/gift-card-batches';
        if (path === base + '/capabilities') {
          await route.fulfill({
            json: {
              today: '2026-11-16',
              timeZone: 'Asia/Kolkata',
              generationAvailable: true,
              recipient: 'fixture@example.test',
              historyAvailable: true,
              maxSize: 10000,
            },
          });
          return;
        }
        if (path === base + '/current-jobs') {
          await route.fulfill({ json: { data: state.created ? [state.record] : [] } });
          return;
        }
        if (path === base + '/search') {
          const input = z.record(z.string(), z.unknown()).parse(request.postDataJSON() as unknown);
          state.searches.push(input);
          await route.fulfill({
            json: {
              reader:
                input.from === '2026-11-16' && input.to === '2026-11-16'
                  ? 'data-reader'
                  : 'bigquery',
              today: '2026-11-16',
              recordsTotal: '12',
              recordsFiltered: '12',
              start: input.start || 0,
              length: input.length || 10,
              data: [{ ...state.record, id: '9007199254740993', message: '=HYPERLINK("fixture")' }],
            },
          });
          return;
        }
        if (path === base && request.method() === 'POST') {
          const input = z
            .object({ operationId: z.uuid(), size: z.number(), message: z.string() })
            .parse(request.postDataJSON() as unknown);
          state.createInputs.push(input);
          state.created = true;
          state.record.size = input.size;
          state.record.message = input.message;
          const receipt = state.receipts.get(input.operationId) || {
            id: input.operationId,
            batchId: '71',
            status: 'success' as const,
            message: 'Gift card generation queued.',
          };
          state.receipts.set(input.operationId, receipt);
          if (state.dropCreate) {
            state.dropCreate = false;
            await route.abort('failed');
            return;
          }
          await route.fulfill({ json: receipt });
          return;
        }
        if (path === base + '/71' && request.method() === 'GET') {
          await route.fulfill({ json: state.record });
          return;
        }
        if (path === base + '/71/artifact-access') {
          state.passwordRequested = true;
          if (state.holdPassword)
            await new Promise<void>((resolve) => {
              state.releasePassword = resolve;
            });
          await route.fulfill({
            json: { filename: 'gift-cards-71.zip', password: 'p'.repeat(43) },
          });
          return;
        }
        if (path === base + '/71/archive') {
          state.archives++;
          await route.fulfill({
            headers: {
              'Content-Type': 'application/zip',
              'Content-Length': String(archive.length),
            },
            body: archive,
          });
          return;
        }
        if (
          ['/print-status', '/block-status', '/retries'].some(
            (suffix) => path === base + '/71' + suffix,
          )
        ) {
          const input = z
            .object({
              operationId: z.uuid(),
              expectedVersion: z.string(),
              blocked: z.boolean().optional(),
              printed: z.literal(true).optional(),
              confirmResend: z.boolean().optional(),
            })
            .parse(request.postDataJSON() as unknown);
          state.mutations.push({ path, input });
          const replay = state.receipts.get(input.operationId);
          if (replay) {
            await route.fulfill({ json: replay });
            return;
          }
          if (state.staleOnce) {
            state.staleOnce = false;
            state.record.version = 'c'.repeat(64);
            await route.fulfill({
              status: 409,
              json: {
                error: {
                  code: 'GIFT_CARD_BATCH_CHANGED',
                  message: 'This batch changed. Reload before confirming again.',
                },
              },
            });
            return;
          }
          if (path.endsWith('/print-status')) state.record.printed = true;
          if (path.endsWith('/block-status')) state.record.blocked = input.blocked === true;
          if (path.endsWith('/retries'))
            state.record.job = {
              ...state.record.job!,
              phase: 'DELIVERED',
              version: 'd'.repeat(64),
            };
          state.record.version = 'e'.repeat(64);
          const receipt = {
            id: input.operationId,
            batchId: '71',
            status: 'success' as const,
            message: 'Batch updated.',
          };
          state.receipts.set(input.operationId, receipt);
          if (state.dropMutation) {
            state.dropMutation = false;
            await route.abort('failed');
            return;
          }
          await route.fulfill({ json: receipt });
          return;
        }
        await route.fulfill({
          status: 404,
          json: { error: { code: 'NOT_FOUND', message: 'Fixture resource was not found.' } },
        });
      });
      return state;
    }
    const open = (page: Page) =>
      page.goto(origin + '/__administration-test__?screen=gift-card-batches');
    it('retries the same creation after a committed response is lost and exposes the recoverable current batch', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.created = false;
        state.dropCreate = true;
        await open(page);
        await page.getByLabel('Number of gift cards').fill('3');
        await page.getByLabel('Gift card batch message').fill('Synthetic cards');
        await page.getByRole('button', { name: 'Generate gift cards', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Retry generation request' }),
        ).toBeEnabled();
        await browserExpect(page.getByLabel('Number of gift cards')).toBeDisabled();
        await page.getByRole('button', { name: 'Retry generation request' }).click();
        await browserExpect(
          page.getByRole('region', { name: 'Selected gift card batch' }),
        ).toBeVisible();
        expect(state.createInputs).toHaveLength(2);
        expect(state.createInputs[1]).toEqual(state.createInputs[0]);
        expect(state.receipts.size).toBe(1);
        await browserExpect(
          page.getByRole('button', { name: 'Batch 71', exact: true }),
        ).toBeVisible();
      } finally {
        await page.close();
      }
    }, 15000);
    it('retains idempotent print/block commands and refreshes a rejected stale revision', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await open(page);
        await page.getByRole('button', { name: 'Batch 71', exact: true }).click();
        state.staleOnce = true;
        await page.getByRole('button', { name: 'Mark as printed', exact: true }).click();
        await page.getByRole('button', { name: 'Confirm batch change' }).click();
        await browserExpect(page.getByRole('dialog')).toContainText(
          'This batch changed. Reload before confirming again.',
        );
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Reload batch' }).click();
        await page.getByRole('button', { name: 'Mark as printed', exact: true }).click();
        await page.getByRole('button', { name: 'Confirm batch change' }).click();
        await browserExpect(page.getByRole('dialog')).not.toBeVisible();
        expect(state.mutations[1]!.input.expectedVersion).toBe('c'.repeat(64));
        expect(state.mutations[1]!.input.operationId).not.toBe(
          state.mutations[0]!.input.operationId,
        );
        state.dropMutation = true;
        await page.getByRole('button', { name: 'Block batch', exact: true }).click();
        await page.getByRole('button', { name: 'Confirm batch change' }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Confirm batch change' }),
        ).toBeEnabled();
        await page.getByRole('button', { name: 'Confirm batch change' }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Unblock batch', exact: true }),
        ).toBeVisible();
        expect(state.mutations[3]).toEqual(state.mutations[2]);
      } finally {
        await page.close();
      }
    }, 15000);
    it('requires an explicit inbox review before resending an uncertain email', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.record.job = { ...state.record.job!, phase: 'UNCERTAIN' };
        await open(page);
        await page.getByRole('button', { name: 'Batch 71', exact: true }).click();
        await page.getByRole('button', { name: 'Retry batch delivery' }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Confirm batch change' }),
        ).toBeDisabled();
        await page
          .getByRole('checkbox', {
            name: 'I checked the inbox and want to send the same encrypted file again.',
          })
          .check();
        await page.getByRole('button', { name: 'Confirm batch change' }).click();
        await browserExpect(
          page.getByRole('region', { name: 'Selected gift card batch' }),
        ).toContainText('Email accepted');
        expect(state.mutations[0]!.input.confirmResend).toBe(true);
      } finally {
        await page.close();
      }
    });
  it('downloads private bytes, keeps the password out of browser storage and clears it on close', async () => {
      const page = await browser.newPage();
      try {
        await fixture(page);
        await open(page);
        await page.getByRole('button', { name: 'Batch 71', exact: true }).click();
        await page.getByRole('button', { name: 'Show archive password' }).click();
        await browserExpect(page.getByLabel('Gift card archive password')).toHaveText(
          'p'.repeat(43),
        );
        const download = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download encrypted CSV' }).click();
        expect((await download).suggestedFilename()).toBe('gift-cards-71.zip');
        expect(
          await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
        ).not.toContain('p'.repeat(43));
        await page.getByRole('button', { name: 'Close batch' }).click();
        await browserExpect(page.getByLabel('Gift card archive password')).not.toBeVisible();
      } finally {
        await page.close();
      }
    });
    it('uses body filters, preserves exact IDs and exports only visible current-page columns', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await open(page);
        await browserExpect(
          page.getByRole('button', { name: '9007199254740993', exact: true }),
        ).toBeVisible();
        await page.getByLabel('Search gift card batches').fill('fixture@example.test');
        await page.getByRole('button', { name: 'Today', exact: true }).click();
        await browserExpect(
          page.getByText('Today’s report reader', { exact: false }),
        ).toBeVisible();
        expect(state.searches.at(-1)).toMatchObject({
          search: 'fixture@example.test',
          from: '2026-11-16',
          to: '2026-11-16',
        });
        await page.getByText('Columns', { exact: true }).click();
        await page.getByRole('checkbox', { name: 'Message', exact: true }).uncheck();
        await browserExpect(
          page.getByRole('columnheader', { name: 'Message', exact: true }),
        ).not.toBeVisible();
        const downloading = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Export current page CSV' }).click();
        const path = await (await downloading).path();
        if (!path) throw new Error('Fixture CSV was not downloaded.');
        const csv = await readFile(path, 'utf8');
        expect(csv).toContain('9007199254740993');
        expect(csv).not.toContain('HYPERLINK');
        expect(csv).not.toContain('password');
        expect(state.headers.every((id) => id === '1')).toBe(true);
        await page.reload();
        await browserExpect(
          page.getByRole('columnheader', { name: 'Message', exact: true }),
        ).not.toBeVisible();
        await browserExpect(page.getByLabel('Search gift card batches')).toHaveValue('');
      } finally {
        await page.close();
      }
    });
    it('withholds a late password and prevents new protected dispatch after the committed actor changes', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.holdPassword = true;
        await open(page);
        await page.getByRole('button', { name: 'Batch 71', exact: true }).click();
        await page.getByRole('button', { name: 'Show archive password' }).click();
        await browserExpect.poll(() => state.passwordRequested).toBe(true);
        await page.evaluate(
          "import('/src/api/client.ts').then(module=>module.setRequestOperator('2'))",
        );
        state.releasePassword();
        await browserExpect(
          page.getByRole('button', { name: 'Download encrypted CSV' }),
        ).toBeEnabled();
        await browserExpect(page.getByLabel('Gift card archive password')).not.toBeVisible();
        await page.getByRole('button', { name: 'Download encrypted CSV' }).click();
        expect(state.archives).toBe(0);
      } finally {
        await page.close();
      }
    });
    it('disables generation and financial batch controls while offline', async () => {
      const page = await browser.newPage();
      try {
        await fixture(page);
        await open(page);
        await page.getByRole('button', { name: 'Batch 71', exact: true }).click();
        await page.context().setOffline(true);
        await browserExpect(
          page.getByRole('button', { name: 'Generate gift cards', exact: true }),
        ).toBeDisabled();
        await browserExpect(
          page.getByRole('button', { name: 'Block batch', exact: true }),
        ).toBeDisabled();
        await browserExpect(
          page.getByRole('button', { name: 'Download encrypted CSV' }),
        ).toBeDisabled();
      } finally {
        await page.context().setOffline(false);
        await page.close();
      }
    });
  },
);
