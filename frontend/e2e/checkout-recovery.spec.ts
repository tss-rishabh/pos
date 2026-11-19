import { type Page } from '@playwright/test';
import { test, expect, sandboxedFrameTrace } from './support/fixtures';
import { signIn } from './support/login';
import {
  invoicePreviewHtml,
  invoicePreviewPolicy,
} from '../../backend/src/modules/invoice-documents/presentation';
import { sanitizeInvoiceHtml } from '../../backend/src/modules/checkout/invoices';

test.use(sandboxedFrameTrace);

async function localSales(page: Page) {
  return page.evaluate(async () => {
    const open = indexedDB.open('souled-pos-v1');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error('Could not inspect the local sale fixture.'));
    });
    try {
      const stores = ['drafts', 'reviewSnapshots', 'completedSales'];
      const transaction = database.transaction(stores, 'readonly');
      const values = await Promise.all(
        stores.map(
          (name) =>
            new Promise<unknown[]>((resolve, reject) => {
              const request = transaction.objectStore(name).getAll();
              request.onsuccess = () => resolve(request.result as unknown[]);
              request.onerror = () => reject(new Error('Could not read the local sale fixture.'));
            }),
        ),
      );
      return { drafts: values[0], reviews: values[1], completed: values[2] };
    } finally {
      database.close();
    }
  });
}

