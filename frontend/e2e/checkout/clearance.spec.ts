import { type Page, type Route } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import type { CheckoutClearance } from '../../src/api/checkout-clearance';
import type {
  ClearedDraft,
  CompletedSale,
  LocalDraft,
  ReviewSnapshot,
} from '../../src/offline/database';
import { signIn } from '../support/login';

async function localClearState(page: Page) {
  return page.evaluate(async () => {
    const open = indexedDB.open('souled-pos-v1');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error('Could not inspect clear fixture.'));
    });
    try {
      const names = ['drafts', 'reviewSnapshots', 'completedSales', 'clearedDrafts', 'operations'];
      const transaction = database.transaction(names, 'readonly');
      const values = await Promise.all(
        names.map(
          (name) =>
            new Promise<unknown[]>((resolve, reject) => {
              const request = transaction.objectStore(name).getAll();
              request.onsuccess = () => resolve(request.result as unknown[]);
              request.onerror = () => reject(new Error('Could not read clear fixture.'));
            }),
        ),
      );
      return {
        drafts: values[0] as LocalDraft[],
        reviews: values[1] as ReviewSnapshot[],
        completed: values[2] as CompletedSale[],
        cleared: values[3] as ClearedDraft[],
        operations: values[4],
      };
    } finally {
      database.close();
    }
  });
}

