// W27 screenshot capture for the UI cleanup report (synthetic seed data only).
// Usage: node tools/w27-screens.mjs <before|after> <outDir> [baseURL] [web|electron]
// Needs a running real stack (backend/tools/e2e/stack.ts) and `vite preview` on the base URL.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, _electron } from '@playwright/test';

const [
  phase = 'after',
  outDir = '../backend/parity/w27-screens/web',
  baseURL = 'http://localhost:4173',
  client = 'web',
] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const operator = { username: 'e2e-operator', password: 'Synthetic-e2e-password-2026', otp: '246810' };
const profile = client === 'electron' ? mkdtempSync(join(tmpdir(), 'w27-electron-')) : '';
const app =
  client === 'electron'
    ? await _electron.launch({
        // Never touch the developer's login keychain.
        args: ['--use-mock-keychain', '.'],
        env: {
          ...process.env,
          NODE_ENV: 'development',
          POS_DESKTOP_URL: baseURL,
          POS_DESKTOP_PROFILE_DIR: profile,
        },
      })
    : null;
const browser = app
  ? null
  : await chromium.launch(
      process.platform === 'darwin'
        ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
        : {},
    );
const results = [];
async function shot(page, name, fullPage = false) {
  const file = join(outDir, `${phase}-${name}.png`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: file, fullPage });
  results.push(file);
}
async function step(name, run) {
  try {
    await run();
  } catch (error) {
    results.push(`FAILED ${name}: ${String(error).split('\n')[0]}`);
  }
}
// The desktop shell refuses renderer-initiated top-level loads, so route in the SPA instead.
async function go(page, path) {
  if (!app) return page.goto(baseURL + path);
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}
async function signIn(page, storeId) {
  await go(page, '/');
  await page.getByLabel('Email or username').fill(operator.username);
  await page.getByLabel('Password', { exact: true }).fill(operator.password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Verification code').waitFor();
  await page.getByLabel('Login store').selectOption(storeId);
  await page.getByLabel('Verification code').fill(operator.otp);
}
let page;
if (app) {
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setContentSize(1440, 900);
  });
} else {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
}
await step('login', async () => {
  await go(page, '/');
  await page.getByLabel('Email or username').waitFor();
  await shot(page, '01-login');
});
// Login without a store check-in, then the check-in flow.
await step('check-in flow', async () => {
  await signIn(page, '0');
  await shot(page, '02-login-otp');
  await page.getByRole('button', { name: /Verify/ }).click();
  await page.waitForLoadState('networkidle');
  await shot(page, '03-after-login-not-checked-in');
  if (phase === 'before') {
    await go(page, '/check-in');
    await page.waitForLoadState('networkidle');
    await shot(page, '04-check-in');
    await page.getByRole('button', { name: 'Check in here' }).click();
    await page.waitForLoadState('networkidle');
  } else {
    const dialog = page.getByRole('dialog', { name: 'Check in to your store' });
    await dialog.waitFor();
    await shot(page, '04-check-in');
    await dialog.getByRole('button', { name: 'Check in', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  await go(page, '/');
  await page.waitForLoadState('networkidle');
});
await step('counter', async () => {
  await page.getByRole('heading', { name: 'The counter.' }).waitFor();
  await page.waitForLoadState('networkidle');
  await shot(page, '05-counter');
  await page.locator('header').first().screenshot({ path: join(outDir, `${phase}-06-header.png`) });
  results.push(join(outDir, `${phase}-06-header.png`));
  await shot(page, '07-counter-full', true);
});
await step('checkout review', async () => {
  await page.getByRole('button', { name: 'Add Classic: Oversized T-shirt to sale' }).click();
  await page.getByRole('button', { name: 'Review sale', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm the sale' });
  await dialog.getByRole('button', { name: 'Confirm prices online' }).click();
  const details = dialog.getByText('Salesperson assignments', { exact: true });
  await details.waitFor();
  if (!(await dialog.getByRole('combobox', { name: 'Sale salesperson', exact: true }).isVisible()))
    await details.click();
  await page.waitForLoadState('networkidle');
  await shot(page, '08-checkout-review');
  await dialog
    .getByRole('combobox', { name: 'Sale salesperson', exact: true })
    .selectOption('810001');
  await dialog.getByRole('button', { name: 'Get final quote' }).click();
  await dialog.getByRole('button', { name: 'Proceed For Payment', exact: true }).click();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  await shot(page, '09-checkout-quoted');
  await dialog.getByRole('button', { name: 'Submit', exact: true }).scrollIntoViewIfNeeded();
  await shot(page, '10-payment-form');
  await dialog.getByRole('button', { name: 'Close checkout' }).click();
});
for (const [name, path] of [
  ['11-orders', '/orders'],
  ['12-reports-export', '/reports/exports'],
  ['13-administration', '/administration'],
  ['14-offline-billing', '/offline-billing'],
  ['15-dashboard', '/dashboard'],
  ['16-returns', '/returns'],
  ['17-day-close', '/day-close'],
  ['18-sync', '/sync'],
  ['19-profile', '/profile'],
  ...(phase === 'before' ? [['20-shortcut-reference', '/shortcut-reference']] : []),
])
  await step(name, async () => {
    await go(page, path);
    await page.waitForLoadState('networkidle');
    await shot(page, name);
  });
await step('logout', async () => {
  await go(page, '/');
  await page.waitForLoadState('networkidle');
  if (phase === 'before') await page.getByRole('button', { name: 'Sign out' }).click();
  else await page.getByRole('banner').getByRole('button', { name: 'Log out', exact: true }).click();
  await page.getByLabel('Email or username').waitFor();
  await shot(page, '21-logged-out');
});
if (app) {
  await app.close();
  rmSync(profile, { recursive: true, force: true });
} else await browser.close();
console.log(results.join('\n'));
