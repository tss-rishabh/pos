import { expect, test, type Locator, type Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeDesktop,
  evidence,
  launchDesktop,
  ledger,
  shot,
  signIn,
  testCustomerContact,
  uat,
  type Desktop,
} from './support';

/**
 * Round 2 checkout on UAT store 7 / counter C1, every sale connected to the allowlisted test
 * customer 12132565 (never another customer: the lookup result is checked before connecting).
 * Product: a real store-7 item scanned by its GS1 barcode (Rs. 49 patch). Each created order is
 * written to the ledger with its payment mode.
 */
/**
 * TSS Originals: Book Lover (L), product 262148, store-7 stock 380: the product UAT API-v2 knows.
 * API-v2 UAT reads store stock from its own catalogue mirror (Mongo/Redis), which does not hold
 * most store-7 products (pos/product answers 404 "Not found" / "Product Not found in given store").
 */
const PATCH = { gtin: '8909034126224' };
const TEE = { gtin: '8909034126224' };
const note = (step: string, data: unknown) =>
  appendFileSync(
    join(evidence, 'flows.jsonl'),
    `${JSON.stringify({ flow: 'checkout-r2', step, data })}\n`,
  );
async function outcome(scope: Locator, success: Locator, ms = 45000) {
  // In-progress notices also carry a request reference, so only a final state counts: the
  // success element, or an error alert once the action stopped (no busy button left).
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await success.count()) return null;
    // Customer insights are informational on UAT (CUSTOMER_INSIGHT_* not configured).
    const alert = scope
      .getByRole('alert')
      .filter({ hasNotText: /Customer insights are unavailable/ })
      .first();
    const busy = await scope.getByRole('button', { name: /…$/ }).count();
    if ((await alert.count()) && !busy) {
      await new Promise((r) => setTimeout(r, 1500));
      if (await success.count()) return null;
      return (await alert.innerText()).replace(/\s+/g, ' ').slice(0, 300);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const status = await scope
    .getByRole('status')
    .allInnerTexts()
    .catch(() => [] as string[]);
  return 'timeout: ' + status.join(' | ').replace(/\s+/g, ' ').slice(0, 300);
}

