import { chromium, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (process.platform === 'darwin' && existsSync(mac) ? mac : undefined),
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
const entry =
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/tests/legacy-fulfillment/browser-entry.tsx"></script></body></html>',
  contexts = [],
  errors = [],
  unexpected = [],
  requests = [];
async function workspace(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1512, height: 1400 },
    serviceWorkers: 'block',
  });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', () => errors.push('UNEXPECTED_PAGE_ERROR'));
  let packed = false,
    received = false,
    packing = 0,
    returns = 0,
    restocks = 0,
    failed = false,
    release;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    receipts = new Map(),
    submitted = [];
  const state = () => ({
    orderId: '9007199254740993',
    storeId: '1',
    reference: 'FIXTURE-LONG',
    split: true,
    sourceStatus: { status: '200', message: 'Order Created Succesfully at Borzo', error: '' },
    action: 'ACCEPTED',
    borzoId: '9007199254741999',
    packed,
    rtoReceived: received,
    rtoEligible: true,
    checkedIn: options.checkedIn !== false,
    reconciliationRequired: options.reconciliation === true,
    rtoReady: options.ready !== false,
    maxNoteCharacters: 210,
    canPack: !packed && !received && options.checkedIn !== false,
    canReceiveRto:
      !received &&
      options.ready !== false &&
      options.checkedIn !== false &&
      options.reconciliation !== true,
    returnLines: [
      {
        id: '9007199254741993',
        productId: '10',
        name: 'Fixture product <script>unsafe()</script>',
        quantity: '2',
      },
      { id: '9007199254741994', productId: '10', name: 'Fixture product', quantity: '1' },
    ],
    excludedLineCount: 1,
    linesTruncated: false,
    tracking: { source: 'https://tracking.example.test/fixture', destination: null },
  });
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.resourceType() === 'document' && url.pathname === '/local-deliveries')
      return route.fulfill({ contentType: 'text/html', body: entry });
    if (url.hostname !== '127.0.0.1') {
      unexpected.push(url.hostname);
      return route.abort();
    }
    if (url.pathname === '/@vite/client')
      return route.fulfill({
        contentType: 'application/javascript',
        body: `const styles=new Map();export function updateStyle(id,text){let style=styles.get(id);if(!style){style=document.createElement('style');document.head.append(style);styles.set(id,style);}style.textContent=text;}export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}export function createHotContext(){return {data:{},accept(){},acceptExports(){},dispose(){},prune(){},invalidate(){},on(){},off(){},send(){}};}export function injectQuery(url){return url;}`,
      });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests.push({ method: request.method(), path: url.pathname });
    expect(request.headers()['x-operator-id']).toBe('44');
    const base = '/api/v1/stores/1/legacy-fulfillment/orders/9007199254740993';
    const lifecycle = '/api/v1/stores/1/local-deliveries/orders/9007199254740993';
    if (url.pathname === lifecycle + '/capabilities')
      return route.fulfill({
        json: {
          timeZone: 'Asia/Kolkata',
          orderId: '9007199254740993',
          storeId: '1',
          ownerStoreId: '1',
          checkedIn: options.checkedIn !== false,
          contractReady: false,
          arrivalRecorded: true,
          reservationsVerified: false,
          nextStoreIds: [],
          canCreate: false,
          canPass: false,
          canConvert: false,
          canCancel: false,
          activeCommand: null,
          workflowPending: false,
        },
      });
    if (url.pathname === lifecycle + '/commands') return route.fulfill({ json: { data: [] } });
    if (url.pathname === base) return route.fulfill({ json: { data: state() } });
    if (url.pathname.startsWith('/api/v1/legacy-fulfillment/commands/')) {
      const value = receipts.get(url.pathname.split('/').at(-1));
      return value
        ? route.fulfill({ json: value })
        : route.fulfill({
            status: 404,
            json: { error: { code: 'LEGACY_COMMAND_NOT_FOUND', message: 'Command not found.' } },
          });
    }
    if ([base + '/packing', base + '/rto-receipts'].includes(url.pathname)) {
      const body = request.postDataJSON(),
        action = url.pathname.endsWith('/packing') ? 'packing' : 'rto-receipt';
      submitted.push({ action, ...body });
      if (action === 'packing') {
        packing++;
        expect(request.method()).toBe('PUT');
        packed = true;
      } else {
        returns++;
        expect(request.method()).toBe('POST');
        if (options.retryRto && !failed) {
          failed = true;
          return route.abort('failed');
        }
        if (!received) restocks++;
        received = true;
      }
      const value = {
        commandId: body.commandId,
        actorId: '44',
        storeId: '1',
        orderId: '9007199254740993',
        action,
        outcome: action === 'packing' ? 'packed' : 'rto-received',
        originalCommandId: null,
        recordedBy: 'rewrite',
        auditId: '9007199254742993',
        restoredUnits: action === 'packing' ? '0' : '3',
        split: true,
        excludedLineCount: action === 'packing' ? 0 : 1,
        steps:
          action === 'packing'
            ? []
            : [
                {
                  hasProductId: '9007199254741993',
                  productId: '10',
                  quantity: '2',
                  before: 5,
                  after: 7,
                },
                {
                  hasProductId: '9007199254741994',
                  productId: '10',
                  quantity: '1',
                  before: 7,
                  after: 8,
                },
              ],
        syncEventId: action === 'packing' ? null : body.commandId,
        integrationState: action === 'packing' ? 'not-required' : 'pending',
        createdAt: Date.now(),
        correctionContract: action === 'packing' ? null : 'pos-legacy-rto-same-store-hp-v1',
      };
      receipts.set(body.commandId, value);
      if (action === 'packing' && options.losePack) return route.abort('failed');
      if (action === 'rto-receipt' && options.deferRto) await gate;
      try {
        return await route.fulfill({ json: value });
      } catch (error) {
        if (!options.deferRto) throw error;
      }
    }
    unexpected.push(request.method() + ' ' + url.pathname);
    return route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED_FIXTURE_REQUEST' } } });
  });
  await page.goto('http://127.0.0.1:4490/local-deliveries');
  await page.getByLabel('Local delivery order ID').fill('9007199254740993');
  await page.getByRole('button', { name: 'View fulfillment', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Returning delivery line items' })).toBeVisible();
  return {
    page,
    context,
    submitted,
    release,
    get stats() {
      return { packing, returns, restocks };
    },
  };
}
try {
  const work = await workspace({ losePack: true }),
    { page } = work;
  await expect(
    page.getByRole('table', { name: 'Returning delivery line items' }).locator('tbody tr'),
  ).toHaveCount(2);
  await expect(
    page.getByText('1 online line(s) in this split order are excluded from the courier return.'),
  ).toBeVisible();
  expect(await page.evaluate(() => typeof window.unsafe)).toBe('undefined');
  await page.getByLabel('Local delivery note').fill('Parcel checked');
  await page.getByRole('button', { name: 'Mark packed', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Packing recorded.' })).toBeVisible();
  expect(work.stats.packing).toBe(1);
  await expect(page.getByRole('button', { name: 'Mark packed', exact: true })).toBeDisabled();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Receive returning parcel', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '3 units restored to this store' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Receive returning parcel', exact: true }),
  ).toBeDisabled();
  expect(work.stats.restocks).toBe(1);
  await expect(
    page.getByRole('complementary', { name: 'Fulfillment command receipt' }),
  ).toContainText('synchronization is pending');
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('pos:legacy-fulfillment-command:')),
    ),
  ).toEqual([]);
  await mkdir('../backend/parity/evidence/legacy-fulfillment', { recursive: true });
  await page.getByRole('heading', { name: 'Local deliveries.' }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '../backend/parity/evidence/legacy-fulfillment/rto-receipt.png',
    fullPage: true,
  });
  const retry = await workspace({ retryRto: true });
  await retry.page.getByLabel('Local delivery note').fill('Original private note');
  await retry.page.getByRole('checkbox').check();
  await retry.page.getByRole('button', { name: 'Receive returning parcel', exact: true }).click();
  await expect(retry.page.getByRole('alert')).toBeVisible();
  const markers = await retry.page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) =>
      key.startsWith('pos:legacy-fulfillment-command:'),
    ),
  );
  expect(markers).toHaveLength(1);
  expect(markers[0][1]).not.toContain('Original private note');
  await retry.page.getByRole('button', { name: 'Receive returning parcel', exact: true }).click();
  await expect(
    retry.page.getByRole('status').filter({ hasText: '3 units restored' }),
  ).toBeVisible();
  expect(retry.submitted.filter((row) => row.action === 'rto-receipt')).toHaveLength(2);
  expect(retry.submitted[0]).toEqual(retry.submitted[1]);
  expect(retry.stats.restocks).toBe(1);
  const unavailable = await workspace({ ready: false });
  await expect(
    unavailable.page.getByRole('button', { name: 'Receive returning parcel', exact: true }),
  ).toBeDisabled();
  await expect(
    unavailable.page.getByRole('status').filter({ hasText: 'Contact the inventory administrator' }),
  ).toBeVisible();
  expect(unavailable.stats.restocks).toBe(0);
  const noCheckin = await workspace({ checkedIn: false });
  await expect(
    noCheckin.page.getByRole('button', { name: 'Mark packed', exact: true }),
  ).toBeDisabled();
  await expect(
    noCheckin.page.getByRole('button', { name: 'Receive returning parcel', exact: true }),
  ).toBeDisabled();
  const reconciliation = await workspace({ reconciliation: true });
  await expect(reconciliation.page.getByRole('alert')).toContainText(
    'records need reconciliation before a return can be received',
  );
  await reconciliation.page.getByRole('checkbox').check();
  await expect(
    reconciliation.page.getByRole('button', { name: 'Receive returning parcel', exact: true }),
  ).toBeDisabled();
  expect(reconciliation.stats.returns).toBe(0);
  const interrupted = await workspace({ deferRto: true });
  await interrupted.page.getByRole('checkbox').check();
  await interrupted.page
    .getByRole('button', { name: 'Receive returning parcel', exact: true })
    .click();
  await expect.poll(() => interrupted.stats.returns).toBe(1);
  await interrupted.page.evaluate(() => window.legacyFixture.logout());
  interrupted.release();
  await expect(interrupted.page.getByText('Fixture signed out', { exact: true })).toBeVisible();
  expect(
    (
      await interrupted.page.evaluate(() =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith('pos:legacy-fulfillment-command:'),
        ),
      )
    ).length,
  ).toBe(1);
  const offline = await workspace();
  await offline.context.setOffline(true);
  await expect(
    offline.page.getByRole('button', { name: 'Mark packed', exact: true }),
  ).toBeDisabled();
  await expect(
    offline.page.getByRole('button', { name: 'Receive returning parcel', exact: true }),
  ).toBeDisabled();
  expect(offline.stats.packing).toBe(0);
  expect(offline.stats.returns).toBe(0);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  const evidence = {
    scope: 'isolated-browser-http-fixtures',
    workflows: 9,
    requests: requests.length,
    pageErrors: errors.length,
    unexpectedRequests: unexpected.length,
    verified: [
      'lossless order/HP/courier IDs and inert product text',
      'split online-line exclusion displayed',
      'lost committed pack response recovered by GET without duplicate PUT',
      'current RTO receipt with per-HP before/after and pending sync',
      'explicit unknown-outcome retry reuses UUID and original note without persisting text',
      'missing inventory readiness/check-in disables writes',
      'prior cancellation/refund reconciliation disables return stock movement',
      'logout retains opaque original-owner receipt metadata',
      'offline never records packing or stock receipt',
    ],
    limitations:
      'Mocked browser HTTP only; independent native MySQL/source-oracle tests establish transaction, stock and correction behavior. No provider, live write or full source-route certification.',
  };
  await writeFile(
    '../backend/parity/evidence/legacy-fulfillment/browser.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
