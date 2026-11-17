import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url)),
  privateCache = mkdtempSync(join(tmpdir(), 'pos-return-repair-browser-'));
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
    returnId = '4918d168-c62e-4ed7-b8ae-89b0a5e70019',
    posts = [];
  let mode = 'lost-committed',
    refreshLinked = false;
  let row = {
    returnOperationId: returnId,
    operationId: returnId,
    operatorId: '1',
    storeId: '1',
    orderId,
    state: 'BLOCKED',
    errorCode: 'RETURN_REPAIR_DISPATCHER_DISABLED',
    version: 1,
    createdAt: '2026-11-17T06:00:00Z',
    updatedAt: '2026-11-17T06:00:00Z',
    command: null,
  };
  await context.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname.endsWith('/fulfillment-status'))
      return route.fulfill({
        json: {
          orderId,
          storeId: '1',
          scopeHash: 'a'.repeat(64),
          eligible: true,
          adapterReady: true,
          stages: Object.fromEntries(
            ['CREATE', 'PACK', 'SHIP', 'DELIVER'].map((value) => [
              value,
              { status: '-', date: '' },
            ]),
          ),
          commands: [],
        },
      });
    if (url.pathname.endsWith('/status-repair-obligations'))
      return route.fulfill({ json: { storeId: '1', orderId, obligations: [row] } });
    if (request.method() === 'POST') {
      if (!url.pathname.endsWith('/' + returnId + '/recoveries'))
        throw new Error('A financial/provider route was dispatched.');
      const body = request.postDataJSON();
      posts.push({ body, actor: request.headers()['x-operator-id'] });
      if (mode === 'lost-uncommitted') return route.abort('failed');
      row = { ...row, state: 'PENDING', errorCode: null, version: row.version + 1 };
      if (mode === 'lost-committed') return route.abort('failed');
      return route.fulfill({ status: 202, json: row });
    }
    if (url.pathname.endsWith('/' + returnId)) {
      if (refreshLinked)
        row = {
          ...row,
          state: 'LINKED',
          command: { operationId: returnId, state: 'QUEUED', platform: 'PACK', errorCode: null },
        };
      return route.fulfill({ json: { ...row, receiptRefreshError: null } });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: 'SYNTHETIC_NOT_FOUND', message: 'Synthetic route unavailable.' } },
    });
  });
  const panel = page.getByRole('region', {
    name: 'Rejected-return repair obligations',
    exact: true,
  });
  await page.goto(`http://127.0.0.1:${address.port}/tests/legacy-order-status/fixture.html`);
  await page.getByRole('button', { name: 'Whole-order status', exact: true }).click();
  await expect(panel.getByText('Original return ' + returnId, { exact: true })).toBeVisible();
  await expect(panel.getByText('Repair: BLOCKED', { exact: true })).toBeVisible();
  passed++;
  await panel.getByRole('button', { name: 'Recheck blocked repair', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  if (posts.length !== 1) throw new Error('Unexpected repeated recovery.');
  const first = posts[0].body;
  if (
    Object.keys(first).sort().join(',') !== 'expectedVersion,operationId' ||
    first.expectedVersion !== 1
  )
    throw new Error('Recovery payload contains return internals.');
  passed++;
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Whole-order status', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByText('Repair: PENDING', { exact: true })).toBeVisible();
  if (posts.length !== 1) throw new Error('Reload resent a recovery.');
  passed++;
  row = {
    ...row,
    state: 'LINKED',
    command: {
      operationId: returnId,
      state: 'UNCERTAIN',
      platform: 'PACK',
      errorCode: 'STATUS_OUTCOME_UNKNOWN',
    },
  };
  await panel.getByRole('button', { name: 'Refresh repair obligations', exact: true }).click();
  refreshLinked = true;
  await panel.getByRole('button', { name: 'Refresh repair receipt', exact: true }).click();
  await expect(panel.getByText('Repair: LINKED · PACK: QUEUED', { exact: true })).toBeVisible();
  if (posts.length !== 1) throw new Error('Receipt reconciliation dispatched a command.');
  refreshLinked = false;
  passed++;
  row = {
    ...row,
    state: 'BLOCKED',
    version: 3,
    errorCode: 'SYNTHETIC_HANDOVER_HELD',
    command: null,
  };
  mode = 'lost-uncommitted';
  await panel.getByRole('button', { name: 'Refresh repair obligations', exact: true }).click();
  await panel.getByRole('button', { name: 'Recheck blocked repair', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  const frozen = posts[1].body;
  await page.reload();
  await expect(
    panel.getByRole('button', { name: 'Retry the same recovery', exact: true }),
  ).toBeVisible();
  mode = 'success';
  await panel.getByRole('button', { name: 'Retry the same recovery', exact: true }).click();
  await expect(panel.getByText('Repair: PENDING', { exact: true })).toBeVisible();
  if (posts.length !== 3 || JSON.stringify(posts[2].body) !== JSON.stringify(frozen))
    throw new Error('Retry changed the saved recovery identity.');
  passed++;
  await page.getByRole('button', { name: 'Toggle connection', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: 'Refresh repair obligations', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Toggle connection', exact: true }).click();
  passed++;
  await page.getByRole('button', { name: 'Change operator', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Whole-order status', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  if (posts.some((value) => value.actor !== '1'))
    throw new Error('Recovery adopted another operator.');
  passed++;
  row = { ...row, state: 'BLOCKED', version: 5, command: null };
  await page.evaluate(
    ({ orderId }) => {
      sessionStorage.clear();
      sessionStorage.setItem(
        'pos-whole-order-status:' + JSON.stringify(['1', 2, 1, ['1'], '1', orderId]),
        JSON.stringify({
          operationId: crypto.randomUUID(),
          platform: 'PACK',
          scopeHash: 'a'.repeat(64),
          unexpected: 'SYNTHETIC_PRIVATE_MARKER',
        }),
      );
    },
    { orderId },
  );
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Whole-order status', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Queue PACK', exact: true })).toBeDisabled();
  await expect(
    page.getByText('Saved status metadata needs reconciliation. New status actions are blocked.', {
      exact: true,
    }),
  ).toBeVisible();
  if ((await page.locator('body').innerText()).includes('SYNTHETIC_PRIVATE_MARKER'))
    throw new Error('Corrupt storage reached presentation.');
  if (posts.length !== 3) throw new Error('Corrupt storage dispatched a new action.');
  passed++;
  await context.close();
  process.stdout.write(
    JSON.stringify({
      resource: 'return-repair-obligations',
      passed,
      browser: 'chromium',
      isolated: true,
    }) + '\n',
  );
} finally {
  await browser?.close();
  await server.close();
  rmSync(privateCache, { recursive: true, force: true });
}