let desktop: Desktop;
const orders: { mode: string; orderId: string | null; status: number }[] = [];
test.beforeAll(async () => {
  desktop = await launchDesktop('checkout-r2');
  await signIn(desktop.page);
  await expect(desktop.page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
  // Earlier, abandoned checkouts of this run keep the customer's 12-hour cart lease
  // (CUSTOMER_CART_BUSY). Detach the test customer from them, as a cashier reviewing that sale would.
  for (const id of (process.env.W26_RELEASE_CHECKOUTS ?? '').split(',').filter(Boolean)) {
    const released = await desktop.page.evaluate(
      async ([checkout, operatorId]) => {
        const base = `/api/v1/stores/7/checkout-sessions/${checkout}`;
        const headers = { 'content-type': 'application/json', 'X-Operator-ID': operatorId };
        const state = (await (await fetch(base, { headers, credentials: 'include' })).json()) as {
          data?: { version?: number };
          version?: number;
        };
        const reply = await fetch(base + '/customer-detachments', {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify({
            operationId: crypto.randomUUID(),
            expectedVersion: state.data?.version ?? state.version,
          }),
        });
        return reply.status;
      },
      [id, uat.operatorId] as const,
    );
    note('release-previous-checkout', { checkout: id, status: released });
  }
  desktop.page.on('response', (response) => {
    const match = /\/stores\/7\/checkout-sessions\/([0-9a-f-]{36})/.exec(
      new URL(response.url()).pathname,
    );
    if (match) checkoutId = match[1]!;
    if (
      response.request().method() === 'POST' &&
      /\/order-submissions$/.test(new URL(response.url()).pathname)
    )
      void response
        .json()
        .then((body: { orderId?: string; order?: { id?: string } }) => {
          const orderId = body?.orderId ?? body?.order?.id ?? null;
          orders.push({
            mode: currentMode,
            orderId: orderId ? String(orderId) : null,
            status: response.status(),
          });
          if (orderId)
            ledger({
              kind: 'order',
              flow: `checkout-${currentMode}`,
              orderId: String(orderId),
              customer: uat.customerId,
              store: uat.storeId,
            });
        })
        .catch(() => orders.push({ mode: currentMode, orderId: null, status: response.status() }));
  });
});
test.afterAll(async () => {
  note('orders', orders);
  if (desktop) await closeDesktop(desktop);
});
let currentMode = 'none';
let checkoutId = '';

async function newSale(page: Page, gtins: string[] = [PATCH.gtin]) {
  const fresh = page.getByRole('button', { name: /^New sale$/i }).first();
  if (await fresh.count()) await fresh.click().catch(() => undefined);
  const search = page.getByLabel('Search products or scan a barcode');
  for (const gtin of gtins) {
    await search.fill(gtin);
    await search.press('Enter');
    await expect(page.getByText(gtin).first()).toBeVisible();
  }
}
/** Review, confirm prices, connect customer 12132565 (checked), salesperson, final quote. */
async function prepare(page: Page, label: string) {
  await page.getByRole('button', { name: 'Review sale', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm the sale' });
  await dialog.getByRole('button', { name: 'Confirm prices online' }).click();
  const quoted = dialog.getByText('Salesperson assignments', { exact: true });
  const priced = await outcome(dialog, quoted);
  note(`${label}:confirm-prices`, priced ?? 'ok');
  expect(priced).toBeNull();
  // Customer: the UI lookup ("Fetch the User") is tried first. On UAT it answers 400 "Access
  // not authorized" (API-v2 check-user-exclusive needs API-v2's AR_APP_ID/AR_APP_KEY, which
  // .env.uat does not hold), so the sale is connected through the app's own connect endpoint
  // (the request "Connect the User" sends), for customer 12132565 only.
  await dialog.getByText('Customer and verification', { exact: true }).click();
  const contact = await testCustomerContact();
  const lookup = page.waitForResponse((r) => /\/customer-lookups$/.test(new URL(r.url()).pathname));
  await dialog
    .getByRole('textbox', { name: 'Mobile', exact: true })
    .fill(contact.telephone.replace(/\D/g, '').slice(-10));
  await dialog.getByRole('textbox', { name: 'Email', exact: true }).fill(contact.email);
  await dialog.getByRole('button', { name: 'Fetch the User' }).click();
  const looked = await lookup;
  const found = (await looked.json().catch(() => ({}))) as {
    data?: { customer?: { id?: string } };
  };
  const foundId = String(found?.data?.customer?.id ?? '');
  note(`${label}:lookup`, {
    status: looked.status(),
    foundIsTestCustomer: foundId === uat.customerId,
  });
  if (foundId === uat.customerId) {
    await dialog.getByRole('button', { name: 'Connect the User' }).click();
    await expect(dialog.getByText('Cart has been Synced')).toBeVisible();
  } else {
    expect(checkoutId, 'checkout session id').not.toBe('');
    const attached = await page.evaluate(
      async ([id, customerId, operatorId]) => {
        const base = `/api/v1/stores/7/checkout-sessions/${id}`;
        const headers = { 'content-type': 'application/json', 'X-Operator-ID': operatorId };
        const state = (await (await fetch(base, { headers, credentials: 'include' })).json()) as {
          data?: { version?: number };
          version?: number;
        };
        const version = state.data?.version ?? state.version;
        const reply = await fetch(base + '/customer', {
          method: 'PUT',
          headers,
          credentials: 'include',
          body: JSON.stringify({
            customerId,
            operationId: crypto.randomUUID(),
            expectedVersion: version,
          }),
        });
        return {
          status: reply.status,
          body: (await reply.json().catch(() => null)) as { status?: string } | null,
        };
      },
      [checkoutId, uat.customerId, uat.operatorId] as const,
    );
    note(`${label}:attach-api`, {
      status: attached.status,
      outcome: attached.body?.status ?? null,
    });
    expect(attached.status).toBeLessThan(300);
    // Re-open the review so the app adopts the connected checkout.
    await page.getByRole('button', { name: 'Close checkout' }).first().click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Review sale', exact: true }).click();
    await dialog
      .getByRole('button', { name: 'Confirm prices online' })
      .click()
      .catch(() => undefined);
    await expect(quoted).toBeVisible({ timeout: 60000 });
  }
  await quoted.click();
  const salesperson = dialog.getByRole('combobox', { name: 'Sale salesperson', exact: true });
  const options = await salesperson
    .locator('option')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => (node as HTMLOptionElement).value)
        .filter((value) => value && value !== '0'),
    );
  note(`${label}:salespeople`, options.length);
  await salesperson.selectOption(options[0]!);
  await dialog.getByRole('button', { name: 'Get final quote' }).click();
  const proceed = dialog.getByRole('button', { name: 'Proceed For Payment', exact: true });
  const quote = await outcome(dialog, proceed);
  note(`${label}:final-quote`, quote ?? 'ok');
  expect(quote).toBeNull();
  await shot(page, `11-${label}-quoted`);
  return dialog;
}
async function pay(page: Page, dialog: Locator, label: string, mode: string, message: string) {
  currentMode = label;
  await dialog.getByRole('button', { name: 'Proceed For Payment', exact: true }).click();
  const form = dialog.locator('#paymentform');
  await expect(form).toBeVisible();
  const due = (await form.locator('.grand-total strong').innerText()).replace(/[^\d.]/g, '');
  if (mode === 'cash') {
    await form.getByRole('spinbutton', { name: 'Cash To Be Accepted:' }).fill(due);
    await form.getByRole('spinbutton', { name: 'Cash Recieved:' }).fill(due);
  } else {
    await form.getByRole('spinbutton', { name: 'Cash To Be Accepted:' }).fill('0');
    await form.getByRole('spinbutton', { name: 'Cash To Be Accepted:' }).blur();
    await form.getByRole('spinbutton', { name: 'Card/UPI:' }).fill(due);
    await form.getByRole('spinbutton', { name: 'Card/UPI:' }).blur();
    const select = form.getByRole('combobox', { name: /Payment Mode/ });
    const labels = await select.locator('option').allInnerTexts();
    note(`${label}:payment-options`, labels);
    const choice = labels.find((text) => text.toLowerCase().includes(mode.toLowerCase()));
    if (!choice) {
      note(`${label}:payment-mode-missing`, mode);
      return 'mode not offered';
    }
    await select.selectOption({ label: choice });
  }
  await form.getByPlaceholder('Enter Message').fill(message);
  await form.getByRole('button', { name: 'Submit', exact: true }).click();
  await dialog.getByRole('button', { name: 'Yes, sure!', exact: true }).click();
  const done = page.getByText(/^Payment confirmed\./).first();
  const result = await outcome(page.locator('body'), done, 90000);
  await page.waitForTimeout(3000);
  await shot(page, `11-${label}-after-pay`);
  const status = await dialog
    .getByRole('status')
    .allInnerTexts()
    .catch(() => []);
  note(`${label}:payment`, {
    result: result ?? 'paid',
    status: status.map((s) => s.slice(0, 200)),
  });
  return result;
}

test('cash: customer 12132565, pos/order, invoice', async () => {
  const { page } = desktop;
  // Two lines: the patch (for the return) and a sized tee (for the exchange).
  await newSale(page, (process.env.W26_CASH_GTINS ?? `${PATCH.gtin},${TEE.gtin}`).split(','));
  const dialog = await prepare(page, 'cash');
  const result = await pay(page, dialog, 'cash', 'cash', 'W26 UAT cash sale');
  expect(result).toBeNull();
  const invoice = page.frameLocator('iframe[title^="Tax invoice for order"]').locator('body');
  await invoice.waitFor({ timeout: 30000 }).catch(() => undefined);
  note('cash:invoice', { frames: await page.locator('iframe[title^="Tax invoice"]').count() });
  await shot(page, '11-cash-invoice');
});

test('Others (1001) with a manual reference', async () => {
  const { page } = desktop;
  await page.keyboard.press('Escape').catch(() => undefined);
  await newSale(page);
  const dialog = await prepare(page, 'others');
  const result = await pay(page, dialog, 'others', 'Others', 'W26-UAT-REF-0001');
  expect(result).toBeNull();
});

test('Pine Labs UAT card: record the terminal state', async () => {
  const { page } = desktop;
  await page.keyboard.press('Escape').catch(() => undefined);
  await newSale(page);
  const dialog = await prepare(page, 'pinelabs');
  const result = await pay(page, dialog, 'pinelabs', 'Pinelab Card', 'W26 UAT Pine Labs');
  await page.waitForTimeout(10000);
  await shot(page, '11-pinelabs-terminal');
  await abandon(page);
  note('pinelabs:terminal', {
    result,
    text: (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 800),
  });
});

test('Paytm staging card: record the state', async () => {
  const { page } = desktop;
  await page.keyboard.press('Escape').catch(() => undefined);
  await newSale(page);
  const dialog = await prepare(page, 'paytm');
  const result = await pay(page, dialog, 'paytm', 'Paytm Card', 'W26 UAT Paytm');
  await page.waitForTimeout(10000);
  await shot(page, '11-paytm-terminal');
  note('paytm:terminal', {
    result,
    text: (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 800),
  });
});

/** Detaches the test customer from the open checkout (frees its cart lease) and closes the dialog. */
async function abandon(page: Page) {
  const clear = page.getByRole('button', { name: 'Clear checkout and start a new sale' });
  if (await clear.count()) {
    await clear.click();
    const confirm = page.getByRole('button', { name: /^(Yes|Clear|Confirm)/ });
    if (await confirm.count())
      await confirm
        .first()
        .click()
        .catch(() => undefined);
    await page.waitForTimeout(3000);
  }
  if (checkoutId)
    await page.evaluate(
      async ([id, operatorId]) => {
        const base = `/api/v1/stores/7/checkout-sessions/${id}`;
        const headers = { 'content-type': 'application/json', 'X-Operator-ID': operatorId };
        const state = (await (await fetch(base, { headers, credentials: 'include' })).json()) as {
          data?: { version?: number };
          version?: number;
        };
        await fetch(base + '/customer-detachments', {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify({
            operationId: crypto.randomUUID(),
            expectedVersion: state.data?.version ?? state.version,
          }),
        });
      },
      [checkoutId, uat.operatorId] as const,
    );
  await page
    .getByRole('button', { name: 'Close checkout' })
    .first()
    .click()
    .catch(() => undefined);
}

test('customer OTP for 12132565 (real delivery through the allowlist)', async () => {
  const { page } = desktop;
  await newSale(page);
  const dialog = await prepare(page, 'otp');
  const sent = page.waitForResponse(
    (r) =>
      /\/customer-verification\/challenges$|\/customer-verification$|verification/.test(
        new URL(r.url()).pathname,
      ) && r.request().method() === 'POST',
  );
  await dialog.getByText('Customer and verification', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Send verification code' }).click();
  const reply = await sent.catch(() => null);
  await page.waitForTimeout(6000);
  await dialog
    .getByRole('button', { name: 'Check verification delivery' })
    .click()
    .catch(() => undefined);
  await page.waitForTimeout(3000);
  const status = (await dialog.getByRole('status').allInnerTexts()).map((s) => s.slice(0, 160));
  note('otp:send', {
    httpStatus: reply?.status() ?? null,
    requestId: reply?.headers()['x-request-id'] ?? null,
    status: status.filter((s) => /verif|deliver|queued|code/i.test(s)),
  });
  await shot(page, '11-otp-sent');
  await abandon(page);
});

test('fast cash checkout for 12132565', async () => {
  const { page } = desktop;
  currentMode = 'fastcash';
  await newSale(page);
  const dialog = await prepare(page, 'fastcash');
  await dialog.getByRole('button', { name: 'Fast Cash' }).click();
  const fast = page.getByRole('dialog', { name: /Fast Checkout \(Cash Only\)!/ });
  await expect(fast).toBeVisible();
  const payable = (
    (await fast.getByRole('heading').innerText()).match(/:\s*([\d.,]+)/)?.[1] ?? ''
  ).replace(/,/g, '');
  await fast.getByRole('spinbutton', { name: 'Cash Recieved:' }).fill(payable);
  await fast.getByPlaceholder('Enter the message for the order').fill('W26 UAT fast cash');
  await fast.getByRole('button', { name: 'Submit', exact: true }).click();
  const done = page.getByText(/^Payment confirmed\./).first();
  const result = await outcome(page.locator('body'), done, 90000);
  await shot(page, '11-fastcash-done');
  note('fastcash:payment', result ?? 'paid');
  expect(result).toBeNull();
});
