import { expect, test } from './support/fixtures';
import { z } from 'zod';
import { signIn } from './support/login';

test('the signed-in counter displays and refreshes the real backend quote', async ({ page }) => {
  const responseSchema = z.object({ text: z.string().min(1).max(2000) }).strict();
  const firstReply = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/motivational-quotes/random') &&
      response.request().method() === 'GET',
  );
  await page.goto('/');
  await signIn(page);
  const initial = await firstReply;
  expect(initial.status()).toBe(200);
  const initialBody: unknown = await initial.json();
  const card = page.getByRole('complementary', { name: 'Customer service thought' });
  await expect(card).toContainText(responseSchema.parse(initialBody).text);

  const refreshedReply = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/motivational-quotes/random') &&
      response.request().method() === 'GET',
  );
  await card.getByRole('button', { name: 'Refresh thought' }).click();
  const refreshed = await refreshedReply;
  expect(refreshed.status()).toBe(200);
  const refreshedBody: unknown = await refreshed.json();
  await expect(card).toContainText(responseSchema.parse(refreshedBody).text);
});

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
  await signIn(page);
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
