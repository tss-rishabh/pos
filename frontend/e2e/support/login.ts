import { expect, type Page } from '@playwright/test';

/**
 * The synthetic operator seeded by `backend/tools/e2e/seed.ts` (keep the values in sync).
 * The e2e stack enables the legacy fixed login OTP for this user id only.
 */
export const e2eOperator = {
  id: '900001',
  username: 'e2e-operator',
  password: 'Synthetic-e2e-password-2026',
  otp: '246810',
} as const;

/** Real sign-in through the login page: password step, then OTP and store check-in. */
export async function signIn(page: Page, storeId = '1') {
  await page.getByLabel('Email or username').fill(e2eOperator.username);
  await page.getByLabel('Password', { exact: true }).fill(e2eOperator.password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verify and check in' })).toBeVisible();
  await page.getByLabel('Login store').selectOption(storeId);
  await page.getByLabel('Verification code').fill(e2eOperator.otp);
  await page.getByRole('button', { name: 'Verify & check in' }).click();
}
