import { expect, test, type Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDesktop, evidence, launchDesktop, shot, signIn, type Desktop } from './support';

/**
 * Round 2: order history, detail, invoice, payment status and cancel, then return and exchange,
 * all on the orders this run created for customer 12132565 at store 7 (W26_ORDERS: cash order,
 * Others order, Paytm-pending order, fast-cash order).
 */
const [CASH, OTHERS, PENDING, FAST] = (
  process.env.W26_ORDERS ?? '19055005,19055006,19055007,19055008'
).split(',');
const note = (step: string, data: unknown) =>
  appendFileSync(
    join(evidence, 'flows.jsonl'),
    `${JSON.stringify({ flow: 'orders-r2', step, data })}\n`,
  );
async function go(page: Page, path: string) {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await page.waitForTimeout(3000);
}
const texts = async (page: Page, role: 'alert' | 'status') =>
  (
    await page
      .getByRole(role)
      .allInnerTexts()
      .catch(() => [] as string[])
  )
    .map((t) => t.replace(/\s+/g, ' ').slice(0, 220))
    .filter((t) => t && !/Customer insights are unavailable/.test(t));
const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

let desktop: Desktop;
test.beforeAll(async () => {
  desktop = await launchDesktop('orders-r2');
  await signIn(desktop.page);
  await expect(desktop.page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
});
test.afterAll(async () => {
  if (desktop) await closeDesktop(desktop);
});

async function openOrder(page: Page, orderId: string) {
  await go(page, '/orders');
  await page.getByLabel('Placed from').fill(`${today}T00:00`);
  await page.getByLabel('Placed to').fill(`${today}T23:59`);
  await page.getByLabel('Search order or customer IDs').fill(orderId);
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await page.waitForTimeout(5000);
  const row = page.getByText(orderId, { exact: true }).first();
  const found = await row.count();
  if (found) {
    await row.click();
    await page.waitForTimeout(4000);
  }
  return found;
}

test('order history, summary, detail and invoice (cash order)', async () => {
  const { page } = desktop;
  const found = await openOrder(page, CASH!);
  const dialog = page.getByRole('dialog').first();
  const buttons = found ? await dialog.getByRole('button').allInnerTexts() : [];
  note('cash:summary', {
    found,
    buttons: buttons.slice(0, 20),
    alerts: await texts(page, 'alert'),
  });
  await shot(page, '12-cash-summary');
  const details = dialog.getByRole('button', { name: 'Open order details' });
  if (await details.count()) {
    await details.click();
    await page.waitForTimeout(5000);
    const detailButtons = await page.getByRole('button').allInnerTexts();
    note('cash:detail', {
      buttons: detailButtons
        .filter((b) => /invoice|cancel|payment|status|copy|return|exchange/i.test(b))
        .slice(0, 20),
      alerts: await texts(page, 'alert'),
    });
    await shot(page, '12-cash-detail');
    const invoice = page
      .getByRole('button', { name: /^Tax invoice$|Store tax invoice|Print invoice/i })
      .first();
    if (await invoice.count()) {
      await invoice.click();
      await page.waitForTimeout(8000);
      note('cash:invoice', {
        frames: await page.locator('iframe[title^="Tax invoice"]').count(),
        alerts: await texts(page, 'alert'),
      });
      await shot(page, '12-cash-invoice');
    }
  }
});

test('payment status and cancel on the Paytm-pending order', async () => {
  const { page } = desktop;
  const found = await openOrder(page, PENDING!);
  const dialog = page.getByRole('dialog').first();
  note('pending:summary', {
    found,
    buttons: found ? (await dialog.getByRole('button').allInnerTexts()).slice(0, 20) : [],
  });
  const details = dialog.getByRole('button', { name: 'Open order details' });
  if (await details.count()) await details.click();
  await page.waitForTimeout(5000);
  const status = page.getByRole('button', { name: 'Check payment status' }).first();
  if (await status.count()) {
    await status.click();
    await page.waitForTimeout(8000);
    note('pending:payment-status', {
      status: await texts(page, 'status'),
      alerts: await texts(page, 'alert'),
    });
  } else note('pending:payment-status', 'no control');
  await shot(page, '12-pending-detail');
  const cancel = page.getByRole('button', { name: 'Cancel Order' }).first();
  if (await cancel.count()) {
    await cancel.click();
    await page.getByRole('button', { name: 'Yes, sure!' }).first().click();
    await page.waitForTimeout(10000);
    note('pending:cancel', {
      status: await texts(page, 'status'),
      alerts: await texts(page, 'alert'),
    });
    await shot(page, '12-pending-cancelled');
  } else note('pending:cancel', 'no control');
});

test('return on the cash order', async () => {
  const { page } = desktop;
  await go(page, '/returns');
  const counter = page.getByRole('combobox', { name: 'Current counter' });
  if (await counter.count()) await counter.selectOption('7').catch(() => undefined);
  await page.getByLabel('Return order ID').fill(CASH!);
  await page.getByRole('button', { name: 'Find order' }).click();
  await page.waitForTimeout(8000);
  await shot(page, '12-return-found');
  const line = page.getByRole('button', { name: /Book Lover/ }).first();
  note('return:find', {
    lines: await line.count(),
    alerts: await texts(page, 'alert'),
    status: await texts(page, 'status'),
  });
  if (!(await line.count())) return;
  await line.click();
  await page.waitForTimeout(4000);
  const reason = page.getByLabel('Return reason', { exact: true });
  if (!(await reason.count())) {
    note('return:eligibility', {
      alerts: await texts(page, 'alert'),
      status: await texts(page, 'status'),
    });
    await shot(page, '12-return-ineligible');
    return;
  }
  const reasons = await reason
    .locator('option')
    .evaluateAll((n) => n.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  await reason.selectOption(reasons[0]!);
  const sub = page.getByLabel('Return sub-reason');
  const subs = await sub
    .locator('option')
    .evaluateAll((n) => n.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  if (subs.length) await sub.selectOption(subs[0]!);
  await page.getByLabel('Comment', { exact: true }).fill('W26 UAT return test');
  await page.getByRole('checkbox', { name: 'I checked the item’s condition' }).check();
  await page.getByRole('checkbox', { name: 'I checked the original tag' }).check();
  await page.getByRole('button', { name: 'Confirm return & refund' }).click();
  await page.waitForTimeout(20000);
  note('return:confirm', {
    headings: (await page.getByRole('heading').allInnerTexts()).slice(0, 6),
    status: await texts(page, 'status'),
    alerts: await texts(page, 'alert'),
  });
  await shot(page, '12-return-done');
});

test('exchange on the Others order', async () => {
  const { page } = desktop;
  await go(page, '/returns');
  await page
    .getByRole('button', { name: 'Exchange', exact: true })
    .click()
    .catch(() => undefined);
  const counter = page.getByRole('combobox', { name: 'Current counter' });
  if (await counter.count()) await counter.selectOption('7').catch(() => undefined);
  const another = page.getByText('Use another order');
  if (await another.count()) await another.click();
  await page.getByLabel('Return order ID').fill(OTHERS!);
  await page.getByRole('button', { name: 'Find order' }).click();
  await page.waitForTimeout(8000);
  const line = page.getByRole('button', { name: /Book Lover/ }).first();
  note('exchange:find', { lines: await line.count(), alerts: await texts(page, 'alert') });
  if (!(await line.count())) return;
  await line.click();
  await page.waitForTimeout(5000);
  const sizes = await page.getByRole('button', { name: /in stock/ }).allInnerTexts();
  note('exchange:sizes', sizes);
  await shot(page, '12-exchange-sizes');
  const target = page
    .getByRole('button', { name: /in stock/ })
    .filter({ hasNotText: /· 0 in stock/ })
    .first();
  if (!(await target.count()) || (await target.isDisabled())) {
    note('exchange:no-size', { alerts: await texts(page, 'alert') });
    return;
  }
  await target.click();
  const people = page.getByLabel('Exchange salesperson');
  const ids = await people
    .locator('option')
    .evaluateAll((n) => n.map((o) => (o as HTMLOptionElement).value).filter((v) => v && v !== '0'));
  await people.selectOption(ids[0]!);
  const reason = page.getByLabel('Exchange reason', { exact: true });
  const reasons = await reason
    .locator('option')
    .evaluateAll((n) => n.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  await reason.selectOption(reasons[0]!);
  const sub = page.getByLabel('Exchange sub-reason');
  const subs = await sub
    .locator('option')
    .evaluateAll((n) => n.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
  if (subs.length) await sub.selectOption(subs[0]!);
  await page.getByLabel('Comment', { exact: true }).fill('W26 UAT exchange test');
  await page.getByRole('checkbox', { name: 'I checked the item’s condition' }).check();
  await page.getByRole('checkbox', { name: 'I checked the original tag' }).check();
  await page.getByRole('button', { name: 'Confirm exchange', exact: true }).click();
  await page.waitForTimeout(25000);
  note('exchange:confirm', {
    headings: (await page.getByRole('heading').allInnerTexts()).slice(0, 6),
    status: await texts(page, 'status'),
    alerts: await texts(page, 'alert'),
  });
  await shot(page, '12-exchange-done');
});

void FAST;
