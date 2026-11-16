import { expect, test } from '@playwright/test';

test('thoughts refresh asynchronously, render as text and remain readable offline', async ({
  page,
}) => {
  let requests = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/motivational-quotes/random', async (route) => {
    requests++;
    if (requests > 1) await pending;
    return route.fulfill({
      json: {
        text:
          requests === 1
            ? 'Original shift thought.'
            : '<img src=x onerror=alert(1)> Refreshed thought.',
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore demo workspace' }).click();
  const card = page.getByRole('complementary', { name: 'Customer service thought' });
  await expect(card).toContainText('Original shift thought.');
  const refresh = card.getByRole('button', { name: 'Refresh thought' });
  await refresh.click();
  await expect(refresh).toBeDisabled();
  const search = page.getByRole('textbox', { name: 'Search products or scan a barcode' });
  await search.fill('ordinary typing');
  await expect(search).toHaveValue('ordinary typing');
  release?.();
  await expect(card).toContainText('<img src=x onerror=alert(1)> Refreshed thought.');
  await expect(card.locator('img')).toHaveCount(0);
  await page.context().setOffline(true);
  await expect(refresh).toBeDisabled();
  await expect(card).toContainText('Refreshed thought.');
});
