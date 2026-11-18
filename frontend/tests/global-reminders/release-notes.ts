/** Targeted informational UI proof on real native sessions and the actual built App.
 * Fixed Date preserves the fixture epoch across navigation despite Node Date mocking.
 * Real timers, native authentication and the original assertion limits remain intact.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page } from '@playwright/test';
import { z } from 'zod';
import {
  expirySchema,
  fixtureNow,
  remindersFixture,
} from '../../../backend/tools/global-reminders/native.js';
import { nativeUiServer } from '../../../backend/tools/global-reminders/native-ui-server.js';
import { goldenSpawnResult } from '../golden/load.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const originalSchema = z.object({
  sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
  sourceHashes: z.record(z.string(), z.string()),
  roles: z.array(
    z.object({
      role: z.number(),
      mappings: z.array(z.array(z.string()).length(2)).length(3),
      headings: z.array(z.string()),
      reportNote: z.boolean(),
      updated: z.string(),
      dateTime: z.string(),
      newBadge: z.boolean(),
      renderSha256: z.string(),
    }),
  ),
});
// Captured from tools/global-reminders/source-release-notes.py at the pinned source.
const rendered = goldenSpawnResult('global-reminders', 'release-notes');
assert.equal(rendered.status, 0, 'Pinned release-notes partial must render');
const original = originalSchema.parse(JSON.parse(rendered.stdout) as unknown);
const web = await nativeUiServer(resolve(root, 'frontend/dist'));
let fixture: Awaited<ReturnType<typeof remindersFixture>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const checks: string[] = [];
const notes = (page: Page) => page.getByRole('dialog', { name: 'What’s New', exact: true });
const trigger = (page: Page) => page.getByRole('button', { name: /what.s new/i });
const expiryPath = '/api/v1/stores/1/fulfillment/expiry-alerts';
try {
  fixture = await remindersFixture(
    process.env.GLOBAL_REMINDERS_MYSQL_URL || '',
    web.origin,
    process.argv[2] || '',
  );
  web.attach(fixture.apiOrigin);
  await fixture.expiry(null);
  await fixture.dayClose('CLOSED');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(chrome) ? chrome : undefined),
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  for (const account of fixture.accounts) {
    const context = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'UTC' });
    await context.addCookies([account.cookie]);
    const page = await context.newPage();
    await page.clock.setFixedTime(fixtureNow);
    await page.goto(web.origin + '/shortcut-reference');
    await expect(
      page.getByRole('heading', { name: 'Shortcut reference.', exact: true }),
    ).toBeVisible();
    const session = await context.request.get(web.origin + '/api/v1/auth/sessions/current');
    assert.equal(session.status(), 200);
    const native = z
      .object({ user: z.object({ role: z.number() }) })
      .parse((await session.json()) as unknown);
    assert.equal(native.user.role, account.user.role);
    const source = original.roles.find((value) => value.role === native.user.role);
    assert(source);
    await expect(trigger(page).getByText('New', { exact: true })).toBeVisible();
    await trigger(page).click();
    await expect(notes(page)).toBeVisible();
    const mapping = await notes(page)
      .locator('tbody tr')
      .evaluateAll((rows) =>
        rows.map((row) =>
          Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent?.trim() || ''),
        ),
      );
    assert.deepEqual(mapping, source.mappings);
    await expect(notes(page).locator('time')).toHaveText(source.updated);
    await expect(notes(page).locator('time')).toHaveAttribute('datetime', source.dateTime);
    const report = notes(page).getByRole('heading', {
      name: '“Cashier Performance” is now “Staff Performance”',
      exact: true,
    });
    if (source.reportNote) await expect(report).toBeVisible();
    else await expect(report).toHaveCount(0);
    assert(await notes(page).evaluate((element) => element.contains(document.activeElement)));
    for (const action of ['Close', 'Got it', 'Escape'] as const) {
      if (action === 'Escape') await page.keyboard.press('Escape');
      else await notes(page).getByRole('button', { name: action, exact: true }).click();
      await expect(notes(page)).toHaveCount(0);
      await expect(trigger(page)).toBeFocused();
      await expect(trigger(page).getByText('New', { exact: true })).toBeVisible();
      if (action !== 'Escape') await trigger(page).click();
    }
    await page.reload();
    await expect(trigger(page).getByText('New', { exact: true })).toBeVisible();
    checks.push(
      `native-role-${native.user.role}-source-mappings-report-policy-date-controls-focus-new-persists`,
    );
    await context.close();
  }

  const priority = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'UTC' });
  await priority.addCookies([fixture.accounts[0]!.cookie]);
  const page = await priority.newPage();
  await page.clock.setFixedTime(fixtureNow);
  await page.goto(web.origin + '/shortcut-reference');
  await trigger(page).click();
  await expect(notes(page)).toBeVisible();
  const expiry = page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== expiryPath || response.status() !== 200) return false;
    const body = expirySchema.safeParse((await response.json()) as unknown);
    return body.success && body.data.expiringSoon.length === 2;
  });
  await fixture.expiry(4);
  await expiry;
  await expect(page.locator('.fulfillment-global-banner')).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(notes(page)).toBeVisible();
  await notes(page).getByRole('button', { name: 'Close', exact: true }).click();
  const urgent = page.getByRole('dialog', { name: 'Urgent: action required', exact: true });
  await expect(urgent).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await urgent.getByRole('button', { name: 'Dismiss', exact: true }).click();
  checks.push('native-release-notes-block-urgent-expiry-until-closed');

  await fixture.expiry(null);
  await fixture.dayClose('CLOSED');
  const nagPath = '/api/v1/stores/1/day-close-prompt';
  const initialNag = page.waitForResponse(
    (response) => new URL(response.url()).pathname === nagPath && response.status() === 200,
  );
  await page.reload();
  await initialNag;
  await trigger(page).click();
  await expect(notes(page)).toBeVisible();
  await fixture.dayClose('STALE');
  const nag = page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== nagPath || response.status() !== 200) return false;
    const body = z
      .object({ prompt: z.literal(true), status: z.literal('STALE') })
      .safeParse((await response.json()) as unknown);
    return body.success;
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await nag;
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(notes(page)).toBeVisible();
  assert.equal(
    await page.evaluate(() => localStorage.getItem('pos-day-close-reminder:["1","1"]')),
    null,
  );
  await notes(page).getByRole('button', { name: 'Got it', exact: true }).click();
  const dayClose = page.getByRole('dialog', { name: 'Day close needs redoing', exact: true });
  await expect(dayClose).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await dayClose.getByRole('button', { name: 'Not now', exact: true }).click();
  await priority.close();
  checks.push('native-release-notes-block-day-close-without-consuming-snooze-before-display');
  assert(
    web.calls.every((call) => ['GET', 'HEAD', 'OPTIONS'].includes(call.method)),
    'Release-note actions must not dispatch HTTP mutations',
  );
  checks.push('no-http-mutation-for-informational-controls');
  process.stdout.write(
    JSON.stringify({
      sourceCommit: original.sourceCommit,
      sourceHashes: original.sourceHashes,
      sourceRolePolicy: original.roles.map((value) => ({
        role: value.role,
        reportNote: value.reportNote,
        newBadge: value.newBadge,
      })),
      checks,
      scope:
        'Targeted informational partial/native App proof only; no whole-template/report-data/financial workflow certification.',
    }) + '\n',
  );
} finally {
  await browser?.close();
  await fixture?.close();
  await web.close();
}
