import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { correctionBrowserFixture, jobId } from './fixtures';

describe.skipIf(process.env.ORDER_IMPORT_BROWSER_TESTS !== 'true')(
  'actual manager CSV correction/recovery workflow',
  { timeout: 20000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = await mkdtemp(join(tmpdir(), 'pos-import-corrections-vite-'));
      server = await createServer({
        configFile: false,
        cacheDir: cache,
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__corrections__')) return next();
        try {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            await server.transformIndexHtml(
              '/__corrections__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/import-corrections/harness.tsx"></script></body></html>',
            ),
          );
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Isolated correction server failed.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : {}),
      });
    });
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cache) await rm(cache, { recursive: true, force: true });
    });
    async function original(page: Page) {
      await page.goto(origin + '/__corrections__');
      await browserExpect(
        page.getByRole('heading', { level: 1, name: 'Historical order imports' }),
      ).toBeVisible();
      await page.getByRole('textbox', { name: 'Import reference', exact: true }).fill(jobId);
      await page.getByRole('button', { name: 'Refresh import', exact: true }).click();
      await browserExpect(
        page.getByRole('button', { name: 'Review correction for CSV row 2', exact: true }),
      ).toBeVisible();
    }
    async function review(page: Page) {
      await page
        .getByRole('button', { name: 'Review correction for CSV row 2', exact: true })
        .click();
      await page.getByRole('button', { name: 'Refresh original row review', exact: true }).click();
    }
    async function attest(page: Page, value = '50') {
      await page
        .getByRole('textbox', { name: 'Historical tender amount', exact: true })
        .fill(value);
      await page.getByRole('checkbox', { name: /I verified this tender/ }).check();
      await page
        .getByRole('button', { name: 'Save linked correction for approval', exact: true })
        .click();
    }
    it('reviews preserved original rows, attests tender independently and requires the purpose-bound successor approval', async () => {
      const page = await browser.newPage(),
        state = await correctionBrowserFixture(page);
      try {
        await original(page);
        await review(page);
        await browserExpect(
          page.getByRole('table', { name: 'Original CSV correction rows' }),
        ).toContainText('9007199254740993');
        await attest(page);
        await browserExpect(
          page.getByRole('status', { name: 'Recorded correction receipt' }),
        ).toBeVisible();
        expect(state.posts).toHaveLength(1);
        expect(state.posts[0]).toMatchObject({
          historicalTenderAmount: '50.00',
          lines: [{ row: 2, unitPrice: '25.49' }],
        });
        await page
          .getByRole('button', { name: 'Open successor for approval', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Review financial approval for CSV row 2', exact: true })
          .click();
        await browserExpect(
          page.getByRole('region', { name: 'Financial approval review' }),
        ).toContainText('Independently attested historical tender');
        await browserExpect(
          page.getByRole('combobox', { name: 'Approval reason', exact: true }),
        ).toHaveValue('historical-correction');
        await browserExpect(
          page.getByRole('combobox', { name: 'Approval reason', exact: true }),
        ).toBeDisabled();
        await page
          .getByRole('checkbox', {
            name: 'I reviewed the original date, independently attested tender, source bill and all products.',
          })
          .check();
        await page.getByRole('button', { name: 'Grant financial approval', exact: true }).click();
        await browserExpect.poll(() => state.approvals.length).toBe(1);
        expect(state.approvals[0]!.reason).toBe('historical-correction');
        expect(state.otherMutations).toEqual([]);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('recovers a lost committed reply by original GET only and retains its receipt if successor refresh fails', async () => {
      const page = await browser.newPage(),
        state = await correctionBrowserFixture(page);
      state.drop = 'after';
      try {
        await original(page);
        await review(page);
        await attest(page);
        await browserExpect(
          page.getByRole('heading', { name: 'Pending correction references' }),
        ).toBeVisible();
        const id = state.posts[0]!.id;
        await page
          .getByRole('button', { name: 'Recover original correction ' + id, exact: true })
          .click();
        await browserExpect(
          page.getByRole('status', { name: 'Recorded correction receipt' }),
        ).toContainText(id);
        state.successorReadFails = true;
        await page
          .getByRole('button', { name: 'Open successor for approval', exact: true })
          .click();
        await browserExpect(
          page.getByRole('status', { name: 'Recorded correction receipt' }),
        ).toContainText(id);
        expect(state.posts).toHaveLength(1);
        expect(state.gets.filter((path) => path.endsWith('/corrections/' + id))).toHaveLength(1);
        expect(state.otherMutations).toEqual([]);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('requires an exact native fence before a fresh review, and never treats404 or500 as proof', async () => {
      const page = await browser.newPage(),
        state = await correctionBrowserFixture(page);
      // The fixture observes the request before awaiting its journal check and
      // committing a receipt. Keep that boundary open deterministically.
      let holdJournalCheck = false,
        journalRequested = () => {},
        releaseJournal = () => {};
      const journalEntered = new Promise<void>((resolve) => {
          journalRequested = resolve;
        }),
        journalReleased = new Promise<void>((resolve) => {
          releaseJournal = resolve;
        }),
        evaluate = page.evaluate.bind(page),
        evaluation = vi.spyOn(page, 'evaluate').mockImplementation(async (script, argument) => {
          if (holdJournalCheck) {
            holdJournalCheck = false;
            journalRequested();
            await journalReleased;
          }
          return evaluate(script, argument);
        });
      state.drop = 'before';
      state.recovery = '404';
      try {
        await original(page);
        await review(page);
        await attest(page);
        await browserExpect.poll(() => state.posts.length).toBe(1);
        const old = state.posts[0]!;
        const checkOriginal = page.getByRole('button', {
          name: 'Check original correction status',
          exact: true,
        });
        const [missing] = await Promise.all([
          page.waitForResponse(
            (response) =>
              response.request().method() === 'GET' &&
              new URL(response.url()).pathname.endsWith('/corrections/' + old.id),
          ),
          checkOriginal.click(),
        ]);
        expect(missing.status()).toBe(404);
        await browserExpect(checkOriginal).toBeEnabled();
        await browserExpect(
          page.getByRole('button', { name: 'Begin fresh review after this fence', exact: true }),
        ).toHaveCount(0);
        expect(state.fences.size).toBe(0);
        state.recovery = '500';
        const [failed] = await Promise.all([
          page.waitForResponse(
            (response) =>
              response.request().method() === 'GET' &&
              new URL(response.url()).pathname.endsWith('/corrections/' + old.id),
          ),
          checkOriginal.click(),
        ]);
        expect(failed.status()).toBe(500);
        await browserExpect(checkOriginal).toBeEnabled();
        await browserExpect(
          page.getByRole('button', { name: 'Begin fresh review after this fence', exact: true }),
        ).toHaveCount(0);
        expect(state.fences.size).toBe(0);
        expect(state.posts).toHaveLength(1);
        state.recovery = 'native';
        await page
          .getByRole('button', { name: 'Check original correction status', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Begin fresh review after this fence', exact: true })
          .click();
        state.drop = 'none';
        holdJournalCheck = true;
        await attest(page);
        await journalEntered;
        await browserExpect.poll(() => state.posts.length).toBe(2);
        expect(state.receipts.size).toBe(0);
        releaseJournal();
        await browserExpect(
          page.getByRole('status', { name: 'Recorded correction receipt' }),
        ).toContainText(state.posts[1]!.id);
        expect(state.posts[1]!.id).not.toBe(old.id);
        expect(state.fences.has(old.id)).toBe(true);
        expect(state.receipts.size).toBe(1);
        expect(state.otherMutations).toEqual([]);
        expect(state.errors).toEqual([]);
      } finally {
        releaseJournal();
        evaluation.mockRestore();
        await page.close();
      }
    });
    it('keeps an unproved source outcome and unsupported benefit calculation paused without a correction POST', async () => {
      const page = await browser.newPage(),
        state = await correctionBrowserFixture(page);
      state.review.eligible = false;
      state.review.blocker = 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED';
      state.review.reviewHash = null;
      try {
        await original(page);
        await review(page);
        await browserExpect(
          page.getByRole('button', { name: 'Save linked correction for approval', exact: true }),
        ).toHaveCount(0);
        state.review.blocker = 'ORDER_IMPORT_CORRECTION_PROFILE_UNQUALIFIED';
        state.review.calculation!.profileQualified = false;
        await page
          .getByRole('button', { name: 'Refresh original row review', exact: true })
          .click();
        await browserExpect(
          page.getByRole('region', { name: 'Manager correction review' }),
        ).toContainText('Do not remove benefits');
        expect(state.posts).toEqual([]);
        expect(state.otherMutations).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('supports explicit qualified zero without changing positive line prices or inferring cash', async () => {
      const page = await browser.newPage(),
        state = await correctionBrowserFixture(page);
      state.review.calculation!.payable = '0.00';
      try {
        await original(page);
        await review(page);
        await attest(page, '0');
        await browserExpect.poll(() => state.posts.length).toBe(1);
        expect(state.posts[0]).toMatchObject({
          historicalTenderAmount: '0.00',
          lines: [{ row: 2, unitPrice: '25.49' }],
        });
        await browserExpect(
          page.getByRole('status', { name: 'Recorded correction receipt' }),
        ).toContainText('₹0.00');
        expect(state.otherMutations).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('does not dispatch an old manager continuation after an actor change during input hashing', async () => {
      const page = await browser.newPage(),
        state = await correctionBrowserFixture(page);
      try {
        await original(page);
        await review(page);
        await page.evaluate(() => {
          const original = crypto.subtle.digest.bind(crypto.subtle);
          let release: () => void = () => {};
          const pending = new Promise<void>((resolve) => {
            release = resolve;
          });
          Object.assign(window, { releaseCorrectionHash: release });
          crypto.subtle.digest = async (...args: Parameters<SubtleCrypto['digest']>) => {
            await pending;
            return original(...args);
          };
        });
        await attest(page);
        await page.getByRole('button', { name: 'Switch operator', exact: true }).click();
        await page.evaluate(() => {
          (window as unknown as { releaseCorrectionHash: () => void }).releaseCorrectionHash();
        });
        await browserExpect(
          page.getByRole('heading', { level: 1, name: 'Historical order imports' }),
        ).toBeVisible();
        expect(state.posts).toEqual([]);
        expect(
          await page.evaluate(() =>
            Object.keys(localStorage).some((key) => key.startsWith('pos-order-import-correction:')),
          ),
        ).toBe(false);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('refuses unmatched historical tender before saving or sending, preserving the row for reconciliation', async () => {
      const page = await browser.newPage(),
        state = await correctionBrowserFixture(page);
      state.review.original.lineValue = '100.00';
      state.review.original.lines[0]!.unitPrice = '100.00';
      state.review.original.lines[0]!.quantity = 1;
      state.review.calculation!.payable = '90.00';
      try {
        await original(page);
        await review(page);
        await attest(page, '100');
        await browserExpect(
          page.getByRole('alert').filter({ hasText: 'must match the qualified source bill' }),
        ).toBeVisible();
        expect(state.posts).toEqual([]);
        expect(
          await page.evaluate(() =>
            Object.keys(localStorage).some((key) => key.startsWith('pos-order-import-correction:')),
          ),
        ).toBe(false);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('a storage failure prevents dispatch and does not lose original upload review', async () => {
      const page = await browser.newPage(),
        state = await correctionBrowserFixture(page);
      try {
        await original(page);
        await review(page);
        await page.evaluate(() => {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key: string, value: string) {
            if (key.startsWith('pos-order-import-correction:'))
              throw new Error('Fixture storage failure');
            return original.call(this, key, value);
          };
        });
        await attest(page);
        await browserExpect(
          page.getByRole('alert').filter({ hasText: 'No correction was sent' }),
        ).toBeVisible();
        expect(state.posts).toEqual([]);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  },
);
