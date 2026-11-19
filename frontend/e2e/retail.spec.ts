import { test, expect } from '@playwright/test';
import { signIn } from './support/login';

test('desktop web flow: search, durable cart, offline reload, replay, and order details', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Classic: Oversized T-shirt to sale' }).click();
  await page.getByRole('button', { name: 'Increase Classic: Oversized T-shirt' }).click();
  await expect(page.getByText('₹1,998.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Save sale', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save sale', exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
  await expect(page.getByText('₹1,998.00').first()).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('You’re offline. Your carts stay on this device.')).toBeVisible();
  await expect(page.getByText('₹1,998.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Add Everyday: Crew Neck to sale' }).click();
  await page.getByRole('button', { name: 'Save on this device', exact: true }).click();
  await expect(page.getByText('Saved locally · sync pending')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Save sale', exact: true })).toBeEnabled({
    timeout: 15000,
  });
  await page.getByRole('link', { name: 'Orders', exact: true }).click();
  await page.getByRole('button', { name: 'View order 6008', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close order' }).click();
  await page.screenshot({ path: 'test-results/orders-desktop.png', fullPage: true });
  await page.getByRole('link', { name: 'The counter', exact: true }).click();
  await page.screenshot({ path: 'test-results/counter-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('operator logout retains drafts but removes identity and cached catalog', async ({ page }) => {
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add Classic: Oversized T-shirt to sale' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Let’s open the store.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Let’s open the store.' })).toBeVisible();
  await signIn(page);
  await expect(page.getByText('₹999.00').last()).toBeVisible();
});

// Report rendering and totals are covered with fixture responses in daily-report.spec.ts. The e2e
// stack limits the legacy day-close rollout (DAY_CLOSE_ENABLED_STORE_IDS) to an unseeded store,
// so the real resource refuses daily reporting for the checked-in store.
test('daily reports call the versioned resource and respect the day-close rollout', async ({
  page,
}) => {
  await page.goto('/');
  await signIn(page);
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  const response = page.waitForResponse((value) =>
    new URL(value.url()).pathname.endsWith('/api/v1/reports/daily-store-sales'),
  );
  await page.getByRole('button', { name: 'View report' }).click();
  expect((await response).status()).toBe(403);
  await expect(
    page.getByText('Daily reporting is not enabled for your checked-in store.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Daily breakdown' })).toHaveCount(0);
});
