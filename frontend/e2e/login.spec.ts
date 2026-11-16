import { test, expect } from '@playwright/test';

test('password proof remains outside the workspace until OTP and store confirmation succeed', async ({
  page,
}) => {
  let signedIn = false,
    proof = false;
  const challenge = () => ({
    authentication: 'challenge',
    method: 'otp',
    expiresAt: Date.now() + 300000,
    stores: [{ id: '1', name: 'Fixture Store' }],
    delivery: 'submitted',
  });
  const principal = {
    id: '900001',
    name: 'Fixture operator',
    email: 'operator@example.test',
    role: 4,
    userType: 1,
    storeIds: ['1', '2'],
  };
  await page.route('**/api/v1/auth/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith('/capabilities'))
      await route.fulfill({ json: { password: true, sso: false, demo: true } });
    else if (path.endsWith('/sessions/current'))
      await route.fulfill(
        signedIn
          ? { json: { user: principal, sessionExpiresAt: Date.now() + 3600000 } }
          : {
              status: 401,
              json: { error: { code: 'AUTH_REQUIRED', message: 'Sign in to continue.' } },
            },
      );
    else if (path.endsWith('/auth/sessions')) {
      proof = true;
      expect(request.postDataJSON()).toEqual({ username: 'fixture', password: 'fixture-password' });
      await route.fulfill({ status: 202, json: challenge() });
    } else if (path.endsWith('/challenges/current/verifications')) {
      expect(request.postDataJSON()).toEqual({ code: '908172', factor: 'otp', storeId: '1' });
      const fixtureSession = await route.fetch({
        url: new URL('/api/v1/auth/demo-sessions', request.url()).href,
        method: 'POST',
      });
      expect(fixtureSession.ok()).toBe(true);
      signedIn = true;
      await route.fulfill({
        response: fixtureSession,
        json: { user: principal, sessionExpiresAt: Date.now() + 3600000 },
      });
    } else if (path.endsWith('/challenges/current'))
      await route.fulfill(
        proof
          ? { json: challenge() }
          : {
              status: 401,
              json: { error: { code: 'LOGIN_CHALLENGE_EXPIRED', message: 'Sign in again.' } },
            },
      );
    else await route.continue();
  });
  await page.goto('/');
  await page.getByLabel('Email or username').fill('fixture');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make it securely yours.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The counter.' })).toHaveCount(0);
  await page.getByLabel('Verification code').fill('908172');
  await page.getByRole('button', { name: 'Verify & check in' }).click();
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(
    'fixture-password',
  );
});
