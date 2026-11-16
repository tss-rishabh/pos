import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test('public staff QR opens before login, keeps the proof out of the URL and omits session cookies', async ({ page, context }) => {
  const authenticationReads: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/auth/sessions/current')) authenticationReads.push(request.url());
  });
  await context.addCookies([{ name: 'pos_session', value: 'fixture-private-cookie', domain: 'localhost', path: '/' }]);
  let calls = 0;
  await page.route('**/api/v1/auth/application-links/staff-download-activations', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers().cookie).toBeUndefined();
    expect(route.request().headers()['x-operator-id']).toBeUndefined();
    expect(route.request().postDataJSON()).toEqual({ token: 'A'.repeat(43), operationId: expect.any(String) });
    calls++;
    await route.fulfill({ status: 409, json: { error: { code: 'APPLICATION_LINK_EXPIRED' } } });
  });
  await page.goto('/application-links/staff#' + 'A'.repeat(43));
  await expect(page.getByRole('heading', { name: 'Staff application download' })).toBeVisible();
  await expect(page).toHaveURL('/application-links/staff');
  await page.getByRole('button', { name: 'Download staff installer' }).click();
  await expect(page.getByText('This application link expired or was already used. Request a new QR code.')).toBeVisible();
  expect(calls).toBe(1);
  expect(authenticationReads).toEqual([]);
});

test('invalid public proof stays outside the operator workspace and makes no redemption request', async ({ page }) => {
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  await page.goto('/application-links/customer#invalid');
  await expect(page.getByRole('heading', { name: 'Open the customer application' })).toBeVisible();
  await expect(page.getByText('This link is invalid. Request a new QR code from the store.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open customer app' })).toHaveCount(0);
  expect(apiRequests).toEqual([]);
});
