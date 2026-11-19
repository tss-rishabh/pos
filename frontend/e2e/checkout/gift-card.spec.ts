import { test, expect } from '@playwright/test';
import { signIn } from '../support/login';

test('physical cards keep individual serials and dates through custom value replacement and recovery', async ({
  page,
}) => {
  const id = crypto.randomUUID();
  let draftId = '',
    draftVersion = 0,
    version = 0,
    initializations = 0,
    valueChanges = 0;
  let manifest: { productId: string; quantity: number }[] = [],
    items: {
      gv_id: string;
      prod_id: number;
      quantity: number;
      price: number;
      gvamount: number;
      custom_price: boolean;
      product: string;
    }[] = [];
  let nextId = 9007199254740993n;
  const metadata: Record<string, { number: string; startDate: string; endDate: string }> = {},
    values: Record<string, number> = {};
  const dates = { startDate: '2026-11-17', endDate: '2027-02-15' };
  const cart = () => ({
    products: { items: [] },
    giftvouchers: { items },
    meta: {
      items: [{ name: 'calculations', total: items.reduce((sum, item) => sum + item.gvamount, 0) }],
    },
  });
  const state = () => ({
    id,
    draftId,
    draftVersion,
    draftImport: {
      lineItems: manifest,
      completedProductIds: version ? ['80'] : [],
      status: version ? 'complete' : 'pending',
    },
    storeId: '1',
    counterId: '1',
    version,
    customerId: null,
    verifiedCustomerUntil: null,
    phase: 'open',
    orderId: null,
    cart: version ? cart() : null,
    quote: null,
    busyOperationId: null,
    giftCards: metadata,
    giftCardDates: Object.fromEntries(items.map((item) => [item.gv_id, dates])),
    giftCardValues: values,
  });
  const add = (value = 500) => ({
    gv_id: String(nextId++),
    prod_id: 80,
    quantity: 1,
    price: value,
    gvamount: value,
    custom_price: value !== 500,
    product: 'Fixture gift card',
  });
  await page.route('**/api/v1/stores/1/catalog/products?*', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: '80',
            name: 'Fixture gift card',
            erpName: 'GIFTCARD500',
            barcode: '8900000000080',
            parentId: '0',
            type: '8',
            price: '500.00',
            specialPrice: '0.00',
            exclusivePrice: null,
            stock: 100,
            gst: 0,
            image: null,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route('**/api/v1/stores/1/checkout-sessions**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: state() });
    const body = request.postDataJSON() as Record<string, unknown>;
    if (path.endsWith('/checkout-sessions')) {
      draftId = String(body.draftId);
      draftVersion = Number(body.draftVersion);
      manifest = body.lineItems as typeof manifest;
      return route.fulfill({ status: 201, json: state() });
    }
    expect(body.expectedVersion).toBe(version);
    if (path.endsWith('/draft-initializations')) {
      initializations++;
      expect(manifest).toEqual([{ productId: '80', quantity: 2 }]);
      items = [add(), add()];
    } else if (path.endsWith('/value')) {
      valueChanges++;
      const oldId = path.split('/').at(-2)!,
        old = metadata[oldId],
        replacement = add(body.customValue === null ? 500 : Number(body.customValue));
      items = items.map((item) => (item.gv_id === oldId ? replacement : item));
      if (old) metadata[replacement.gv_id] = old;
      delete metadata[oldId];
      delete values[oldId];
      if (body.customValue !== null) values[replacement.gv_id] = Number(body.customValue);
    } else if (path.endsWith('/removals')) {
      const oldId = path.split('/').at(-2)!;
      items = items.filter((item) => item.gv_id !== oldId);
      delete metadata[oldId];
      delete values[oldId];
    } else if (/\/gift-card-items\/\d+$/.test(path)) {
      const giftId = path.split('/').at(-1)!;
      metadata[giftId] = {
        number: String(body.number).replaceAll('_', ''),
        startDate: String(body.startDate),
        endDate: String(body.endDate),
      };
    } else throw new Error('Unexpected physical-card fixture mutation.');
    version++;
    return route.fulfill({ json: { status: 'succeeded', state: state(), result: {} } });
  });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add Fixture gift card to sale' }).click();
  await page.getByRole('button', { name: 'Increase Fixture gift card' }).click();
  await page.getByRole('button', { name: 'Review sale', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm prices online' }).click();
  const groups = page.getByRole('group', { name: 'Fixture gift card', exact: true });
  await expect(groups).toHaveCount(2);
  await expect(groups.first().getByLabel('Valid from')).toHaveValue('2026-11-17');
  await expect(groups.first().getByLabel('Valid until')).toHaveValue('2027-02-15');
  await groups.first().getByLabel('Gift card number', { exact: true }).fill('990_111');
  await groups.first().getByLabel('Valid until').fill('2027-05-17');
  await groups.first().getByRole('button', { name: 'Save card number and dates' }).click();
  await expect(groups.first().getByText('Card number and dates are saved.')).toBeVisible();
  await groups.first().getByLabel('Custom gift card value').fill('1234');
  await groups.first().getByRole('button', { name: 'Apply gift card value' }).click();
  await expect(groups.first().getByLabel('Gift card number', { exact: true })).toHaveValue(
    '990111',
  );
  await expect(groups.first().getByLabel('Valid until')).toHaveValue('2027-05-17');
  await expect(groups.first().getByText(/Card value:.*1,234/)).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('990111');
  await page.getByRole('button', { name: 'Close checkout' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Review sale', exact: true }).click();
  await expect(groups).toHaveCount(2);
  await expect(groups.first().getByLabel('Custom gift card value')).toHaveValue('1234');
  await groups.first().getByRole('button', { name: 'Use catalog gift card value' }).click();
  await expect(groups.first().getByLabel('Gift card number', { exact: true })).toHaveValue(
    '990111',
  );
  await expect(groups.first().getByText(/Card value:.*500/)).toBeVisible();
  await groups.last().getByRole('button', { name: 'Remove this gift card' }).click();
  await expect(groups).toHaveCount(1);
  expect(initializations).toBe(1);
  expect(valueChanges).toBe(2);
  expect(Object.values(metadata)[0]).toEqual({
    number: '990111',
    startDate: '2026-11-17',
    endDate: '2027-05-17',
  });
});
