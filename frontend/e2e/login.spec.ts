import { test, expect } from './support/fixtures';
import { e2eOperator } from './support/login';

for (const restoration of ['absent', 'late', 'existing'] as const) {
  test(`password proof remains outside the workspace until OTP and store confirmation succeed (${restoration} restoration)`, async ({
    page,
  }) => {
    let signedIn = false,
      proof = restoration === 'existing',
      verifications = 0,
      challengeReads = 0,
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
      if (path.endsWith('/capabilities')) await route.fulfill({ json: { password: true } });
      else if (path.endsWith('/session-state'))
        // Signed out is a 200 state. A pending password step (a reload mid-login, or the late
        // case's earlier attempt) is reported so the page restores that challenge.
        await route.fulfill({
          json: {
            session: signedIn ? { user: principal, sessionExpiresAt: Date.now() + 3600000 } : null,
            loginChallengePending: !signedIn && (proof || restoration === 'late'),
          },
        });
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
        // Issue a real session for the seeded operator: the real password step sets the
        // pending-login cookie, then this verification is forwarded with the real fixed OTP.
        const origin = new URL(request.url()).origin;
        const realChallenge = await page.request.post('/api/v1/auth/sessions', {
          headers: { origin },
          data: { username: e2eOperator.username, password: e2eOperator.password },
        });
        expect(realChallenge.status()).toBe(202);
        const fixtureSession = await route.fetch({
          postData: JSON.stringify({ code: e2eOperator.otp, factor: 'otp', storeId: '1' }),
        });
        expect(fixtureSession.ok()).toBe(true);
        signedIn = true;
        await route.fulfill({
          response: fixtureSession,
          json: { user: principal, sessionExpiresAt: Date.now() + 3600000 },
        });
      } else if (path.endsWith('/challenges/current')) {
        challengeReads++;
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
    if (restoration === 'absent') await expect(page.getByLabel('Email or username')).toBeVisible();
    else await restoring;
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
    // Without a pending password step the page never asks for a challenge to restore.
    expect(challengeReads).toBe(restoration === 'absent' ? 0 : 1);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(
      'fixture-password',
    );
  });
}
