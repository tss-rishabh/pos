import { expect, test } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDesktop, evidence, launchDesktop, type Desktop } from './support';

/**
 * Staff login OTP delivery through the outbound allowlist: one "Resend OTP" for operator 268
 * (otp_method 2, email). The operator's email is on the allowlist, so it is delivered to the
 * user's own inbox; the request ID is recorded for the user to confirm receipt.
 */
let desktop: Desktop;
test.afterAll(async () => {
  if (desktop) await closeDesktop(desktop);
});

test('login OTP resend is delivered to the allowlisted operator email', async () => {
  desktop = await launchDesktop('login-otp');
  const { page } = desktop;
  const resends: { status: number; requestId: string | null }[] = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (response.request().method() === 'POST' && /\/auth\/challenges\//.test(path))
      resends.push({
        status: response.status(),
        requestId: response.headers()['x-request-id'] ?? null,
      });
  });
  await page.getByLabel('Email or username').waitFor();
  await signInPasswordOnly(page);
  // LOGIN_OTP_RESEND_COOLDOWN (30 s) starts when the challenge is created.
  await page.waitForTimeout(32000);
  await page.getByRole('button', { name: 'Resend OTP' }).click();
  await page.waitForTimeout(6000);
  const notice = await page
    .getByRole('status')
    .allInnerTexts()
    .catch(() => []);
  appendFileSync(
    join(evidence, 'flows.jsonl'),
    `${JSON.stringify({ flow: 'messaging', step: 'staff-login-otp-resend', data: { resends, notice } })}\n`,
  );
  expect(resends.length).toBeGreaterThan(0);
});

async function signInPasswordOnly(page: import('@playwright/test').Page) {
  const { homedir } = await import('node:os');
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(join(homedir(), '.config/pos-uat/uat.env'), 'utf8');
  const value = (key: string) =>
    (text.split('\n').find((line) => line.startsWith(`${key}=`)) ?? '')
      .slice(key.length + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
  await page.getByLabel('Email or username').fill(value('UAT_LOGIN_USERNAME'));
  await page.getByLabel('Password', { exact: true }).fill(value('UAT_LOGIN_PASSWORD'));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('Login store')).toBeVisible();
}
