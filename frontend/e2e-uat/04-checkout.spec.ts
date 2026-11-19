import { expect, test, type Locator, type Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeDesktop,
  evidence,
  launchDesktop,
  ledger,
  shot,
  signIn,
  uat,
  type Desktop,
} from './support';

/**
 * Normal and fast cash checkout at store 7, counter C1, through API-v2 UAT `pos/order`.
 * A real UAT order is created only if every step succeeds; its id is written to the ledger.
 * The product is a real store-7 item scanned by its GS1 barcode (Rs. 49 patch).
 */
const PATCH = { gtin: '8907880531278', name: 'Patch: Slytherin (Small)' };
const note = (step: string, data: unknown) =>
  appendFileSync(
    join(evidence, 'flows.jsonl'),
    `${JSON.stringify({ flow: 'checkout', step, data })}\n`,
  );

/** The error text and code an action ended with, or null when it succeeded. */
async function outcome(page: Page, scope: Locator, waitFor: Locator, ms = 30000) {
  const failed = scope.getByText(/\(Reference [0-9a-f-]{36}\)|Reference [0-9a-f-]{36}/).first();
  await Promise.race([
    waitFor.waitFor({ timeout: ms }).catch(() => undefined),
    failed.waitFor({ timeout: ms }).catch(() => undefined),
  ]);
  if (await waitFor.count()) return null;
  return (await failed.innerText().catch(() => 'no outcome')).replace(/\s+/g, ' ').slice(0, 300);
}

let desktop: Desktop;
test.beforeAll(async () => {
  desktop = await launchDesktop('checkout');
  await signIn(desktop.page);
  await expect(desktop.page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
});
test.afterAll(async () => {
  if (desktop) await closeDesktop(desktop);
});

async function scan(page: Page) {
  const search = page.getByLabel('Search products or scan a barcode');
  await search.fill(PATCH.gtin);
  await search.press('Enter');
  await expect(page.getByText(PATCH.gtin).first()).toBeVisible();
}

test('normal checkout: scan, quote, salesperson, cash payment, pos/order, invoice', async () => {
  const { page } = desktop;
  await scan(page);
  await page.getByRole('button', { name: 'Review sale', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm the sale' });
  await dialog.getByRole('button', { name: 'Confirm prices online' }).click();
  const quoted = dialog.getByText('Salesperson assignments', { exact: true });
  const blocked = await outcome(page, dialog, quoted);
  note('confirm-prices', blocked ?? 'ok');
  await shot(page, '04-confirm-prices');
  expect(blocked, 'Confirm prices online').toBeNull();

  // Legacy flags and the salesperson guard: the final quote needs a salesperson.
  await quoted.click();
  const salesperson = dialog.getByRole('combobox', { name: 'Sale salesperson', exact: true });
  const options = await salesperson
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value).filter(Boolean));
  note('salespeople', { count: options.length });
  await salesperson.selectOption(options[0]!);
  await dialog.getByRole('button', { name: 'Get final quote' }).click();
  const proceed = dialog.getByRole('button', { name: 'Proceed For Payment', exact: true });
  const quoteBlocked = await outcome(page, dialog, proceed);
  note('final-quote', quoteBlocked ?? 'ok');
  expect(quoteBlocked).toBeNull();
  await proceed.click();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  const submissions: { status: number; orderId?: string }[] = [];
  page.on('response', (response) => {
    if (
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/order-submissions')
    )
      void response
        .json()
        .then((body: { orderId?: string }) =>
          submissions.push({ status: response.status(), orderId: body?.orderId }),
        )
        .catch(() => submissions.push({ status: response.status() }));
  });
  await dialog.getByRole('button', { name: 'Yes, sure!', exact: true }).click();
  const done = page.getByText('Payment confirmed. Your sale is complete.');
  const submitBlocked = await outcome(page, page.locator('body'), done, 90000);
  await shot(page, '04-submitted');
  note('submit', { submitBlocked, submissions });
  for (const submission of submissions)
    if (submission.orderId)
      ledger({
        kind: 'order',
        flow: 'normal-checkout-cash',
        orderId: submission.orderId,
        store: uat.storeId,
      });
  expect(submitBlocked).toBeNull();
});

test('fast cash checkout (F)', async () => {
  const { page } = desktop;
  await page
    .getByRole('button', { name: /new sale/i })
    .first()
    .click()
    .catch(() => undefined);
  await scan(page);
  await page.locator('body').press('f');
  const fast = page.getByText('Fast Checkout (Cash Only)!');
  const blocked = await outcome(page, page.locator('body'), fast);
  note('fast-cash-open', blocked ?? 'ok');
  await shot(page, '04-fast-cash');
  expect(blocked).toBeNull();
});
