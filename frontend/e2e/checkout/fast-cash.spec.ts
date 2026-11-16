import { test, expect, type Page } from '@playwright/test';
import { z } from 'zod';
import { performanceValues } from '../../src/offline/performance/contracts';
import { sanitizeInvoiceHtml } from '../../../backend/src/modules/checkout/invoices.js';
import { installInvoicePrintProbe } from './invoice-print-probe';
import {
  invoicePreviewHtml,
  invoicePreviewPolicy,
} from '../../../backend/src/modules/invoice-documents/presentation';

async function local(page: Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('souled-pos-v1');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Local fixture unavailable'));
    });
    try {
      const names = ['drafts', 'completedSales', 'fastCashCommands'],
        tx = database.transaction(names, 'readonly');
      const values = await Promise.all(
        names.map(
          (name) =>
            new Promise<unknown[]>((resolve, reject) => {
              const read = tx.objectStore(name).getAll();
              read.onsuccess = () => resolve(read.result as unknown[]);
              read.onerror = () => reject(new Error('Local cash fixture unavailable'));
            }),
        ),
      );
      return { drafts: values[0], completed: values[1], commands: values[2] };
    } finally {
      database.close();
    }
  });
}
for (const scenario of ['normal', 'lost-note', 'lost-order', 'lost-payment', 'prepaid'] as const) {
  test(`fast cash ${scenario} preserves immutable IDs and the reviewed cart`, async ({ page }) => {
    const checkoutId = crypto.randomUUID(),
      orderId = '9007199254740993',
      payable = scenario === 'prepaid' ? '0.00' : '99.95';
    let ownerId = '1',
      draftId = '',
      draftVersion = 0,
      version = 0,
      phase = 'open',
      submissionId: string | null = null,
      attemptId: string | null = null,
      paid = false,
      receiptVisible = scenario !== 'lost-payment',
      creates = 0,
      submissions = 0,
      settlements = 0;
    let manifest: { productId: string; quantity: number }[] = [];
    let salespersonId: string | null = null;
    const lineSalespersons: Record<string, string> = {};
    let settlementNote: { hash: string; payable: string; cashReceived: string } | null = null;
    let messageText = '';
    let noteWrites = 0;
    let performanceReceipt: {
      operationId: string;
      checkoutId: string;
      orderId: string;
      status: 'recorded';
      performance: z.infer<typeof performanceValues>;
      recordedAt: string;
    } | null = null;
    const cart = () => ({
      products: {
        items: manifest.map((line) => ({
          prod_id: line.productId,
          quantity: line.quantity,
          prod_type: 1,
        })),
      },
      giftvouchers: { items: [] },
      meta: { items: [{ name: 'calculations', products_total: 99.95, total: Number(payable) }] },
    });
    const state = () => ({
      id: checkoutId,
      operatorId: ownerId,
      draftId,
      draftVersion,
      draftImport: {
        lineItems: manifest,
        completedProductIds: version ? manifest.map((line) => line.productId) : [],
        status: version ? 'complete' : 'pending',
      },
      storeId: '1',
      counterId: '1',
      version,
      customerId: null,
      salespersonId,
      lineSalespersons,
      settlementNote,
      verifiedCustomerUntil: null,
      phase,
      orderId: phase === 'submitted' ? orderId : null,
      orderSubmissionOperationId: submissionId,
      confirmationPhase: phase === 'submitted' ? 'acknowledged' : null,
      busyOperationId: null,
      giftCards: {},
      cart: version ? cart() : null,
      quote: ['quoted', 'submitted'].includes(phase) ? cart() : null,
      settlement:
        scenario === 'prepaid' && phase === 'submitted' && submissionId
          ? {
              status: 'paid',
              source: 'prepaid',
              receiptId: submissionId,
              checkoutId,
              checkoutOperationId: submissionId,
              orderId,
              transactionId: 'FAST-PREPAID-FIXTURE',
              cashAmount: '0.00',
              onlineAmount: '0.00',
            }
          : null,
    });
    const reply = () => ({
      status: 'succeeded',
      operationId: submissionId || undefined,
      state: state(),
      result:
        phase === 'submitted'
          ? {
              orderId,
              paymentStatus: scenario === 'prepaid' ? 'paid' : 'pending',
              settlement: state().settlement,
            }
          : {},
    });
    await page.route('**/api/v1/stores/1/checkout-sessions**', async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (path.endsWith('/performance') && request.method() === 'POST') {
        expect(phase).toBe('submitted');
        expect(paid || scenario === 'prepaid').toBe(true);
        const input = z
          .object({
            operationId: z.uuid(),
            orderId: z.literal(orderId),
            performance: performanceValues,
          })
          .strict()
          .parse(request.postDataJSON() as unknown);
        expect(performanceReceipt).toBeNull();
        performanceReceipt = {
          ...input,
          checkoutId,
          status: 'recorded',
          recordedAt: new Date().toISOString(),
        };
        return route.fulfill({ status: 201, json: performanceReceipt });
      }
      if (path.includes('/performance/submissions/') && request.method() === 'GET') {
        if (performanceReceipt) {
          expect(path.split('/').at(-1)).toBe(performanceReceipt.operationId);
          return route.fulfill({ json: performanceReceipt });
        }
        return route.fulfill({
          status: 404,
          json: {
            error: {
              code: 'CHECKOUT_PERFORMANCE_NOT_FOUND',
              message: 'No timing submission.',
            },
          },
        });
      }
      if (request.method() === 'GET')
        return route.fulfill({
          json: path.endsWith('/discount-approval')
            ? {
                status: 'not-required',
                amount: '0.00',
                productsTotal: '99.95',
                challengeId: null,
                expiresAt: null,
                retryAt: null,
                delivered: 0,
                pending: 0,
              }
            : path.endsWith('/settlement-note')
              ? settlementNote
                ? { ...settlementNote, message: messageText }
                : null
              : path.includes('/operations/')
                ? reply()
                : state(),
        });
      const raw = request.postDataJSON() as unknown;
      if (path.endsWith('/checkout-sessions')) {
        const body = z
          .object({
            draftId: z.uuid(),
            draftVersion: z.number(),
            lineItems: z.array(z.object({ productId: z.string(), quantity: z.number() })),
          })
          .parse(raw);
        ownerId = request.headers()['x-operator-id'] || '1';
        creates++;
        draftId = body.draftId;
        draftVersion = body.draftVersion;
        manifest = body.lineItems;
        return route.fulfill({ status: 201, json: state() });
      }
      const body = z.object({ operationId: z.uuid(), expectedVersion: z.number() }).parse(raw);
      expect(body.expectedVersion).toBe(version);
      if (path.endsWith('/draft-initializations')) version++;
      else if (path.endsWith('/settlement-note')) {
        const note = z
          .object({ message: z.string().min(1).max(255), cashReceived: z.literal('100.00') })
          .parse(raw);
        expect(note.message).toContain(
          scenario === 'normal' ? 'CASH-REVIEW-PRIVATE' : '#Cash Received:100.00',
        );
        settlementNote = { hash: 'a'.repeat(64), payable, cashReceived: note.cashReceived };
        messageText = note.message;
        noteWrites++;
        version++;
        if (scenario === 'lost-note')
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'CONTROLLED_NOTE_REPLY_LOST',
                message: 'Controlled lost note reply.',
              },
            },
          });
      } else if (path.endsWith('/salesperson')) {
        const selected = z
          .object({ salespersonId: z.enum(['5', '6']), productId: z.string().optional() })
          .parse(raw);
        if (selected.productId) lineSalespersons[selected.productId] = selected.salespersonId;
        else salespersonId = selected.salespersonId;
        version++;
      } else if (path.endsWith('/quotes')) {
        phase = 'quoted';
        version++;
      } else if (path.endsWith('/order-submissions')) {
        if (scenario !== 'prepaid') {
          expect(salespersonId).toBe('5');
          expect(lineSalespersons[manifest[0]!.productId]).toBe('6');
        }
        submissions++;
        submissionId = body.operationId;
        phase = 'submitted';
        version++;
        if (scenario === 'lost-order')
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'CHECKOUT_OUTCOME_UNCERTAIN',
                message: 'Controlled lost order reply.',
              },
            },
          });
      } else throw new Error('Unexpected fast cash mutation');
      return route.fulfill({ json: reply() });
    });
    const payment = () => ({
      id: attemptId,
      operatorId: ownerId,
      storeId: '1',
      counterId: '1',
      orderId,
      channel: 'cash',
      cashAmount: payable,
      onlineAmount: '0.00',
      cashReceived: '100.00',
      checkoutNote: { checkoutId, noteHash: 'a'.repeat(64) },
      transactionId: 'FAST-CASH-FIXTURE',
      status: 'paid',
      errorCode: null,
    });
    await page.route(`**/api/v1/stores/1/orders/${orderId}/payment-options`, (route) =>
      route.fulfill({
        json: { payable, options: [{ channel: 'cash', label: 'Cash', machineId: null }] },
      }),
    );
    await page.route(`**/api/v1/stores/1/orders/${orderId}/payment-attempts**`, async (route) => {
      if (route.request().method() === 'GET') {
        if (!paid)
          return route.fulfill({
            status: 404,
            json: {
              error: { code: 'PAYMENT_ATTEMPT_NOT_FOUND', message: 'Controlled missing attempt.' },
            },
          });
        if (!receiptVisible)
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'CHECKOUT_PROJECTION_UNCONFIRMED',
                message: 'Controlled unavailable paid proof.',
              },
            },
          });
        return route.fulfill({ json: payment() });
      }
      const body = z
        .object({
          operationId: z.uuid(),
          channel: z.literal('cash'),
          cashAmount: z.literal('99.95'),
          cashReceived: z.literal('100.00'),
          onlineAmount: z.literal('0.00'),
          checkoutNote: z.object({
            checkoutId: z.literal(checkoutId),
            noteHash: z.literal('a'.repeat(64)),
          }),
        })
        .parse(route.request().postDataJSON() as unknown);
      settlements++;
      if (attemptId) expect(body.operationId).toBe(attemptId);
      attemptId = body.operationId;
      paid = true;
      if (scenario === 'lost-payment')
        return route.fulfill({
          status: 503,
          json: {
            error: { code: 'PAYMENT_OUTCOME_UNCERTAIN', message: 'Controlled lost cash reply.' },
          },
        });
      return route.fulfill({ status: 201, json: payment() });
    });
    const invoiceHtml = sanitizeInvoiceHtml(
      '<h1>Controlled fast cash invoice</h1><table><tr><td>GST</td><td>Fixture</td></tr></table>',
    );
    await installInvoicePrintProbe(page);
    await page.route(`**/api/v1/stores/1/orders/${orderId}/invoice`, (route) => {
      expect(paid || scenario === 'prepaid').toBe(true);
      expect(route.request().headers()['x-operator-id']).toBeTruthy();
      return route.fulfill({
        json: {
          orderId,
          number: 'FIXTURE/INV/1',
          filename: `tax-invoice-${orderId}.html`,
          html: invoiceHtml,
        },
      });
    });
    await page.route(
      `**/api/v1/operators/*/stores/1/orders/${orderId}/invoices/store/preview`,
      (route) => {
        expect(paid || scenario === 'prepaid').toBe(true);
        const match = /\/operators\/(\d+)\//.exec(new URL(route.request().url()).pathname)!;
        return route.fulfill({
          contentType: 'text/html',
          headers: {
            'Content-Security-Policy': invoicePreviewPolicy,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
          },
          body: invoicePreviewHtml(
            invoiceHtml,
            { operatorId: match[1]!, storeId: '1', orderId, kind: 'store' },
            'FIXTURE/INV/1',
          ),
        });
      },
    );
    await page.route(
      '**/api/v1/stores/1/salespeople?purpose=checkout&active=true&after=0&limit=100',
      (route) =>
        route.fulfill({
          json: {
            data: [
              { id: '5', name: 'Sale fixture' },
              { id: '6', name: 'Product fixture' },
            ],
            nextCursor: null,
          },
        }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Explore demo workspace' }).click();
    const add = page.getByRole('button', { name: /^Add .+ to sale$/ }).first(),
      productName = (await add.getAttribute('aria-label'))!
        .replace(/^Add /, '')
        .replace(/ to sale$/, '');
    await add.click();
    await page.getByRole('button', { name: 'Review sale', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm prices online' }).click();
    if (scenario !== 'prepaid') {
      await page.getByText('Salesperson assignments', { exact: true }).click();
      await page.getByLabel('Sale salesperson', { exact: true }).selectOption('5');
      const line = page.getByLabel(/^Salesperson for /).first();
      await expect(line).toHaveValue('5');
      await line.selectOption('6');
      await expect(line).toHaveValue('6');
    }
    await page.getByRole('button', { name: 'Get final quote' }).click();
    await expect(
      page.getByRole('button', { name: 'Complete cash sale', exact: true }),
    ).toBeEnabled();
    if (scenario !== 'prepaid')
      await page.getByLabel('Cash received for fast checkout').fill('100.00');
    if (scenario === 'normal') {
      await expect(page.getByLabel('Cash order message')).toHaveValue(
        '#Cash Received:100.00\n#Cash To Be Accepted:99.95\n#Cash To Be Return:0.05',
      );
      await page.getByLabel('Cash order message').fill('CASH-REVIEW-PRIVATE\nCounter café');
    }
    await page.getByRole('button', { name: 'Complete cash sale', exact: true }).click();
    const original = draftId;
    if (scenario === 'lost-note') {
      await expect(page.getByText('Controlled lost note reply.', { exact: false })).toBeVisible();
      expect(submissions).toBe(0);
      expect(settlements).toBe(0);
      expect((await local(page)).commands).toHaveLength(0);
      await page.getByRole('button', { name: 'Check action status', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Complete cash sale', exact: true }),
      ).toBeEnabled();
      await page.getByRole('button', { name: 'Complete cash sale', exact: true }).click();
    }
    if (scenario === 'lost-order' || scenario === 'lost-payment') {
      await expect(
        page.getByText(
          scenario === 'lost-order'
            ? 'Controlled lost order reply.'
            : 'Controlled lost cash reply.',
          { exact: false },
        ),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create order', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Close checkout' }).click();
      await page.reload();
      if (scenario === 'lost-order')
        await page.getByRole('button', { name: `Increase ${productName}`, exact: true }).click();
      receiptVisible = true;
      await page.getByRole('button', { name: 'Review sale', exact: true }).click();
      if (scenario === 'lost-order') {
        await expect(
          page.getByRole('button', { name: 'Continue exact saved cash sale' }),
        ).toBeVisible();
        expect(settlements).toBe(0);
        await page.getByRole('button', { name: 'Continue exact saved cash sale' }).click();
      }
    }
    await expect(page.getByRole('dialog', { name: 'Confirm the sale' })).not.toBeVisible();
    await expect
      .poll(async () => JSON.stringify((await local(page)).completed))
      .toContain(scenario === 'prepaid' ? 'FAST-PREPAID-FIXTURE' : 'FAST-CASH-FIXTURE');
    const saved = await local(page);
    expect(saved.completed).toEqual([
      expect.objectContaining({
        draftId: original,
        orderId,
        source: scenario === 'prepaid' ? 'prepaid' : 'counter',
        receiptId: scenario === 'prepaid' ? submissionId : attemptId,
      }),
    ]);
    expect(saved.commands).toEqual([
      expect.objectContaining({
        state: 'paid',
        draftId: original,
        payable,
        cashReceived: scenario === 'prepaid' ? '0.00' : '100.00',
      }),
    ]);
    if (scenario === 'lost-order')
      expect(saved.drafts).toEqual([
        expect.objectContaining({
          id: expect.not.stringMatching(original),
          lines: [expect.objectContaining({ quantity: 2 })],
        }),
      ]);
    expect(creates).toBe(1);
    expect(submissions).toBe(1);
    expect(settlements).toBe(scenario === 'prepaid' ? 0 : 1);
    expect(noteWrites).toBe(scenario === 'prepaid' ? 0 : 1);
    expect(JSON.stringify(saved.commands)).not.toContain('CASH-REVIEW-PRIVATE');
    expect(JSON.stringify(saved.commands)).not.toContain('message');
    if (scenario === 'normal') expect(messageText).toBe('CASH-REVIEW-PRIVATE\nCounter café');
    const automaticInvoice = page.getByRole('dialog', { name: 'Tax invoice FIXTURE/INV/1' });
    await expect(automaticInvoice).toBeVisible();
    await expect(
      page.frameLocator('iframe').getByText('Controlled fast cash invoice'),
    ).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-invoice-print-count', '1');
    await automaticInvoice.getByRole('button', { name: 'Close invoice' }).click();
    if (scenario === 'normal') {
      await page.getByRole('button', { name: 'Tax invoice', exact: true }).click();
      await expect(
        page.frameLocator('iframe').getByText('Controlled fast cash invoice'),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Print invoice', exact: true }).click();
      await expect(page.frameLocator('iframe').locator('body')).toHaveAttribute(
        'data-print-called',
        'true',
      );
      await expect(page.locator('html')).toHaveAttribute('data-invoice-print-count', '2');
      await page.getByRole('button', { name: 'Close invoice' }).click();
      await page.reload();
      await expect(page.getByRole('heading', { name: 'The counter.', exact: true })).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Tax invoice FIXTURE/INV/1' })).toHaveCount(0);
      expect(await page.locator('html').getAttribute('data-invoice-print-count')).toBeNull();
      expect(creates).toBe(1);
      expect(settlements).toBe(1);
    }
  });
}
