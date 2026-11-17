import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  correctionReceiptSchema,
  type CorrectionInput,
  type CorrectionReceipt,
} from '../../src/pages/payment-reversals/client';

import {
  prepareReturnSchema,
  attestReturnSchema,
  cancelReturnSchema,
  type CashReturnView,
} from '../../src/pages/payment-reversals/intent-contracts';

import {
  retainedClaimInputSchema,
  type ClaimView,
} from '../../src/pages/payment-reversals/intents-client';

const originalId = '11111111-1111-4111-8111-111111111111';
describe.skipIf(process.env.PAYMENT_REVERSAL_BROWSER_TESTS !== 'true')(
  'actual cash-correction child and original payment recovery in Chromium',
  { timeout: 15000 },
  () => {
    let server: ViteDevServer, browser: Browser, origin: string, cache: string;
    beforeAll(async () => {
      cache = await mkdtemp(join(tmpdir(), 'pos-payment-correction-vite-'));
      server = await createServer({
        configFile: false,
        cacheDir: cache,
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith('/__payment-correction__')) return next();
        try {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            await server.transformIndexHtml(
              '/__payment-correction__',
              '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/payment-reversals/harness.tsx"></script></body></html>',
            ),
          );
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Isolated correction browser server failed.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
      if (cache) await rm(cache, { recursive: true, force: true });
    });
    async function fixture(page: Page) {
      const state = {
        posts: [] as { kind: string; body: Record<string, unknown> }[],
        intent: null as CashReturnView | null,
        receipt: null as CorrectionReceipt | null,
        claim: null as ClaimView | null,
        commands: new Map<string, { kind: string; actorId: string }>(),
        drop: '',
        rejectAttestationOnce: false,
        commit: true,
        held: false,
        release: () => undefined as void,
        errors: [] as string[],
        gets: [] as string[],
      };
      page.setDefaultTimeout(7000);
      page.on('pageerror', (error) => state.errors.push(error.message));
      const timestamp = () => new Date().toISOString();
      const notFound = (route: import('@playwright/test').Route, code: string) =>
        route.fulfill({
          status: 404,
          json: { error: { code, message: 'Original reference not found.' } },
        });
      function receipt(value: CashReturnView) {
        return correctionReceiptSchema.parse({
          id: value.correctionId,
          contract: 'pos-payment-correction-v1',
          status: 'recorded',
          orderId: '91',
          storeId: '1',
          counterId: '3',
          operatorId: '44',
          originalPaymentId: originalId,
          originalPaymentHash: 'b'.repeat(64),
          transactionId: 'TXN-ORIGINAL',
          originalCash: '100.00',
          originalCashReceived: '150.00',
          originalFundingAt: '2026-11-16 10:00:00',
          orderDate: '2026-11-16',
          returnedCash: '100.00',
          cashReturnReceiptId: value.cashReturnReceiptId,
          reason: value.reason,
          recordedAt: '2026-11-17 11:00:00',
          businessDate: value.attestation!.evidence.businessDate,
          headerHash: 'c'.repeat(64),
          lines: [
            { id: '9007199254740994', productId: '10', quantity: '2', inputHash: 'd'.repeat(64) },
          ],
          stockChanged: false,
          benefitsChanged: false,
          providerRefunded: false,
          goodsRetainedAtCounter: true,
          cashReturn: value.attestation!.evidence,
          recordedInstant: timestamp(),
        });
      }
      await page.route('**/api/v1/**', async (route) => {
        const req = route.request(),
          path = new URL(req.url()).pathname;
        if (req.headers()['x-operator-id'] !== '44' || !path.startsWith('/api/v1/stores/1/'))
          return route.fulfill({
            status: 403,
            json: { error: { code: 'STORE_ACCESS_DENIED', message: 'Fixture authority changed.' } },
          });
        if (req.method() === 'GET') {
          state.gets.push(path);
          if (path === '/api/v1/stores/1/cash-return-intents')
            return route.fulfill({
              json: {
                data:
                  state.intent && !['RECORDED', 'CANCELLED'].includes(state.intent.phase)
                    ? [state.intent]
                    : [],
                nextCursor: null,
              },
            });
          if (path === '/api/v1/stores/1/cash-return-claims')
            return route.fulfill({
              json: {
                data: state.claim?.phase === 'ATTESTED' ? [state.claim] : [],
                nextCursor: null,
              },
            });
          if (path.endsWith('/payment-reversals'))
            return route.fulfill({
              json: {
                orderId: '91',
                storeId: '1',
                counterId: '3',
                eligible: !state.intent && !state.receipt,
                blocker: state.intent ? 'CASH_RETURN_RECONCILIATION_REQUIRED' : null,
                snapshotHash: state.intent ? null : 'a'.repeat(64),
                originalPaymentId: state.intent ? null : originalId,
                returnedCash: state.intent ? null : '100.00',
                latest: state.receipt,
                activeIntent: state.intent,
              },
            });
          if (path.includes('/cash-return-claims/'))
            return state.claim
              ? route.fulfill({ json: state.claim })
              : notFound(route, 'CASH_RETURN_CLAIM_NOT_FOUND');
          if (path.includes('/payment-reversals/'))
            return state.receipt
              ? route.fulfill({ json: state.receipt })
              : notFound(route, 'PAYMENT_REVERSAL_NOT_FOUND');
          if (path.includes('/operations/')) {
            const id = path.split('/').at(-1)!,
              command = state.commands.get(id);
            return command && state.intent
              ? route.fulfill({
                  json: { ...command, operationId: id, intent: state.intent, newlyArmed: false },
                })
              : notFound(route, 'CASH_RETURN_OPERATION_NOT_FOUND');
          }
          if (path.includes('/cash-return-intents/'))
            return state.intent
              ? route.fulfill({ json: state.intent })
              : notFound(route, 'CASH_RETURN_INTENT_NOT_FOUND');
          return notFound(route, 'NOT_FOUND');
        }
        if (path.endsWith('/cash-return-claims')) {
          const input = retainedClaimInputSchema.parse(req.postDataJSON() as unknown);
          state.posts.push({ kind: 'retain', body: input });
          if (state.drop !== 'retain' || state.commit)
            state.claim = {
              id: input.original.operationId,
              origin: 'retained-device',
              phase: 'ATTESTED',
              orderId: '91',
              storeId: '1',
              counterId: '3',
              registeredBy: '44',
              registeredAt: timestamp(),
              returnedBy: input.returnedBy,
              returnedAt: input.returnedAt.slice(0, 19).replace('T', ' '),
              returnedInstant: input.returnedAt,
              businessDate: input.returnedAt.slice(0, 10),
              returnedCash: '100.00',
              originalPaymentId: originalId,
              cashReturnReceiptId: input.original.cashReturnReceiptId,
            };
          if (state.drop === 'retain') {
            state.drop = '';
            return route.abort('failed');
          }
          return route.fulfill({ json: state.claim });
        }
        if (path.includes('/cash-return-claims/') && path.endsWith('/reconciliations')) {
          const raw = z
            .object({ operationId: z.uuid() })
            .strict()
            .parse(req.postDataJSON() as unknown);
          state.posts.push({ kind: 'resolve-claim', body: raw });
          const claim = state.claim;
          if (!claim) throw new Error('Fixture missing retained claim.');
          const value: CashReturnView = {
            id: claim.id,
            contract: 'pos-cash-return-intent-v1',
            revision: 3,
            phase: 'ATTESTED',
            orderId: '91',
            storeId: '1',
            counterId: '3',
            preparedBy: '44',
            preparedAt: claim.registeredAt,
            correctionId: claim.id,
            cashReturnReceiptId: claim.cashReturnReceiptId,
            originalPaymentId: originalId,
            returnedCash: '100.00',
            reason: 'customer-payment-correction',
            armed: { actorId: claim.returnedBy, at: claim.returnedInstant },
            attestation: {
              actorId: '44',
              at: claim.registeredAt,
              evidenceId: claim.id,
              evidence: {
                intentId: claim.id,
                attestationId: claim.id,
                returnedBy: claim.returnedBy,
                attestedBy: '44',
                returnedInstant: claim.returnedInstant,
                returnedAt: claim.returnedAt,
                businessDate: claim.businessDate,
                businessTimezone: 'UTC',
                preparedHash: 'e'.repeat(64),
                origin: 'retained-device-claim',
              },
            },
            cancellation: null,
            resolution: null,
          };
          state.receipt = receipt(value);
          claim.phase = 'RECORDED';
          if (state.drop === 'resolve-claim') {
            state.drop = '';
            return route.abort('failed');
          }
          return route.fulfill({ json: state.receipt });
        }
        const raw = z.record(z.string(), z.unknown()).parse(req.postDataJSON() as unknown),
          kind = path.endsWith('/armings')
            ? 'arm'
            : path.endsWith('/attestations')
              ? 'attest'
              : path.endsWith('/cancellations')
                ? 'cancel'
                : path.endsWith('/reconciliations')
                  ? 'resolve'
                  : 'prepare';
        state.posts.push({ kind, body: raw });
        if (state.held && kind === 'resolve')
          await new Promise<void>((resolve) => {
            state.release = resolve;
          });
        if (kind === 'attest' && state.rejectAttestationOnce) {
          state.rejectAttestationOnce = false;
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: 'CASH_RETURN_TIME_INVALID',
                message: 'Review the actual return time.',
              },
            },
          });
        }
        const operationId = z.uuid().parse(raw.operationId),
          replay = state.commands.has(operationId),
          commit = state.drop !== kind || state.commit;
        if (commit && !replay) {
          if (kind === 'prepare') {
            const body = prepareReturnSchema.parse(raw);
            state.intent = {
              id: body.operationId,
              contract: 'pos-cash-return-intent-v1',
              revision: 1,
              phase: 'PREPARED',
              orderId: '91',
              storeId: '1',
              counterId: '3',
              preparedBy: '44',
              preparedAt: timestamp(),
              correctionId: body.correctionId,
              cashReturnReceiptId: body.cashReturnReceiptId,
              originalPaymentId: originalId,
              returnedCash: '100.00',
              reason: body.reason,
              armed: null,
              attestation: null,
              cancellation: null,
              resolution: null,
            };
          } else {
            const value = state.intent;
            if (!value) throw new Error('Fixture missing durable preparation.');
            if (kind === 'arm') {
              value.phase = 'RETURN_PENDING';
              value.armed = { actorId: '44', at: timestamp() };
            }
            if (kind === 'attest') {
              const body = attestReturnSchema.parse(raw),
                at = timestamp();
              value.phase = 'ATTESTED';
              value.attestation = {
                actorId: '44',
                at,
                evidenceId: body.evidenceId,
                evidence: {
                  intentId: value.id,
                  attestationId: body.operationId,
                  returnedBy: value.armed!.actorId,
                  attestedBy: '44',
                  returnedInstant: body.returnedAt,
                  returnedAt: body.returnedAt.slice(0, 19).replace('T', ' '),
                  businessDate: body.returnedAt.slice(0, 10),
                  businessTimezone: 'UTC',
                  preparedHash: 'e'.repeat(64),
                },
              };
            }
            if (kind === 'cancel') {
              const body = cancelReturnSchema.parse(raw);
              value.phase = 'CANCELLED';
              value.cancellation = {
                actorId: '44',
                at: timestamp(),
                reason: body.reason,
                evidenceId: body.evidenceId,
              };
            }
            if (kind === 'resolve') {
              state.receipt = receipt(value);
              value.phase = 'RECORDED';
              value.resolution = {
                actorId: '44',
                at: timestamp(),
                correctionId: value.correctionId,
              };
            }
            value.revision++;
          }
          state.commands.set(operationId, { kind, actorId: '44' });
        }
        if (state.drop === kind) {
          state.drop = '';
          return route.abort('failed');
        }
        return route.fulfill({
          json:
            kind === 'resolve'
              ? state.receipt
              : {
                  operationId,
                  kind,
                  actorId: '44',
                  intent: state.intent,
                  newlyArmed: kind === 'arm' && !replay,
                },
        });
      });
      return state;
    }
    async function open(page: Page) {
      await page.goto(origin + '/__payment-correction__');
      await browserExpect(
        page.getByRole('checkbox', { name: /Goods have not been handed over/ }),
      ).toBeVisible();
    }
    async function prepare(page: Page) {
      await page.getByRole('checkbox', { name: /Goods have not been handed over/ }).check();
      await page.getByRole('button', { name: 'Prepare return of 100.00' }).click();
      await browserExpect(
        page.getByRole('button', { name: 'Authorize one cash handback' }),
      ).toBeVisible();
    }
    async function arm(page: Page) {
      await page.getByRole('button', { name: 'Authorize one cash handback' }).click();
      await browserExpect(page.getByText(/One cash handback is authorized:/)).toBeVisible();
    }
    async function attest(page: Page) {
      await page
        .getByRole('checkbox', { name: /I confirm this original cash was already returned/ })
        .check();
      await page.getByRole('button', { name: 'Attest original cash return' }).click();
      await browserExpect(
        page.getByRole('button', { name: 'Reconcile returned cash' }),
      ).toBeVisible();
    }
    async function submit(page: Page) {
      await prepare(page);
      await arm(page);
      await attest(page);
      await page.getByRole('button', { name: 'Reconcile returned cash' }).click();
    }
    it('prepares before handback and a lost committed financial POST reloads with GET only', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      state.drop = 'resolve';
      try {
        await open(page);
        await submit(page);
        await browserExpect(
          page.getByRole('button', { name: 'Check original return action' }),
        ).toBeVisible();
        expect(state.posts.map((row) => row.kind)).toEqual(['prepare', 'arm', 'attest', 'resolve']);
        const original = state.posts.at(-1)!.body.operationId;
        await page.reload();
        await browserExpect(page.getByText(/Cash correction recorded ·/)).toBeVisible();
        expect(state.receipt?.id).toBe(original);
        expect(state.posts).toHaveLength(4);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('a lost preparation acknowledgment recovers before the first authorized handback', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      state.drop = 'prepare';
      try {
        await open(page);
        await page.getByRole('checkbox', { name: /Goods have not been handed over/ }).check();
        await page.getByRole('button', { name: 'Prepare return of 100.00' }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Check original return action' }),
        ).toBeVisible();
        await page.reload();
        await browserExpect(
          page.getByRole('button', { name: 'Authorize one cash handback' }),
        ).toBeVisible();
        await arm(page);
        expect(state.posts.map((row) => row.kind)).toEqual(['prepare', 'arm']);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('unknown arming never repeats physical instructions after original GET recovery or reload', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      state.drop = 'arm';
      try {
        await open(page);
        await prepare(page);
        await page.getByRole('button', { name: 'Authorize one cash handback' }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Check original return action' }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Check original return action' }).click();
        await browserExpect(page.getByText(/Cash may already have been handed back/)).toBeVisible();
        await browserExpect(page.getByText(/One cash handback is authorized:/)).toHaveCount(0);
        await page.reload();
        await browserExpect(page.getByText(/Cash may already have been handed back/)).toBeVisible();
        expect(state.posts.map((row) => row.kind)).toEqual(['prepare', 'arm']);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('a missing financial receipt keeps the same durable intent and original UUID for explicit reconciliation', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      state.drop = 'resolve';
      state.commit = false;
      try {
        await open(page);
        await submit(page);
        const original = state.posts.at(-1)!.body;
        await page.reload();
        await browserExpect(
          page.getByRole('button', { name: 'Reconcile returned cash' }),
        ).toBeVisible();
        await browserExpect(page.getByText(/One cash handback is authorized:/)).toHaveCount(0);
        state.commit = true;
        await page.getByRole('button', { name: 'Reconcile returned cash' }).click();
        await browserExpect(page.getByText(/Cash correction recorded ·/)).toBeVisible();
        expect(state.posts.at(-1)!.body).toEqual(original);
        expect(state.posts.filter((row) => row.kind === 'arm')).toHaveLength(1);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('storage failure prevents preparation dispatch before cash handback', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      try {
        await open(page);
        await page.evaluate(() => {
          Storage.prototype.setItem = () => {
            throw new DOMException('Fixture storage unavailable', 'QuotaExceededError');
          };
        });
        await page.getByRole('checkbox', { name: /Goods have not been handed over/ }).check();
        await page.getByRole('button', { name: 'Prepare return of 100.00' }).click();
        await browserExpect(page.getByRole('alert')).toContainText('Fixture storage unavailable');
        expect(state.posts).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('a refused evidence time can be reviewed after GET absence using the same command and financial UUID', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      state.rejectAttestationOnce = true;
      try {
        await open(page);
        await prepare(page);
        await arm(page);
        const correctionId = state.intent!.correctionId;
        await page
          .getByRole('checkbox', { name: /I confirm this original cash was already returned/ })
          .check();
        await page.getByRole('button', { name: 'Attest original cash return' }).click();
        await browserExpect(page.getByRole('alert')).toContainText(
          'Review the actual return time.',
        );
        await page.getByRole('button', { name: 'Check original return action' }).click();
        await page.getByRole('button', { name: 'Review unrecorded return evidence' }).click();
        await page
          .getByRole('checkbox', { name: /I confirm this original cash was already returned/ })
          .check();
        await page.getByRole('button', { name: 'Attest original cash return' }).click();
        await browserExpect(
          page.getByRole('button', { name: 'Reconcile returned cash' }),
        ).toBeVisible();
        expect(
          state.posts.filter((row) => row.kind === 'attest').map((row) => row.body.operationId),
        ).toEqual([state.posts[2]!.body.operationId, state.posts[2]!.body.operationId]);
        expect(state.intent!.correctionId).toBe(correctionId);
        await browserExpect(page.getByText(/One cash handback is authorized:/)).toHaveCount(0);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('unperformed PREPARED cancellation is explicit and never appears after arming', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      try {
        await open(page);
        await prepare(page);
        await page
          .getByRole('checkbox', { name: /no cash was returned for this preparation/ })
          .check();
        await page.getByRole('button', { name: 'Cancel unperformed preparation' }).click();
        await browserExpect(page.getByText(/unperformed preparation was cancelled/)).toBeVisible();
        expect(state.posts.map((row) => row.kind)).toEqual(['prepare', 'cancel']);
        expect(state.receipt).toBeNull();
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('manager store queue exposes other-device pending returns without authorizing another handback', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      try {
        await open(page);
        await prepare(page);
        await arm(page);
        state.intent!.armed!.actorId = '55';
        await page.reload();
        await browserExpect(page.getByText(/Cash may already have been handed back/)).toBeVisible();
        await page.getByRole('button', { name: 'Review store cash returns' }).click();
        await browserExpect(page.getByRole('listitem')).toContainText('operator 55');
        expect(state.posts.map((row) => row.kind)).toEqual(['prepare', 'arm']);
        await browserExpect(page.getByText(/One cash handback is authorized:/)).toHaveCount(0);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('a malformed earlier device reference cannot hide valid server pending returns or expose its contents', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      try {
        await open(page);
        await prepare(page);
        await arm(page);
        await page.evaluate(() =>
          localStorage.setItem('pos:payment-correction:v1:55:1:91', '{"private-customer-canary":'),
        );
        await page.getByRole('button', { name: 'Review store cash returns' }).click();
        await browserExpect(page.getByRole('alert')).toContainText(
          'A retained device reference could not be verified.',
        );
        await browserExpect(page.getByRole('listitem')).toContainText('RETURN_PENDING');
        expect(await page.locator('body').innerText()).not.toContain('private-customer-canary');
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('detail refresh failure retains the immutable receipt and never repeats a financial command', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      try {
        await open(page);
        await page.getByRole('checkbox', { name: 'Fail detail refresh' }).check();
        await submit(page);
        await browserExpect(page.getByRole('alert')).toContainText('do not return cash again');
        expect(state.posts).toHaveLength(4);
        await page.getByRole('checkbox', { name: 'Fail detail refresh' }).uncheck();
        await page.getByRole('button', { name: 'Refresh corrected order' }).click();
        await browserExpect(page.getByLabel('Detail refresh count')).toHaveText('2');
        expect(state.posts).toHaveLength(4);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it.each(['Switch operator', 'Switch store'])(
      'a late recorded receipt cannot publish after %s',
      async (button) => {
        const page = await browser.newPage(),
          state = await fixture(page);
        state.held = true;
        try {
          await open(page);
          await submit(page);
          await browserExpect.poll(() => state.posts.length).toBe(4);
          await page.getByRole('button', { name: button }).click();
          state.release();
          await browserExpect(page.getByLabel('Detail refresh count')).toHaveText('0');
          await browserExpect(page.getByText(/Cash correction recorded ·/)).toHaveCount(0);
          expect(state.posts).toHaveLength(4);
          expect(state.errors).toEqual([]);
        } finally {
          state.release();
          await page.close();
        }
      },
    );
    it('offline preparation sends no command and cannot authorize a handback', async () => {
      const page = await browser.newPage(),
        state = await fixture(page);
      try {
        await open(page);
        await page.getByRole('button', { name: 'Toggle network' }).click();
        await browserExpect(
          page.getByText('Reconnect to review the original server evidence.'),
        ).toBeVisible();
        expect(state.posts).toEqual([]);
        await browserExpect(
          page.getByRole('button', { name: 'Authorize one cash handback' }),
        ).toHaveCount(0);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('old device journal becomes a durable manager claim and a lost registration reply recovers by GET without a new nonce', async () => {
      const page = await browser.newPage(),
        state = await fixture(page),
        raw: CorrectionInput = {
          operationId: crypto.randomUUID(),
          originalPaymentId: originalId,
          counterId: '3',
          snapshotHash: 'a'.repeat(64),
          cashReturnReceiptId: crypto.randomUUID(),
          returnedCash: '100.00',
          reason: 'customer-payment-correction',
          confirmCashReturned: true,
          confirmNoHandover: true,
        };
      await page.addInitScript((input) => {
        localStorage.setItem('pos:payment-correction:v1:44:1:91', JSON.stringify(input));
      }, raw);
      state.drop = 'retain';
      try {
        await page.goto(origin + '/__payment-correction__');
        await browserExpect(
          page.getByRole('button', { name: 'Retain original claim for store managers' }),
        ).toBeVisible();
        await page
          .getByLabel('Actual original cash return time (UTC)')
          .fill('2026-11-16T11:00:00.000');
        await page
          .getByRole('checkbox', {
            name: /I reviewed evidence that this original cash was already returned/,
          })
          .check();
        await page
          .getByRole('button', { name: 'Retain original claim for store managers' })
          .click();
        await browserExpect(page.getByRole('alert')).toBeVisible();
        expect(state.posts.map((row) => row.kind)).toEqual(['retain']);
        await page.reload();
        await browserExpect(
          page.getByText(/is retained by the server for store managers/),
        ).toBeVisible();
        expect(state.posts).toHaveLength(1);
        expect(state.claim?.id).toBe(raw.operationId);
        await browserExpect(page.getByText(/One cash handback is authorized:/)).toHaveCount(0);
        await page.getByRole('button', { name: 'Reconcile retained original claim' }).click();
        await browserExpect(
          page.getByText(/Original cash correction .* is recorded/),
        ).toBeVisible();
        expect(state.receipt?.id).toBe(raw.operationId);
        expect(state.posts.map((row) => row.kind)).toEqual(['retain', 'resolve-claim']);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('a current manager can intake another signed-out operator’s old device reference into the shared queue', async () => {
      const page = await browser.newPage(),
        state = await fixture(page),
        raw: CorrectionInput = {
          operationId: crypto.randomUUID(),
          originalPaymentId: originalId,
          counterId: '3',
          snapshotHash: 'a'.repeat(64),
          cashReturnReceiptId: crypto.randomUUID(),
          returnedCash: '100.00',
          reason: 'customer-payment-correction',
          confirmCashReturned: true,
          confirmNoHandover: true,
        };
      await page.addInitScript(
        (input) => localStorage.setItem('pos:payment-correction:v1:55:1:91', JSON.stringify(input)),
        raw,
      );
      try {
        await open(page);
        await page.getByRole('button', { name: 'Review store cash returns' }).click();
        await page
          .getByRole('button', { name: 'Review retained device claim ' + raw.operationId })
          .click();
        await browserExpect(page.getByLabel('Original cash handler operator ID')).toHaveValue('55');
        await page
          .getByLabel('Actual original cash return time (UTC)')
          .fill('2026-11-16T11:00:00.000');
        await page
          .getByRole('checkbox', {
            name: /I reviewed evidence that this original cash was already returned/,
          })
          .check();
        await page
          .getByRole('button', { name: 'Retain original claim for store managers' })
          .click();
        await browserExpect(
          page.getByText(/is retained by the server for store managers/),
        ).toBeVisible();
        expect(state.claim).toMatchObject({
          id: raw.operationId,
          registeredBy: '44',
          returnedBy: '55',
        });
        expect(state.posts.map((row) => row.kind)).toEqual(['retain']);
        expect(state.posts[0]!.body).toMatchObject({ original: raw, returnedBy: '55' });
        await page.getByRole('button', { name: 'Reconcile retained original claim' }).click();
        await browserExpect(
          page.getByText(
            'Original cash correction ' +
              raw.operationId +
              ' is recorded. No additional cash handback is authorized.',
          ),
        ).toBeVisible();
        expect(
          await page.evaluate(() => localStorage.getItem('pos:payment-correction:v1:55:1:91')),
        ).toBeNull();
        expect(state.posts.map((row) => row.kind)).toEqual(['retain', 'resolve-claim']);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('old missing/500 correction never produces a new cash handback or replacement reference', async () => {
      const page = await browser.newPage(),
        state = await fixture(page),
        raw: CorrectionInput = {
          operationId: crypto.randomUUID(),
          originalPaymentId: originalId,
          counterId: '3',
          snapshotHash: 'a'.repeat(64),
          cashReturnReceiptId: crypto.randomUUID(),
          returnedCash: '100.00',
          reason: 'customer-payment-correction',
          confirmCashReturned: true,
          confirmNoHandover: true,
        };
      await page.addInitScript(
        (input) => localStorage.setItem('pos:payment-correction:v1:44:1:91', JSON.stringify(input)),
        raw,
      );
      try {
        await page.goto(origin + '/__payment-correction__');
        await browserExpect(
          page.getByRole('button', { name: 'Check original cash correction' }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Check original cash correction' }).click();
        expect(state.posts).toEqual([]);
        await browserExpect(
          page.getByRole('button', { name: /Authorize one cash handback|Prepare return/ }),
        ).toHaveCount(0);
        expect(
          await page.evaluate(
            () => JSON.parse(localStorage.getItem('pos:payment-correction:v1:44:1:91')!) as unknown,
          ),
        ).toEqual(raw);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
    it('an original reversed payment never emits a paid callback and a new cash receipt has a distinct ID', async () => {
      const page = await browser.newPage(),
        posts: z.infer<typeof bodySchema>[] = [],
        errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const bodySchema = z.object({ operationId: z.uuid() }).passthrough();
      await page.route('**/api/v1/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/payment-options'))
          return route.fulfill({
            json: {
              payable: '100.00',
              options: [{ channel: 'cash', label: 'Cash', machineId: null }],
            },
          });
        const base = {
          id: originalId,
          orderId: '91',
          transactionId: 'TXN-ORIGINAL',
          channel: 'cash',
          cashAmount: '100.00',
          onlineAmount: '0.00',
          status: 'reversed',
          reversalId: '22222222-2222-4222-8222-222222222222',
          errorCode: null,
        };
        if (route.request().method() === 'GET') return route.fulfill({ json: base });
        const body = bodySchema.parse(route.request().postDataJSON() as unknown);
        posts.push(body);
        return route.fulfill({
          json: { ...base, id: body.operationId, status: 'paid', transactionId: 'TXN-NEW' },
        });
      });
      try {
        await page.goto(origin + '/__payment-correction__?payment');
        await browserExpect(page.getByText(/recorded cash payment was corrected/)).toBeVisible();
        await browserExpect(page.getByLabel('Paid callback')).toHaveText('');
        await page.getByRole('button', { name: 'Choose another payment' }).click();
        await page.getByRole('button', { name: 'Record received payment' }).click();
        await browserExpect(page.getByText(/Payment confirmed · TXN-NEW/)).toBeVisible();
        expect(posts).toHaveLength(1);
        expect(posts[0]?.operationId).not.toBe(originalId);
        await browserExpect(page.getByLabel('Paid callback')).toHaveText(posts[0]!.operationId);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  },
);