for (const interrupted of [false, true]) {
  test(`a recovered ${interrupted ? 'interrupted confirmation' : 'paid checkout'} completes its original snapshot and preserves a later local quantity`, async ({
    page,
    network,
  }) => {
    if (interrupted) {
      // The confirmation response is interrupted on purpose, and the first reconciliation is
      // refused until the fixture proves completion.
      network.expectFailure({
        method: 'POST',
        path: /^\/api\/v1\/stores\/1\/checkout-sessions\/[0-9a-f-]{36}\/order-submissions$/,
        outcome: 503,
      });
      network.expectFailure({
        method: 'POST',
        path: /^\/api\/v1\/stores\/1\/checkout-sessions\/[0-9a-f-]{36}\/confirmation-reconciliations$/,
        outcome: 503,
      });
    }
    const checkoutId = crypto.randomUUID();
    let draftId = '',
      productId = '',
      version = 0,
      phase = 'open',
      orderId: string | null = null,
      submissionId: string | null = null,
      paid = false,
      creates = 0,
      lines = 0,
      submissions = 0;
    let confirmationPhase: string | null = null,
      proofReady = false,
      reconciliations = 0;
    let draftVersion = 0,
      manifest: { productId: string; quantity: number }[] = [];
    const cart = () => ({
      products: { items: [{ prod_id: productId, quantity: 1, prod_type: 1 }] },
      meta: { items: [{ name: 'calculations', products_total: 100, total: 0 }] },
    });
    const state = () => ({
      id: checkoutId,
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
      verifiedCustomerUntil: null,
      phase,
      orderId,
      orderSubmissionOperationId: submissionId,
      confirmationPhase,
      busyOperationId: null,
      giftCards: {},
      cart: version ? cart() : null,
      quote: ['quoted', 'submitted'].includes(phase) ? cart() : null,
      settlement:
        paid && submissionId && orderId
          ? {
              status: 'paid',
              source: 'prepaid',
              receiptId: submissionId,
              checkoutOperationId: submissionId,
              checkoutId,
              orderId,
              transactionId: 'FIXTURE-RECOVERED-PREPAID',
              cashAmount: '0.00',
              onlineAmount: '0.00',
            }
          : null,
    });
    await page.route('**/api/v1/stores/1/checkout-sessions**', async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (request.method() === 'GET')
        return route.fulfill({
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
            : state(),
        });
      const body = request.postDataJSON() as Record<string, unknown>;
      if (path.endsWith('/checkout-sessions')) {
        creates++;
        draftId = String(body.draftId);
        draftVersion = Number(body.draftVersion);
        manifest = body.lineItems as typeof manifest;
        productId = manifest[0]!.productId;
        return route.fulfill({ status: 201, json: state() });
      }
      expect(body.expectedVersion).toBe(version);
      if (path.endsWith('/draft-initializations')) {
        lines++;
        expect(manifest).toEqual([{ productId, quantity: 1 }]);
      } else if (path.endsWith('/quotes')) phase = 'quoted';
      else if (path.endsWith('/order-submissions')) {
        submissions++;
        orderId = '8801';
        submissionId = String(body.operationId);
        if (interrupted) {
          phase = 'uncertain';
          confirmationPhase = 'dispatching';
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'CHECKOUT_OUTCOME_UNCERTAIN',
                message: 'Confirmation response was interrupted.',
              },
            },
          });
        }
        phase = 'submitted';
        confirmationPhase = 'acknowledged';
      } else if (path.endsWith('/confirmation-reconciliations')) {
        reconciliations++;
        if (!proofReady)
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'CHECKOUT_PROJECTION_UNCONFIRMED',
                message: 'Stock and wallet completion is not proved.',
              },
            },
          });
        phase = 'submitted';
        confirmationPhase = 'acknowledged';
        paid = true;
      } else throw new Error('Unexpected checkout fixture mutation.');
      version++;
      return route.fulfill({
        json: {
          status: 'succeeded',
          state: state(),
          result: orderId
            ? { orderId, paymentStatus: paid ? 'paid' : 'pending', settlement: state().settlement }
            : {},
        },
      });
    });
    await page.route('**/api/v1/stores/1/orders/8801/payment-options', (route) =>
      route.fulfill({ json: { payable: '0.00', options: [] } }),
    );
    await page.route('**/api/v1/stores/1/orders/8801/payment-attempts', (route) =>
      route.fulfill({ json: { data: [] } }),
    );
    // Order 8801 exists only in this fixture; completion opens its store invoice preview.
    await page.route(
      '**/api/v1/operators/*/stores/1/orders/8801/invoices/store/preview',
      (route) => {
        const operatorId = /\/operators\/(\d+)\//.exec(
          new URL(route.request().url()).pathname,
        )![1]!;
        return route.fulfill({
          contentType: 'text/html',
          headers: {
            'Content-Security-Policy': invoicePreviewPolicy,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
          },
          body: invoicePreviewHtml(
            sanitizeInvoiceHtml('<h1>Fixture tax invoice for order 8801</h1>'),
            { operatorId, storeId: '1', orderId: '8801', kind: 'store' },
            'FIXTURE-8801',
          ),
        });
      },
    );
    await page.goto('/');
    await signIn(page);
    const add = page.getByRole('button', { name: /^Add .+ to sale$/ }).first();
    const productName = (await add.getAttribute('aria-label'))!
      .replace(/^Add /, '')
      .replace(/ to sale$/, '');
    await add.click();
    await page.getByRole('button', { name: 'Review sale', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm prices online' }).click();
    await page.getByRole('button', { name: 'Get final quote' }).click();
    await page.getByRole('button', { name: 'Proceed For Payment', exact: true }).click();
    if (interrupted) {
      await expect(
        page.getByText('Confirmation response was interrupted.', { exact: false }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Reconcile saved confirmation' }).click();
      await expect(
        page.getByText('Stock and wallet completion is not proved.', { exact: false }),
      ).toBeVisible();
      expect((await localSales(page)).completed).toEqual([]);
    } else
      await expect(
        page.getByText('Payment must be confirmed before handing over products.', { exact: false }),
      ).toBeVisible();
    const originalId = draftId;
    expect(originalId).toMatch(/^[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: 'Close checkout' }).click();
    await page.reload();
    await page.getByRole('button', { name: `Increase ${productName}`, exact: true }).click();
    await expect
      .poll(async () => JSON.stringify((await localSales(page)).drafts))
      .toContain('"quantity":2');
    await page.getByRole('button', { name: 'Review sale', exact: true }).click();
    await expect(
      page.getByText('You are resuming the original checkout.', { exact: false }),
    ).toBeVisible();
    await expect(
      interrupted
        ? page.getByRole('button', { name: 'Reconcile saved confirmation' })
        : page.getByText('Payment must be confirmed before handing over products.', {
            exact: false,
          }),
    ).toBeVisible();
    // Reading the server-authoritative checkout never reapplies the original one-item cart.
    expect(lines).toBe(1);
    expect(creates).toBe(1);
    expect(submissions).toBe(1);
    if (interrupted) {
      proofReady = true;
      await page.getByRole('button', { name: 'Reconcile saved confirmation' }).click();
    } else {
      await page.getByRole('button', { name: 'Close checkout' }).click();
      paid = true;
      await page.getByRole('button', { name: 'Review sale', exact: true }).click();
    }
    await expect(page.getByRole('dialog', { name: 'Confirm the sale' })).not.toBeVisible();
    await expect(
      page.getByText('Payment confirmed. Changes made in another window are kept in a new sale.'),
    ).toBeVisible();
    await expect
      .poll(async () => JSON.stringify((await localSales(page)).completed))
      .toContain('FIXTURE-RECOVERED-PREPAID');
    const saved = await localSales(page);
    expect(saved.reviews).toEqual([]);
    expect(saved.completed).toEqual([
      expect.objectContaining({
        draftId: originalId,
        orderId: '8801',
        source: 'prepaid',
        receiptId: submissionId,
      }),
    ]);
    expect(saved.drafts).toEqual([
      expect.objectContaining({
        id: expect.not.stringMatching(originalId),
        version: 0,
        lines: [expect.objectContaining({ quantity: 2 })],
      }),
    ]);
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith('souled-checkout:')),
      ),
    ).toEqual([]);
    expect(lines).toBe(1);
    expect(creates).toBe(1);
    expect(submissions).toBe(1);
    expect(reconciliations).toBe(interrupted ? 2 : 0);
  });
}
