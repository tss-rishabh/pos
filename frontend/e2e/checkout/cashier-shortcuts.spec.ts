import { test, expect, type Page } from '@playwright/test';
import { z } from 'zod';
import { signIn } from '../support/login';

async function counter(page: Page) {
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
}
async function bodyKeys(page: Page, key: string) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press(key);
}
async function fixture(page: Page, beforeCreateResponse?: () => Promise<void>) {
  const id = crypto.randomUUID();
  let ownerId = '900001',
    draftId = '',
    draftVersion = 0,
    version = 0,
    loaded = false,
    phase = 'open',
    exclusive = false,
    npsFeedback = false,
    creates = 0,
    quotes = 0,
    orderSubmissions = 0,
    cashWrites = 0,
    clears = 0,
    reads = 0;
  const mutations: { path: string; body: unknown }[] = [];
  let manifest: { productId: string; quantity: number }[] = [];
  const cart = () => ({
    products: {
      items: manifest.map((line) => ({
        prod_id: line.productId,
        quantity: line.quantity,
        prod_type: 1,
      })),
    },
    giftvouchers: { items: [] },
    meta: {
      items: [
        { name: 'calculations', products_total: 99.95, total: 99.95 },
        { name: 'exclusive_user', active: exclusive },
      ],
    },
  });
  const state = () => ({
    id,
    operatorId: ownerId,
    draftId,
    draftVersion,
    draftImport: {
      lineItems: manifest,
      completedProductIds: loaded ? manifest.map((line) => line.productId) : [],
      status: loaded ? 'complete' : 'pending',
    },
    storeId: '1',
    counterId: '1',
    version,
    customerId: null,
    salespersonId: '5',
    lineSalespersons: {},
    orderNotifications: { sendSms: true, npsFeedback },
    verifiedCustomerUntil: null,
    phase,
    orderId: null,
    orderSubmissionOperationId: null,
    confirmationPhase: null,
    busyOperationId: null,
    giftCards: {},
    cart: loaded ? cart() : null,
    quote: phase === 'quoted' ? cart() : null,
    settlement: null,
  });
  await page.route('**/api/v1/stores/1/salespeople?**', (route) =>
    route.fulfill({ json: { data: [{ id: '5', name: 'Fixture salesperson' }], nextCursor: null } }),
  );
  await page.route('**/api/v1/stores/1/checkout-sessions**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      reads++;
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
          : state(),
      });
    }
    const raw: unknown = request.postDataJSON();
    mutations.push({ path, body: raw });
    if (path.endsWith('/checkout-sessions')) {
      const input = z
        .object({
          draftId: z.uuid(),
          draftVersion: z.number(),
          lineItems: z.array(z.object({ productId: z.string(), quantity: z.number() })),
        })
        .parse(raw);
      ownerId = request.headers()['x-operator-id'] || ownerId;
      draftId = input.draftId;
      draftVersion = input.draftVersion;
      manifest = input.lineItems;
      creates++;
      await beforeCreateResponse?.();
      return route.fulfill({ status: 201, json: state() });
    }
    const input = z.object({ operationId: z.uuid(), expectedVersion: z.number() }).parse(raw);
    expect(input.expectedVersion).toBe(version);
    if (path.endsWith('/draft-initializations')) loaded = true;
    else if (path.endsWith('/quotes')) {
      quotes++;
      phase = 'quoted';
    } else if (path.endsWith('/membership-benefits')) {
      exclusive = z.object({ enabled: z.boolean() }).parse(raw).enabled;
      phase = 'open';
    } else if (path.endsWith('/order-notifications'))
      npsFeedback = z.object({ npsFeedback: z.boolean() }).parse(raw).npsFeedback;
    else if (path.endsWith('/order-submissions')) orderSubmissions++;
    else if (path.endsWith('/settlement-note')) cashWrites++;
    else if (path.endsWith('/clear')) clears++;
    else throw new Error('Unexpected keyboard fixture operation.');
    version++;
    return route.fulfill({ json: { status: 'succeeded', state: state(), result: {} } });
  });
  await page.route('**/api/v1/stores/1/orders/*/payments**', (route) => {
    cashWrites++;
    return route.abort();
  });
  return {
    mutations,
    stats: () => ({ creates, quotes, orderSubmissions, cashWrites, clears, reads }),
  };
}

