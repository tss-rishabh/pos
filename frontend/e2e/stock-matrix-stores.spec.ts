import { expect, test } from './support/fixtures';
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
  // W27: the store list is a searchable multi-select (a checkbox per offered store).
  await page.getByRole('button', { name: 'Stores', exact: true }).click();
  const picker = page.getByRole('group', { name: 'Stores' });
  await expect(picker.getByRole('listitem')).toHaveText(['Bandra Flagship', 'Indiranagar']);
  await expect(picker.getByRole('checkbox', { name: 'Colaba Unassigned' })).toHaveCount(0);
  await picker.getByRole('checkbox', { name: 'Bandra Flagship', exact: true }).check();
  await picker.getByRole('checkbox', { name: 'Indiranagar', exact: true }).check();
  await page.keyboard.press('Escape');
  const searched = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/catalog/inventory/search',
  );
  await page.getByRole('button', { name: 'View inventory', exact: true }).click();
  expect((await searched).status()).toBe(200);
  expect(failures).toEqual([]);
});
