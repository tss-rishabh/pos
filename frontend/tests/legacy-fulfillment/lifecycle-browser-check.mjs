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
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/tests/legacy-fulfillment/lifecycle-browser-entry.tsx"></script></body></html>',
  contexts = [],
  errors = [],
  unexpected = [],
  requests = [];
const initial = (id, action = 'cancel') => ({
  commandId: id,
  actorId: '44',
  storeId: '1',
  orderId: '9007199254740993',
  action,
  phase: 'queued',
  version: 2,
  outcome: 'pending',
  nextStoreIds: ['2'],
  nextJobAt: null,
  newOrderId: null,
  courierOrderId: null,
  providerCallIds: [],
  auditIds: [],
  inventoryMovementCommandId: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  errorCode: null,
  integrationState: 'pending',
  recoveryActorId: null,
  moneyHistoryId: null,
});
async function workspace(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1512, height: 1200 },
    serviceWorkers: 'block',
  });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', () => errors.push('PAGE_ERROR'));
  const records = new Map(),
    posts = [];
  let failed = false,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  if (options.review) {
    const receipt = {
      ...initial('00000000-0000-4000-a000-000000000001'),
      actorId: 'service',
      phase: 'uncertain',
      version: 4,
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      integrationState: 'uncertain',
    };
    records.set(receipt.commandId, receipt);
  }
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.resourceType() === 'document' && url.pathname === '/delivery-lifecycle')
      return route.fulfill({ contentType: 'text/html', body: entry });
    if (url.hostname !== '127.0.0.1') {
      unexpected.push(url.hostname);
      return route.abort();
    }
    if (url.pathname === '/@vite/client')
      return route.fulfill({
        contentType: 'application/javascript',
        body: 'const styles=new Map();export function updateStyle(id,text){let style=styles.get(id);if(!style){style=document.createElement("style");document.head.append(style);styles.set(id,style);}style.textContent=text;}export function removeStyle(id){styles.get(id)?.remove();styles.delete(id);}export function createHotContext(){return {data:{},accept(){},acceptExports(){},dispose(){},prune(){},invalidate(){},on(){},off(){},send(){}};}export function injectQuery(url){return url;}',
      });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests.push({ method: request.method(), path: url.pathname });
    expect(request.headers()['x-operator-id']).toBe('44');
    const base = '/api/v1/stores/1/local-deliveries/orders/9007199254740993';
    if (url.pathname === base + '/capabilities') {
      const active = [...records.values()].find(
        (row) => !['completed', 'rejected'].includes(row.phase),
      );
      return route.fulfill({
        json: {
          timeZone: 'Asia/Kolkata',
          orderId: '9007199254740993',
          storeId: '1',
          ownerStoreId: '1',
          checkedIn: options.checkedIn !== false,
          contractReady: options.ready !== false,
          arrivalRecorded: true,
          reservationsVerified: true,
          nextStoreIds: ['2'],
          canCreate: !active && options.checkedIn !== false && options.ready !== false,
          canPass: !active && options.checkedIn !== false && options.ready !== false,
          canConvert: !active && options.checkedIn !== false && options.ready !== false,
          canCancel: !active && options.checkedIn !== false && options.ready !== false,
          activeCommand: active || null,
          workflowPending: !!active,
        },
      });
    }
    if (url.pathname === base + '/commands')
      return route.fulfill({ json: { data: [...records.values()] } });
    if (url.pathname.startsWith('/api/v1/local-delivery-commands/')) {
      const id = url.pathname.split('/')[4],
        receipt = records.get(id);
      if (!receipt)
        return route.fulfill({
          status: 404,
          json: {
            error: { code: 'LOCAL_DELIVERY_COMMAND_NOT_FOUND', message: 'Command not found.' },
          },
        });
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        posts.push({ kind: 'reconcile', ...body });
        expect(body.expectedVersion).toBe(4);
        const done = {
          ...receipt,
          phase: 'completed',
          outcome: 'cancelled',
          version: 6,
          errorCode: null,
          integrationState: 'delivered',
          recoveryActorId: '44',
        };
        records.set(id, done);
        return route.fulfill({ json: done });
      }
      return route.fulfill({ json: receipt });
    }
    const action = {
      'courier-requests': 'create',
      transfers: 'pass',
      'online-conversions': 'convert',
      cancellations: 'cancel',
    }[url.pathname.split('/').at(-1)];
    if (action && request.method() === 'POST') {
      const body = request.postDataJSON();
      posts.push({ kind: action, ...body });
      if (options.loseBefore && !failed) {
        failed = true;
        return route.abort('failed');
      }
      const value = {
        ...initial(body.commandId, action),
        phase: 'completed',
        version: 4,
        outcome: {
          create: 'created',
          pass: 'transferred',
          convert: 'converted',
          cancel: 'cancelled',
        }[action],
        integrationState: 'delivered',
        ...(action === 'create' ? { courierOrderId: '9007199254742999' } : {}),
        ...(action === 'pass' ? { nextJobAt: Date.now() + 3600000 } : {}),
        ...(action === 'convert' ? { newOrderId: '9007199254743999' } : {}),
      };
      records.set(body.commandId, value);
      if (options.loseCommit) return route.abort('failed');
      if (options.defer) await gate;
      try {
        return await route.fulfill({ json: value });
      } catch (error) {
        if (!options.defer) throw error;
        return;
      }
    }
    unexpected.push(request.method() + ' ' + url.pathname);
    return route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED_REQUEST' } } });
  });
  await page.goto('http://127.0.0.1:4490/delivery-lifecycle');
  await expect(page.getByRole('heading', { name: 'Delivery actions', exact: true })).toBeVisible();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  return { context, page, posts, records, release };
}
async function confirm(work, label, reason = 'Fixture reason') {
  await work.page.getByRole('button', { name: label, exact: true }).click();
  await work.page.getByLabel('Delivery action reason').fill(reason);
  await work.page.getByRole('checkbox').check();
  await work.page
    .getByRole('button', { name: 'Confirm ' + label.toLowerCase(), exact: true })
    .click();
}
try {
  const create = await workspace({ loseCommit: true });
  await confirm(create, 'Accept delivery');
  await expect(
    create.page.getByRole('complementary', { name: 'Delivery command receipt' }),
  ).toContainText('Courier order 9007199254742999');
  expect(create.posts).toHaveLength(1);
  expect(
    await create.page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('pos:local-delivery-command:')),
    ),
  ).toEqual([]);
  const pass = await workspace();
  await pass.page.getByRole('button', { name: 'Pass to backup stores', exact: true }).click();
  await pass.page.getByLabel('Delivery action reason').fill('Need another store');
  await pass.page.getByLabel('Delivery reason category').fill('Store capacity');
  await pass.page.getByRole('checkbox').check();
  await pass.page
    .getByRole('button', { name: 'Confirm pass to backup stores', exact: true })
    .click();
  await expect(
    pass.page.getByRole('complementary', { name: 'Delivery command receipt' }),
  ).toContainText('Next scheduled check');
  expect(pass.posts[0]).toMatchObject({
    kind: 'pass',
    reason: 'Need another store',
    reasonCategory: 'Store capacity',
  });
  const converted = await workspace();
  await confirm(converted, 'Convert to online');
  await expect(
    converted.page.getByRole('complementary', { name: 'Delivery command receipt' }),
  ).toContainText('Online replacement order 9007199254743999');
  const retry = await workspace({ loseBefore: true });
  await confirm(retry, 'Cancel delivery', 'Original private reason');
  await expect(retry.page.getByRole('alert')).toBeVisible();
  const markers = await retry.page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) => key.startsWith('pos:local-delivery-command:')),
  );
  expect(markers).toHaveLength(1);
  expect(markers[0][1]).not.toContain('Original private');
  await retry.page.getByLabel('Delivery action reason').fill('Changed private reason');
  await retry.page.getByRole('button', { name: 'Confirm cancel delivery', exact: true }).click();
  await expect(retry.page.getByRole('alert')).toContainText('previous request');
  expect(retry.posts).toHaveLength(1);
  await retry.page.getByLabel('Delivery action reason').fill('Original private reason');
  await retry.page.getByRole('button', { name: 'Confirm cancel delivery', exact: true }).click();
  await expect(
    retry.page.getByRole('complementary', { name: 'Delivery command receipt' }),
  ).toContainText('Cancellation recorded');
  expect(retry.posts).toHaveLength(2);
  expect(retry.posts[0]).toEqual(retry.posts[1]);
  const review = await workspace({ review: true });
  await review.page.getByRole('button', { name: 'View receipt 00000000', exact: true }).click();
  await review.page.getByLabel('Delivery review reason').fill('Read original provider receipt');
  await review.page.getByRole('button', { name: 'Check provider evidence', exact: true }).click();
  await expect(
    review.page.getByRole('complementary', { name: 'Delivery command receipt' }),
  ).toContainText('Cancellation recorded');
  expect(review.posts.filter((row) => row.kind === 'reconcile')).toHaveLength(1);
  const unready = await workspace({ ready: false });
  await expect(
    unready.page.getByRole('button', { name: 'Accept delivery', exact: true }),
  ).toBeDisabled();
  await expect(
    unready.page.getByRole('status').filter({ hasText: 'processing is not ready' }),
  ).toBeVisible();
  const unchecked = await workspace({ checkedIn: false });
  await expect(
    unchecked.page.getByRole('button', { name: 'Cancel delivery', exact: true }),
  ).toBeDisabled();
  const offline = await workspace();
  await offline.context.setOffline(true);
  await expect(
    offline.page.getByRole('button', { name: 'Accept delivery', exact: true }),
  ).toBeDisabled();
  expect(offline.posts).toHaveLength(0);
  const interrupted = await workspace({ defer: true });
  await confirm(interrupted, 'Cancel delivery');
  await expect.poll(() => interrupted.posts.length).toBe(1);
  await interrupted.page.evaluate(() => window.deliveryFixture.logout());
  interrupted.release();
  await expect(interrupted.page.getByText('Fixture signed out', { exact: true })).toBeVisible();
  expect(
    (
      await interrupted.page.evaluate(() =>
        Object.keys(localStorage).filter((key) => key.startsWith('pos:local-delivery-command:')),
      )
    ).length,
  ).toBe(1);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
  await mkdir('../backend/parity/evidence/legacy-fulfillment', { recursive: true });
  await create.page.screenshot({
    path: '../backend/parity/evidence/legacy-fulfillment/lifecycle.png',
    fullPage: true,
  });
  const evidence = {
    scope: 'isolated-browser-http-fixtures',
    workflows: 9,
    requests: requests.length,
    pageErrors: errors.length,
    unexpectedRequests: unexpected.length,
    verified: [
      'captured operator and lossless64bit receipt IDs',
      'lost committed courier request recovered by GET without redispatch',
      'explicit transfer reason/category and scheduled next step',
      'online replacement receipt',
      'unknown cancellation reuses original opaque UUID and hash without persisted notes',
      'manager versioned evidence review retains original service owner',
      'readiness/check-in/offline write gates',
      'logout during command retains original-owner reconciliation marker',
    ],
    limitations:
      'Mocked browser HTTP only; independent native SQL and pinned source tests establish lifecycle effects. No real providers, stock writes, messages or blanket source-route certification.',
  };
  await writeFile(
    '../backend/parity/evidence/legacy-fulfillment/lifecycle-browser.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(evidence) + '\n');
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
