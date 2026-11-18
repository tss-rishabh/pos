/** Full built application, native identities/sessions and no operational scope. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, request as proxyRequest } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { z } from 'zod';
import { nativeShortcutReferenceFixture } from '../../../backend/tools/cashier-shortcuts/native-reference-fixture.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const original = z
  .object({
    sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
    rows: z.array(z.tuple([z.string(), z.string(), z.string()])).length(9),
  })
  .parse(JSON.parse(readFileSync(process.argv[2] || '', 'utf8')) as unknown);
const built = resolve(root, 'frontend/dist');
const calls: { method: string; path: string; status: number }[] = [];
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
let apiOrigin = '';
const web = createServer((incoming, outgoing) => {
  const requested = new URL(incoming.url || '/', 'http://127.0.0.1');
  if (requested.pathname.startsWith('/api/') || requested.pathname.startsWith('/health/')) {
    const target = new URL(apiOrigin);
    target.pathname = requested.pathname;
    target.search = requested.search;
    const proxy = proxyRequest(
      target,
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        calls.push({
          method: incoming.method || 'GET',
          path: requested.pathname,
          status: response.statusCode || 500,
        });
        outgoing.writeHead(response.statusCode || 500, response.headers);
        response.pipe(outgoing);
      },
    );
    proxy.on('error', () => {
      outgoing.writeHead(502);
      outgoing.end('Fixture proxy failed');
    });
    incoming.pipe(proxy);
    return;
  }
  let file = resolve(built, '.' + decodeURIComponent(requested.pathname));
  if (file !== built && !file.startsWith(built + sep)) {
    outgoing.writeHead(400);
    outgoing.end();
    return;
  }
  if (requested.pathname === '/' || !extname(requested.pathname))
    file = resolve(built, 'index.html');
  if (!existsSync(file)) {
    outgoing.writeHead(404);
    outgoing.end();
    return;
  }
  outgoing.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
  outgoing.end(readFileSync(file));
});
await new Promise<void>((done) => web.listen(0, '127.0.0.1', done));
const address = web.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
let fixture: Awaited<ReturnType<typeof nativeShortcutReferenceFixture>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const cases: { role: number; userType: number; stores: number; keys: number }[] = [];
const checks: string[] = [];
try {
  fixture = await nativeShortcutReferenceFixture(
    process.env.SHORTCUT_REFERENCE_MYSQL_TEST_URL || '',
    origin,
  );
  apiOrigin = fixture.apiOrigin;
  assert(await fixture.unassigned());
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(chrome) ? chrome : undefined),
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto(origin + '/shortcut-reference');
  await expect(page.getByRole('heading', { name: 'Let’s open the store.' })).toBeVisible();
  await expect(page.locator('.shortcut-reference')).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem('pos-letter-shortcuts', 'off'));
  checks.push('anonymous-deep-link-requires-authentication');

  const first = fixture.accounts[0];
  assert(first);
  for (const account of fixture.accounts) {
    await context.addCookies([account.cookie]);
    await page.goto(origin + '/shortcut-reference');
    await expect(page.getByRole('heading', { name: 'Shortcut reference.' })).toBeVisible();
    const response = await context.request.get(origin + '/api/v1/auth/sessions/current');
    assert.equal(response.status(), 200);
    const principal = z
      .object({
        user: z.object({
          id: z.string(),
          role: z.number(),
          userType: z.number(),
          storeIds: z.array(z.string()),
        }),
      })
      .parse((await response.json()) as unknown).user;
    assert.equal(principal.id, account.user.id);
    assert.equal(principal.role, account.user.role);
    assert.equal(principal.userType, account.user.userType);
    assert.deepEqual(principal.storeIds, []);
    const stores = await context.request.get(origin + '/api/v1/stores');
    assert.equal(stores.status(), 200);
    assert.deepEqual(
      z.object({ data: z.array(z.unknown()) }).parse((await stores.json()) as unknown).data,
      [],
    );
    const keys = (await page.locator('.shortcut-reference kbd').allTextContents()).flatMap((key) =>
      key.split(/\s*\/\s*/),
    );
    assert.deepEqual(
      keys,
      original.rows.map((row) => row[1]),
    );
    await expect(page.getByRole('checkbox', { name: 'Enable letter shortcuts' })).toBeChecked();
    assert.equal(
      await page.evaluate(
        (id) => localStorage.getItem(`pos-letter-shortcuts:${id}`),
        account.user.id,
      ),
      null,
    );
    if (account.user.id === first.user.id) {
      await page.getByRole('checkbox', { name: 'Enable letter shortcuts' }).uncheck();
      await page.reload();
      await expect(
        page.getByRole('checkbox', { name: 'Enable letter shortcuts' }),
      ).not.toBeChecked();
    }
    await page.getByRole('link', { name: 'The counter', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Select your store to start' })).toBeVisible();
    await expect(page.locator('.counter-workspace')).toHaveCount(0);
    await page.getByRole('link', { name: 'Shortcut reference', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Shortcut reference.' })).toBeVisible();
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    for (const key of ['t', 'b', 'r', 'p', 'f']) await page.keyboard.press(key);
    await expect(page.locator('.sale-tabs')).toHaveCount(0);
    cases.push({
      role: principal.role,
      userType: principal.userType,
      stores: 0,
      keys: keys.length,
    });
  }
  checks.push('all-five-roles-both-user-types-no-assignment-no-selection-deep-link-and-navigation');
  checks.push('legacy-unowned-preference-is-not-inherited-and-native-operator-switch-isolated');
  checks.push('reference-page-registers-no-counter-letter-bindings');

  await context.addCookies([first.cookie]);
  await page.goto(origin + '/shortcut-reference/');
  await expect(page.getByRole('heading', { name: 'Shortcut reference.' })).toBeVisible();
  await expect(page.locator('.counter-workspace')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Enable letter shortcuts' })).not.toBeChecked();
  checks.push('trailing-slash-deep-link-keeps-authenticated-unassigned-reference-access');
  const secondPage = await context.newPage();
  await secondPage.goto(origin + '/shortcut-reference');
  await expect(
    secondPage.getByRole('checkbox', { name: 'Enable letter shortcuts' }),
  ).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Enable letter shortcuts' }).check();
  await expect(secondPage.getByRole('checkbox', { name: 'Enable letter shortcuts' })).toBeChecked();
  await secondPage.getByRole('checkbox', { name: 'Enable letter shortcuts' }).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Enable letter shortcuts' })).not.toBeChecked();
  checks.push('operator-preference-persists-and-synchronizes-across-real-tabs');

  assert(await first.valid());
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Let’s open the store.' })).toBeVisible();
  await expect.poll(() => first.valid()).toBe(false);
  await page.reload();
  await expect(page.locator('.shortcut-reference')).toHaveCount(0);
  await secondPage.reload();
  await expect(secondPage.locator('.shortcut-reference')).toHaveCount(0);
  checks.push('real-logout-revokes-native-session-and-hides-reference-after-reload');

  const other = fixture.accounts[1];
  assert(other);
  await context.addCookies([
    {
      ...other.cookie,
      value: (other.cookie.value.startsWith('A') ? 'B' : 'A') + other.cookie.value.slice(1),
    },
  ]);
  assert.equal((await context.request.get(origin + '/api/v1/stores')).status(), 401);
  await page.goto(origin + '/shortcut-reference');
  await expect(page.locator('.shortcut-reference')).toHaveCount(0);
  checks.push('tampered-native-session-cannot-read-or-render-reference');
  assert(await fixture.unassigned());
  const mutations = calls.filter((call) => !['GET', 'HEAD', 'OPTIONS'].includes(call.method));
  assert(
    mutations.every(
      (call) => call.method === 'DELETE' && call.path === '/api/v1/auth/sessions/current',
    ),
  );
  assert.equal(
    calls.filter((call) =>
      /\/(payments|order-submissions|checkout-sessions|cash-sales)(?:\/|$)/.test(call.path),
    ).length,
    0,
  );
  assert.equal(calls.filter((call) => call.path.includes('/catalog/products')).length, 0);
  process.stdout.write(
    JSON.stringify({
      sourceCommit: original.sourceCommit,
      subjectSourceIds: ['order/urls.py:57', 'order/templates/order/shortcuts.html'],
      cases,
      checks,
      identities: cases.length,
      nativeSessionStore: true,
      demoMode: false,
      assignmentsAndCounters: 0,
      interceptionHandlers: 0,
      financialDispatches: 0,
      frontend: 'actual-full-production-dist',
      backend: 'actual-full-buildApp-native-identity-and-mysql-session',
      workflowCertified: false,
      productionReady: false,
      exclusions: [
        'password-and-SSO-login-provider',
        'counter-and-financial-shortcut-effects',
        'full-source-application-and-release',
      ],
    }) + '\n',
  );
} finally {
  web.closeAllConnections();
  const closed = await Promise.allSettled([
    browser?.close(),
    fixture?.close(),
    new Promise<void>((done, reject) => web.close((error) => (error ? reject(error) : done()))),
  ]);
  assert(
    !closed.some((result) => result.status === 'rejected'),
    'Native reference fixture cleanup failed',
  );
}
