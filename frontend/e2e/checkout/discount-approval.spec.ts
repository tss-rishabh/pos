import { test, expect } from '@playwright/test';
import { signIn } from '../support/login';

test('manager approval is restored safely and a changed final quote requires approval again', async ({
  page,
}) => {
  const id = crypto.randomUUID(),
    challengeId = crypto.randomUUID();
  let draftId = '',
    version = 0,
    phase = 'open',
    orderId: string | null = null,
    status = 'required',
    amount = 0,
    requests = 0,
    confirmations = 0,
    orders = 0;
  let draftVersion = 0,
    manifest: { productId: string; quantity: number }[] = [];
  const cart = () => ({
    products: { items: [{ prod_id: 10, quantity: 1, prod_type: 1 }] },
    meta: {
      items: [
        {
          name: 'calculations',
          products_total: 100 - amount,
          total: 100 - amount,
          used_store_discount_pg: amount,
        },
      ],
    },
  });
  const state = () => ({
    id,
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
    cart: cart(),
    quote: phase === 'quoted' || phase === 'submitted' ? cart() : null,
    busyOperationId: null,
    giftCards: {},
  });
  const approval = () => ({
    status,
    amount: amount.toFixed(2),
    productsTotal: (100 - amount).toFixed(2),
    challengeId: status === 'required' ? null : challengeId,
    expiresAt: status === 'required' ? null : Date.now() + 600000,
    retryAt: null,
    delivered: status === 'pending' ? 1 : 0,
    pending: 0,
  });
  await page.route('**/api/v1/stores/1/checkout-sessions**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() === 'GET')
      return route.fulfill({ json: path.endsWith('/discount-approval') ? approval() : state() });
    if (path.endsWith('/checkout-sessions')) {
      const draft = req.postDataJSON() as Record<string, unknown>;
      draftId = String(draft.draftId);
      draftVersion = Number(draft.draftVersion);
      manifest = draft.lineItems as typeof manifest;
      return route.fulfill({ status: 201, json: state() });
    }
    const body = req.postDataJSON() as Record<string, unknown>;
    expect(body.expectedVersion).toBe(version);
    version++;
    if (path.endsWith('/discount')) {
      expect(body).toMatchObject({
        kind: 'store',
        amount: '20',
        apply: true,
        remark: 'PRIVATE-DISCOUNT-REMARK',
        reason: 'Founder billing',
      });
      amount = 20;
      phase = 'open';
    }
    if (path.endsWith('/quotes')) {
      phase = 'quoted';
      status = 'required';
    }
    if (path.endsWith('/challenges')) {
      requests++;
      status = 'pending';
    }
    if (path.endsWith('/confirmations')) {
      confirmations++;
      expect(body.code).toBe('123456');
      status = 'approved';
    }
    if (path.endsWith('/order-submissions')) {
      orders++;
      phase = 'submitted';
      orderId = '7701';
    }
    return route.fulfill({
      status: 200,
      json: {
        status: 'succeeded',
        state: state(),
        result: {
          ...(path.includes('/discount-approval/') ? { discountApproval: approval() } : {}),
          ...(orderId ? { orderId, paymentStatus: 'pending' } : {}),
        },
      },
    });
  });
  await page.route('**/api/v1/stores/1/orders/7701/payment-options', (route) =>
    route.fulfill({
      json: { payable: '80.00', options: [{ channel: 'cash', label: 'Cash', machineId: null }] },
    }),
  );
  await page.route('**/api/v1/stores/1/orders/7701/payment-attempts', (route) =>
    route.fulfill({ json: { data: [] } }),
  );
  await page.goto('/');
  await signIn(page);
  await page
    .getByRole('button', { name: /^Add .+ to sale$/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Review sale', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm prices online' }).click();
  await page.getByText('Store and payment gateway discounts', { exact: true }).click();
  await page.getByLabel('Discount amount', { exact: true }).fill('20');
  await page.getByLabel('Discount remark', { exact: true }).fill('PRIVATE-DISCOUNT-REMARK');
  await page.getByLabel('Store discount reason').selectOption('Founder billing');
  await page.getByRole('button', { name: 'Apply discount', exact: true }).click();
  await page.getByRole('button', { name: 'Get final quote' }).click();
  await expect(page.getByRole('button', { name: 'Create order', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Request manager approval code' }).click();
  await expect(page.getByText('The manager code was sent.')).toBeVisible();
  await page.getByLabel('Manager approval code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Verify manager approval' }).click();
  await expect(page.getByRole('button', { name: 'Create order', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('123456');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(
    'PRIVATE-DISCOUNT-REMARK',
  );
  await page.getByRole('button', { name: 'Close checkout' }).click();
  await page.getByRole('button', { name: 'Review sale', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create order', exact: true })).toBeEnabled();
  expect(requests).toBe(1);
  expect(confirmations).toBe(1);
  expect(orders).toBe(0);
  await page.getByRole('button', { name: 'Refresh final quote' }).click();
  await expect(page.getByRole('button', { name: 'Create order', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Request manager approval code' }).click();
  await page.getByLabel('Manager approval code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Verify manager approval' }).click();
  await page.getByRole('button', { name: 'Create order', exact: true }).click();
  await expect(
    page.getByText('Payment must be confirmed before handing over products.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close checkout' }).click();
  await expect(page.getByRole('button', { name: 'Review sale', exact: true })).toBeEnabled();
  expect(orders).toBe(1);
  expect(requests).toBe(2);
});
