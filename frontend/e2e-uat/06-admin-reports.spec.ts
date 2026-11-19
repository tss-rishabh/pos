import { expect, test, type Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeDesktop,
  evidence,
  launchDesktop,
  ledger,
  shot,
  signIn,
  type Desktop,
} from './support';

/**
 * Reports, the export job queue and administration on UAT store 7. The only admin edit is
 * store 7's "Per Hour Threshold", changed by +1 and reverted in the same test.
 */
const note = (flow: string, step: string, data: unknown) =>
  appendFileSync(join(evidence, 'flows.jsonl'), `${JSON.stringify({ flow, step, data })}\n`);
async function go(page: Page, path: string) {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await page.waitForTimeout(4000);
}
const alerts = (page: Page) =>
  page
    .getByRole('alert')
    .allInnerTexts()
    .then((texts) => texts.map((text) => text.replace(/\s+/g, ' ').slice(0, 200)))
    .catch(() => [] as string[]);

let desktop: Desktop;
test.beforeAll(async () => {
  desktop = await launchDesktop('admin-reports');
  await signIn(desktop.page);
  await expect(desktop.page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
});
test.afterAll(async () => {
  if (desktop) await closeDesktop(desktop);
});

test('daily report and cash ledger for store 7', async () => {
  const { page } = desktop;
  await go(page, '/reports');
  await shot(page, '06-daily');
  note('reports', 'daily', {
    alerts: await alerts(page),
    text: (await page.locator('main').innerText()).slice(0, 600),
  });
  await go(page, '/cash-ledger');
  await shot(page, '06-cash-ledger');
  note('finance', 'cash-ledger', { alerts: await alerts(page) });
  await go(page, '/day-close');
  await shot(page, '06-day-close-before');
  note('finance', 'day-close-page', {
    alerts: await alerts(page),
    text: (await page.locator('main').innerText()).slice(0, 1200),
  });
});

test('export through the job queue: order transactions, store 7, today', async () => {
  const { page } = desktop;
  await go(page, '/reports/exports');
  await page
    .getByRole('combobox', { name: 'Report', exact: true })
    .selectOption('order-transactions');
  await page
    .getByLabel('Stores')
    .selectOption('7')
    .catch(() => undefined);
  const created: { status: number; id?: string }[] = [];
  page.on('response', (response) => {
    if (
      response.request().method() === 'POST' &&
      /report-exports$/.test(new URL(response.url()).pathname)
    )
      void response
        .json()
        .then((body: { id?: string; exportId?: string }) =>
          created.push({ status: response.status(), id: body?.id ?? body?.exportId }),
        )
        .catch(() => created.push({ status: response.status() }));
  });
  await page.getByRole('button', { name: 'Request export' }).click();
  await page.waitForTimeout(8000);
  note('reports', 'export-request', {
    created,
    alerts: await alerts(page),
    status: await page.getByRole('status').allInnerTexts(),
  });
  for (const entry of created)
    if (entry.status < 300)
      ledger({
        kind: 'report_exports',
        flow: 'export-order-transactions',
        id: entry.id ?? 'see history',
      });
  // The worker picks the job up; the history shows its final state.
  await page.waitForTimeout(30000);
  await page.reload();
  await page.waitForTimeout(6000);
  await shot(page, '06-export-history');
  note('reports', 'export-history', {
    rows: (await page.getByRole('row').allInnerTexts()).slice(0, 4),
  });
});

test('administration: store 7 per-hour threshold +1, then revert', async () => {
  const { page } = desktop;
  await go(page, '/administration');
  await page.getByLabel('Find store').fill('Indiranagar');
  await page.waitForTimeout(3000);
  const row = page.getByRole('row').filter({ hasText: 'Indiranagar' }).first();
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const field = page.getByLabel('Per Hour Threshold');
  await expect(field).toBeVisible();
  const original = await field.inputValue();
  const changed = String(Number(original) + 1);
  const save = async (value: string) => {
    await page.getByLabel('Per Hour Threshold').fill(value);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await page.waitForTimeout(6000);
    return {
      alerts: await alerts(page),
      status: await page
        .getByRole('status')
        .allInnerTexts()
        .catch(() => []),
    };
  };
  const first = await save(changed);
  note('admin', 'store-edit', { from: original, to: changed, ...first });
  ledger({
    kind: 'stores',
    flow: 'admin-edit',
    storeId: '7',
    field: 'per_hour_threshold',
    from: original,
    to: changed,
  });
  await shot(page, '06-store-edited');
  if (!(await page.getByLabel('Per Hour Threshold').count())) {
    await page.getByLabel('Find store').fill('Indiranagar');
    await page.waitForTimeout(3000);
    await page
      .getByRole('row')
      .filter({ hasText: 'Indiranagar' })
      .first()
      .getByRole('button', { name: 'Edit', exact: true })
      .click();
  }
  const second = await save(original);
  note('admin', 'store-revert', { to: original, ...second });
  ledger({
    kind: 'stores',
    flow: 'admin-revert',
    storeId: '7',
    field: 'per_hour_threshold',
    from: changed,
    to: original,
  });
});

test('gift cards: batch list', async () => {
  const { page } = desktop;
  await go(page, '/administration/gift-card-batches');
  await shot(page, '06-gift-cards');
  note('gift-cards', 'list', {
    alerts: await alerts(page),
    rows: await page.getByRole('row').count(),
  });
});
