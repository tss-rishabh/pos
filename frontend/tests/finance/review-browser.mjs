import { existsSync } from 'node:fs';
// Actual production pages with controlled same-origin HTTP state, not native financial parity.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
const split = {
  system: '0',
  actual: '0',
  manual_punched: '0',
  manual_created: '0',
  difference: '0',
  reason: '',
  comment: '',
};
const close = {
  version: 2,
  status: 'CLOSED',
  closed_at: '2026-11-18 22:01',
  closed_by_id: '1',
  stale_reason: null,
  stale_trigger_ref: null,
  cash: { ...split, refund: '0' },
  card: { ...split },
  banking_amount: '0',
};
const state = {
  store_id: '1',
  close_date: '2026-11-18',
  tolerance: '0',
  window: {
    state: 'OPEN',
    allowed: true,
    override: null,
    message: '',
    opens_at: '',
    closes_at: '',
  },
  system: {
    order_count: 0,
    cash: '0',
    cash_refund: '0',
    card_upi: '2',
    online_other: '3',
    total_online: '5',
    district: '7',
    total_collection: '12',
  },
  close: null,
};
let mode = 'fresh',
  submissions = [],
  saved = null,
  lookups = 0;
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir: `/tmp/pos-finance-review-vite-${process.pid}`,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'bounded-finance-http-fixture',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/api/')) return next();
          res.setHeader('Content-Type', 'application/json');
          const reply = (body, status = 200) => {
            res.statusCode = status;
            res.end(JSON.stringify(body));
          };
          if (req.url.startsWith('/api/v1/reports/store-cash-balances/stores'))
            return reply({
              data: [
                { id: '1', name: 'Store One' },
                { id: '2', name: 'Store Two' },
              ],
            });
          if (req.url.startsWith('/api/v1/finance/day-close-commands/')) {
            lookups++;
            return reply({ data: saved });
          }
          if (req.method === 'POST') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString());
            submissions.push(body);
            saved = {
              ...close,
              version: body.expectedVersion + 1,
              cash: { ...split, refund: '0', actual: body.entries.cash_actual },
              card: { ...split, actual: body.entries.card_actual },
              banking_amount: body.entries.banking_amount,
            };
            if (mode === 'lost')
              return reply(
                { error: { code: 'FIXTURE_LOST_REPLY', message: 'Fixture reply lost' } },
                503,
              );
            return reply({ data: saved }, 201);
          }
          if (req.url.startsWith('/api/v1/stores/1/day-closes'))
            return reply({
              ...state,
              close:
                saved ||
                (mode === 'revision'
                  ? close
                  : mode === 'stale'
                    ? {
                        ...close,
                        status: 'STALE',
                        stale_reason: 'REFUND',
                        stale_trigger_ref: 'fixture-order-ref',
                      }
                    : null),
            });
          reply(
            { error: { code: 'UNEXPECTED_FIXTURE_READ', message: 'Unexpected fixture read' } },
            404,
          );
        });
      },
    },
  ],
});
await server.listen();
const address = server.httpServer.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
});
const open = async (nextMode) => {
  mode = nextMode;
  submissions = [];
  saved = null;
  lookups = 0;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin + '/tests/finance/review.html');
  await expect(page.getByRole('heading', { name: 'Cash reconciliation' })).toBeVisible();
  return { context, page };
};
const fill = async (page) => {
  await page.getByLabel('Actual cash', { exact: true }).fill('0');
  await page.getByLabel('Actual card / UPI', { exact: true }).fill('5');
  await page.getByLabel('Amount banked', { exact: true }).fill('0');
  for (const kind of ['cash', 'card'])
    for (const name of ['punched', 'created'])
      await page.getByLabel(`Manual bills ${name} (${kind})`, { exact: true }).fill('0');
};
try {
  let { context, page } = await open('fresh');
  for (const kind of ['cash', 'card'])
    for (const name of ['punched', 'created'])
      await expect(page.getByLabel(`Manual bills ${name} (${kind})`, { exact: true })).toHaveValue(
        '',
      );
  await expect(page.getByText('Card / UPI ₹2 · Other online ₹3 · District ₹7')).toBeVisible();
  await page.getByLabel('Actual cash', { exact: true }).fill('0');
  await page.getByLabel('Actual card / UPI', { exact: true }).fill('5');
  await page.getByLabel('Amount banked', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Close this day' }).click();
  assert.equal(submissions.length, 0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await fill(page);
  await page.getByRole('button', { name: 'Close this day' }).click();
  let dialog = page.getByRole('dialog', { name: 'File this close?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Tallied');
  assert.equal(submissions.length, 0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Actual card / UPI', { exact: true })).toHaveValue('5');
  assert.equal(submissions.length, 0);
  await page.getByRole('button', { name: 'Close this day' }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  assert.equal(submissions.length, 0);
  await page.getByRole('button', { name: 'Close this day' }).click();
  await page.getByRole('button', { name: 'File close', exact: true }).click();
  await expect(page.getByText('Closed · version 1')).toBeVisible();
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].expectedVersion, 0);
  assert.equal(submissions[0].entries.card_actual, '5');
  await context.close();
  ({ context, page } = await open('fresh'));
  await fill(page);
  await page.evaluate(() => {
    const other = document.createElement('dialog');
    other.id = 'existing-financial-dialog';
    document.body.append(other);
    other.showModal();
    document.querySelector('form').requestSubmit();
  });
  assert.equal(await page.locator('dialog[open]').count(), 1);
  assert.equal(submissions.length, 0);
  await page.evaluate(() => document.getElementById('existing-financial-dialog').remove());
  await expect(page.getByRole('dialog', { name: 'File this close?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(submissions.length, 0);
  await context.close();
  ({ context, page } = await open('revision'));
  await expect(page.getByLabel('Manual bills created (cash)', { exact: true })).toHaveValue('0');
  await fill(page);
  await page.getByRole('button', { name: 'Submit revision' }).click();
  dialog = page.getByRole('dialog', { name: 'Revise this close?' });
  await expect(dialog).toContainText('the original is kept');
  await dialog.getByRole('button', { name: 'Yes, revise' }).click();
  await expect(page.getByText('Closed · version 3')).toBeVisible();
  assert.equal(submissions[0].expectedVersion, 2);
  await context.close();
  ({ context, page } = await open('stale'));
  await expect(page.getByText(/Signed at.*attempt 2/)).toContainText(
    'a cash refund was paid out (order fixture-order-ref)',
  );
  await context.close();
  ({ context, page } = await open('lost'));
  await fill(page);
  await page.getByRole('button', { name: 'Close this day' }).click();
  await page.getByRole('button', { name: 'File close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check submission' })).toBeVisible();
  assert.equal(submissions.length, 1);
  await page.getByRole('button', { name: 'Check submission' }).click();
  await expect(page.getByText('Closed · version 1')).toBeVisible();
  assert.equal(lookups, 1);
  assert.equal(submissions.length, 1);
  await context.close();
  context = await browser.newContext();
  page = await context.newPage();
  await page.clock.install({ time: new Date('2026-11-18T23:59:00+05:30') });
  await page.goto(origin + '/tests/finance/review.html?reports=1');
  await page.getByRole('button', { name: 'Stores', exact: true }).click();
  await expect(
    page.getByRole('group', { name: 'Stores', exact: true }).getByRole('checkbox'),
  ).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Report from date')).toHaveValue('2026-11-13');
  await expect(page.getByLabel('Report to date')).toHaveValue('2026-11-19');
  await page.getByRole('button', { name: 'Select all stores' }).click();
  await page.getByRole('button', { name: 'Stores', exact: true }).click();
  const storeBoxes = page.getByRole('group', { name: 'Stores', exact: true }).getByRole('checkbox');
  await expect(storeBoxes.nth(0)).toBeChecked();
  await expect(storeBoxes.nth(1)).toBeChecked();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Clear all stores' }).click();
  await expect(page.getByRole('button', { name: 'View report' })).toBeDisabled();
  await context.close();
  console.log(
    'PASS: actual finance/report pages: explicit declarations, cancel/Escape, signed revision, stale cause/ref, online split, one-POST lost reply recovery, midnight defaults and bulk selection. Controlled HTTP fixture; no native parity claim.',
  );
} finally {
  await browser.close();
  await server.close();
}
