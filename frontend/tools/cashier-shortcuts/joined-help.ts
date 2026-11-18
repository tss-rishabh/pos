/** Source help -> actual signed-session API -> production UI, no route mocks. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, request as proxyRequest } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page } from '@playwright/test';
import { z } from 'zod';
import { buildApp } from '../../../backend/src/app.js';
import { readConfig } from '../../../backend/src/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = z
  .object({
    sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
    sourceSha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    framework: z.object({
      django: z.literal('4.2.5'),
      asgiref: z.literal('3.7.2'),
      sqlparse: z.literal('0.4.4'),
      whitenoise: z.literal('6.12.0'),
    }),
    rows: z.array(z.tuple([z.string(), z.string(), z.string()])).length(9),
    cases: z
      .array(
        z.object({
          authenticatedGet: z.literal(200),
          authenticatedHead: z.literal(200),
          authenticatedPost: z.literal(405),
          missingCsrfPost: z.literal(403),
          tamperedCookie: z.literal(302),
        }),
      )
      .length(10),
    anonymousStatus: z.literal(302),
    databaseUsed: z.literal(false),
  })
  .parse(JSON.parse(readFileSync(process.argv[2] || '', 'utf8')) as unknown);
const built = resolve(root, 'frontend/dist');
assert(existsSync(resolve(built, 'index.html')), 'Build the frontend before this workflow');
const calls: { method: string; path: string; status: number }[] = [];
let backend = '';
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};
const web = createServer((incoming, outgoing) => {
  const path = new URL(incoming.url || '/', 'http://127.0.0.1').pathname;
  if (path.startsWith('/api/') || path.startsWith('/health/')) {
    const requested = new URL(incoming.url || '/', 'http://127.0.0.1');
    const target = new URL(backend);
    target.pathname = requested.pathname;
    target.search = requested.search;
    const proxy = proxyRequest(
      target,
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        calls.push({ method: incoming.method || 'GET', path, status: response.statusCode || 500 });
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
  let file = resolve(built, '.' + decodeURIComponent(path));
  if (file !== built && !file.startsWith(built + sep)) {
    outgoing.writeHead(400);
    outgoing.end();
    return;
  }
  if (path === '/' || !extname(path)) file = resolve(built, 'index.html');
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
const origin = 'http://127.0.0.1:' + address.port;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const checks: string[] = [];
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
function financial() {
  return calls.filter(
    (call) =>
      !['GET', 'HEAD', 'OPTIONS'].includes(call.method) &&
      /\/(?:payments|order-submissions|settlement-note|cash-sales|refunds)(?:\/|$)/.test(call.path),
  );
}
async function tabCount(page: Page) {
  return page.locator('.sale-tabs > button:not(.new-tab)').count();
}
try {
  app = await buildApp(
    readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      WEB_ORIGIN: origin,
      SESSION_SECRET: randomBytes(32).toString('base64'),
    }),
  );
  backend = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      (existsSync(localChrome) ? localChrome : undefined),
    headless: true,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  async function press(key: string) {
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.keyboard.press(key);
  }
  const denied = await context.request.get(origin + '/api/v1/stores/1/catalog/products');
  assert.equal(denied.status(), 401);
  await page.goto(origin);
  await expect(page.locator('.cashier-shortcut-help')).toHaveCount(0);
  await page.getByRole('button', { name: 'Explore demo workspace' }).click();
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
  assert((await context.cookies()).some((cookie) => cookie.httpOnly && cookie.value.length > 30));
  assert(
    calls.some(
      (call) =>
        call.method === 'POST' && call.path === '/api/v1/auth/demo-sessions' && call.status === 200,
    ),
  );
  const accepted = await context.request.get(origin + '/api/v1/stores/1/catalog/products');
  assert.equal(accepted.status(), 200);
  checks.push('actual-signed-session-gates-api-and-help-ui');

  await page.getByText('Keyboard shortcuts', { exact: true }).click();
  const keys = await page.locator('.cashier-shortcut-help tbody tr kbd').allTextContents();
  assert.deepEqual(
    keys.flatMap((key) => key.split(/\s*\/\s*/)),
    source.rows.map((row) => row[1]),
  );
  const descriptions = await page.locator('.cashier-shortcut-help tbody tr td').allTextContents();
  assert.equal(descriptions.length, 8);
  assert(descriptions.every((text) => text.trim().length > 0));
  checks.push('all-nine-pinned-help-keys-survive-combined-p-pp-row');

  await press('b');
  const search = page.getByRole('textbox', { name: 'Search products or scan a barcode' });
  await expect(search).toBeFocused();
  const originalTabs = await tabCount(page);
  await search.fill('tpenrfs');
  assert.equal(await tabCount(page), originalTabs);
  await search.fill('');
  await press('t');
  await expect(page.locator('.sale-tabs > button:not(.new-tab)')).toHaveCount(originalTabs + 1);
  checks.push('actual-b-focus-t-new-sale-and-ordinary-text-entry');

  const before = await tabCount(page);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    for (const options of [
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { repeat: true },
      { isComposing: true },
    ])
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 't',
          bubbles: true,
          composed: true,
          cancelable: true,
          ...options,
        }),
      );
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    editable.tabIndex = 0;
    document.body.append(editable);
    editable.focus();
    editable.dispatchEvent(
      new KeyboardEvent('keydown', { key: 't', bubbles: true, composed: true, cancelable: true }),
    );
    editable.remove();
  });
  assert.equal(await tabCount(page), before);
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'shortcut-fixture-unrelated-dialog';
    document.body.append(dialog);
    dialog.showModal();
  });
  await press('t');
  assert.equal(await tabCount(page), before);
  await page.evaluate(() => document.getElementById('shortcut-fixture-unrelated-dialog')?.remove());
  checks.push('modifiers-repeat-ime-contenteditable-and-native-modal-pause');

  const catalogReads = calls.filter(
    (call) => call.path === '/api/v1/stores/1/catalog/products',
  ).length;
  await press('r');
  await expect
    .poll(() => calls.filter((call) => call.path === '/api/v1/stores/1/catalog/products').length)
    .toBeGreaterThan(catalogReads);
  for (const key of ['p', 'p', 'f', 'n', 'e', 's']) await press(key);
  assert.equal(financial().length, 0);
  assert.equal(calls.filter((call) => call.path.includes('/checkout-sessions')).length, 0);
  checks.push('real-refresh-and-empty-sale-action-preconditions-no-financial-dispatch');

  await page.getByRole('checkbox', { name: 'Enable letter shortcuts' }).uncheck();
  await press('t');
  assert.equal(await tabCount(page), before);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
  const restored = await tabCount(page);
  await press('t');
  assert.equal(await tabCount(page), restored);
  await page.getByText('Keyboard shortcuts', { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Enable letter shortcuts' })).not.toBeChecked();
  checks.push('off-preference-persists-across-production-ui-reload');

  await page.getByRole('link', { name: 'Shortcut reference', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shortcut reference.' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Enable letter shortcuts' })).not.toBeChecked();
  await press('t');
  await expect(page.locator('.sale-tabs')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Enable letter shortcuts' }).check();
  await press('t');
  await expect(page.locator('.sale-tabs')).toHaveCount(0);
  await page.getByRole('link', { name: 'The counter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
  await expect(page.locator('.sale-tabs > button:not(.new-tab)')).toHaveCount(restored);
  const returned = await tabCount(page);
  await press('t');
  await expect(page.locator('.sale-tabs > button:not(.new-tab)')).toHaveCount(returned + 1);
  checks.push(
    'standalone-and-counter-share-operator-preference-with-no-reference-page-letter-binding',
  );

  const cookies = await context.cookies();
  const cookie = cookies.find((value) => value.httpOnly && value.value.length > 30);
  assert(cookie);
  await context.addCookies([
    { ...cookie, value: (cookie.value.startsWith('A') ? 'B' : 'A') + cookie.value.slice(1) },
  ]);
  assert.equal(
    (await context.request.get(origin + '/api/v1/stores/1/catalog/products')).status(),
    401,
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Explore demo workspace' })).toBeVisible();
  await expect(page.locator('.cashier-shortcut-help')).toHaveCount(0);
  checks.push('tampered-real-cookie-removes-authenticated-help');
  assert.equal(financial().length, 0);
  process.stdout.write(
    JSON.stringify({
      sourceCommit: source.sourceCommit,
      sourceFramework: source.framework,
      sourceAuthCases: source.cases.length,
      sourceKeys: source.rows.map((row) => row[1]),
      checks,
      interceptionHandlers: 0,
      financialDispatches: financial().length,
      apiCalls: calls.length,
      backend: 'actual-buildApp-demo-identity-and-synthetic-read-fixtures',
      frontend: 'actual-production-dist',
      workflowCertified: false,
      exclusions: [
        'production-identity-provider',
        'real-store-checkout-and-financial-writers',
        'positive-quoted-sale-shortcut-actions',
        'full-counter-template',
      ],
    }) + '\n',
  );
} finally {
  web.closeAllConnections();
  const cleanup = await Promise.allSettled([
    browser?.close(),
    app?.close(),
    new Promise<void>((done, reject) => web.close((error) => (error ? reject(error) : done()))),
  ]);
  assert(!cleanup.some((result) => result.status === 'rejected'), 'Fixture cleanup failed');
}
