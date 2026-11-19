import { expect, test, type Page, type Response } from '@playwright/test';
import {
  orderSearchOptions,
  type OrderDefaultRanges,
} from '../../src/pages/order-history/search-client';
import {
  applyFixtures,
  enter,
  harnessOperatorId,
  isSearch,
  pageErrors,
  type HarnessManifest,
} from '../harness/support';

/**
 * Order history (legacy `OrdersView` / `ShowOrderDetailsView`) on the real stack: the routed
 * Orders page, the server-clock default window, explicit calendar ranges read from MySQL (no
 * warehouse path), order details read by id only, exact order links, the Online view and the
 * request reference on a refused read. Rows: the e2e seed plus harness-fixtures.ts `orders`.
 * order-default-ranges.spec.ts (Playwright suite) additionally covers focus/reconnect/reload.
 */
let fixtures: HarnessManifest;
test.beforeAll(() => {
  fixtures = applyFixtures('orders');
});

/** Legacy OrdersView: local minute floor, five days back, one minute ahead (independent). */
function sourceWindow(defaults: OrderDefaultRanges) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: defaults.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(defaults.generatedAt));
  const part = (name: string) => parts.find((value) => value.type === name)?.value ?? '';
  const wall = Date.parse(
    `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:00Z`,
  );
  const stamp = (value: number) => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
  return { placedFrom: stamp(wall - 5 * 86_400_000), placedTo: stamp(wall + 60_000) };
}
const rowIds = (page: Page) =>
  page
    .locator('.order-search-workspace tbody tr')
    .evaluateAll((rows) =>
      rows.map((row) => row.querySelector('td button')?.textContent?.trim() ?? ''),
    );
const isDetail = (id: string) => (response: Response) =>
  response.request().method() === 'GET' &&
  new URL(response.url()).pathname === `/api/v1/stores/1/orders/${id}`;
const isOptions = (response: Response) =>
  new URL(response.url()).pathname === '/api/v1/stores/1/order-search-options';

test('order history reads current and historical orders, details and links from MySQL', async ({
  page,
}) => {
  const errors = pageErrors(page);
  const history = fixtures.orders.find((order) => order.id === '6106');
  if (!history) throw new Error('The historical harness order is missing.');
  const historyDate = history.created.slice(0, 10);

  // 1. Server-clock default window, applied by the first explicit search.
  const options = page.waitForResponse(isOptions),
    initial = page.waitForResponse(isSearch);
  await enter(page, '/orders');
  const metadata = orderSearchOptions.parse((await (await options).json()) as unknown);
  if (!metadata.defaults) throw new Error('The server omitted the original order window.');
  const expected = sourceWindow(metadata.defaults);
  expect(metadata.defaults.store).toEqual(expected);
  const first = await initial;
  expect(first.request().headers()['x-operator-id']).toBe(harnessOperatorId);
  expect(first.request().postDataJSON()).toMatchObject({
    ...expected,
    from: expected.placedFrom.slice(0, 10),
    to: expected.placedTo.slice(0, 10),
  });
  await expect(page.getByLabel('Orders from', { exact: true })).toHaveValue(
    expected.placedFrom.slice(0, 10),
  );
  await expect(page.getByLabel('Orders to', { exact: true })).toHaveValue(
    expected.placedTo.slice(0, 10),
  );
  await expect(page.getByRole('button', { name: 'View order 6008', exact: true })).toBeVisible();
  expect(await rowIds(page)).not.toContain('6106');

  // 2. An explicit past calendar range is read from MySQL like any other (no warehouse notice).
  await page.getByLabel('Orders from', { exact: true }).fill(historyDate);
  await page.getByLabel('Orders to', { exact: true }).fill(historyDate);
  const past = page.waitForResponse(isSearch);
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  const pastResponse = await past;
  expect(pastResponse.status()).toBe(200);
  const pastBody = pastResponse.request().postDataJSON() as Record<string, unknown>;
  expect(pastBody).toMatchObject({ from: historyDate, to: historyDate, orderType: 'ST' });
  expect(pastBody).not.toHaveProperty('placedFrom');
  expect(await pastResponse.json()).toMatchObject({ reader: 'primary', recordsFiltered: '1' });
  expect(new URL(page.url()).searchParams.get('from')).toBe(historyDate);
  await expect(page.locator('.order-search-workspace tbody tr')).toHaveCount(1);
  expect(await rowIds(page)).toEqual(['6106']);
  await expect(page.locator('.order-search-workspace tbody tr').first()).toContainText(
    history.created,
  );

  // 3. Details are read by order id only (legacy ShowOrderDetailsView), never by date window.
  const detail = page.waitForResponse(isDetail('6106'));
  await page.getByRole('button', { name: 'View order 6106', exact: true }).click();
  const detailResponse = await detail;
  expect(detailResponse.status()).toBe(200);
  expect(new URL(detailResponse.url()).search).toBe('');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: history.reference, exact: true })).toBeVisible();
  await expect(dialog).toContainText('₹2,499.00');
  await expect(dialog).toContainText('Signature: Denim Jacket');
  await expect(dialog).toContainText(`Placed ${history.created.slice(0, 10)}`);
  await page.getByRole('button', { name: 'Close order', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Orders from', { exact: true })).toHaveValue(historyDate);
  expect(new URL(page.url()).searchParams.has('orderId')).toBe(false);

  // 4. An exact order link of unknown age opens directly, without a date filter.
  const linked = page.waitForResponse(isDetail('6106'));
  await page.goto('/orders?orderId=6106');
  const linkedResponse = await linked;
  expect(linkedResponse.status()).toBe(200);
  expect(new URL(linkedResponse.url()).search).toBe('');
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: history.reference, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close order', exact: true }).click();

  // 5. A refused read shows the server message and its request reference.
  const missing = page.waitForResponse(isDetail('999999'));
  await page.goto('/orders?orderId=999999');
  const missingResponse = await missing;
  expect(missingResponse.status()).toBe(404);
  const reference = missingResponse.headers()['x-request-id'] ?? '';
  expect(reference).toMatch(/^[0-9a-f-]{36}$/);
  const refusal = page.getByRole('dialog').getByRole('alert');
  await expect(refusal.locator('code')).toHaveText(reference);
  const message = ((await missingResponse.json()) as { error: { message: string } }).error.message;
  await expect(refusal).toContainText(message);
  await page.getByRole('button', { name: 'Close order', exact: true }).click();

  // 6. The Online view is local delivery with no default date range.
  await page.goto('/orders');
  await expect(page.getByRole('button', { name: 'View order 6008', exact: true })).toBeVisible();
  const onlineSearch = page.waitForResponse(isSearch);
  await page.getByRole('button', { name: 'Online orders', exact: true }).click();
  const onlineResponse = await onlineSearch;
  const onlineBody = onlineResponse.request().postDataJSON() as Record<string, unknown>;
  expect(onlineBody).toMatchObject({ orderType: 'HL', storeIds: ['1'] });
  for (const name of ['from', 'to', 'placedFrom', 'placedTo'])
    expect(onlineBody).not.toHaveProperty(name);
  await expect(page.getByRole('heading', { name: 'Online orders.', exact: true })).toBeVisible();
  expect(await rowIds(page)).toEqual(['6102']);
  errors.assertNone();
});