test('counter shortcuts respect typing, input methods, other dialogs and the persisted off switch', async ({
  page,
}) => {
  await counter(page);
  await bodyKeys(page, 'b');
  const search = page.getByRole('textbox', { name: 'Search products or scan a barcode' });
  await expect(search).toBeFocused();
  await search.fill('');
  await page.keyboard.type('tpen');
  await expect(page.locator('.sale-tabs > button:not(.new-tab)')).toHaveCount(1);
  await search.fill('');
  await bodyKeys(page, 't');
  await expect(page.locator('.sale-tabs > button:not(.new-tab)')).toHaveCount(2);
  await page.getByText('Keyboard shortcuts', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Enable letter shortcuts' }).uncheck();
  await bodyKeys(page, 't');
  await expect(page.locator('.sale-tabs > button:not(.new-tab)')).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
  await bodyKeys(page, 't');
  await expect(page.locator('.sale-tabs > button:not(.new-tab)')).toHaveCount(2);
});

test('P/PP never bypass pricing or duplicate an order; F only prepares and focuses cash review', async ({
  page,
}) => {
  let releaseCreate = () => {};
  const createResponse = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const api = await fixture(page, () => createResponse);
  await counter(page);
  await page.getByRole('button', { name: 'Add Classic: Oversized T-shirt to sale' }).click();
  await expect(page.getByRole('button', { name: 'Review sale', exact: true })).toBeEnabled();
  await bodyKeys(page, 'p');
  // Assert the second press while checkout creation is actually pending;
  // separate keyboard round trips can otherwise arrive after pricing is ready.
  await expect.poll(() => api.stats().creates).toBe(1);
  await page.keyboard.press('p');
  releaseCreate();
  const dialog = page.getByRole('dialog', { name: 'Confirm the sale' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Get final quote' })).toBeEnabled();
  expect(api.stats()).toMatchObject({
    creates: 1,
    quotes: 0,
    orderSubmissions: 0,
    cashWrites: 0,
    clears: 0,
  });
  // Legacy F clicks #fast-checkout (create_order.html:1032-1038): the final quote is taken and
  // the Fast Checkout (Cash Only) dialog opens with its order message focused; nothing is charged.
  await bodyKeys(page, 'f');
  const fastCash = page.getByRole('dialog', { name: /^Fast Checkout \(Cash Only\)!/ });
  await expect(fastCash.getByRole('textbox', { name: 'Order Message' })).toBeFocused();
  expect(api.stats()).toMatchObject({
    creates: 1,
    quotes: 1,
    orderSubmissions: 0,
    cashWrites: 0,
    clears: 0,
  });
  await bodyKeys(page, 'f');
  await page.keyboard.press('f');
  expect(api.stats().cashWrites).toBe(0);
  await bodyKeys(page, 't');
  await expect(page.locator('.sale-tabs > button:not(.new-tab)')).toHaveCount(1);
  await bodyKeys(page, 'r');
  await expect.poll(() => api.stats().reads).toBeGreaterThan(0);
  expect(api.stats()).toMatchObject({ orderSubmissions: 0, cashWrites: 0, clears: 0 });
});

test('N/E/S use scoped enabled controls and letters typed into cash remain ordinary input', async ({
  page,
}) => {
  const api = await fixture(page);
  await counter(page);
  await page.getByRole('button', { name: 'Add Classic: Oversized T-shirt to sale' }).click();
  await expect(page.getByRole('button', { name: 'Review sale', exact: true })).toBeEnabled();
  await bodyKeys(page, 's');
  const salesperson = page.getByRole('combobox', { name: 'Sale salesperson', exact: true });
  await expect(salesperson).toBeFocused();
  // Legacy posts nps_feedback_switch from a checked, disabled box (create_order.html:76), so N
  // has no enabled target and changes nothing.
  await bodyKeys(page, 'n');
  await page.getByText('Order messages', { exact: true }).click();
  const nps = page.getByRole('checkbox', { name: 'NPS Feedback' });
  await expect(nps).toBeChecked();
  await expect(nps).toBeDisabled();
  expect(api.mutations.filter((call) => call.path.endsWith('/order-notifications'))).toEqual([]);
  await bodyKeys(page, 'e');
  await expect(page.getByRole('checkbox', { name: 'Apply walk-in member benefits' })).toBeChecked();
  expect(api.mutations.filter((call) => call.path.endsWith('/membership-benefits'))).toHaveLength(
    1,
  );
  await bodyKeys(page, 'f');
  const message = page
    .getByRole('dialog', { name: /^Fast Checkout \(Cash Only\)!/ })
    .getByRole('textbox', { name: 'Order Message' });
  await expect(message).toBeFocused();
  await page.keyboard.type('penrst');
  await expect(message).toHaveValue('penrst');
  expect(api.stats()).toMatchObject({ orderSubmissions: 0, cashWrites: 0, clears: 0 });
  expect(api.mutations.filter((call) => call.path.endsWith('/membership-benefits'))).toHaveLength(
    1,
  );
});
