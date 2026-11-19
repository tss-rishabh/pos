import { expect, test } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeDesktop,
  evidence,
  launchDesktop,
  mainText,
  shot,
  signIn,
  type Desktop,
} from './support';

/**
 * Counter on UAT store 7: barcode scan and search with real store-7 products (found by a
 * read-only query: in stock, with a GS1 barcode), stock and product details, then review the
 * sale up to the online price confirmation. Nothing is submitted here.
 */
const PATCH = { gtin: '8907880531278', name: 'Patch: Slytherin (Small)' };
const note = (step: string, data: unknown) =>
  appendFileSync(
    join(evidence, 'flows.jsonl'),
    `${JSON.stringify({ flow: 'counter', step, data })}\n`,
  );

let desktop: Desktop;
test.beforeAll(async () => {
  desktop = await launchDesktop('counter');
  await signIn(desktop.page);
  await expect(desktop.page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
});
test.afterAll(async () => {
  if (desktop) await closeDesktop(desktop);
});

test('barcode scan adds a real store-7 product', async () => {
  const { page } = desktop;
  const search = page.getByLabel('Search products or scan a barcode');
  await search.fill(PATCH.gtin);
  await search.press('Enter');
  await page.waitForTimeout(4000);
  await shot(page, '02-scan');
  note('scan', await mainText(page));
});

test('text search for a store-7 product', async () => {
  const { page } = desktop;
  const search = page.getByLabel('Search products or scan a barcode');
  await search.fill('Black Panther');
  await page.waitForTimeout(5000);
  await shot(page, '02-search');
  note('search', await mainText(page));
});

test('review sale and confirm prices online', async () => {
  const { page } = desktop;
  await page.getByRole('button', { name: 'Review sale', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm the sale' });
  await expect(dialog).toBeVisible();
  await shot(page, '02-review');
  await dialog.getByRole('button', { name: 'Confirm prices online' }).click();
  await page.waitForTimeout(8000);
  await shot(page, '02-confirm-prices');
  note('confirm-prices', await dialog.innerText().catch(() => ''));
});
