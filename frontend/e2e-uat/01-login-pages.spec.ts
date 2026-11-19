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
 * Login and check-in to store 7, then every read-only page of the app on UAT. Each page is
 * opened from its route; the outcome (headings, error alerts, API errors) is recorded.
 */
const routes = [
  '/',
  '/dashboard',
  '/check-in',
  '/catalog',
  '/catalog/inventory',
  '/catalog/inventory-pulls',
  '/inventory',
  '/inventory/associations',
  '/orders',
  '/returns',
  '/fulfillment',
  '/local-deliveries',
  '/monitoring',
  '/reports',
  '/reports/order-transactions',
  '/reports/returned-orders',
  '/reports/flash-sales',
  '/reports/hyperlocal-daily',
  '/reports/customer-feedback',
  '/reports/day-close-history',
  '/reports/exports',
  '/cash-ledger',
  '/day-close',
  '/stores',
  '/administration',
  '/administration/barcodes',
  '/administration/gift-card-batches',
  '/administration/model-accounts',
  '/administration/model-history',
  '/administration/permission-history',
  '/application-links',
  '/countries',
  '/gift-vouchers',
  '/wallet-adjustments',
  '/profile',
  '/sync',
  '/documentation',
  '/shortcut-reference',
  '/offline-billing',
  '/offline-worksheet',
];

let desktop: Desktop;
test.beforeAll(async () => {
  desktop = await launchDesktop('pages');
});
test.afterAll(async () => {
  if (desktop) await closeDesktop(desktop);
});

test('sign in with password and fixed OTP, check in to store 7', async () => {
  const { page } = desktop;
  await expect(page.getByLabel('Email or username')).toBeVisible();
  await shot(page, '01-login');
  await signIn(page);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(3000);
  await shot(page, '01-after-login');
  appendFileSync(
    join(evidence, 'pages.jsonl'),
    `${JSON.stringify({ route: 'after-login', url: page.url(), text: await mainText(page) })}\n`,
  );
  await expect(page.getByLabel('Email or username')).toHaveCount(0);
});

test('every page renders on UAT', async () => {
  const { page } = desktop;
  for (const route of routes) {
    await page.evaluate((path) => {
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, route);
    await page.waitForTimeout(4000);
    const alerts = await page
      .getByRole('alert')
      .allInnerTexts()
      .catch(() => [] as string[]);
    const headings = await page
      .getByRole('heading')
      .allInnerTexts()
      .catch(() => [] as string[]);
    appendFileSync(
      join(evidence, 'pages.jsonl'),
      `${JSON.stringify({ route, url: new URL(page.url()).pathname, headings: headings.slice(0, 8), alerts: alerts.slice(0, 5) })}\n`,
    );
    await shot(page, `page${route.replace(/\//g, '_') || '_root'}`);
  }
});
