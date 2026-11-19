import { test, expect } from './support/fixtures';
import { z } from 'zod';
import { sessionSchema } from '../src/api/schemas';
import { signIn } from './support/login';

test('self-service profile updates, password validation and offline restrictions', async ({
  network,
  page,
  context,
}) => {
  // A wrong current password is refused with 400 on purpose.
  network.expectFailure({
    method: 'PUT',
    path: '/api/v1/operators/current/password',
    outcome: 400,
  });
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
  const session = sessionSchema.parse(
    await (await page.request.get('/api/v1/auth/sessions/current')).json(),
  );
  let profile = {
    firstName: 'Fixture',
    lastName: 'Operator',
    gender: null,
    age: null,
    email: 'fixture@example.test',
    phone: '2222222222',
    contactEmail: 'otp@example.test',
    otpMethod: 'email',
    mfaEnabled: false,
    canChangeEmailAndPhone: false,
    hasProfileImage: true,
    hasCoverImage: true,
    revision: 'a'.repeat(64),
  };
  let passwordAttempts = 0;
  await page.route('**/api/v1/operators/current/profile', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = z
        .object({ firstName: z.string(), revision: z.string() })
        .passthrough()
        .parse(route.request().postDataJSON() as unknown);
      expect(body.revision).toBe(profile.revision);
      expect(body).not.toHaveProperty('role');
      profile = { ...profile, firstName: body.firstName, revision: 'b'.repeat(64) };
    }
    await route.fulfill({
      json: {
        profile,
        user: { ...session.user, name: `${profile.firstName} ${profile.lastName}` },
        sessionExpiresAt: session.sessionExpiresAt,
      },
    });
  });
  await page.route('**/api/v1/operators/current/password', async (route) => {
    passwordAttempts++;
    const body = z
      .object({ currentPassword: z.string(), newPassword: z.string(), confirmation: z.string() })
      .strict()
      .parse(route.request().postDataJSON() as unknown);
    if (body.currentPassword !== 'old-fixture-password')
      await route.fulfill({
        status: 400,
        json: {
          error: { code: 'CURRENT_PASSWORD_INVALID', message: 'Check your current password.' },
        },
      });
    else {
      expect(body.newPassword).toBe(body.confirmation);
      profile = { ...profile, revision: 'c'.repeat(64) };
      await route.fulfill({
        json: { profile, user: session.user, sessionExpiresAt: session.sessionExpiresAt },
      });
    }
  });
  await page.getByRole('link', { name: 'Your profile' }).click();
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
  await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('readonly', '');
  await page.getByLabel('First name').fill('Updated');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByLabel('First name')).toHaveValue('Updated');
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Change password', exact: true }) });
  await form.getByLabel('Current password', { exact: true }).fill('wrong-fixture-password');
  await form.getByLabel('New password', { exact: true }).fill('Independent passphrase! 42');
  await form.getByLabel('Confirm new password').fill('Mismatch phrase!');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(form.getByRole('alert')).toHaveText('Passwords must match.');
  expect(passwordAttempts).toBe(0);
  await form.getByLabel('Confirm new password').fill('Independent passphrase! 42');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(form.getByText('Check your current password.')).toBeVisible();
  await form.getByLabel('Current password', { exact: true }).fill('old-fixture-password');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(form.getByRole('status')).toContainText('Password changed.');
  await expect(form.getByLabel('Current password', { exact: true })).toHaveValue('');
  expect(passwordAttempts).toBe(2);
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Save profile' })).toBeDisabled();
  await expect(form.getByRole('button', { name: 'Change password' })).toBeDisabled();
  await context.setOffline(false);
});
