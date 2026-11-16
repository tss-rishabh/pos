import { expect, test } from '@playwright/test';

test('opens exact order links in the current store and clears selection before a store transition', async ({
  page,
}) => {
  const id = '9007199254740993',
    requests: string[] = [];
  await page.route('**/api/v1/stores/*/orders/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/cancellations'))
      return route.fulfill({
        json: {
          orderId: id,
          storeId: '1',
          counterId: '1',
          eligible: false,
          snapshotHash: null,
          blocker: 'ORDER_NOT_CANCELLABLE',
          receipt: null,
        },
      });
    if (path.endsWith('/payment-context'))
      return route.fulfill({
        json: {
          orderId: id,
          storeId: '1',
          counterId: '1',
          payable: '99.95',
          canRecordPayment: false,
          activeAttemptId: null,
          legacyPayment: null,
          blocker: 'CHECK_IN_REQUIRED',
        },
      });
    expect(path.split('/').at(-1)).toBe(id);
    requests.push(path);
    expect(route.request().headers()['x-operator-id']).toBeTruthy();
    if (!path.includes('/stores/1/'))
      return route.fulfill({
        status: 404,
        json: {
          error: { code: 'ORDER_NOT_FOUND', message: 'This order is not in the selected store.' },
        },
      });
    return route.fulfill({
      json: {
        reference: 'EXACT-LINK-FIXTURE',
        amount: 99.95,
        isPaid: false,
        status: 'PLACED',
        createdAt: '2026-11-16T10:00:00',
        lines: [
          {
            id: '1',
            productId: '10',
            name: 'Scoped fixture',
            quantity: '1',
            amount: 99.95,
            gst: 5,
            status: 'PLACED',
          },
        ],
      },
    });
  });
  await page.goto('/orders?orderId=' + id);
  await page.getByRole('button', { name: 'Explore demo workspace' }).click();
  await expect(
    page.getByRole('heading', { name: 'EXACT-LINK-FIXTURE', exact: true }),
  ).toBeVisible();
  expect(requests).toEqual([`/api/v1/stores/1/orders/${id}`]);
  await page.getByLabel('Current store', { exact: true }).selectOption('2');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has('orderId')).toBe(false);
  expect(requests).toHaveLength(1);
  await page.goto('/orders?orderId=1e3');
  await expect(page.getByText('The order link contains an invalid reference.')).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.goto('/orders?orderId=' + id);
  await expect(page.getByText('This order is not in the selected store.')).toBeVisible();
  await expect(page.getByText('EXACT-LINK-FIXTURE')).not.toBeVisible();
  expect(requests).toEqual([`/api/v1/stores/1/orders/${id}`, `/api/v1/stores/2/orders/${id}`]);
  await page.getByRole('button', { name: 'Close order', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has('orderId')).toBe(false);
});
