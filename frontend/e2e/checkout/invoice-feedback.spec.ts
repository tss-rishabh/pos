import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const directory = resolve('../backend/compatibility/upstream/invoice-security'),
  contract = 'pos-feedback-proof-v1';
function proof() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url'),
    iat = Math.floor(Date.now() / 1000),
    content = `${encode({ alg: 'HS256', typ: 'JWT', kid: 'browser-fixture' })}.${encode({
      v: 1,
      iss: 'pos-invoice',
      aud: 'tss-pos-feedback',
      purpose: 'nps',
      type: 'nps',
      order_id: '9007199254740993',
      iat,
      exp: iat + 3600,
      jti: '1'.repeat(32),
    })}`;
  return (
    content +
    '.' +
    createHmac('sha256', 'not-a-live-key-browser-feedback-only').update(content).digest('base64url')
  );
}
async function assets(page: Page) {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.route('**/invoice-feedback*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = path.endsWith('.js')
      ? 'feedback-client.js'
      : path.endsWith('.css')
        ? 'feedback.css'
        : 'feedback.html';
    return route.fulfill({
      contentType: file.endsWith('.js')
        ? 'application/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html',
      headers: {
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      },
      body: await readFile(resolve(directory, file), 'utf8'),
    });
  });
  return failures;
}
test('consumes a fragment-only feedback capability without cookies, storage, URL secrets or HTML injection', async ({
  page,
  context,
}) => {
  const failures = await assets(page),
    token = proof(),
    seen: { method: string; url: string; body: unknown }[] = [];
  await context.addCookies([
    {
      name: 'operator-cookie-canary',
      value: 'PRIVATE-OPERATOR-COOKIE',
      domain: 'localhost',
      path: '/',
      httpOnly: true,
    },
  ]);
  await page.route('**/api/v1/post-order/nps/new-feedback**', async (route) => {
    const request = route.request();
    expect(request.headers().authorization).toBe(token);
    expect(request.headers()['x-pos-feedback-contract']).toBe(contract);
    expect(request.headers().cookie).toBeUndefined();
    expect(request.headers().referer).toBeUndefined();
    expect(request.url()).not.toContain(token);
    seen.push({
      method: request.method(),
      url: request.url(),
      body: request.postDataJSON() as unknown,
    });
    return route.fulfill({
      headers: { 'X-POS-Feedback-Contract': contract },
      json:
        request.method() === 'GET'
          ? {
              score: null,
              isExclusive: false,
              additionalFeedback: null,
              redirectTo: null,
              options: [
                { id: 1, optionName: 'Service <img src=x onerror=alert(1)>', rating: null },
              ],
            }
          : {
              error: false,
              errorMessage: null,
              redirectTo: 'http://localhost:4173/api/v1/post-order/nps/thank-you',
            },
    });
  });
  await page.goto('/invoice-feedback#feedback_proof=' + token);
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await page.getByLabel('Likelihood of recommending us (1–10)').selectOption('8');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Service <img src=x onerror=alert(1)>', exact: true }),
  ).toBeVisible();
  expect(await page.locator('img').count()).toBe(0);
  await page.locator('[name="option-1"]').selectOption('3');
  await page.getByLabel('Additional feedback', { exact: true }).fill('Private feedback canary');
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Thank you. Your feedback has been received.');
  expect(seen.map((item) => item.method)).toEqual(['GET', 'POST']);
  expect(seen[1]?.body).toEqual({
    score: 8,
    optionsResponses: [{ id: 1, rating: 3 }],
    additionalFeedback: 'Private feedback canary',
  });
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  await page.reload();
  await expect(page.getByRole('status')).toContainText('invalid or expired');
  expect(seen).toHaveLength(2);
  expect(failures).toEqual([]);
});
test('keeps an interrupted feedback submission GET-only and does not claim unproved additional details', async ({
  page,
}) => {
  const failures = await assets(page),
    token = proof();
  let posts = 0,
    reads = 0;
  await page.route('**/api/v1/post-order/nps/new-feedback**', async (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      return route.abort('failed');
    }
    reads++;
    return route.fulfill({
      headers: { 'X-POS-Feedback-Contract': contract },
      json: posts
        ? {
            score: null,
            isExclusive: null,
            additionalFeedback: null,
            options: [],
            redirectTo: 'http://localhost:4173/api/v1/post-order/nps/feedback',
          }
        : {
            score: null,
            isExclusive: false,
            additionalFeedback: null,
            options: [],
            redirectTo: null,
          },
    });
  });
  await page.goto('/invoice-feedback#feedback_proof=' + token);
  await page.getByLabel('Likelihood of recommending us (1–10)').selectOption('9');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Additional feedback', { exact: true }).fill('Do not replay this comment');
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('submission result is unconfirmed');
  await expect(page.getByRole('button', { name: 'Send feedback', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Check submission status', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    'additional details of the interrupted submission could not be confirmed',
  );
  expect(posts).toBe(1);
  expect(reads).toBe(2);
  expect(failures).toEqual([]);
});
test('rejects malformed or expired feedback capabilities and unexpected redirect destinations', async ({
  page,
}) => {
  const failures = await assets(page),
    token = proof();
  let reads = 0;
  await page.route('**/api/v1/post-order/nps/new-feedback**', async (route) => {
    reads++;
    return route.fulfill(
      reads === 1
        ? {
            headers: { 'X-POS-Feedback-Contract': contract },
            json: {
              score: null,
              isExclusive: null,
              additionalFeedback: null,
              options: [],
              redirectTo: 'https://untrusted.example.test/?token=PRIVATE',
            },
          }
        : { status: 401, json: { error: { code: 'FEEDBACK_PROOF_INVALID' } } },
    );
  });
  await page.goto('/invoice-feedback#feedback_proof=' + token + '&feedback_proof=' + token);
  await expect(page.getByRole('status')).toContainText('invalid or expired');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  expect(reads).toBe(0);
  await page.goto('/invoice-feedback#feedback_proof=' + token);
  await page.getByLabel('Likelihood of recommending us (1–10)').selectOption('8');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('could not be loaded');
  expect(new URL(page.url()).pathname).toBe('/invoice-feedback');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('invalid or expired');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  expect(reads).toBe(2);
  expect(failures).toEqual([]);
});
