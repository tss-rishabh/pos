import { readFile } from 'node:fs/promises';
import { expect, test } from './support/fixtures';
import { z } from 'zod';
import { signIn } from './support/login';

test.use({ serviceWorkers: 'block' });

test('device QR credentials remain ephemeral, bind revocation and disappear offline', async ({
  page,
  context,
}) => {
  const image = (await readFile('tests/administration/fixtures/private-image.png')).toString(
      'base64',
    ),
    code = '731492',
    revision = 'b'.repeat(64);
  await page.goto('/');
  await signIn(page);
  await page.route('**/api/v1/operators/current/profile', (route) =>
    route.fulfill({
      json: {
        profile: {
          firstName: 'Fixture',
          lastName: 'Operator',
          gender: null,
          age: null,
          email: 'fixture@example.test',
          phone: null,
          contactEmail: null,
          otpMethod: 'email',
          mfaEnabled: false,
          canChangeEmailAndPhone: false,
          hasProfileImage: false,
          hasCoverImage: false,
          revision: 'a'.repeat(64),
        },
        sessionExpiresAt: Date.now() + 3600000,
      },
    }),
  );
  await page.route('**/api/v1/operators/current/device-handoffs/capabilities', (route) =>
    route.fulfill({ json: { available: true } }),
  );
  let requests = 0,
    revoked = 0;
  await page.route('**/api/v1/operators/current/device-handoffs', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON() as unknown).toEqual({});
    requests++;
    const serverNow = Date.now();
    await route.fulfill({
      json: {
        code,
        revision,
        serverNow,
        expiresAt: serverNow + 60000,
        qrDataUrl: 'data:image/png;base64,' + image,
      },
    });
  });
  await page.route('**/api/v1/operators/current/device-handoffs/current', async (route) => {
    expect(route.request().method()).toBe('DELETE');
    expect(
      z
        .object({ revision: z.string() })
        .strict()
        .parse(route.request().postDataJSON() as unknown),
    ).toEqual({ revision });
    revoked++;
    await route.fulfill({ json: { status: 'revoked' } });
  });
  await page.getByRole('link', { name: 'Your profile' }).click();
  await page.getByRole('button', { name: 'Device sign-in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Device sign-in' });
  await expect(dialog.getByRole('img', { name: 'Device sign-in QR code' })).toBeVisible();
  await expect(dialog.getByLabel('Device sign-in code')).toHaveText(code);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(code);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(revision);
  await dialog.getByRole('button', { name: 'Revoke code' }).click();
  await expect(dialog.getByText('Code revoked.')).toBeVisible();
  await expect(dialog.getByRole('img')).toHaveCount(0);
  expect(revoked).toBe(1);
  await dialog.getByRole('button', { name: 'Refresh code' }).click();
  await expect(dialog.getByLabel('Device sign-in code')).toHaveText(code);
  await context.setOffline(true);
  await expect(dialog.getByText('Reconnect to generate a device code.')).toBeVisible();
  await expect(dialog.getByRole('img')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Refresh code' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await context.setOffline(false);
  expect(requests).toBe(2);
});
