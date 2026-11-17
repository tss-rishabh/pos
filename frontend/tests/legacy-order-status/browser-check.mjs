import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const privateCache = mkdtempSync(join(tmpdir(), 'pos-whole-status-browser-'));
const server = await createServer({
  configFile: false,
  root,
  cacheDir: privateCache,
  plugins: [react()],
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
let browser,
  passed = 0;
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Isolated fixture unavailable.');
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (process.platform === 'darwin' &&
    existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({ serviceWorkers: 'block' }),
    page = await context.newPage(),
    orderId = '9007199254740993',
    scopeHash = 'a'.repeat(64),
    posts = [],
    reads = [];
  let saved = null,
    lostPost = false,
    unknown = false,
    missing = false;
  const status = () => ({
    orderId,
    storeId: '1',
    scopeHash,
    eligible: true,
    adapterReady: true,
    stages: {
      CREATE: { status: 'SUCCESS', date: '' },
      PACK: { status: saved?.state === 'SUCCEEDED' ? 'SUCCESS' : 'FAILED', date: '' },
      SHIP: { status: saved?.state === 'SUCCEEDED' ? 'SUCCESS' : '-', date: '' },
      DELIVER: { status: saved?.state === 'SUCCEEDED' ? 'SUCCESS' : '-', date: '' },
    },
    commands: saved ? [saved] : [],
  });
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    reads.push({ path: url.pathname, actor: request.headers()['x-operator-id'] });
    if (url.pathname.endsWith('/status-repair-obligations'))
      return route.fulfill({ json: { storeId: '1', orderId, obligations: [] } });
    if (url.pathname.endsWith('/fulfillment-status')) return route.fulfill({ json: status() });
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      posts.push(body);
      if (!saved)
        saved = {
          operationId: body.operationId,
          storeId: '1',
          orderId,
          platform: body.platform,
          source: 'manual',
          returnOperationId: null,
          state: 'PENDING',
          requestHash: 'b'.repeat(64),
          lineCount: 3,
          receipt: null,
          errorCode: null,
          createdAt: '2026-11-17 06:00:00',
          updatedAt: '2026-11-17 06:00:00',
          message: 'Request has been queued for processing',
        };
      if (lostPost) return route.abort('failed');
      return route.fulfill({ status: 202, json: saved });
    }
    if (missing)
      return route.fulfill({
        status: 404,
        json: {
          error: {
            code: 'WHOLE_ORDER_STATUS_COMMAND_NOT_FOUND',
            message: 'The operation has not been recorded.',
          },
        },
      });
    if (!saved)
      return route.fulfill({
        status: 404,
        json: { error: { code: 'WHOLE_ORDER_STATUS_COMMAND_NOT_FOUND', message: 'Not recorded.' } },
      });
    if (unknown) saved = { ...saved, state: 'UNCERTAIN', errorCode: 'STATUS_OUTCOME_UNKNOWN' };
    return route.fulfill({ json: saved });
  });
  const open = async () => {
    const toggle = page.getByRole('button', { name: 'Whole-order status', exact: true });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(
      page.getByRole('button', { name: 'Refresh status receipt', exact: true }),
    ).toBeVisible();
  };
  await page.goto(`http://127.0.0.1:${address.port}/tests/legacy-order-status/fixture.html`);
  await open();
  await expect(page.getByRole('button', { name: 'Queue PACK', exact: true })).toBeEnabled();
  passed++;
  await page.getByRole('button', { name: 'Queue PACK', exact: true }).click();
  await expect(page.getByText('PACK: PENDING. 3 item rows.', { exact: true })).toBeVisible();
  if (posts.length !== 1 || posts[0].scopeHash !== scopeHash || !posts[0].operationId)
    throw new Error('Immutable status intent changed.');
  passed++;
  await expect(page.getByRole('button', { name: 'Queue SHIP', exact: true })).toBeDisabled();
  if (reads.some((row) => row.actor !== '1')) throw new Error('Original actor missing.');
  passed++;
  await page.reload();
  await open();
  await expect(page.getByText('PACK: PENDING. 3 item rows.', { exact: true })).toBeVisible();
  if (posts.length !== 1) throw new Error('Reload repeated a command.');
  passed++;
  unknown = true;
  await page.getByRole('button', { name: 'Refresh status receipt', exact: true }).click();
  await expect(page.getByText(/PACK: UNCERTAIN/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Queue PACK', exact: true })).toBeDisabled();
  if (posts.length !== 1) throw new Error('Unknown recovery resent the action.');
  passed++;
  await page.getByRole('button', { name: 'Toggle connection', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Refresh status receipt', exact: true }),
  ).toBeDisabled();
  passed++;
  await page.getByRole('button', { name: 'Toggle connection', exact: true }).click();
  unknown = false;
  saved = { ...saved, state: 'SUCCEEDED' };
  await page.getByRole('button', { name: 'Refresh status receipt', exact: true }).click();
  await expect(page.getByText(/All requested fulfillment stages completed/)).toBeVisible();
  if (
    await page.evaluate(() =>
      Object.entries(sessionStorage).some(([key]) => key.startsWith('pos-whole-order-status:')),
    )
  )
    throw new Error('Terminal marker was not cleared.');
  passed++;
  await context.clearCookies();
  await page.evaluate(() => sessionStorage.clear());
  saved = null;
  lostPost = true;
  await page.reload();
  await open();
  await page.getByRole('button', { name: 'Queue SHIP', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  const frozen = posts.at(-1);
  await page.reload();
  lostPost = false;
  await open();
  await expect(page.getByText('SHIP: PENDING. 3 item rows.', { exact: true })).toBeVisible();
  if (posts.length !== 2 || saved.operationId !== frozen.operationId)
    throw new Error('Lost reply did not recover the same intent.');
  passed++;
  missing = true;
  await page.getByRole('button', { name: 'Refresh status receipt', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Retry saving the same request', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Retry saving the same request', exact: true }).click();
  if (posts.length !== 3 || JSON.stringify(posts[2]) !== JSON.stringify(posts[1]))
    throw new Error('A missing intent retry changed its operation.');
  passed++;
  missing = false;
  await page.getByRole('button', { name: 'Change operator', exact: true }).click();
  await open();
  await expect.poll(() => reads.at(-1)?.actor).toBe('2');
  if (posts.length !== 3) throw new Error('Operator change submitted an old command.');
  passed++;
  await context.close();
  process.stdout.write(
    JSON.stringify({
      resource: 'whole-order-status',
      browser: 'chromium',
      isolated: true,
      passed,
    }) + '\n',
  );
} finally {
  await browser?.close();
  await server.close();
  rmSync(privateCache, { recursive: true, force: true });
}
