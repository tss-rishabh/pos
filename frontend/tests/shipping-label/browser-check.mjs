import { chromium, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const backend = resolve('../backend'),
  html = execFileSync(
    process.execPath,
    [
      '--import',
      resolve(backend, 'node_modules/tsx/dist/loader.mjs'),
      'tools/fulfillment/shipping-label-browser-fixture.ts',
    ],
    { cwd: backend, encoding: 'utf8', timeout: 15_000 },
  );
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (process.platform === 'darwin' && existsSync(mac) ? mac : undefined),
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
const entry =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/tests/shipping-label/browser-entry.tsx"></script></body></html>';
const errors = [],
  consoleErrors = [],
  unexpected = [],
  contexts = [];
let requests = 0;
async function workspace(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1512, height: 1100 },
    serviceWorkers: 'block',
  });
  contexts.push(context);
  await context.addInitScript(() => {
    window.print = () =>
      window.parent.postMessage(
        {
          type: 'shipping-fixture-printed',
          scope: document.querySelector('meta[name="pos-shipping-label"]')?.getAttribute('content'),
        },
        window.parent.location.origin,
      );
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('403'))
      consoleErrors.push('UNEXPECTED_BROWSER_CONSOLE_ERROR');
  });
  let calls = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.resourceType() === 'document' && url.pathname === '/shipping-label')
      return route.fulfill({ contentType: 'text/html', body: entry });
    if (url.hostname !== '127.0.0.1') {
      unexpected.push(url.hostname);
      return route.abort();
    }
    // This fixture never edits modules while running. Preserve CSS injection
    // while disabling only Vite's development hot-reload websocket, which is
    // unrelated to the shipping transport or the printed document's real CSP.
    if (url.pathname === '/@vite/client')
      return route.fulfill({
        contentType: 'application/javascript',
        body: `const styles=new Map();export function updateStyle(id,text){let style=styles.get(id);if(!style){style=document.createElement('style');document.head.append(style);styles.set(id,style);}style.textContent=text;}export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}export function createHotContext(){return {data:{},accept(){},acceptExports(){},dispose(){},prune(){},invalidate(){},on(){},off(){},send(){}};}export function injectQuery(url){return url;}`,
      });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests++;
    calls++;
    expect(request.method()).toBe('GET');
    expect(request.headers()['x-operator-id']).toBe('1');
    expect(url.pathname).toBe('/api/v1/stores/1/fulfillment/orders/1001/shipping-label/preview');
    if (options.defer) await gate;
    if (options.denyPrint && calls > 1)
      return route.fulfill({
        status: 403,
        json: { error: { code: 'STORE_ACCESS_DENIED', message: 'Store access changed.' } },
      });
    try {
      return await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        headers: { 'Cache-Control': 'private, no-store' },
        body: html,
      });
    } catch (error) {
      if (!options.defer) throw error;
    }
  });
  await page.goto('http://127.0.0.1:4490/shipping-label' + (options.offline ? '?offline=1' : ''));
  await expect(page.getByRole('dialog', { name: 'Order shipping label' })).toBeVisible();
  return {
    page,
    release,
    get calls() {
      return calls;
    },
  };
}
try {
  const live = await workspace(),
    { page } = live,
    preview = page.frameLocator('iframe[title="Shipping label for order 1001"]');
  await expect(preview.getByRole('main', { name: 'Order shipping label' })).toBeVisible();
  await expect(preview.locator('svg')).toHaveCount(2);
  await expect(
    preview.getByText('Fixture <script>unsafe()</script>', { exact: true }),
  ).toBeVisible();
  await expect(preview.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.unsafe)).toBe('undefined');
  await expect(
    page.getByRole('button', { name: 'Print shipping label', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Print shipping label', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.shippingFixture.printCount)).toBe(1);
  expect(live.calls).toBe(2);
  await mkdir('../backend/parity/evidence/fulfillment-shipping', { recursive: true });
  await page.screenshot({
    path: '../backend/parity/evidence/fulfillment-shipping/shipping-label.png',
    fullPage: true,
  });
  await page.evaluate(() => window.shippingFixture.expire());
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Print shipping label', exact: true }),
  ).toBeDisabled();
  expect(live.calls).toBe(2);
  const denied = await workspace({ denyPrint: true });
  await expect(
    denied.page.getByRole('button', { name: 'Print shipping label', exact: true }),
  ).toBeEnabled();
  await denied.page.getByRole('button', { name: 'Print shipping label', exact: true }).click();
  await expect(denied.page.getByText('Store access changed.').first()).toBeVisible();
  await expect(denied.page.locator('iframe')).toHaveCount(0);
  expect(await denied.page.evaluate(() => window.shippingFixture.printCount)).toBe(0);
  const stale = await workspace({ defer: true });
  await expect.poll(() => stale.calls).toBe(1);
  await stale.page.evaluate(() => window.shippingFixture.changeOperator());
  stale.release();
  await expect(stale.page.locator('iframe')).toHaveCount(0);
  await expect(
    stale.page.getByText('Sign in with a current operator session for this store.'),
  ).toBeVisible();
  expect(await stale.page.evaluate(() => window.shippingFixture.printCount)).toBe(0);
  const offline = await workspace({ offline: true });
  await expect(
    offline.page.getByRole('button', { name: 'Print shipping label', exact: true }),
  ).toBeDisabled();
  await expect(offline.page.locator('iframe')).toHaveCount(0);
  expect(offline.calls).toBe(0);
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(unexpected).toEqual([]);
  const evidence = {
    scope: 'isolated-browser-http-fixtures-with-real-shipping-renderer',
    workflows: 6,
    requests,
    pageErrors: errors.length,
    consoleErrors: consoleErrors.length,
    unexpectedRequests: unexpected.length,
    verified: [
      'source field layout and two machine-readable SVG barcodes',
      'escaped destination data and no active scripts',
      'fresh captured-actor authorization before print',
      'expired cached session removes private preview',
      'server access revocation blocks print and removes preview',
      'operator change during pending response and offline controls',
    ],
    limitations:
      'HTTP is mocked; separate isolated native MySQL source-handler vectors verify authorization/query behavior. No real address, production login, printer or provider was used.',
  };
  await writeFile(
    '../backend/parity/evidence/fulfillment-shipping/browser.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
