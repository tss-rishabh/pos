import { expect, test, type Page } from '@playwright/test';
import {
  orderSearchOptions,
  type OrderDefaultRanges,
} from '../src/pages/order-history/search-client';
import { signIn } from './support/login';

function originalRange(generatedAt: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(generatedAt));
  const part = (name: string) => parts.find((value) => value.type === name)!.value;
  const wall = new Date(
    `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:00Z`,
  );
  const stamp = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');
  return {
    placedFrom: stamp(new Date(wall.getTime() - 5 * 86400000)),
    placedTo: stamp(new Date(wall.getTime() + 60000)),
  };
}
const local = (value: string) => value.replace(' ', 'T').slice(0, 16);
const metadataResponse = (page: Page) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname.endsWith('/order-search-options') &&
      response.status() === 200,
  );
const searchResponse = (page: Page) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/orders/searches') &&
      response.status() === 200,
  );
async function enter(page: Page, path = '/orders') {
  const metadata = metadataResponse(page),
    result = searchResponse(page);
  await page.goto(path);
  await signIn(page);
  const value = orderSearchOptions.parse((await (await metadata).json()) as unknown);
  expect(value.defaults).toBeDefined();
  const response = await result;
  expect(await response.finished()).toBeNull();
  return {
    defaults: value.defaults!,
    body: response.request().postDataJSON() as Record<string, unknown>,
  };
}
test('actual routed App uses original server-clock defaults and preserves edits through focus and reconnect', async ({
  page,
  context,
}) => {
  const { defaults, body } = await enter(page);
  const expected = originalRange(defaults.generatedAt, defaults.timeZone);
  expect(defaults.store).toEqual(expected);
  expect(body).toMatchObject({
    ...expected,
    from: expected.placedFrom.slice(0, 10),
    to: expected.placedTo.slice(0, 10),
  });
  await expect(page.getByLabel('Orders from', { exact: true })).toHaveValue(
    expected.placedFrom.slice(0, 10),
  );
  await expect(page.getByLabel('Placed from', { exact: true })).toHaveValue(
    local(expected.placedFrom),
  );
  await expect(page.getByLabel('Placed to', { exact: true })).toHaveValue(local(expected.placedTo));
  const unchanged = searchResponse(page);
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  expect((await unchanged).request().postDataJSON()).toMatchObject(expected);
  expect(new URL(page.url()).searchParams.has('from')).toBe(false);
  const custom = local(expected.placedFrom).slice(0, 10) + 'T12:34';
  await page.getByLabel('Placed from', { exact: true }).fill(custom);
  const other = await context.newPage();
  await other.goto('about:blank');
  // Production disables focus refetch globally; exercise a real focus transition.
  await page.bringToFront();
  await other.close();
  await expect(page.getByLabel('Placed from', { exact: true })).toHaveValue(custom);
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Apply filters', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Placed from', { exact: true })).toHaveValue(custom);
  const reconnected = metadataResponse(page);
  await context.setOffline(false);
  await reconnected;
  await expect(page.getByRole('button', { name: 'Apply filters', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Placed from', { exact: true })).toHaveValue(custom);
  const applied = searchResponse(page);
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  expect((await applied).request().postDataJSON()).toMatchObject({
    placedFrom: custom.replace('T', ' ') + ':00',
    placedTo: expected.placedTo,
  });
  const refreshed = metadataResponse(page),
    restarted = searchResponse(page);
  await page.reload();
  const fresh = orderSearchOptions.parse((await (await refreshed).json()) as unknown)
    .defaults as OrderDefaultRanges;
  expect((await restarted).request().postDataJSON()).toMatchObject(
    originalRange(fresh.generatedAt, fresh.timeZone),
  );
});
test('actual routed App retains explicit calendar filters instead of injecting rolling precise bounds', async ({
  page,
}) => {
  const initial = await enter(page, '/orders?from=2026-11-01&to=2026-11-02');
  expect(initial.body).toMatchObject({ from: '2026-11-01', to: '2026-11-02' });
  expect(initial.body).not.toHaveProperty('placedFrom');
  expect(initial.body).not.toHaveProperty('placedTo');
  await expect(page.getByLabel('Orders from', { exact: true })).toHaveValue('2026-11-01');
  await expect(page.getByLabel('Placed from', { exact: true })).toHaveValue('');
  // Use the real server window so synthetic demo rows are present; no response stubs.
  const from = initial.defaults.store.placedFrom.slice(0, 10),
    to = originalRange(initial.defaults.generatedAt, initial.defaults.timeZone).placedTo.slice(
      0,
      10,
    );
  const searched = searchResponse(page);
  await page.goto(`/orders?from=${from}&to=${to}`);
  await searched;
  const opened = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      /\/api\/v1\/stores\/[^/]+\/orders\/[1-9]\d*$/.test(new URL(response.url()).pathname) &&
      response.status() === 200,
  );
  await page
    .getByRole('button', { name: /^View order / })
    .first()
    .click();
  const detail = await opened;
  expect(new URL(detail.url()).searchParams.get('from')).toBe(from);
  expect(new URL(detail.url()).searchParams.get('to')).toBe(to);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close order', exact: true }).click();
  await expect(page.getByLabel('Orders from', { exact: true })).toHaveValue(from);
  await expect(page.getByLabel('Orders to', { exact: true })).toHaveValue(to);
  await page.goto('/orders?from=invalid');
  await expect(page.getByText('Use valid start and end dates.', { exact: true })).toBeVisible();
});
