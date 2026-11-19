import { test, expect } from './support/fixtures';
import { e2eOperator } from './support/login';

/**
 * W27 header and check-in flow on the real stack: the Log in / Log out toggle, the check-in
 * prompt right after a sign-in without a store, the header check-in / check-out control (the
 * unchanged PUT/DELETE operators/me/check-in), and no bell, sound toggle or connection card.
 */
test('sign-in without a store asks for a check-in; the header checks out, in and logs out', async ({
  page,
}) => {
  const checkIns: string[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/v1/operators/me/check-in')
      checkIns.push(`${response.request().method()} ${response.status()}`);
  });
  await page.goto('/');
  const header = page.getByRole('banner');
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  await header.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByLabel('Email or username')).toBeFocused();
  await page.getByLabel('Email or username').fill(e2eOperator.username);
  await page.getByLabel('Password', { exact: true }).fill(e2eOperator.password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verify and check in' })).toBeVisible();
  // Legacy "Not at the store": signed in without a check-in.
  await page.getByLabel('Login store').selectOption('0');
  await page.getByLabel('Verification code').fill(e2eOperator.otp);
  await page.getByRole('button', { name: 'Verify & check in' }).click();

  const prompt = page.getByRole('dialog', { name: 'Check in to your store' });
  await expect(prompt).toBeVisible();
  await expect(header.getByLabel('Store check-in: Not checked in', { exact: true })).toBeVisible();
  await prompt.getByLabel('Store', { exact: true }).selectOption('1');
  await expect(prompt.getByLabel('Counter', { exact: true })).toBeEnabled();
  await prompt.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await expect(header.getByLabel('Store check-in: Checked in', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();

  // Removed: the separate check-in page and sub-bar link, the sound toggle, an empty bell and
  // the connection card / banner while online with nothing waiting.
  await expect(page.getByRole('link', { name: /Store check-in|Checked in at/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /sound/i })).toHaveCount(0);
  await expect(header.getByRole('button', { name: /^Notifications/ })).toHaveCount(0);
  await expect(header.getByRole('link', { name: /^Offline\./ })).toHaveCount(0);
  await expect(page.getByText('Keyboard shortcuts')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Shortcut reference' })).toHaveCount(0);

  await header.getByRole('button', { name: 'Check out', exact: true }).click();
  await expect(header.getByLabel('Store check-in: Not checked in', { exact: true })).toBeVisible();
  await header.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(header.getByLabel('Store check-in: Checked in', { exact: true })).toBeVisible();
  // A reload is not a fresh sign-in: the prompt is not shown again. Reload only once the
  // check-in refresh settled; a reload cancels in-flight reads.
  await page.waitForLoadState('networkidle');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Check in to your store' })).toHaveCount(0);

  await page.waitForLoadState('networkidle');
  await header.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  const writes = checkIns.filter((entry) => !entry.startsWith('GET'));
  expect(writes).toHaveLength(3);
  expect(writes[0]).toMatch(/^PUT 20\d$/);
  expect(writes[1]).toMatch(/^DELETE 20\d$/);
  expect(writes[2]).toMatch(/^PUT 20\d$/);
});
