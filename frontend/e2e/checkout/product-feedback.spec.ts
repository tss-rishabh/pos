import { expect, test } from '../support/fixtures';
import { signIn } from '../support/login';

test('mounts scoped product feedback in the production app and rejects store changes and malformed IDs before reading', async ({
  page,
}) => {
  const requests: string[] = [];
  const orderId = '9007199254740993';
  await page.route(
    '**/api/v1/stores/*/checkout-sessions/*/customers/*/orders/*/product-feedback?*',
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      expect(route.request().headers()['x-operator-id']).toBeTruthy();
      await route.fulfill({
        json: {
          customerId: '777',
          checkoutVersion: 1,
          orderId,
          orderAmount: 125.5,
          editable: true,
          items: [
            {
              lineId: '9007199254740997',
              productId: '9007199254740995',
              name: 'Production feedback fixture',
              feedback: [
                {
                  id: '9007199254741001',
                  optionId: '0',
                  rating: 4.5,
                  platform: 'WEB',
                  comment: '<script>window.feedbackPwned=true</script>',
                },
              ],
            },
          ],
          nextCursor: null,
        },
      });
    },
  );
  const path = (store: string, customer: string) =>
    `/stores/${store}/checkout-sessions/a53b9ec4-76ce-4641-95d5-7d3f4f073ab4/customers/${customer}/orders/${orderId}/feedback`;
  await page.goto(path('1', '777'));
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Product feedback', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Production feedback fixture' })).toBeVisible();
  await expect(
    page.getByRole('cell', { name: '<script>window.feedbackPwned=true</script>', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Object.hasOwn(window, 'feedbackPwned'))).toBe(false);
  expect(requests).toHaveLength(1);
  await page.getByLabel('Current store', { exact: true }).selectOption('2');
  await expect(
    page.getByText('Open product feedback from the customer history in your current store.'),
  ).toBeVisible();
  await expect(page.getByText('Production feedback fixture')).not.toBeVisible();
  expect(requests).toHaveLength(1);
  await page.goto(path('2', 'bad-id'));
  await expect(
    page.getByText('Open product feedback from the customer history in your current store.'),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
});
