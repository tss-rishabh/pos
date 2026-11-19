import { expect, test } from '@playwright/test';
import { recordApi, shot, signIn, workspace } from './support';

/**
 * Web client (Chromium, no Electron) against the same UAT backend: sign in to store 7 and open
 * the finance day-close page. The backend runs with the UAT value COMMON_GROUP_ALERT_ON=1, which
 * stopped API start-up before the finance alert-option fix (dbd36fde).
 */
test('web: sign in on UAT and open day close (finance alert options parse "1")', async ({
  page,
}) => {
  recordApi(page, 'web');
  await page.goto(workspace + '/');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
  await page.goto(workspace + '/day-close');
  await expect(page.getByRole('heading', { name: 'Day close.' })).toBeVisible();
  await expect(page.getByText('Cash reconciliation')).toBeVisible();
  await shot(page, '10-web-day-close');
});
