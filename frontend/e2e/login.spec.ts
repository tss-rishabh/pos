import { test, expect } from '@playwright/test';

for (const restoration of ['absent', 'late', 'existing'] as const) {
  test(`password proof remains outside the workspace until OTP and store confirmation succeed (${restoration} restoration)`, async ({
    page,
  }) => {
    let signedIn = false,
      proof = restoration === 'existing',
      verifications = 0,
      restoreStarted!: () => void,
      releaseRestore!: () => void;
    const restoring = new Promise<void>((resolve) => {
        restoreStarted = resolve;
      }),
      restoreGate = new Promise<void>((resolve) => {
        releaseRestore = resolve;
      });
    const challenge = () => ({
      authentication: 'challenge',
      method: 'otp',
      expiresAt: Date.now() + 300000,
      stores: [{ id: '1', name: 'Fixture Store' }],
      otpChannel: 'sms',
      message: 'One Time Password (OTP) has been sent on your registered mobile number',
      locked: false,
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
        expect(request.postDataJSON()).toEqual({
          username: 'fixture',
          password: 'fixture-password',
        });
        await route.fulfill({ status: 202, json: challenge() });
      } else if (path.endsWith('/challenges/current/verifications')) {
        verifications++;
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
      } else if (path.endsWith('/challenges/current')) {
        restoreStarted();
        if (restoration === 'late') await restoreGate;
        await route.fulfill(
          proof
            ? { json: challenge() }
            : {
                status: 401,
                json: { error: { code: 'LOGIN_CHALLENGE_EXPIRED', message: 'Sign in again.' } },
              },
        );
      } else await route.continue();
    });
    await page.goto('/');
    await restoring;
    if (restoration !== 'existing') {
      await page.getByLabel('Email or username').fill('fixture');
      await page.getByLabel('Password', { exact: true }).fill('fixture-password');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
    }
    await expect(page.getByRole('heading', { name: 'Make it securely yours.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'The counter.' })).toHaveCount(0);
    await page.getByLabel('Verification code').fill('908172');
    if (restoration === 'late') {
      // Reproduce the Windows trace: the mount GET began before credentials but
      // finishes only after the operator has entered the newly issued OTP.
      const restored = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith('/auth/challenges/current') &&
          response.request().method() === 'GET',
      );
      releaseRestore();
      await (await restored).finished();
      // Flush the response's React render before checking controlled input state;
      // this is a browser-frame boundary, not a delay or a click retry.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(page.getByLabel('Verification code')).toHaveValue('908172');
    }
    expect(verifications).toBe(0);
    await expect(page.getByRole('button', { name: 'Verify & check in' })).toBeEnabled();
    await page.getByRole('button', { name: 'Verify & check in' }).click();
    await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
    expect(verifications).toBe(1);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(
      'fixture-password',
    );
  });
}