for (const delayed of [false, true]) {
  test(`two-tab clear ${delayed ? 'keeps a newer open review when its old callback arrives' : 'reuses one durable result after stale-tab recovery and reload'}`, async ({
    page,
    context,
    network,
  }) => {
    // The stale tab's quote after the clear is refused with 409 CHECKOUT_CLEARED on purpose.
    network.expectFailure({
      method: 'POST',
      path: /^\/api\/v1\/stores\/1\/checkout-sessions\/[0-9a-f-]{36}\/quotes$/,
      outcome: 409,
    });
    const checkoutId = crypto.randomUUID();
    let draftId = '',
      draftVersion = 0,
      version = 0,
      creates = 0,
      imports = 0,
      clears = 0;
    let manifest: { productId: string; quantity: number }[] = [],
      lastClear: CheckoutClearance | null = null;
    let blockedQuote: Route | null = null;
    const cart = () => ({
      products: {
        items: lastClear ? [] : [{ prod_id: manifest[0]!.productId, quantity: 1, prod_type: 1 }],
      },
      giftvouchers: { items: [] },
      meta: { items: [{ name: 'calculations', products_total: 100, total: 100 }] },
    });
    const state = () => ({
      id: checkoutId,
      draftId,
      draftVersion,
      draftImport: {
        lineItems: manifest,
        completedProductIds: imports ? manifest.map((line) => line.productId) : [],
        status: imports ? 'complete' : 'pending',
      },
      storeId: '1',
      counterId: '1',
      version,
      customerId: null,
      verifiedCustomerUntil: null,
      phase: lastClear ? 'cleared' : 'open',
      lastClear,
      orderId: null,
      busyOperationId: null,
      giftCards: {},
      cart: imports ? cart() : null,
      quote: null,
    });
    await context.route('**/api/v1/stores/1/checkout-sessions**', async (route) => {
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
        return route.fulfill({ status: 201, json: state() });
      }
      if (path.endsWith('/quotes') && delayed && !lastClear) {
        blockedQuote = route;
        return;
      }
      if (lastClear)
        return route.fulfill({
          status: 409,
          json: {
            error: { code: 'CHECKOUT_CLEARED', message: 'This checkout is already cleared.' },
          },
        });
      expect(body.expectedVersion).toBe(version);
      if (path.endsWith('/draft-initializations')) imports++;
      else if (path.endsWith('/clear')) {
        clears++;
        lastClear = {
          status: 'cleared',
          checkoutId,
          operationId: String(body.operationId),
          operatorId: request.headers()['x-operator-id'] || '1',
          storeId: '1',
          counterId: '1',
          draftId,
          draftVersion,
          reason: 'cart-clear',
          clearedAt: Date.now(),
        };
      } else throw new Error('Unexpected clear fixture mutation.');
      version++;
      return route.fulfill({ json: { status: 'succeeded', state: state(), result: {} } });
    });
    await page.goto('/');
    await signIn(page);
    const add = page.getByRole('button', { name: /^Add .+ to sale$/ }).first();
    const productName = (await add.getAttribute('aria-label'))!
      .replace(/^Add /, '')
      .replace(/ to sale$/, '');
    await add.click();
    await page.getByRole('button', { name: 'Review sale', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm prices online' }).click();
    await expect(page.getByRole('button', { name: 'Get final quote' })).toBeVisible();
    const other = await context.newPage();
    await other.goto('/');
    // The second tab shares the signed-in session cookie; sign in only if it is missing.
    if (await other.getByLabel('Email or username').isVisible()) await signIn(other);
    await other.getByRole('button', { name: `Increase ${productName}`, exact: true }).click();
    await expect
      .poll(async () => (await localClearState(other)).drafts[0]?.lines[0]?.quantity)
      .toBe(2);
    await other.getByRole('button', { name: 'Review sale', exact: true }).click();
    await expect(
      other.getByText('You are resuming the original checkout.', { exact: false }),
    ).toBeVisible();
    await expect(other.getByRole('button', { name: 'Get final quote' })).toBeVisible();
    if (delayed) {
      await other.getByRole('button', { name: 'Get final quote' }).click();
      await expect.poll(() => blockedQuote !== null).toBe(true);
    }
    await page
      .getByRole('button', { name: 'Clear checkout and start a new sale', exact: true })
      .click();
    await expect(page.getByRole('dialog', { name: 'Confirm the sale' })).not.toBeVisible();
    await expect(
      page.getByText('Checkout cleared. Changes made in another window are kept in a new sale.', {
        exact: true,
      }),
    ).toBeVisible();
    const first = await localClearState(page),
      replacementId = first.cleared[0]!.replacementDraftId;
    expect(first.completed).toEqual([]);
    expect(first.cleared).toHaveLength(1);
    expect(first.reviews).toEqual([]);
    expect(first.operations).toEqual([]);
    expect(first.drafts).toEqual([
      expect.objectContaining({
        id: replacementId,
        version: 0,
        lines: [expect.objectContaining({ quantity: 2 })],
      }),
    ]);
    expect(replacementId).not.toBe(draftId);
    if (delayed) {
      await other.getByRole('button', { name: 'Close checkout' }).click();
      await other.getByRole('button', { name: 'Review sale', exact: true }).click();
      await expect(other.getByRole('button', { name: 'Confirm prices online' })).toBeVisible();
      await (blockedQuote as Route | null)?.fulfill({
        status: 409,
        json: { error: { code: 'CHECKOUT_CLEARED', message: 'This checkout is already cleared.' } },
      });
      await expect
        .poll(
          async () =>
            Object.keys(await other.evaluate(() => ({ ...localStorage }))).filter((key) =>
              key.includes(draftId),
            ).length,
        )
        .toBe(0);
      await expect(other.getByRole('dialog', { name: 'Confirm the sale' })).toBeVisible();
      await expect(other.getByRole('button', { name: 'Confirm prices online' })).toBeVisible();
      await expect
        .poll(async () => (await localClearState(other)).reviews.map((row) => row.draftId))
        .toEqual([replacementId]);
      await other.getByRole('button', { name: 'Close checkout' }).click();
    } else {
      await other.getByRole('button', { name: 'Get final quote' }).click();
      await expect(other.getByRole('dialog', { name: 'Confirm the sale' })).not.toBeVisible();
    }
    await page.reload();
    await other.reload();
    const final = await localClearState(other);
    expect(final.cleared).toHaveLength(1);
    expect(final.completed).toEqual([]);
    expect(final.drafts).toEqual(first.drafts);
    expect(final.reviews.some((row) => row.draftId === draftId)).toBe(false);
    expect(
      await other.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith('souled-checkout:')),
      ),
    ).toEqual([]);
    expect(creates).toBe(1);
    expect(imports).toBe(1);
    expect(clears).toBe(1);
    await other.close();
  });
}
