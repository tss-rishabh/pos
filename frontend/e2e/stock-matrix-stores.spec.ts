import { expect, test } from '@playwright/test';
import { signIn } from './support/login';

/**
 * Legacy ProductsStockView (core/views.py:183-190) lists only the operator's assigned active
 * stores to roles other than 1. The seeded role-4 operator is assigned stores 1 and 2; the active
 * store 3 exists but is not assigned, so the picker must not offer it and every offered store must
 * be searchable (no 403).
 */
test('stock-matrix store picker offers only the stores the backend authorises', async ({
  page,
}) => {
  await page.goto('/catalog/inventory');
  await signIn(page);
  await expect(page.getByRole('heading', { name: /^Inventory matrix/ })).toBeVisible();
  // Signed in: no store-scope refusal (403) or other API failure from here on.
  const failures: string[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400)
      failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  const picker = page.getByRole('listbox', { name: 'Stores' });
  await expect(picker.getByRole('option')).toHaveText(['Bandra Flagship', 'Indiranagar']);
  await expect(picker.getByRole('option', { name: 'Colaba Unassigned' })).toHaveCount(0);
  await picker.selectOption(['1', '2']);
  const searched = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/catalog/inventory/search',
  );
  await page.getByRole('button', { name: 'View inventory', exact: true }).click();
  expect((await searched).status()).toBe(200);
  expect(failures).toEqual([]);
});
