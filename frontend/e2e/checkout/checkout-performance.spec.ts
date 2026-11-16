import { test, expect, type Page } from '@playwright/test';
import { z } from 'zod';
import { performanceValues } from '../../src/offline/performance/contracts';

async function savedMetadata(page: Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('souled-pos-v1');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Performance fixture storage unavailable.'));
    });
    try {
      const names = ['performanceCommands', 'fastCashCommands', 'completedSales'],
        transaction = database.transaction(names, 'readonly');
      const rows = await Promise.all(
        names.map(
          (name) =>
            new Promise<unknown[]>((resolve, reject) => {
              const read = transaction.objectStore(name).getAll();
              read.onsuccess = () => resolve(read.result as unknown[]);
              read.onerror = () => reject(new Error('Performance fixture storage unavailable.'));
            }),
        ),
      );
      return { performance: rows[0], cash: rows[1], completed: rows[2] };
    } finally {
      database.close();
    }
  });
}
for (const lostReply of [false, true]) {
  test(`paid cash timing ${lostReply ? 'recovers its lost metadata reply by GET' : 'records once'} without recharging`, async ({
    page,
  }) => {
    const checkoutId = crypto.randomUUID(),
      orderId = '9007199254740993';
    let draftId = '',
      draftVersion = 0,
      version = 0,
      phase = 'open',
      ownerId = '1',
      submissionId: string | null = null,
      paymentId: string | null = null,
      paid = false,
      creates = 0,
      orders = 0,
      payments = 0,
      metricPosts = 0,
      metricGets = 0;
    let manifest: { productId: string; quantity: number }[] = [];
    let salespersonId: string | null = null;
    let note: { hash: string; message: string; payable: string; cashReceived: string } | null =
      null;
    let metricReceipt: {
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
      meta: { items: [{ name: 'calculations', products_total: 100, total: 100 }] },
    });
    const state = () => ({
      id: checkoutId,
      operatorId: ownerId,
      draftId,
      draftVersion,
      draftImport: {
        lineItems: manifest,
        completedProductIds: manifest.map((line) => line.productId),
        status: version ? 'complete' : 'pending',
      },
      storeId: '1',
      counterId: '1',
      version,
      customerId: null,
      salespersonId,
      lineSalespersons: {},
      settlementNote: note
        ? { hash: note.hash, payable: note.payable, cashReceived: note.cashReceived }
        : null,
      verifiedCustomerUntil: null,
      phase,
      orderId: phase === 'submitted' ? orderId : null,
      orderSubmissionOperationId: submissionId,
      confirmationPhase: phase === 'submitted' ? 'acknowledged' : null,
      busyOperationId: null,
      giftCards: {},
      cart: version ? cart() : null,
      quote: ['quoted', 'submitted'].includes(phase) ? cart() : null,
      settlement: null,
    });
    await page.route('**/api/v1/stores/1/checkout-sessions**', async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (path.endsWith('/performance') && request.method() === 'POST') {
        expect(paid).toBe(true);
        const input = z
          .object({
            operationId: z.uuid(),
            orderId: z.literal(orderId),
            performance: performanceValues,
          })
          .strict()
          .parse(request.postDataJSON() as unknown);
        expect(input.performance.overall_performance_time).toBe('NaN');
        metricPosts++;
        expect(metricReceipt).toBeNull();
        metricReceipt = {
          ...input,
          checkoutId,
          status: 'recorded',
          recordedAt: new Date().toISOString(),
        };
        if (lostReply) {
          await route.abort('failed');
          return;
        }
        await route.fulfill({ status: 201, json: metricReceipt });
        return;
      }
      if (path.includes('/performance/submissions/') && request.method() === 'GET') {
        metricGets++;
        expect(path.split('/').at(-1)).toBe(metricReceipt?.operationId);
        await route.fulfill(
          metricReceipt
            ? { json: metricReceipt }
            : {
                status: 404,
                json: {
                  error: {
                    code: 'CHECKOUT_PERFORMANCE_NOT_FOUND',
                    message: 'No timing submission.',
                  },
                },
              },
        );
        return;
      }
      if (request.method() === 'GET') {
        await route.fulfill({
          json: path.endsWith('/discount-approval')
            ? {
                status: 'not-required',
                amount: '0.00',
                productsTotal: '100.00',
                challengeId: null,
                expiresAt: null,
                retryAt: null,
                delivered: 0,
                pending: 0,
              }
            : path.endsWith('/settlement-note')
              ? note
              : path.includes('/operations/')
                ? { status: 'succeeded', state: state(), result: {} }
                : state(),
        });
        return;
      }
      if (path.endsWith('/checkout-sessions')) {
        const input = z
          .object({
            draftId: z.uuid(),
            draftVersion: z.number(),
            lineItems: z.array(z.object({ productId: z.string(), quantity: z.number() })),
          })
          .parse(request.postDataJSON() as unknown);
        creates++;
        ownerId = request.headers()['x-operator-id'] || '1';
        draftId = input.draftId;
        draftVersion = input.draftVersion;
        manifest = input.lineItems;
        await route.fulfill({ status: 201, json: state() });
        return;
      }
      const input = z
        .object({ operationId: z.uuid(), expectedVersion: z.number() })
        .parse(request.postDataJSON() as unknown);
      expect(input.expectedVersion).toBe(version);
      if (path.endsWith('/draft-initializations')) version++;
      else if (path.endsWith('/salesperson')) {
        salespersonId = z
          .object({ salespersonId: z.literal('5') })
          .parse(request.postDataJSON() as unknown).salespersonId;
        version++;
      } else if (path.endsWith('/quotes')) {
        phase = 'quoted';
        version++;
      } else if (path.endsWith('/settlement-note')) {
        const body = z
          .object({ message: z.string(), cashReceived: z.literal('100.00') })
          .parse(request.postDataJSON() as unknown);
        note = {
          hash: 'a'.repeat(64),
          message: body.message,
          payable: '100.00',
          cashReceived: body.cashReceived,
        };
        version++;
      } else if (path.endsWith('/order-submissions')) {
        orders++;
        submissionId = input.operationId;
        phase = 'submitted';
        version++;
      } else throw new Error('Unexpected financial mutation in timing fixture.');
      await route.fulfill({
        json: {
          status: 'succeeded',
          state: state(),
          result: phase === 'submitted' ? { orderId, paymentStatus: 'pending' } : {},
        },
      });
    });
    await page.route(`**/api/v1/stores/1/orders/${orderId}/payment-options`, (route) =>
      route.fulfill({
        json: { payable: '100.00', options: [{ channel: 'cash', label: 'Cash', machineId: null }] },
      }),
    );
    await page.route('**/api/v1/stores/1/salespeople?**', (route) =>
      route.fulfill({
        json: { data: [{ id: '5', name: 'Synthetic salesperson' }], nextCursor: null },
      }),
    );
    await page.route(`**/api/v1/stores/1/orders/${orderId}/payment-attempts**`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill(paid ? { json: { id: paymentId, operatorId: ownerId, storeId: '1', counterId: '1',
          orderId, channel: 'cash', cashAmount: '100.00', onlineAmount: '0.00', cashReceived: '100.00',
          checkoutNote: { checkoutId, noteHash: 'a'.repeat(64) }, transactionId: 'FIXTURE-TIMING-PAID',
          status: 'paid', errorCode: null } } : { status: 404,
          json: { error: { code: 'PAYMENT_ATTEMPT_NOT_FOUND', message: 'No payment attempt.' } } });
        return;
      }
      const input = z
        .object({
          operationId: z.uuid(),
          channel: z.literal('cash'),
          cashAmount: z.literal('100.00'),
          onlineAmount: z.literal('0.00'),
          cashReceived: z.literal('100.00'),
          checkoutNote: z.object({
            checkoutId: z.literal(checkoutId),
            noteHash: z.literal('a'.repeat(64)),
          }),
        })
        .parse(route.request().postDataJSON() as unknown);
      payments++;
      paymentId = input.operationId;
      paid = true;
      await route.fulfill({
        status: 201,
        json: {
          id: paymentId,
          operatorId: ownerId,
          storeId: '1',
          counterId: '1',
          orderId,
          channel: 'cash',
          cashAmount: '100.00',
          onlineAmount: '0.00',
          cashReceived: '100.00',
          checkoutNote: input.checkoutNote,
          transactionId: 'FIXTURE-TIMING-PAID',
          status: 'paid',
          errorCode: null,
        },
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Explore demo workspace' }).click();
    await page
      .getByRole('button', { name: /^Add .+ to sale$/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Review sale', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm prices online' }).click();
    await page.getByText('Salesperson assignments', { exact: true }).click();
    await page.getByLabel('Sale salesperson', { exact: true }).selectOption('5');
    await page.getByRole('button', { name: 'Get final quote' }).click();
    await expect(
      page.getByRole('button', { name: 'Complete cash sale', exact: true }),
    ).toBeEnabled();
    await page.getByLabel('Cash received for fast checkout').fill('100.00');
    await page.getByRole('button', { name: 'Complete cash sale', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Confirm the sale' })).not.toBeVisible();
    await expect.poll(() => metricPosts, { timeout: 15000 }).toBe(1);
    await expect
      .poll(async () => JSON.stringify((await savedMetadata(page)).performance), { timeout: 20000 })
      .toContain('"state":"recorded"');
    const saved = await savedMetadata(page);
    expect(saved.performance).toEqual([
      expect.objectContaining({
        state: 'recorded',
        orderId,
        checkoutId,
        draftId,
        operationId: metricReceipt!.operationId,
        receiptId: paymentId,
        performance: metricReceipt!.performance,
      }),
    ]);
    expect(saved.cash).toEqual([
      expect.objectContaining({ state: 'paid', orderId, paymentId, submissionId }),
    ]);
    expect(saved.completed).toEqual([
      expect.objectContaining({ draftId, orderId, receiptId: paymentId }),
    ]);
    expect(creates).toBe(1);
    expect(orders).toBe(1);
    expect(payments).toBe(1);
    expect(metricPosts).toBe(1);
    expect(metricGets).toBe(lostReply ? 1 : 0);
    await expect(page.getByRole('button', { name: 'Tax invoice', exact: true })).toBeEnabled();
  });
}
