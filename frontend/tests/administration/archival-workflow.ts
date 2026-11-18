/** Joined pinned Django/native API/actual built App lifecycle proof, not component mocks. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, request as proxyRequest } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type APIResponse, type BrowserContext } from '@playwright/test';
import { archivalWorkflowFixture } from '../../../backend/tools/administration/archival-workflow-fixture.js';
import { storeSchema } from '../../src/pages/administration/api.js';
import { z } from 'zod';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const built = resolve(root, 'frontend/dist');
const calls: { method: string; path: string; status: number; dropped: boolean }[] = [];
const checks: string[] = [];
let apiOrigin = '';
let dropOperatorReply = false;
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};
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
        const dropped =
          dropOperatorReply &&
          incoming.method === 'PATCH' &&
          requested.pathname === '/api/v1/admin/operators/30/status';
        if (dropped) dropOperatorReply = false;
        calls.push({
          method: incoming.method || 'GET',
          path: requested.pathname,
          status: response.statusCode || 500,
          dropped,
        });
        if (dropped) {
        // Native handler has committed. Truncate its real body after forwarding
        // genuine headers/one byte, avoiding an empty-response transport retry.
        outgoing.writeHead(response.statusCode || 500, response.headers);
        let began = false;
        response.on('data', (chunk: Buffer) => {
          if (began) return;
          began = true;
          outgoing.write(chunk.subarray(0, 1));
          setImmediate(() => outgoing.destroy());
        });
        response.on('end', () => { if (!began) outgoing.destroy(); });
        } else {
          outgoing.writeHead(response.statusCode || 500, response.headers);
          response.pipe(outgoing);
        }
      },
    );
    proxy.on('error', () => {
      outgoing.writeHead(502);
      outgoing.end();
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
  if (!extname(requested.pathname) || requested.pathname === '/')
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
let fixture: Awaited<ReturnType<typeof archivalWorkflowFixture>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  fixture = await archivalWorkflowFixture(
    process.env.ARCHIVAL_WORKFLOW_MYSQL_URL || '',
    origin,
    process.argv[2] || '',
  );
  apiOrigin = fixture.apiOrigin;
  const history = await fixture.history();
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(chrome) ? chrome : undefined),
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });

  // Every source case binds its actual native postcondition to the replacement HTTP route.
  for (const original of fixture.original.cases) {
    const resource = original.resource === 'users' ? 'operators' : 'stores';
    const id =
      resource === 'stores' ? '2' : original.self ? '1' : original.targetRole === 2 ? '2' : '30';
    await fixture.resetActive(resource, id, original.initialActive);
    const context: BrowserContext = await browser.newContext({ serviceWorkers: 'block' });
    if (original.actorRole !== null)
      await context.addCookies([(await fixture.account(String(original.actorRole))).cookie]);
    const response: APIResponse = await context.request.patch(
      `${origin}/api/v1/admin/${resource}/${id}/status`,
      {
        headers: {
          Origin: origin,
          ...(original.actorRole === null ? {} : { 'X-Operator-Id': String(original.actorRole) }),
        },
        data: { active: original.action === 'activate' },
      },
    );
    const allowed = original.initialActive !== original.active;
    assert.equal(response.status(), allowed ? 200 : original.actorRole === null ? 401 : 403,
      JSON.stringify({ resource, action: original.action, actorRole: original.actorRole,
        targetRole: original.targetRole, self: original.self, sourceHttpStatus: original.httpStatus,
        sourceStatus: original.sourceStatus, permissionDenied: original.permissionDenied,
        failureCategory: original.failureCategory }));
    assert.equal(await fixture.active(resource, id), original.active);
    assert(original.retainedId);
    assert(
      (await fixture.history()) === history,
      'Archival must retain financial rows and assignments',
    );
    await fixture.resetActive(resource, id, true);
    await context.close();
  }
  checks.push('twelve-source-dispatch-cases-bind-to-native-http-and-retained-history');

  const organization = await browser.newContext({ serviceWorkers: 'block' });
  await organization.addCookies([(await fixture.account('11')).cookie]);
  const outsideOrganization = await organization.request.patch(
    origin + '/api/v1/admin/operators/30/status',
    {
      headers: { Origin: origin, 'X-Operator-Id': '11' },
      data: { active: false },
    },
  );
  assert.equal(outsideOrganization.status(), 403);
  assert.equal(await fixture.active('operators', '30'), true);
  await organization.close();
  checks.push('native-organization-boundary-denies-unrelated-operator');

  const admin = await fixture.account('1'),
    staff = await fixture.account('30');
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addCookies([admin.cookie]);
  const nativeStores = await context.request.post(origin + '/api/v1/admin/stores/search', {
    headers: { Origin: origin, 'X-Operator-Id': '1' },
    data: { after: '0', limit: 25, search: '', active: 'true', sort: 'id', direction: 'asc' },
  });
  assert.equal(nativeStores.status(), 200, 'Native store collection must load before UI binding');
  const collection = z.object({ data: z.array(storeSchema) }).safeParse(await nativeStores.json() as unknown);
  assert(collection.success, 'Store DTO issue paths: ' + (collection.success ? '' : collection.error.issues.map((issue) => issue.path.join('.')).join(',')));
  assert.equal(collection.data.data.length, 2, 'Native collection must include both fixture stores');
  const page = await context.newPage();
  await page.goto(origin + '/');
  await page.getByRole('link', { name: 'Administration', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Store management', exact: true })).toBeVisible();
  const store = page.getByRole('row').filter({ hasText: 'Archival fixture store 2' });
  await expect(store).toHaveCount(1);
  await store.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('Store archived.', { exact: true })).toBeVisible();
  assert.equal(await fixture.active('stores', '2'), false);
  await page.getByLabel('Store status', { exact: true }).selectOption('false');
  await expect(store.getByRole('button', { name: 'Activate', exact: true })).toBeVisible();
  const staffContext = await browser.newContext({ serviceWorkers: 'block' });
  await staffContext.addCookies([staff.cookie]);
  const staleStore = await staffContext.request.put(origin + '/api/v1/operators/me/check-in', {
    headers: { Origin: origin, 'X-Operator-Id': '30' },
    data: { storeId: '2', counterId: '2' },
  });
  assert.equal(staleStore.status(), 409, 'Archived store must reject stale check-in');
  const unavailableStore = z.object({ error: z.object({ code: z.literal('STORE_UNAVAILABLE') }) }).safeParse(await staleStore.json() as unknown);
  assert(unavailableStore.success, 'Archived store rejection must identify the unavailable store');
  const stores = await staffContext.request.get(origin + '/api/v1/stores', {
    headers: { 'X-Operator-Id': '30' },
  });
  assert.equal(stores.status(), 200);
  const storeRows: unknown = await stores.json();
  assert(
    !JSON.stringify(storeRows).includes('Archival fixture store 2'),
    'Operational store list must omit archived stores',
  );
  await store.getByRole('button', { name: 'Activate', exact: true }).click();
  await expect(page.getByText('Store activated.', { exact: true })).toBeVisible();
  assert.equal(await fixture.active('stores', '2'), true);
  checks.push('actual-app-store-archive-activate-stale-store-denial');

  await page.getByRole('tab', { name: 'Operators', exact: true }).click();
  const operator = page.getByRole('row').filter({ hasText: 'Archival 30 Fixture' });
  await expect(operator).toHaveCount(1);
  const beforeLostReply = calls.filter(
    (call) => call.method === 'PATCH' && call.path === '/api/v1/admin/operators/30/status',
  ).length;
  const epochBeforeLostReply = await fixture.epoch('30');
  dropOperatorReply = true;
  await operator.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect.poll(() => fixture!.active('operators', '30')).toBe(false);
  await expect.poll(() => calls.filter((call) => call.dropped).length).toBe(1);
  assert.equal(await staff.valid(), false);
  assert.equal(await fixture.epoch('30'), epochBeforeLostReply + 1n);
  assert.equal(
    (await staffContext.request.get(origin + '/api/v1/auth/sessions/current')).status(),
    401,
  );
  await page.reload();
  await page.getByRole('tab', { name: 'Operators', exact: true }).click();
  await page.getByLabel('Operators status', { exact: true }).selectOption('false');
  await expect(operator.getByRole('button', { name: 'Activate', exact: true })).toBeVisible();
  assert.equal(await fixture.epoch('30'), epochBeforeLostReply + 1n);
  assert.equal(
    calls.filter(
      (call) => call.method === 'PATCH' && call.path === '/api/v1/admin/operators/30/status',
    ).length,
    beforeLostReply + 1,
  );
  await operator.getByRole('button', { name: 'Activate', exact: true }).click();
  await expect(page.getByText('Operator activated.', { exact: true })).toBeVisible();
  assert.equal(await fixture.active('operators', '30'), true);
  assert.equal(await staff.valid(), false);
  assert.equal(
    (await staffContext.request.get(origin + '/api/v1/auth/sessions/current')).status(),
    401,
  );
  assert(
    (await fixture.history()) === history,
    'Archive/reactivation must retain financial history',
  );
  checks.push('actual-app-lost-reply-reload-no-repeat-archive-reactivation-retains-revocation');

  const stale = await browser.newContext({ serviceWorkers: 'block' });
  await stale.addCookies([(await fixture.account('2')).cookie]);
  await fixture.role('2', 4);
  const denied = await stale.request.patch(origin + '/api/v1/admin/operators/30/status', {
    headers: { Origin: origin, 'X-Operator-Id': '2' },
    data: { active: false },
  });
  // The real session credential is role-bound; direct demotion invalidates it
  // at authentication before the administrative writer handler is reached.
  assert.equal(denied.status(), 401);
  assert.equal(await fixture.active('operators', '30'), true);
  await fixture.role('2', 2);
  await stale.close();
  await staffContext.close();
  await context.close();
  checks.push('native-role-bound-authentication-denies-stale-actor');
  const staffNavigation = await browser.newContext({ serviceWorkers: 'block' });
  await staffNavigation.addCookies([(await fixture.account('4')).cookie]);
  const staffPage = await staffNavigation.newPage();
  await staffPage.goto(origin + '/shortcut-reference');
  await expect(
    staffPage.getByRole('heading', { name: 'Shortcut reference.', exact: true }),
  ).toBeVisible();
  await expect(staffPage.getByRole('link', { name: 'Administration', exact: true })).toHaveCount(0);
  await staffNavigation.close();
  checks.push('actual-app-staff-navigation-hides-administration');
  assert((await fixture.history()) === history);
  assert(
    calls.every(
      (call) => !/(?:cash-completions|refund|payments|order-submissions)/.test(call.path),
    ),
  );
  process.stdout.write(
    JSON.stringify({
      sourceCommit: fixture.original.sourceCommit,
      routeIds: fixture.original.routeIds,
      sourceHashes: fixture.original.hashes,
      checks,
      scope:
        'Reversible store/operator archival only; no broad administration or financial-dispatch certification.',
    }) + '\n',
  );
} finally {
  await browser?.close();
  await fixture?.close();
  await new Promise<void>((done, reject) => web.close((error) => (error ? reject(error) : done())));
}
