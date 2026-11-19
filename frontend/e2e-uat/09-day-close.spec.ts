import { expect, test } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeDesktop,
  evidence,
  launchDesktop,
  ledger,
  shot,
  signIn,
  type Desktop,
} from './support';

/**
 * Day close for store 7, once, at the end of the run (writes a real UAT store_day_close row).
 * Run only with W26_DAY_CLOSE=1. Every amount is entered as the counted value 0, matching the
 * system figures shown for a day with no store-7 collections.
 */
test.skip(process.env.W26_DAY_CLOSE !== '1', 'Day close writes UAT data; set W26_DAY_CLOSE=1.');
let desktop: Desktop;
test.afterAll(async () => {
  if (desktop) await closeDesktop(desktop);
});

test('file the store-7 day close', async () => {
  desktop = await launchDesktop('day-close');
  const { page } = desktop;
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
  await page.evaluate(() => {
    window.history.pushState({}, '', '/day-close');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('button', { name: 'Close this day' })).toBeVisible();
  for (const label of [
    'Actual cash',
    'Manual bills punched (cash)',
    'Manual bills created (cash)',
    'Actual card / UPI',
    'Manual bills punched (card)',
    'Manual bills created (card)',
    'Amount banked',
  ])
    await page.getByLabel(label, { exact: true }).fill('0');
  const filed: { status: number; requestId: string | null; body: unknown }[] = [];
  page.on('response', (response) => {
    if (
      response.request().method() === 'POST' &&
      /\/day-closes/.test(new URL(response.url()).pathname)
    )
      void response
        .json()
        .then((body: unknown) =>
          filed.push({
            status: response.status(),
            requestId: response.headers()['x-request-id'] ?? null,
            body,
          }),
        )
        .catch(() => filed.push({ status: response.status(), requestId: null, body: null }));
  });
  await page.getByRole('button', { name: 'Close this day' }).click();
  const review = page.getByRole('dialog');
  await shot(page, '09-day-close-review');
  await review.getByRole('button', { name: 'File close' }).click();
  await page.waitForTimeout(10000);
  await shot(page, '09-day-close-filed');
  const alerts = await page
    .getByRole('alert')
    .allInnerTexts()
    .catch(() => []);
  const statusText = await page
    .getByRole('status')
    .allInnerTexts()
    .catch(() => []);
  appendFileSync(
    join(evidence, 'flows.jsonl'),
    `${JSON.stringify({ flow: 'finance', step: 'day-close-filed', data: { filed, alerts, statusText } })}\n`,
  );
  ledger({
    kind: 'store_day_close',
    flow: 'day-close',
    storeId: '7',
    responses: filed.map((entry) => ({ status: entry.status, requestId: entry.requestId })),
  });
  expect(filed.some((entry) => entry.status < 300)).toBe(true);
});
