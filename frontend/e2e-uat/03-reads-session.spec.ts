import { expect, test, type Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDesktop, evidence, launchDesktop, shot, signIn, uat, type Desktop } from './support';

/**
 * Read flows on UAT store 7 and the session lifecycle. Existing store-7 orders belong to other
 * UAT customers, so for them only HTTP outcomes are recorded (no screenshots, no page text).
 */
const STORE_ORDER = '19054775'; // store 7, paid, invoiced (read-only)
const PRODUCT = '214648'; // in stock at store 7
const note = (flow: string, step: string, data: unknown) =>
  appendFileSync(join(evidence, 'flows.jsonl'), `${JSON.stringify({ flow, step, data })}\n`);
async function go(page: Page, path: string) {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await page.waitForTimeout(4000);
}
const alerts = (page: Page) =>
  page
    .getByRole('alert')
    .allInnerTexts()
    .then((texts) => texts.map((text) => text.replace(/\s+/g, ' ').slice(0, 200)))
    .catch(() => [] as string[]);

let desktop: Desktop;
test.beforeAll(async () => {
  desktop = await launchDesktop('reads');
  await signIn(desktop.page);
  await expect(desktop.page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
});
test.afterAll(async () => {
  if (desktop) await closeDesktop(desktop);
});

test('catalog product details and stock locations', async () => {
  const { page } = desktop;
  await go(page, `/catalog/products/${PRODUCT}`);
  await shot(page, '03-product');
  note('catalog', 'product-details', {
    headings: await page.getByRole('heading').allInnerTexts(),
    alerts: await alerts(page),
  });
  await go(page, '/catalog/inventory');
  await shot(page, '03-inventory-matrix');
  note('catalog', 'inventory-matrix', { alerts: await alerts(page) });
});

test('store order search, detail and invoice (status only)', async () => {
  const { page } = desktop;
  await go(page, '/orders');
  const box = page.getByLabel('Search order or customer IDs');
  await page.getByLabel('Placed from').fill('2026-10-20T00:00');
  await page.getByLabel('Placed to').fill('2026-10-21T00:00');
  await box.fill(STORE_ORDER);
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.waitForTimeout(6000);
  const found = await page.getByText(STORE_ORDER).count();
  note('orders', 'search-by-id', { found, alerts: await alerts(page) });
  if (found) {
    await page.getByText(STORE_ORDER).first().click();
    await page.waitForTimeout(6000);
    const dialogs = await page.getByRole('dialog').count();
    const buttons = dialogs
      ? await page.getByRole('dialog').first().getByRole('button').allInnerTexts()
      : [];
    note('orders', 'detail', {
      dialogs,
      buttons: buttons.slice(0, 30),
      alerts: await alerts(page),
    });
    const invoice = page.getByRole('button', { name: /invoice/i }).first();
    if (await invoice.count()) {
      await invoice.click();
      await page.waitForTimeout(8000);
      note('orders', 'invoice', {
        frames: await page.locator('iframe[title^="Tax invoice"]').count(),
        alerts: await alerts(page),
      });
    }
  }
});

test('notifications and the header check-in control', async () => {
  const { page } = desktop;
  await go(page, '/');
  // W27: the bell exists only when the store's notification feed holds notifications.
  const bell = page.getByRole('banner').getByRole('button', { name: /^Notifications/ });
  if (await bell.count()) {
    await bell.click();
    await page.waitForTimeout(3000);
    await shot(page, '03-notifications');
  }
  note('notifications', 'open', { bell: await bell.count(), alerts: await alerts(page) });
  // The separate check-in page is gone; check-in lives in the header.
  await shot(page, '03-check-in');
  note('check-in', 'header', {
    status: await page
      .getByRole('banner')
      .getByLabel(/^Store check-in:/)
      .getAttribute('aria-label'),
  });
});

test('session expiry: a removed session cookie returns to sign-in', async () => {
  const { page } = desktop;
  // Electron keeps the session cookie in its default session, not in Playwright's context.
  const before = await desktop.app.evaluate(async ({ session }) =>
    (await session.fromPartition('persist:souled-pos').cookies.get({})).map(
      (cookie) => cookie.name,
    ),
  );
  await desktop.app.evaluate(({ session }) =>
    session.fromPartition('persist:souled-pos').clearStorageData({ storages: ['cookies'] }),
  );
  await page.reload();
  await page.waitForTimeout(5000);
  const login = await page.getByLabel('Email or username').count();
  note('session', 'cookie-cleared', { cookieNames: before, loginShown: login });
  await shot(page, '03-session-expired');
  expect(login).toBe(1);
});

test('sign in again, then log out', async () => {
  const { page } = desktop;
  await signIn(page, uat.storeId);
  // Signing in with the store checks in; the header shows it.
  await expect(
    page.getByRole('banner').getByLabel('Store check-in: Checked in', { exact: true }),
  ).toBeVisible();
  const logout = page.getByRole('button', { name: /log ?out|sign ?out/i }).first();
  note('session', 'logout-control', { count: await logout.count() });
  if (await logout.count()) {
    await logout.click();
    const confirm = page.getByRole('button', { name: /log ?out|sign ?out|yes/i });
    if (await confirm.count())
      await confirm
        .last()
        .click()
        .catch(() => undefined);
    await page.waitForTimeout(4000);
  }
  const login = await page.getByLabel('Email or username').count();
  note('session', 'logged-out', { loginShown: login });
  await shot(page, '03-logged-out');
  expect(login).toBe(1);
});
