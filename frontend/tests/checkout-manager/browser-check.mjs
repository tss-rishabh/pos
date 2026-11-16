import { chromium, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (process.platform === 'darwin' && existsSync(mac) ? mac : undefined);
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const html =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/tests/checkout-manager/browser-entry.tsx"></script></body></html>';
const errors = [],
  unexpected = [],
  requests = [],
  contexts = [];
async function workspace(query = '') {
  const context = await browser.newContext({
      viewport: { width: 1512, height: 1100 },
      serviceWorkers: 'block',
    }),
    page = await context.newPage();
  contexts.push(context);
  page.on('pageerror', (error) => errors.push(error.message));
  let fixtures = null,
    receipts = null,
    operations = new Map(),
    reviews = 0,
    imports = 0,
    uploads = 0,
    loseReview = true,
    failImport = true;
  const clone = (value) => JSON.parse(JSON.stringify(value)),
    accepted = (entry) =>
      Object.fromEntries(
        Object.entries(entry).filter(
          ([key]) =>
            !['envelope', 'authorizationWindow', 'auditEvents', 'activeApproval'].includes(key),
        ),
      );
  const initialize = async () => {
    if (receipts) return;
    fixtures = await page.evaluate(() => ({
      envelopes: window.cashManagerFixture.envelopes,
      publicKey: window.cashManagerFixture.publicKey,
      authorizationWindow: window.cashManagerFixture.authorizationWindow,
    }));
    receipts = fixtures.envelopes.map((envelope, index) => {
      const value = envelope.receipt,
        status =
          index < 26
            ? 'conflicted'
            : index === 26
              ? 'accepted'
              : index === 27
                ? 'importing'
                : 'imported';
      return {
        receiptId: value.id,
        receiptNumber: value.receiptNumber,
        operatorId: value.operatorId,
        storeId: value.storeId,
        counterId: value.counterId,
        businessDate: value.businessDate,
        completedAt: value.completedAt,
        acceptedAt: Date.now() - index * 1000,
        importedAt: status === 'imported' ? Date.now() : null,
        payableCents: value.payableCents,
        cashReceivedCents: value.cashReceivedCents,
        changeCents: value.changeCents,
        status,
        conflicts: status === 'conflicted' ? ['clock-outside-authorization', 'stock-shortage'] : [],
        orderId: status === 'imported' ? '9007199254740995' : null,
        version: 1,
        envelope,
        authorizationWindow: fixtures.authorizationWindow,
        auditEvents: [],
        activeApproval: null,
      };
    });
  };
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.resourceType() === 'document' && url.pathname === '/cash-manager')
      return route.fulfill({ contentType: 'text/html', body: html });
    if (url.hostname !== '127.0.0.1') {
      unexpected.push(url.hostname);
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    await initialize();
    requests.push({ method: request.method(), path: url.pathname });
    expect(request.headers()['x-operator-id']).toBe('1');
    const base = '/api/v1/stores/1/offline-cash-receipts';
    if (url.pathname === base && request.method() === 'GET') {
      expect(url.searchParams.get('limit')).toBe('25');
      const rows = receipts.filter((row) => row.status === url.searchParams.get('status')),
        after = url.searchParams.get('afterId'),
        start = after ? rows.findIndex((row) => row.receiptId === after) + 1 : 0,
        data = rows.slice(start, start + 25),
        last = data.at(-1);
      if (after) {
        expect(url.searchParams.get('after')).toBe(String(rows[start - 1].acceptedAt));
      }
      return route.fulfill({
        json: {
          data: data.map(accepted),
          nextCursor:
            rows.length > start + 25
              ? { acceptedAt: last.acceptedAt, receiptId: last.receiptId }
              : null,
        },
      });
    }
    if (url.pathname === base && request.method() === 'POST') {
      uploads++;
      const envelope = request.postDataJSON(),
        original = fixtures.envelopes[0];
      expect(envelope).toEqual(original);
      expect(
        await page.evaluate((value) => window.cashManagerFixture.verify(value), envelope),
      ).toBe(true);
      expect(envelope.receipt.operatorId).toBe('44');
      return route.fulfill({ status: 201, json: accepted(receipts[0]) });
    }
    const tail = url.pathname.startsWith(base + '/')
        ? url.pathname.slice(base.length + 1).split('/')
        : [],
      row = receipts.find((value) => value.receiptId === tail[0]);
    if (row && tail.length === 1 && request.method() === 'GET')
      return route.fulfill({ json: clone(row) });
    if (row && tail.length === 2 && request.method() === 'POST') {
      const body = request.postDataJSON(),
        kind = tail[1],
        key = kind + ':' + body.operationId,
        prior = operations.get(key);
      if (prior) {
        expect(body).toEqual(prior.body);
        if (prior.result) return route.fulfill({ json: prior.result });
      } else operations.set(key, { body: clone(body), result: null });
      expect(body.expectedVersion).toBe(row.version);
      if (kind === 'manager-reviews') {
        reviews++;
        row.version++;
        row.auditEvents.unshift({
          operationId: body.operationId,
          kind: 'manager-reviewed',
          actorId: '1',
          receiptVersion: row.version,
          createdAt: Date.now(),
        });
        const result = accepted(row);
        operations.get(key).result = clone(result);
        if (loseReview) {
          loseReview = false;
          return route.abort('failed');
        }
        return route.fulfill({ json: result });
      }
      if (kind === 'import-approvals') {
        expect(body.orderCreatedAt).toBe('2026-11-16 09:35:00');
        expect(body.reason).toBeTruthy();
        row.version++;
        row.activeApproval = {
          operationId: body.operationId,
          actorId: '1',
          receiptVersion: row.version,
        };
        row.auditEvents.unshift({
          operationId: body.operationId,
          kind: 'import-approved',
          actorId: '1',
          receiptVersion: row.version,
          createdAt: Date.now(),
        });
        const result = accepted(row);
        operations.get(key).result = clone(result);
        return route.fulfill({ json: result });
      }
      if (kind === 'order-imports') {
        imports++;
        expect(body.approvalId).toBe(row.activeApproval.operationId);
        if (failImport) {
          failImport = false;
          return route.abort('failed');
        }
        row.version++;
        row.status = 'imported';
        row.orderId = '9007199254740997';
        row.importedAt = Date.now();
        row.activeApproval = null;
        row.auditEvents.unshift({
          operationId: body.operationId,
          kind: 'order-imported',
          actorId: '1',
          receiptVersion: row.version,
          createdAt: Date.now(),
        });
        const result = accepted(row);
        operations.get(key).result = clone(result);
        return route.fulfill({ json: result });
      }
    }
    unexpected.push(request.method() + ' ' + url.pathname);
    return route.fulfill({
      status: 500,
      json: {
        error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unexpected fixture request.' },
      },
    });
  });
  await page.goto('http://127.0.0.1:4490/cash-manager' + query);
  await expect(page.getByRole('dialog', { name: 'Cash receipt manager' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Saved pending cash receipts' })).toBeVisible();
  return {
    page,
    context,
    initialize,
    get rows() {
      return receipts;
    },
    get operations() {
      return operations;
    },
    get stats() {
      return { reviews, imports, uploads };
    },
  };
}
try {
  const work = await workspace(),
    { page } = work;
  await expect(page.getByRole('table', { name: 'Saved pending cash receipts' })).toContainText(
    '44',
  );
  await page.getByRole('button', { name: 'View saved receipt', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Saved cash receipt' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Cash receipt' })).toContainText('399.00');
  expect(await page.locator('script').count()).toBeGreaterThan(0);
  expect(await page.evaluate(() => typeof window.unsafe)).toBe('undefined');
  await page.getByRole('button', { name: 'Close cash receipt' }).click();
  const table = page.getByRole('table', { name: 'Server cash receipts' });
  await expect(table.locator('tbody tr')).toHaveCount(25);
  await page.getByRole('button', { name: 'Next server receipts' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Previous server receipts' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(25);
  await page.getByRole('button', { name: 'Synchronize saved store receipts' }).click();
  await expect(page.getByText('No pending receipts on this page', { exact: true })).toBeVisible();
  expect(work.stats.uploads).toBe(1);
  const stored = await page.evaluate(() => window.cashManagerFixture.snapshot());
  expect(stored.receipts).toHaveLength(1);
  expect(stored.receipts[0]).toMatchObject({
    ownerId: '44',
    syncState: 'conflicted',
    envelope: { receipt: { operatorId: '44', payableCents: 39900 } },
  });
  await table.getByRole('button', { name: 'Review receipt', exact: true }).first().click();
  const detail = page.getByRole('region', { name: 'Selected cash receipt' });
  await expect(detail).toContainText('Version 1');
  await page
    .getByLabel('Manager review note')
    .fill('Checked original signed receipt; preserve cash.');
  await page.getByRole('button', { name: 'Record manager review' }).click();
  await expect(detail).toContainText('Version 2');
  await expect(detail).toContainText('Needs manager review');
  await expect(
    page.getByRole('status').filter({ hasText: 'Earlier manager review confirmed' }),
  ).toBeVisible();
  expect(work.stats.reviews).toBe(1);
  expect(work.rows[0]).toMatchObject({
    status: 'conflicted',
    payableCents: 39900,
    cashReceivedCents: 50000,
    changeCents: 10100,
  });
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('pos:cash-manager-command:')),
    ),
  ).toEqual([]);
  await page.getByLabel('Cash attribution time').fill('2026-11-16T09:35');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Approve this import' }).click();
  await expect(detail).toContainText('Version 3');
  await expect(
    page.getByRole('status').filter({ hasText: 'Your approval is bound' }),
  ).toBeVisible();
  expect(work.rows[0]).toMatchObject({ status: 'conflicted', payableCents: 39900 });
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Import authoritative order' }).click();
  await expect(page.getByRole('button', { name: 'Retry saved import request' })).toBeEnabled();
  const markers = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) => key.startsWith('pos:cash-manager-command:')),
  );
  expect(markers).toHaveLength(1);
  expect(markers[0][1]).not.toContain('Checked original');
  expect(Object.keys(JSON.parse(markers[0][1])).sort()).toEqual([
    'approvalId',
    'expectedVersion',
    'hash',
    'id',
  ]);
  await page.getByRole('button', { name: 'Retry saved import request' }).click();
  await expect(detail).toContainText('Order synchronized');
  await expect(detail).toContainText('9007199254740997');
  expect(work.stats.imports).toBe(2);
  const after = await page.evaluate(() => window.cashManagerFixture.snapshot());
  expect(after.receipts[0]).toMatchObject({
    ownerId: '44',
    syncState: 'imported',
    importedAt: expect.any(Number),
    acceptance: { orderId: '9007199254740997', payableCents: 39900 },
  });
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('pos:cash-manager-command:')),
    ),
  ).toEqual([]);
  for (const status of ['accepted', 'importing', 'imported']) {
    await page.getByLabel('Cash receipt status').selectOption(status);
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(status === 'imported' ? 2 : 1);
  }
  await mkdir('../backend/parity/evidence/checkout-manager', { recursive: true });
  await page.screenshot({
    path: '../backend/parity/evidence/checkout-manager/manager-imported.png',
    fullPage: true,
  });
  const expired = await workspace();
  await expired.page.evaluate(() => window.cashManagerFixture.expire());
  await expect(
    expired.page.getByRole('table', { name: 'Saved pending cash receipts' }),
  ).toHaveCount(0);
  await expect(expired.page.getByRole('table', { name: 'Server cash receipts' })).toHaveCount(0);
  await expect(
    expired.page.getByText(/cached manager session expired|current manager session/),
  ).toBeVisible();
  expect(expired.stats.uploads).toBe(0);
  const changed = await workspace();
  await changed.page.evaluate(() => window.cashManagerFixture.changeCachedScope());
  await expect(
    changed.page.getByRole('table', { name: 'Saved pending cash receipts' }),
  ).toHaveCount(0);
  await expect(
    changed.page.getByRole('button', { name: 'Synchronize saved store receipts' }),
  ).toHaveCount(0);
  expect(changed.stats.uploads).toBe(0);
  const actor = await workspace();
  await actor.page.evaluate(() => window.cashManagerFixture.changeOperator());
  await expect(actor.page.getByRole('table', { name: 'Server cash receipts' })).toHaveCount(0);
  await expect(
    actor.page.getByText('Sign in with a current manager session for this store.'),
  ).toBeVisible();
  const offline = await workspace('?offline=1');
  await expect(
    offline.page.getByRole('button', { name: 'Synchronize saved store receipts' }),
  ).toBeDisabled();
  expect(offline.stats.uploads).toBe(0);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  const evidence = {
    scope: 'isolated-browser-fixtures',
    workflows: 10,
    requests: requests.length,
    pageErrors: errors.length,
    unexpectedRequests: unexpected.length,
    verified: [
      'original-owner signed handoff',
      '25-row server pagination and four states',
      'local receipt print with escaped text',
      'lost review acknowledgment confirmed by audit without automatic retry',
      'versioned clock-attributed approval leaves cash/conflicts unchanged',
      'unknown import retries exact saved UUID/version/approval',
      'proof-bearing imported receipt refresh preserves original owner',
      'expired or changed cached manager scope hides other-owner cash',
      'operator switch aborts workspace',
      'offline handoff stays queued',
    ],
    limitations:
      'Mocked HTTP fixtures only; actual atomic MySQL importer/sealed proof parity is independently tested by checkout and finance suites.',
  };
  await writeFile(
    '../backend/parity/evidence/checkout-manager/browser.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
