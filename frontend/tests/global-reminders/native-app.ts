/** Native services/HTTP and the built App. Clock/visibility are explicit browser seams.
 * Fixed Date survives navigation when the native fixture freezes Node Date too:
 * Playwright replay timestamps otherwise add the real browser/Node clock offset.
 * Timers keep running; explicit fixed-Date advances below remain controllable.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, request as proxyRequest } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  remindersFixture,
  expirySchema,
  fixtureNow,
  fixtureDay,
} from '../../../backend/tools/global-reminders/native.js';
import { sourceClientEvidence } from '../../../backend/tools/global-reminders/source-client.js';
import { fulfillmentExpiryInstant } from '../../src/pages/fulfillment/expiry-alerts.js';
import { checkInSchema } from '../../src/pages/administration/api.js';
import { z } from 'zod';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const built = resolve(root, 'frontend/dist');
const calls: { method: string; path: string; date: string | null; status: number }[] = [];
const checks: string[] = [];
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
          date: requested.searchParams.get('date'),
          status: response.statusCode || 500,
        });
        outgoing.writeHead(response.statusCode || 500, response.headers);
        response.pipe(outgoing);
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
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
  };
  outgoing.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
  outgoing.end(readFileSync(file));
});
await new Promise<void>((done) => web.listen(0, '127.0.0.1', done));
const address = web.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
let fixture: Awaited<ReturnType<typeof remindersFixture>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const expiryPath = '/api/v1/stores/1/fulfillment/expiry-alerts';
const financePath = '/api/v1/stores/1/day-closes';
const nagPath = '/api/v1/stores/1/day-close-prompt';
const expiryDialog = (page: Page) =>
  page.getByRole('dialog', { name: /orders expiring soon|urgent: action required/i });
const nagDialog = (page: Page) =>
  page.getByRole('dialog', { name: /day close pending|day close needs redoing/i });
const expiryReply = (page: Page) =>
  page.waitForResponse(
    (response) => new URL(response.url()).pathname === expiryPath && response.status() === 200,
  );
async function visibility(page: Page, visible: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: value ? 'visible' : 'hidden',
    });
    Object.defineProperty(document, 'hidden', { configurable: true, value: !value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visible);
}
try {
  fixture = await remindersFixture(
    process.env.GLOBAL_REMINDERS_MYSQL_URL || '',
    origin,
    process.argv[2] || '',
  );
  apiOrigin = fixture.apiOrigin;
  const source = await fixture.sourceExpiry();
  const sourceScripts = sourceClientEvidence(process.argv[2] || '', source.body, fixtureNow);
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(chrome) ? chrome : undefined),
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  async function context(timeZone = 'UTC'): Promise<BrowserContext> {
    assert(browser && fixture);
    const value = await browser.newContext({ serviceWorkers: 'block', timezoneId: timeZone });
    await value.addCookies([fixture.accounts[0]!.cookie]);
    return value;
  }
  async function open(
    value: BrowserContext,
    forceVisible = false,
    checkinHistory = false,
  ): Promise<Page> {
    const page = await value.newPage();
    await page.clock.setFixedTime(fixtureNow);
    if (forceVisible)
      await page.addInitScript(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          value: 'visible',
        });
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      });
    if (checkinHistory)
      await page.addInitScript(() => {
        if (location.pathname !== '/shortcut-reference') return;
        history.replaceState({ idx: 0 }, '', '/check-in');
        history.pushState({ idx: 1 }, '', '/shortcut-reference');
      });
    await page.goto(origin + '/shortcut-reference');
    await expect(
      page.getByRole('heading', { name: 'Shortcut reference.', exact: true }),
    ).toBeVisible();
    return page;
  }
  async function benignReadWhileOpen(page: Page, kind: 'expiry' | 'day-close') {
    const modal = kind === 'expiry' ? expiryDialog(page) : nagDialog(page);
    const element = await modal.elementHandle();
    assert(element);
    const stampBefore = await page.evaluate(() =>
      localStorage.getItem('pos-day-close-reminder:["1","1"]'),
    );
    const currentTime = await page.evaluate(() => Date.now());
    const read = page.waitForResponse(
      (reply) =>
        new URL(reply.url()).pathname === '/api/v1/operators/me/check-in' && reply.status() === 200,
    );
    await page.clock.setFixedTime(currentTime + 11000);
    await page.goBack();
    await read;
    // A real subsequent expiry cycle lets the successful authority read publish.
    await expiryReply(page);
    assert(
      await element.evaluate(
        (node) => node instanceof HTMLDialogElement && node.isConnected && node.open,
      ),
      'Benign successful authority reads must retain the existing open dialog',
    );
    assert.equal(
      await page.evaluate(() => localStorage.getItem('pos-day-close-reminder:["1","1"]')),
      stampBefore,
      'Benign authority reads must not re-stamp the day-close snooze',
    );
  }

  const first = await context('America/Los_Angeles');
  const response = await first.request.get(origin + expiryPath, {
    headers: { 'X-Operator-Id': '1' },
  });
  assert.equal(response.status(), 200);
  const native = expirySchema.parse((await response.json()) as unknown);
  assert.deepEqual(
    native.expiringSoon.map((item) => ({
      orderId: item.orderId,
      type: item.type,
      expiresAt: item.expiresAt.replace('T', ' '),
    })),
    source.body.expiring_soon.map((item) => ({
      orderId: String(item.order_id),
      type: item.type,
      expiresAt: item.expires_at.replace('T', ' '),
    })),
  );
  assert.deepEqual(native.bannerCounts, source.body.banner_counts);
  assert.equal(native.pollIntervalMs, 5000);
  assert.equal(native.businessTimeZone, 'Asia/Kolkata');
  const page = await open(first, false, true);
  await expect(expiryDialog(page)).toBeVisible();
  await expect(expiryDialog(page).getByRole('listitem')).toHaveCount(2);
  await expect(expiryDialog(page)).toContainText('Accept 1 order(s)');
  await expect(expiryDialog(page)).toContainText(
    '1 order(s) will be automatically marked as packed',
  );
  await benignReadWhileOpen(page, 'expiry');
  checks.push('benign-native-authority-read-retains-open-expiry-dialog');
  await expiryDialog(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(
    page.getByRole('link', {
      name: 'Server check-in: Checked in at Reminder store 1',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Account type', { exact: true })).toHaveText('In-House');
  checks.push('global-native-checked-in-store-context-and-in-house-account-label');
  await page.reload();
  await expect(
    page.getByRole('complementary', { name: 'Fulfillment status', exact: true }),
  ).toBeVisible();
  const repeated = expiryReply(page);
  await repeated;
  await expect(expiryDialog(page)).toHaveCount(0);
  await fixture.expiry(4);
  await page.reload();
  await expect(
    page.getByRole('dialog', { name: 'Urgent: action required', exact: true }),
  ).toBeVisible();
  await expiryDialog(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await fixture.expiry(null);
  await expiryReply(page);
  await expect(
    page.getByRole('complementary', { name: 'Fulfillment status', exact: true }),
  ).toHaveCount(0);
  const seen = await page.evaluate(
    () =>
      Object.keys(
        JSON.parse(localStorage.getItem('pos-fulfillment-expiry-seen:["1","1"]') || '{}') as Record<
          string,
          unknown
        >,
      ).length,
  );
  assert.equal(seen, 0);
  checks.push(
    'pinned-django-native-http-global-off-route-grouped-30-to-5-dedup-reload-cleanup-host-LA',
  );
  await first.close();

  await fixture.expiry(4);
  await fixture.dayClose('CLOSED');
  const tabs = await context();
  const pages = await Promise.all([open(tabs, true), open(tabs, true)]);
  for (const item of pages)
    assert.equal(await item.evaluate(() => document.visibilityState), 'visible');
  await expect
    .poll(async () =>
      (await Promise.all(pages.map((item) => expiryDialog(item).count()))).reduce(
        (a, b) => a + b,
        0,
      ),
    )
    .toBe(1);
  for (const item of pages)
    if (await expiryDialog(item).count())
      await expiryDialog(item).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await Promise.all(pages.map((item) => expiryReply(item)));
  assert.equal(
    (await Promise.all(pages.map((item) => expiryDialog(item).count()))).reduce((a, b) => a + b, 0),
    0,
  );
  checks.push('native-cross-tab-web-lock-dedup-no-second-window-warning');
  await tabs.close();

  await fixture.expiry(null);
  await fixture.dayClose('STALE');
  const financial = await context();
  const financialPage = await open(financial, false, true);
  await expect(nagDialog(financialPage)).toBeVisible();
  await expect(nagDialog(financialPage)).toContainText(fixtureDay);
  await benignReadWhileOpen(financialPage, 'day-close');
  checks.push('benign-native-authority-read-retains-open-day-close-dialog-without-resnooze');
  await fixture.expiry(4);
  await expiryReply(financialPage);
  await expect(expiryDialog(financialPage)).toHaveCount(0);
  await expect(financialPage.locator('dialog[open]')).toHaveCount(1);
  await nagDialog(financialPage).getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(expiryDialog(financialPage)).toBeVisible();
  await expect(financialPage.locator('dialog[open]')).toHaveCount(1);
  await expiryDialog(financialPage).getByRole('button', { name: 'Dismiss', exact: true }).click();
  checks.push(
    'native-day-close-financial-reminder-keeps-priority-over-urgent-expiry-until-dismissal',
  );
  await financial.close();

  await fixture.expiry(null);
  await fixture.dayClose('STALE');
  const snooze = await context();
  const snoozePage = await snooze.newPage();
  await snoozePage.clock.setFixedTime(fixtureNow);
  await snoozePage.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  });
  let ownNagReads = 0;
  const requestVisibility: { visibility: string; hidden: boolean }[] = [];
  snoozePage.on('request', (request) => {
    if (new URL(request.url()).pathname === nagPath) {
      ownNagReads++;
      void snoozePage
        .evaluate(() => ({ visibility: document.visibilityState, hidden: document.hidden }))
        .then((value) => requestVisibility.push(value))
        .catch(() => undefined);
    }
  });
  await snoozePage.goto(origin + '/shortcut-reference');
  await expect(
    snoozePage.getByRole('heading', { name: 'Shortcut reference.', exact: true }),
  ).toBeVisible();
  await expiryReply(snoozePage);
  const hiddenState = await snoozePage.evaluate(() => ({
    visibility: document.visibilityState,
    hidden: document.hidden,
  }));
  assert.equal(
    hiddenState.visibility,
    'hidden',
    'Visibility seam must still be hidden after native App initialization',
  );
  assert.equal(
    ownNagReads,
    0,
    'Hidden page must not issue its own day-close prompt read: ' +
      JSON.stringify(requestVisibility),
  );
  await visibility(snoozePage, true);
  await expect(nagDialog(snoozePage)).toBeVisible();
  await snoozePage.clock.setFixedTime(fixtureNow + 30000);
  await nagDialog(snoozePage).getByRole('button', { name: 'Not now', exact: true }).click();
  const dismissedAt = await snoozePage.evaluate(() =>
    Number(localStorage.getItem('pos-day-close-reminder:["1","1"]')),
  );
  const beforeSnoozed = ownNagReads;
  await snoozePage.clock.setFixedTime(dismissedAt + 30000);
  await visibility(snoozePage, true);
  await expect(nagDialog(snoozePage)).toHaveCount(0);
  assert.equal(ownNagReads, beforeSnoozed);
  await snoozePage.clock.setFixedTime(dismissedAt + 60001);
  await visibility(snoozePage, true);
  await expect(nagDialog(snoozePage)).toBeVisible();
  await nagDialog(snoozePage).getByRole('link', { name: 'Close the day now', exact: true }).click();
  await expect(snoozePage).toHaveURL(origin + '/day-close?date=' + fixtureDay);
  await expect(snoozePage.getByLabel('Business date', { exact: true })).toHaveValue(fixtureDay);
  await expect(
    snoozePage.getByRole('heading', { name: 'Cash reconciliation', exact: true }),
  ).toBeVisible();
  assert(
    calls.some(
      (call) => call.path === financePath && call.date === fixtureDay && call.status === 200,
    ),
  );
  checks.push('native-foreground-only-full-dismiss-snooze-and-server-date-navigation');
  for (const search of ['?date=2026-02-30', '?date=2026-11-18&date=2026-11-17']) {
    const before = calls.filter((call) => call.path === financePath).length;
    await snoozePage.goto(origin + '/day-close' + search);
    await expect(
      snoozePage.getByText('Choose a valid business date.', { exact: true }),
    ).toBeVisible();
    const refresh = snoozePage.getByRole('button', { name: 'Refresh figures', exact: true });
    await expect(refresh).toBeDisabled();
    await refresh.click({ force: true });
    assert.equal(calls.filter((call) => call.path === financePath).length, before);
  }
  checks.push(
    'actual-app-invalid-duplicate-calendar-query-and-manual-refresh-send-no-finance-http',
  );
  await snooze.close();

  await fixture.expiry(4);
  await fixture.dayClose('CLOSED');
  const restoredScope = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'UTC' });
  await restoredScope.addCookies([fixture.accounts[1]!.cookie]);
  const restoredPage = await open(restoredScope, true);
  await expect(expiryDialog(restoredPage)).toBeVisible();
  await expiryDialog(restoredPage).getByRole('button', { name: 'Dismiss', exact: true }).click();
  const checkinPath = '/api/v1/operators/me/check-in';
  const originalAuthority = z
    .object({ data: checkInSchema })
    .parse((await (await restoredScope.request.get(origin + checkinPath)).json()) as unknown).data;
  let successfulExpiryReads = 0,
    ownRestoredNagReads = 0;
  restoredPage.on('response', (reply) => {
    if (new URL(reply.url()).pathname === expiryPath && reply.status() === 200)
      successfulExpiryReads++;
  });
  restoredPage.on('request', (read) => {
    if (new URL(read.url()).pathname === nagPath) ownRestoredNagReads++;
  });
  const rejectedExpiry = restoredPage.waitForResponse(
    (reply) => new URL(reply.url()).pathname === expiryPath && reply.status() === 403,
  );
  await fixture.assignment('2', '1', false);
  await rejectedExpiry;
  await expect(
    restoredPage.getByRole('complementary', { name: 'Fulfillment status', exact: true }),
  ).toHaveCount(0);
  const rejectedNag = restoredPage.waitForResponse(
    (reply) => new URL(reply.url()).pathname === nagPath && reply.status() === 403,
  );
  await visibility(restoredPage, true);
  await rejectedNag;
  await fixture.assignment('2', '1', true);
  await fixture.dayClose('STALE');
  const expiryReadsBeforeRecovery = successfulExpiryReads;
  const nagReadsBeforeRecovery = ownRestoredNagReads;
  const now = await restoredPage.evaluate(() => Date.now());
  await restoredPage.clock.setFixedTime(now + 11000);
  const freshAuthority = restoredPage.waitForResponse(
    (reply) => new URL(reply.url()).pathname === checkinPath && reply.status() === 200,
  );
  await restoredPage.getByRole('link', { name: 'Store check-in', exact: true }).click();
  const fresh = await freshAuthority;
  const verifiedAuthority = z
    .object({ data: checkInSchema })
    .parse((await fresh.json()) as unknown).data;
  assert.deepEqual(
    verifiedAuthority,
    originalAuthority,
    'Fresh authoritative read must retain the exact check-in record',
  );
  await visibility(restoredPage, true);
  const recovery = await Promise.allSettled([
    expect.poll(() => successfulExpiryReads).toBeGreaterThan(expiryReadsBeforeRecovery),
    expect.poll(() => ownRestoredNagReads).toBeGreaterThan(nagReadsBeforeRecovery),
  ]);
  await restoredScope.close();
  assert(
    recovery.every((result) => result.status === 'fulfilled'),
    'Fresh unchanged check-in must resume expiry and day-close reminders after assignment restoration: ' +
      JSON.stringify({ expiry: recovery[0]?.status, dayClose: recovery[1]?.status }),
  );
  checks.push(
    'same-record-fresh-native-authority-restores-both-global-reminders-after-scope-regrant',
  );

  await fixture.expiry(4);
  await fixture.dayClose('CLOSED');
  const authority = await context();
  const authorityPage = await open(authority);
  await expect(expiryDialog(authorityPage)).toBeVisible();
  await fixture.checkIn('1', '2');
  const forbidden = await authority.request.get(origin + expiryPath, {
    headers: { 'X-Operator-Id': '1' },
  });
  assert.equal(forbidden.status(), 403);
  await authorityPage.reload();
  await expect(
    authorityPage.getByRole('link', {
      name: 'Server check-in: Checked in at Reminder store 2',
      exact: true,
    }),
  ).toBeVisible();
  await expect(expiryDialog(authorityPage)).toHaveCount(0);
  await expect(
    authorityPage.getByRole('complementary', { name: 'Fulfillment status', exact: true }),
  ).toHaveCount(0);
  await fixture.archive('1');
  await authorityPage.reload();
  await expect(
    authorityPage.getByRole('heading', { name: 'Let’s open the store.', exact: true }),
  ).toBeVisible();
  await expect(authorityPage.locator('dialog[open]')).toHaveCount(0);
  await authority.close();
  checks.push(
    'native-current-checkin-store-and-archived-authentication-hide-private-global-alerts',
  );

  assert.equal(
    fulfillmentExpiryInstant('2026-11-18 17:50:00', 'Asia/Kolkata'),
    Date.parse('2026-11-18T12:20:00Z'),
  );
  assert.equal(
    fulfillmentExpiryInstant('2026-11-18 17:50:00', 'UTC'),
    Date.parse('2026-11-18T17:50:00Z'),
  );
  assert.equal(fulfillmentExpiryInstant('2026-11-01 01:30:00', 'America/New_York'), null);
  assert.equal(fulfillmentExpiryInstant('2026-03-08 02:30:00', 'America/New_York'), null);
  assert.equal(fulfillmentExpiryInstant('2026-02-30 12:00:00', 'Asia/Kolkata'), null);
  checks.push('explicit-business-zone-UTC-IST-and-invalid-ambiguous-DST-wall-time-boundaries');
  assert(
    calls.every(
      (call) => !/(?:cash-completions|refund|payments|order-submissions)/.test(call.path),
    ),
  );
  assert(calls.every((call) => !call.path.includes('/day-closes') || call.method === 'GET'));
  process.stdout.write(
    JSON.stringify({
      sourceCommit: source.sourceCommit,
      sourceRouteId: source.routeId,
      sourceHashes: { ...source.hashes, ...sourceScripts.hashes },
      sourceScriptChecks: sourceScripts.checks,
      checks,
      boundaries: [
        'Node Date-only clock fixed; timers/network/native SQL and actual services remain real.',
        'Browser Date/visibility seams explicit. No HTTP response fulfillment or principal/session-cache injection.',
        'Financial modal priority covers the actual global day-close reminder, not checkout/payment completion.',
        'No whole-base/template or full finance/fulfillment route certification.',
      ],
    }) + '\n',
  );
} finally {
  await browser?.close();
  await fixture?.close();
  await new Promise<void>((done, reject) => web.close((error) => (error ? reject(error) : done())));
}
